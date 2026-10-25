import * as THREE from 'three';

/**
 * 极简 Verlet 布料（位置约束 / PBD）。
 *
 * 设计取舍：
 * - 顶部两排质点固定在横杆上；
 * - 结构约束（横 / 纵 / 斜）保证布料不可拉伸；
 * - 「折叠约束」是跨多列的长程约束：它把布料的水平跨度钉在收拢后的宽度上，
 *   否则结构约束会把布料拉平成一张大布，褶皱就全没了；
 * - 「长程附着（LRA）」限制质点到对应固定点的直线距离不超过材料长度，
 *   用来抑制重力下的过度拉伸（真丝本来就有一点弹性）；
 * - 速度上限 + 固定步长，保证模拟「稳定不爆炸」。
 *
 * 全部数据放在 TypedArray 里，update 每帧不产生任何新对象。
 */

/** 布料求解参数。 */
export interface ClothOptions {
  /** 横向质点数。 */
  cols: number;
  /** 纵向质点数。 */
  rows: number;
  /** 顶部固定点的总跨度（米）。 */
  width: number;
  /** 悬挂高度（米）。 */
  height: number;
  /** 褶皱的横向周期（列数），需与折叠约束的跨度一致。 */
  foldPeriod: number;
  /** 褶皱的初始幅度（米）。 */
  foldAmplitude: number;
  /** 结构约束刚度。 */
  stiffness: number;
  /** 折叠（保持收拢）约束刚度。 */
  foldStiffness: number;
  /** 约束迭代次数。 */
  iterations: number;
  /** 每步保留的速度比例。 */
  damping: number;
}

/** 每步施加的外部作用力。 */
export interface ClothForces {
  /** 步长（秒）。 */
  dt: number;
  /** 累计时间（秒）。 */
  time: number;
  /** 重力加速度（米/秒²，负值向下）。 */
  gravity: number;
  /** 风在 x / y / z 上的分量。 */
  windX: number;
  windY: number;
  windZ: number;
  /** 湍流强度。 */
  turbulence: number;
  /** 涟漪强度（0~1）。 */
  ripple: number;
}

/** 布料所处的环境（地面与障碍柱）。 */
export interface ClothWorld {
  /** 地面高度（米）。 */
  groundY: number;
  /** 障碍柱轴心 x / z。 */
  poleX: number;
  poleZ: number;
  /** 障碍柱半径（米）。 */
  poleRadius: number;
  /** 障碍柱顶端高度（米），高于此高度不参与碰撞。 */
  poleTop: number;
}

/** 单步允许的最大位移（米），超过就截断，防止数值爆炸。 */
const MAX_STEP = 0.12;

/** 地面碰撞时保留的切向速度比例。 */
const GROUND_FRICTION = 0.45;

/** 抓取影响范围的默认形状（沿布料的横向 / 纵向半径）。 */
const GRAB_RADIUS_X = 0.42;
const GRAB_RADIUS_Y = 0.17;

export class Cloth {
  readonly cols: number;
  readonly rows: number;
  readonly count: number;

  /** 当前质点位置（x, y, z 交错）。 */
  readonly positions: Float32Array;
  /** 逆质量：0 表示固定点。 */
  readonly invMass: Float32Array;

  private readonly previous: Float32Array;
  private readonly pinPosition: Float32Array;

  private readonly ca: Int32Array;
  private readonly cb: Int32Array;
  private readonly crest: Float32Array;
  private readonly cstiff: Float32Array;
  private readonly constraintCount: number;

  private readonly grabWeight: Float32Array;
  private readonly grabOffset: Float32Array;
  private readonly hand = new THREE.Vector3();
  private grabbing = false;

  /** 竖直方向的材料长度（用于长程附着）。 */
  private readonly materialHeight: number;
  /** 折叠约束的跨度（列）。 */
  private readonly foldSpan: number;
  /** 顶部的横向间距（米）。 */
  private readonly spacingX: number;
  /** 每步保留的速度比例。 */
  private readonly damping: number;
  /** 约束迭代次数。 */
  private readonly iterations: number;

