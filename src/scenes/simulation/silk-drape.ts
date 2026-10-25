import * as THREE from 'three';
import type { PinchInfo, SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { disposeObject } from '../../core/loader.js';
import { Cloth } from './cloth.js';
import type { ClothForces, ClothWorld } from './cloth.js';

/**
 * 悬垂绸缎
 *
 * 一幅真丝从黄铜横杆上垂落：布料本体用 `cloth.ts` 的 Verlet / PBD 解算器，
 * 顶部两排质点钉在杆上，横向折叠约束把面料收成一道道竖直褶皱。
 *
 * 音乐驱动：
 * - `ctx.audio.bass` → 风力（`ClothForces.windX / windZ` + 湍流），低频起音时绸缎鼓起；
 * - `ctx.audio.pulse` → 涟漪（`ClothForces.ripple`），沿布面向上流动的细波；
 * - `ctx.audio.level` → 面料光泽（`MeshPhysicalMaterial.sheen`）与控制环的辉光。
 *
 * XR 捏合：场景里的黄铜控制环标记了 `userData.pinchable = true`，
 * 捏住后控制环与布料顶部的固定点一起跟随手部移动（「把绸缎拽起来 / 抖一抖」）。
 */

/** 横杆高度（米，场景根节点局部空间）。 */
const ROD_Y = 2.62;
/** 横杆的半长（米）。 */
const ROD_HALF = 2.72;
/** 左侧立柱的 x 坐标（米）。 */
const POLE_X = -1.95;
/** 立柱半径（米）。 */
const POLE_RADIUS = 0.05;
/** 布料解算的固定步长（秒）。 */
const FIXED_STEP = 1 / 60;
/** 单帧最多推进的物理步数，避免卡顿后「死亡螺旋」。 */
const MAX_SUBSTEPS = 3;
/** cloth.ts 里被钉住的顶部行数。 */
const PINNED_ROWS = 2;
/** 抓住时布料固定点跟随手部的最大速度（米/秒）。 */
const PIN_SPEED = 1.5;
/** 抓住时控制环跟随手部的最大速度（米/秒）。 */
const RING_SPEED = 2.4;

/** 一幅垂布的外观参数。 */
interface DrapeSpec {
  /** 横向质点数。 */
  cols: number;
  /** 纵向质点数。 */
  rows: number;
  /** 悬挂总宽（米）。 */
  width: number;
  /** 悬挂高度（米）。 */
  height: number;
  /** 褶皱周期（列数）。 */
  foldPeriod: number;
  /** 褶皱幅度（米）。 */
  foldAmplitude: number;
  /** 相对根节点的位置。 */
  offset: THREE.Vector3;
  /** 绕 Y 轴的旋转（弧度）。 */
  turn: number;
}

/** 主幅：宽 3.2 米的整幅丝帘。 */
const MAIN_DRAPE: DrapeSpec = {
  cols: 33,
  rows: 30,
  width: 3.2,
  height: 2.4,
  foldPeriod: 6,
  foldAmplitude: 0.18,
  offset: new THREE.Vector3(0, ROD_Y, 0),
  turn: 0,
};

/** 侧幅：更窄的一幅青蓝色丝，挂在横杆右侧，和主幅拉开一点距离。 */
const SIDE_DRAPE: DrapeSpec = {
  cols: 15,
  rows: 22,
  width: 1.0,
  height: 2.05,
  foldPeriod: 5,
  foldAmplitude: 0.11,
  offset: new THREE.Vector3(2.18, ROD_Y, 0),
  turn: -0.12,
};

/**
 * 打开自由质点的解算。
 *
 * `cloth.ts` 的构造函数把 `invMass` 整块初始化为 0，而 0 的含义是「固定点」，
 * 于是所有质点都会被钉死、解算器完全不动。这里在场景侧补上自由质点的逆质量，
 * 再把顶部两排重新置 0（它们本来就该是固定的）。
 * 上游若已修正，这里就是幂等的空操作。
 */
function enableDynamicParticles(cloth: Cloth): void {
  cloth.invMass.fill(1);
  for (let r = 0; r < PINNED_ROWS; r += 1) {
    for (let c = 0; c < cloth.cols; c += 1) {
      cloth.invMass[r * cloth.cols + c] = 0;
    }
  }
}

/** 为布料建立与解算器拓扑一致的网格：顶点顺序 = 质点顺序（行 0 在顶端）。 */
function createDrapeGeometry(cols: number, rows: number): THREE.BufferGeometry {
  const count = cols * rows;
  const positions = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);

  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const i = r * cols + c;
      uvs[i * 2] = c / (cols - 1);
      uvs[i * 2 + 1] = 1 - r / (rows - 1);
    }
  }

  const indices = new Uint32Array((cols - 1) * (rows - 1) * 6);
  let k = 0;
  for (let r = 0; r < rows - 1; r += 1) {
    for (let c = 0; c < cols - 1; c += 1) {
      const a = r * cols + c;
      const b = r * cols + c + 1;
      const d = (r + 1) * cols + c;
      const e = (r + 1) * cols + c + 1;
      indices[k] = a;
      indices[k + 1] = d;
      indices[k + 2] = b;
      indices[k + 3] = b;
      indices[k + 4] = d;
      indices[k + 5] = e;
      k += 6;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  return geometry;
}

/** 一幅垂布：解算器 + 网格 + 材质。 */
interface Drape {
  readonly cloth: Cloth;
  readonly mesh: THREE.Mesh;
  readonly geometry: THREE.BufferGeometry;
  readonly position: THREE.BufferAttribute;
  readonly material: THREE.MeshPhysicalMaterial;
  readonly world: ClothWorld;
}

function createDrape(spec: DrapeSpec, material: THREE.MeshPhysicalMaterial): Drape {
  const cloth = new Cloth({
    cols: spec.cols,
    rows: spec.rows,
    width: spec.width,
    height: spec.height,
    foldPeriod: spec.foldPeriod,
    foldAmplitude: spec.foldAmplitude,
    stiffness: 0.9,
    foldStiffness: 0.12,
    iterations: 6,
    damping: 0.985,
  });
  enableDynamicParticles(cloth);

  const geometry = createDrapeGeometry(spec.cols, spec.rows);
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  cloth.writeTo(position);

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'silk-drape';
  mesh.position.copy(spec.offset);
  mesh.rotation.y = spec.turn;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;

  // 布料的局部空间 = 根节点空间平移了 mesh.position，碰撞体按同样规则换算。
  const world: ClothWorld = {
    groundY: -spec.offset.y,
    poleX: POLE_X - spec.offset.x,
    poleZ: -spec.offset.z,
    poleRadius: POLE_RADIUS,
    poleTop: ROD_Y - spec.offset.y,
  };

  return { cloth, mesh, geometry, position, material, world };
}

function createSilkDrape(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'silk-drape-scene';

  const camera = new THREE.PerspectiveCamera(52, 1, 0.05, 60);
  camera.position.set(0, 1.55, 4.4);
  camera.lookAt(0, 1.45, 0);

  // ── 面料材质：真丝的高光泽 + 珠光 ───────────────────────────────────────
  const silkMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x3a1c46,
    roughness: 0.38,
    metalness: 0.0,
    sheen: 0.8,
    sheenRoughness: 0.26,
    sheenColor: new THREE.Color(0xffd2a8),
    iridescence: 0.42,
    iridescenceIOR: 1.6,
    iridescenceThicknessRange: [140, 460],
    clearcoat: 0.25,
    clearcoatRoughness: 0.45,
    side: THREE.DoubleSide,
  });
  silkMaterial.envMap = ctx.env.envMap;
  silkMaterial.envMapIntensity = 1.15;

  const sideMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x123a4a,
    roughness: 0.44,
    metalness: 0.0,
    sheen: 0.7,
    sheenRoughness: 0.3,
    sheenColor: new THREE.Color(0xa8e6ff),
    iridescence: 0.3,
    iridescenceIOR: 1.5,
    iridescenceThicknessRange: [120, 380],
    side: THREE.DoubleSide,
  });
  sideMaterial.envMap = ctx.env.envMap;
  sideMaterial.envMapIntensity = 1.0;

  // ── 布面 ────────────────────────────────────────────────────────────────
  const main = createDrape(MAIN_DRAPE, silkMaterial);
  const side = createDrape(SIDE_DRAPE, sideMaterial);
  root.add(main.mesh, side.mesh);

  // ── 黄铜横杆与立柱 ──────────────────────────────────────────────────────
  const brassMaterial = new THREE.MeshStandardMaterial({
    color: 0xb98a45,
    metalness: 1.0,
    roughness: 0.29,
    envMap: ctx.env.envMap,
    envMapIntensity: 1.2,
  });

  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, ROD_HALF * 2, 20), brassMaterial);
  rod.name = 'silk-rod';
  rod.position.set(0, ROD_Y, 0);
  rod.rotation.z = Math.PI / 2;
  rod.castShadow = true;
  root.add(rod);

  const post = new THREE.Mesh(new THREE.CylinderGeometry(POLE_RADIUS, POLE_RADIUS * 1.25, ROD_Y, 18), brassMaterial);
  post.name = 'silk-post';
  post.position.set(POLE_X, ROD_Y / 2, 0);
  post.castShadow = true;
  root.add(post);

  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.24, 0.05, 24), brassMaterial);
  base.name = 'silk-base';
  base.position.set(POLE_X, 0.025, 0);
  base.castShadow = true;
  base.receiveShadow = true;
  root.add(base);

  const finial = new THREE.Mesh(new THREE.SphereGeometry(0.055, 20, 14), brassMaterial);
  finial.name = 'silk-finial';
  finial.position.set(ROD_HALF, ROD_Y, 0);
  finial.castShadow = true;
  root.add(finial);

  // ── 可抓取的控制环（VR 捏合目标） ───────────────────────────────────────
  const ringMaterial = new THREE.MeshStandardMaterial({
    color: 0xd8a24e,
    metalness: 1.0,
    roughness: 0.22,
    emissive: new THREE.Color(0x2a1405),
    emissiveIntensity: 0.6,
    envMap: ctx.env.envMap,
    envMapIntensity: 1.3,
  });

  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.085, 0.015, 12, 32), ringMaterial);
  ring.name = 'silk-control-ring';
  ring.position.set(0.45, 1.1, 0.42);
  ring.castShadow = true;
  ring.userData.pinchable = true;
  root.add(ring);

  // 吊环的细绳：从横杆垂到控制环。
  const cordMaterial = new THREE.MeshStandardMaterial({ color: 0x241c14, roughness: 0.85, metalness: 0.05 });
  const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 1, 6, 1, true), cordMaterial);
  cord.name = 'silk-cord';
  root.add(cord);

  const ringLight = new THREE.PointLight(0xffb066, 0.6, 3.2, 2);
  ringLight.name = 'silk-ring-light';
  ringLight.position.copy(ring.position);
  root.add(ringLight);

  // ── 灯光与地面 ──────────────────────────────────────────────────────────
  const lights = ctx.env.createStudioLights();
  lights.traverse((child) => {
    if (child instanceof THREE.Light) child.intensity *= 0.85;
  });
  root.add(lights);

  const ground = ctx.env.createGround(18);
  root.add(ground);

  // ── 运行期状态 ──────────────────────────────────────────────────────────
  const forces: ClothForces = {
    dt: FIXED_STEP,
    time: 0,
    gravity: -9.8,
    windX: 0,
    windY: 0,
    windZ: 0,
    turbulence: 0.2,
    ripple: 0,
  };

  const ringRest = ring.position.clone();
  const cordAnchor = new THREE.Vector3(ringRest.x, ROD_Y, 0);

  // 抓取态的临时量：全部预分配，update 里不再新建对象。
  const grabStartHand = new THREE.Vector3();
  const grabStartRing = new THREE.Vector3();
  /** 手部相对抓取起点的位移（目标值）。 */
  const grabWant = new THREE.Vector3();
  /** 已经施加到布料固定点上的位移。 */
  const grabApplied = new THREE.Vector3();
  /** 控制环在布料局部空间中的位置（抓取中心）。 */
  const ringLocal = new THREE.Vector3();
  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();
  const tmpC = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  let grabbing = false;
  let accumulator = 0;
  let smoothedBass = 0;
  let smoothedLevel = 0;

  /**
   * 把布料顶部的固定点整排平移（抓住时的「拽起来」）。
   * 两排固定点用同一个增量，避免顶部被拉出永久性的拉伸——
   * 那会让解算器的长程约束每帧都在打架，把布料弹飞。
   */
  const movePinnedRows = (cloth: Cloth, dx: number, dy: number, dz: number): void => {
    const cols = cloth.cols;
    const positions = cloth.positions;
    for (let r = 0; r < PINNED_ROWS; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const i3 = (r * cols + c) * 3;
        positions[i3] += dx;
        positions[i3 + 1] += dy;
        positions[i3 + 2] += dz;
      }
    }
  };

  /** 把位移向量限制在给定长度内（限速用）。 */
  const limitLength = (v: THREE.Vector3, maxLength: number): void => {
    const len = v.length();
    if (len > maxLength && len > 1e-6) v.multiplyScalar(maxLength / len);
  };

  /** 让控制环在没有被抓住时也随音乐轻轻摇晃。 */
  const updateCord = (): void => {
    tmpA.copy(cordAnchor);
    tmpB.copy(ring.position);
    tmpC.subVectors(tmpB, tmpA);
    const length = tmpC.length();
    if (length < 1e-4) return;
    tmpC.multiplyScalar(1 / length);
    cord.position.copy(tmpA).addScaledVector(tmpC, length * 0.5);
    cord.scale.set(1, length, 1);
    cord.quaternion.setFromUnitVectors(up, tmpC);
  };

  updateCord();

  return {
    root,
    camera,
    framing: { distance: 5.2, height: 1.55, targetY: 1.45, width: 4.9 },

    update(time: number, delta: number, context: SceneContext): void {
      const audio = context.audio;
      smoothedBass += (audio.bass - smoothedBass) * Math.min(1, delta * 8);
      smoothedLevel += (audio.level - smoothedLevel) * Math.min(1, delta * 6);

      // ── 音乐 → 外力 ────────────────────────────────────────────────────
      forces.windX = smoothedBass * 4.2;
      forces.windZ = smoothedBass * 2.6 + Math.sin(time * 0.53) * 0.9;
      forces.windY = Math.sin(time * 0.31) * 0.25;
      forces.turbulence = 0.18 + smoothedBass * 0.55;
      forces.ripple = audio.pulse * 0.55;

      // ── 固定步长推进布料 ───────────────────────────────────────────────
      accumulator += Math.min(delta, 0.05);
      let steps = 0;
      while (accumulator >= FIXED_STEP && steps < MAX_SUBSTEPS) {
        accumulator -= FIXED_STEP;
        steps += 1;
        forces.time += FIXED_STEP;
        main.cloth.step(forces, main.world);
        side.cloth.step(forces, side.world);
      }

      // ── 位置 → 网格 ────────────────────────────────────────────────────
      main.cloth.writeTo(main.position);
      side.cloth.writeTo(side.position);
      main.geometry.computeVertexNormals();
      side.geometry.computeVertexNormals();

      // ── 音乐 → 面料与控制环 ────────────────────────────────────────────
      silkMaterial.sheen = 0.55 + smoothedLevel * 0.85;
      silkMaterial.iridescence = 0.28 + audio.pulse * 0.35;
      sideMaterial.sheen = 0.45 + smoothedLevel * 0.6;
      ringMaterial.emissiveIntensity = 0.45 + audio.pulse * 1.5;
      ringLight.intensity = 0.35 + smoothedBass * 1.5;

      // ── 抓取态：控制环与布料固定点一起跟手走（限速，避免把布料拽爆）──
      if (grabbing) {
        tmpA.subVectors(grabWant, grabApplied);
        limitLength(tmpA, PIN_SPEED * Math.max(delta, 1e-3));
        grabApplied.add(tmpA);
        movePinnedRows(main.cloth, tmpA.x, tmpA.y, tmpA.z);

        // 控制环：跟着手，但有重量感（限速）
        tmpB.copy(grabStartRing).add(grabWant).sub(ring.position);
        limitLength(tmpB, RING_SPEED * Math.max(delta, 1e-3));
        ring.position.add(tmpB);
        ringLight.position.copy(ring.position);

        // 被抓住的一小片布跟着控制环走（布料局部空间）
        tmpC.copy(ringLocal).add(grabApplied);
        main.cloth.moveGrab(tmpC);
        updateCord();
      } else {
        // 未被抓住时，控制环做一点呼吸般的摆动
        ring.position.set(
          ringRest.x + Math.sin(time * 0.62) * 0.03,
          ringRest.y + Math.sin(time * 0.44) * 0.022,
          ringRest.z + Math.cos(time * 0.51) * 0.02,
        );
        ringLight.position.copy(ring.position);
        updateCord();
      }
    },

    onPinch(info: PinchInfo): void {
      if (info.phase === 'start') {
        if (!info.hit) return;
        grabbing = true;
        grabStartHand.copy(info.hand);
        grabStartRing.copy(ring.position);
        grabWant.set(0, 0, 0);
        grabApplied.set(0, 0, 0);
        // 以控制环在布料局部空间中的位置为抓取中心（与手部坐标系无关）
        main.mesh.updateWorldMatrix(true, false);
        ringLocal.copy(ring.position);
        main.mesh.worldToLocal(ringLocal);
        main.cloth.beginGrab(ringLocal, Math.min(1, Math.max(0.25, info.strength)));
        return;
      }

      if (info.phase === 'move') {
        if (!grabbing) return;
        // 用位移而不是绝对坐标驱动，手部坐标系（根节点局部 / 世界）都能工作
        grabWant.subVectors(info.hand, grabStartHand);
        // 限制活动范围，避免把布料拖到解算器够不着的地方
        grabWant.x = THREE.MathUtils.clamp(grabWant.x, -1.4, 1.4);
        grabWant.y = THREE.MathUtils.clamp(grabWant.y, -1.2, 1.6);
        grabWant.z = THREE.MathUtils.clamp(grabWant.z, -0.8, 0.8);
        return;
      }

      if (info.phase === 'end') {
        if (!grabbing) return;
        grabbing = false;
        main.cloth.endGrab();
        // 松手后控制环停在原地，继续做轻微的呼吸摆动
        ringRest.copy(ring.position);
      }
    },

    dispose(): void {
      disposeObject(root);
    },
  };
}

export const silkDrapeScene: SceneDefinition = {
  id: 'silk-drape',
  title: '悬垂绸缎',
  subtitle: 'Silk Drape',
  description: '一整幅真丝自黄铜横杆垂落，低频让它鼓起、脉冲让它泛起细波，伸手就能把它拽起来。',
  tags: ['布料', '模拟', '丝绸', '可交互'],
  accent: '#d9a6ff',
  gradient: ['#3a1c46', '#0b1424'],
  category: 'simulation',
  audio: 'zen-stones.mp3',
  breathing: { inhale: 4, hold: 4, exhale: 6 },
  create(ctx: SceneContext): SceneInstance {
    return createSilkDrape(ctx);
  },
};

export default silkDrapeScene;