  constructor(options: ClothOptions) {
    const cols = Math.max(4, Math.round(options.cols));
    const rows = Math.max(4, Math.round(options.rows));
    this.cols = cols;
    this.rows = rows;
    this.count = cols * rows;

    const dx = options.width / (cols - 1);
    const ry = options.height / (rows - 1);
    this.materialHeight = options.height;
    this.spacingX = dx;
    this.damping = options.damping;
    this.iterations = options.iterations;

    this.positions = new Float32Array(this.count * 3);
    this.previous = new Float32Array(this.count * 3);
    this.invMass = new Float32Array(this.count);
    // 自由质点的逆质量必须为非零，否则解算器会认为所有质点都被固定，
    // 重力 / 风力 / 距离约束 / 抓取全部失效（布会退化成一张静态网格）。
    this.invMass.fill(1);
    this.pinPosition = new Float32Array(this.count * 3);
    this.grabWeight = new Float32Array(this.count);
    this.grabOffset = new Float32Array(this.count * 3);

    // ── 初始形状：顶部两排平直（固定在横杆上），下方逐渐长出柔和的褶皱 ──
    const period = Math.max(2, Math.round(options.foldPeriod));
    this.foldSpan = period;
    const taperRows = Math.max(2, Math.round(rows * 0.16));
    const phase = period * 0.17;

    for (let r = 0; r < rows; r += 1) {
      const taper = Math.min(1, r / taperRows);
      // 顶端用余弦过渡，避免褶皱突然出现
      const eased = taper * taper * (3 - 2 * taper);
      for (let c = 0; c < cols; c += 1) {
        const i3 = (r * cols + c) * 3;
        const x = (c - (cols - 1) / 2) * dx;
        const y = -r * ry;
        const z = options.foldAmplitude * eased * Math.sin((c / period) * Math.PI * 2 + phase);
        this.positions[i3] = x;
        this.positions[i3 + 1] = y;
        this.positions[i3 + 2] = z;
      }
    }

    // 固定顶部两排
    for (let r = 0; r < Math.min(2, rows); r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const i = r * cols + c;
        this.invMass[i] = 0;
        const i3 = i * 3;
        this.pinPosition[i3] = this.positions[i3];
        this.pinPosition[i3 + 1] = this.positions[i3 + 1];
        this.pinPosition[i3 + 2] = this.positions[i3 + 2];
      }
    }

    // ── 由初始形状推出材料宽度（横向静止长度） ──
    let sum = 0;
    let samples = 0;
    for (let r = Math.floor(rows * 0.35); r < rows; r += 1) {
      for (let c = 0; c < cols - 1; c += 1) {
        const a = (r * cols + c) * 3;
        const b = (r * cols + c + 1) * 3;
        const ex = this.positions[b] - this.positions[a];
        const ey = this.positions[b + 1] - this.positions[a + 1];
        const ez = this.positions[b + 2] - this.positions[a + 2];
        sum += Math.sqrt(ex * ex + ey * ey + ez * ez);
        samples += 1;
      }
    }
    const restX = samples > 0 ? sum / samples : dx;
    const restY = ry;
    const restDiag = Math.sqrt(restX * restX + restY * restY);

    // ── 约束集合 ──
    const maxConstraints = cols * rows * 8;
    const ca = new Int32Array(maxConstraints);
    const cb = new Int32Array(maxConstraints);
    const crest = new Float32Array(maxConstraints);
    const cstiff = new Float32Array(maxConstraints);
    let n = 0;

    const add = (a: number, b: number, rest: number, stiffness: number): void => {
      ca[n] = a;
      cb[n] = b;
      crest[n] = rest;
      cstiff[n] = stiffness;
      n += 1;
    };

    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const i = r * cols + c;
        // 横向结构约束
        if (c + 1 < cols) add(i, i + 1, restX, options.stiffness);
        // 纵向结构约束
        if (r + 1 < rows) add(i, i + cols, restY, options.stiffness);
        // 斜向剪切约束
        if (r + 1 < rows && c + 1 < cols) {
          add(i, i + cols + 1, restDiag, options.stiffness * 0.3);
          add(i + 1, i + cols, restDiag, options.stiffness * 0.3);
        }
        // 纵向弯曲约束（让绸缎有一点点挺括感，避免整体塌成一团）
        if (r + 2 < rows) add(i, i + cols * 2, restY * 2, 0.05);
      }
    }

    // 横向折叠约束：把水平跨度钉在收拢后的宽度上，褶皱才不会散掉
    const span = Math.min(this.foldSpan, cols - 1);
    if (span >= 2) {
      for (let r = 0; r < rows; r += 1) {
        for (let c = 0; c + span < cols; c += 1) {
          add(r * cols + c, r * cols + c + span, dx * span, options.foldStiffness);
        }
      }
    }

    this.ca = ca.subarray(0, n);
    this.cb = cb.subarray(0, n);
    this.crest = crest.subarray(0, n);
    this.cstiff = cstiff.subarray(0, n);
    this.constraintCount = n;
  }

  /** 是否正在抓取布料。 */
  get isGrabbing(): boolean {
    return this.grabbing;
  }

  /**
   * 开始抓取：以命中点为中心，横向一带布料跟随手部运动。
   */
  beginGrab(point: THREE.Vector3, strength: number): void {
    const cols = this.cols;
    const rows = this.rows;
    const p = this.positions;

    // 找最近的质点
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < this.count; i += 1) {
      const i3 = i * 3;
      const dx = p[i3] - point.x;
      const dy = p[i3 + 1] - point.y;
      const dz = p[i3 + 2] - point.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    if (best < 0) return;

    const bestRow = Math.floor(best / cols);
    const bestCol = best % cols;
    const dx = this.spacingX;

    this.grabbing = true;
    this.hand.copy(point);

    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const i = r * cols + c;
        const i3 = i * 3;
        const ox = (c - bestCol) * dx;
        const oy = (r - bestRow) * (this.materialHeight / Math.max(1, rows - 1));
        const q = (ox * ox) / (GRAB_RADIUS_X * GRAB_RADIUS_X) + (oy * oy) / (GRAB_RADIUS_Y * GRAB_RADIUS_Y);
        if (q >= 1) {
          this.grabWeight[i] = 0;
          continue;
        }
        const falloff = 1 - q;
        const weight = i === best ? 1 : falloff * falloff * 0.85;
        this.grabWeight[i] = weight * strength;
        this.grabOffset[i3] = p[i3] - point.x;
        this.grabOffset[i3 + 1] = p[i3 + 1] - point.y;
        this.grabOffset[i3 + 2] = p[i3 + 2] - point.z;
      }
    }
  }

  /** 更新手部位置（布料的一排质点随之移动）。 */
  moveGrab(hand: THREE.Vector3): void {
    if (!this.grabbing) return;
    this.hand.copy(hand);
  }

  /** 释放抓取。 */
  endGrab(): void {
    this.grabbing = false;
    this.grabWeight.fill(0);
  }

  /** 推进一个固定步长。 */
  step(forces: ClothForces, world: ClothWorld): void {
    this.integrate(forces);
    this.applyGrab(1);

    const iterations = this.iterations;
    for (let iter = 0; iter < iterations; iter += 1) {
      this.solveConstraints(iter);
      this.applyLongRange(0.85);
      this.collide(world);
      this.applyGrab(0.9);
    }

    this.applyLongRange(1);
    this.collide(world);
  }

  /** 把当前位置写进几何体的 position 属性。 */
  writeTo(attribute: THREE.BufferAttribute): void {
    const array = attribute.array as Float32Array;
    array.set(this.positions);
    attribute.needsUpdate = true;
  }

  /* ------------------------------------------------------------------ *
   * 内部实现
   * ------------------------------------------------------------------ */

  private integrate(f: ClothForces): void {
    const p = this.positions;
    const prev = this.previous;
    const invMass = this.invMass;
    const dt2 = f.dt * f.dt;
    const damping = this.damping;

    for (let i = 0; i < this.count; i += 1) {
      const i3 = i * 3;
      if (invMass[i] === 0) {
        // 固定点：位置直接钉在目标上，速度归零
        prev[i3] = p[i3];
        prev[i3 + 1] = p[i3 + 1];
        prev[i3 + 2] = p[i3 + 2];
        continue;
      }

      const x = p[i3];
      const y = p[i3 + 1];
      const z = p[i3 + 2];

      let vx = (x - prev[i3]) * damping;
      let vy = (y - prev[i3 + 1]) * damping;
      let vz = (z - prev[i3 + 2]) * damping;

      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (speed > MAX_STEP) {
        const s = MAX_STEP / speed;
        vx *= s;
        vy *= s;
        vz *= s;
      }

      // 湍流：用几个正弦叠加出随时间流动的小涡流
      const turb =
        f.turbulence *
        (Math.sin(x * 3.1 + f.time * 1.7) * Math.cos(z * 2.3 - f.time * 1.1) +
          Math.sin(y * 4.7 + f.time * 2.3) * 0.6);

      // 涟漪：沿布料向上流动的波
      const ripplePhase = y * 7.0 - f.time * 2.6;
      const rippleZ = Math.cos(ripplePhase) * f.ripple * 2.4;
      const rippleX = Math.sin(ripplePhase * 0.83 + 1.7) * f.ripple * 0.9;

      const ax = f.windX + turb + rippleX;
      const ay = f.gravity + f.windY + turb * 0.4;
      const az = f.windZ + turb * 1.1 + rippleZ;

      prev[i3] = x;
      prev[i3 + 1] = y;
      prev[i3 + 2] = z;

      p[i3] = x + vx + ax * dt2;
      p[i3 + 1] = y + vy + ay * dt2;
      p[i3 + 2] = z + vz + az * dt2;
    }
  }

  private solveConstraints(iteration: number): void {
    const p = this.positions;
    const ca = this.ca;
    const cb = this.cb;
    const crest = this.crest;
    const cstiff = this.cstiff;
    const invMass = this.invMass;
    const total = this.constraintCount;
    const reverse = (iteration & 1) === 1;

    for (let k = 0; k < total; k += 1) {
      const i = reverse ? total - 1 - k : k;
      const ia = ca[i];
      const ib = cb[i];
      const wa = invMass[ia];
      const wb = invMass[ib];
      const sum = wa + wb;
      if (sum === 0) continue;

      const a = ia * 3;
      const b = ib * 3;
      const dx = p[b] - p[a];
      const dy = p[b + 1] - p[a + 1];
      const dz = p[b + 2] - p[a + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < 1e-12) continue;
      const d = Math.sqrt(d2);
      const diff = ((d - crest[i]) / d) * cstiff[i];
      const fa = (wa / sum) * diff;
      const fb = (wb / sum) * diff;
      p[a] += dx * fa;
      p[a + 1] += dy * fa;
      p[a + 2] += dz * fa;
      p[b] -= dx * fb;
      p[b + 1] -= dy * fb;
      p[b + 2] -= dz * fb;
    }
  }

  /** 长程附着：质点到顶部固定点的直线距离不得超过材料长度。 */
  private applyLongRange(factor: number): void {
    const p = this.positions;
    const invMass = this.invMass;
    const cols = this.cols;
    const rows = this.rows;
    const rowHeight = this.materialHeight / Math.max(1, rows - 1);

    for (let r = 1; r < rows; r += 1) {
      const maxDist = rowHeight * r;
      for (let c = 0; c < cols; c += 1) {
        const i = r * cols + c;
        if (invMass[i] === 0) continue;
        const i3 = i * 3;
        const pin = c * 3;
        const dx = p[i3] - p[pin];
        const dy = p[i3 + 1] - p[pin + 1];
        const dz = p[i3 + 2] - p[pin + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d <= maxDist || d < 1e-9) continue;
        const k = ((d - maxDist) / d) * factor;
        p[i3] -= dx * k;
        p[i3 + 1] -= dy * k;
        p[i3 + 2] -= dz * k;
      }
    }
  }

  private collide(world: ClothWorld): void {
    const p = this.positions;
    const prev = this.previous;
    const invMass = this.invMass;
    const floor = world.groundY + 0.012;

    for (let i = 0; i < this.count; i += 1) {
      if (invMass[i] === 0) continue;
      const i3 = i * 3;

      if (p[i3 + 1] < floor) {
        p[i3 + 1] = floor;
        // 切向摩擦
        prev[i3] = p[i3] - (p[i3] - prev[i3]) * GROUND_FRICTION;
        prev[i3 + 2] = p[i3 + 2] - (p[i3 + 2] - prev[i3 + 2]) * GROUND_FRICTION;
      }

      if (p[i3 + 1] < world.poleTop && world.poleRadius > 0) {
        const dx = p[i3] - world.poleX;
        const dz = p[i3 + 2] - world.poleZ;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d < world.poleRadius && d > 1e-6) {
          const k = (world.poleRadius - d) / d;
          p[i3] += dx * k;
          p[i3 + 2] += dz * k;
          // 去掉朝内的速度
          prev[i3] = p[i3] - (p[i3] - prev[i3]) * 0.35;
          prev[i3 + 2] = p[i3 + 2] - (p[i3 + 2] - prev[i3 + 2]) * 0.35;
        }
      }
    }
  }

  /** 抓取修正：被抓住的一排质点跟随手部。 */
  private applyGrab(factor: number): void {
    if (!this.grabbing) return;
    const p = this.positions;
    const w = this.grabWeight;
    const off = this.grabOffset;
    const hx = this.hand.x;
    const hy = this.hand.y;
    const hz = this.hand.z;

    for (let i = 0; i < this.count; i += 1) {
      const weight = w[i];
      if (weight <= 0) continue;
      const i3 = i * 3;
      const k = weight * factor;
      p[i3] += (hx + off[i3] - p[i3]) * k;
      p[i3 + 1] += (hy + off[i3 + 1] - p[i3 + 1]) * k;
      p[i3 + 2] += (hz + off[i3 + 2] - p[i3 + 2]) * k;
    }
  }
}
