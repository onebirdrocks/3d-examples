import * as THREE from 'three';

/**
 * 粒子空间（Particle Space）
 * ---------------------------------------------------------------
 * 让粒子系统活在一套**独立于世界坐标**的局部空间里：
 *
 * 1. 粒子在自己的空间里生成、循环（wrap）、演化，坐标始终是「粒子空间坐标」；
 * 2. 整片粒子场通过一个 4x4 变换矩阵（旋转 / 缩放 / 位移）整体作用到世界上；
 * 3. 变换在顶点着色器里完成，因此旋转与呼吸缩放都是零 CPU 成本，
 *    在头显上也能保持稳定帧率。
 *
 * 典型用法（冥想场景）：
 *   const space = new ParticleSpace({ radius: 6, spin: 0.012 });
 *   const points = createWrappedPointField(space, 2400);
 *   attachParticleSpace(points.material, space);
 *   // 每帧：space.update(delta); space.breathe = 呼吸相位;
 *
 * 自定义 ShaderMaterial 请直接使用 PARTICLE_SPACE_GLSL 片段。
 */

export interface ParticleSpaceOptions {
  /** 粒子场半径（米），粒子在半径内的空间里循环。 */
  radius?: number;
  /** 初始缩放。 */
  scale?: number;
  /** 初始位置（世界坐标）。 */
  position?: THREE.Vector3 | [number, number, number];
  /** 绕 Y 轴的自转速度（rad/s）。 */
  spin?: number;
  /** 自转轴倾角（弧度），让旋转不完全水平。 */
  tilt?: number;
}

/** 供自定义着色器使用的 GLSL 片段（含 uniform 声明）。 */
export const PARTICLE_SPACE_GLSL = /* glsl */ `
uniform mat4 particleMatrix;
vec3 particleSpaceTransform( vec3 p ) {
  return ( particleMatrix * vec4( p, 1.0 ) ).xyz;
}
`;

export class ParticleSpace {
  /** 承载粒子的组节点；把它加到场景根节点下。 */
  readonly group = new THREE.Group();
  /** 粒子空间 → 世界空间的变换矩阵，直接注入着色器。 */
  readonly matrix = new THREE.Matrix4();
  /** 着色器 uniform。 */
  readonly uniform = { value: this.matrix };
  /** 粒子场半径。 */
  readonly radius: number;

  /** 呼吸缩放系数：1 为基准，可由外部在 0.8~1.2 之间平滑驱动。 */
  breathe = 1;
  /** 呼吸相位（0~1），供材质做亮度等联动。 */
  breathPhase = 0;

  private readonly baseScale: number;
  private readonly position = new THREE.Vector3();
  private readonly euler = new THREE.Euler();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scaleVector = new THREE.Vector3();
  private readonly drift = new THREE.Vector3();
  private spin: number;
  private readonly tilt: number;
  private driftSpeed = new THREE.Vector3(0, 0.004, 0);

  constructor(options: ParticleSpaceOptions = {}) {
    this.radius = options.radius ?? 5;
    this.baseScale = options.scale ?? 1;
    this.spin = options.spin ?? 0.01;
    this.tilt = options.tilt ?? 0;

    if (options.position) {
      if (Array.isArray(options.position)) {
        this.position.set(options.position[0], options.position[1], options.position[2]);
      } else {
        this.position.copy(options.position);
      }
    }

    this.group.name = 'particle-space';
    this.group.position.copy(this.position);
    this.updateMatrix();
  }

  /** 每帧推进自转与漂移，并重新合成变换矩阵。 */
  update(delta: number, elapsed: number): void {
    this.euler.set(this.tilt, this.spin * elapsed, this.tilt * 0.35);
    this.quaternion.setFromEuler(this.euler);

    // 极缓慢的整体漂移，避免整片粒子场看起来「钉死」在原地
    this.drift.set(
      Math.sin(elapsed * 0.07) * 0.12,
      Math.sin(elapsed * 0.05) * 0.06,
      Math.cos(elapsed * 0.06) * 0.12,
    );
    this.driftSpeed.multiplyScalar(1);
    this.position.addScaledVector(this.driftSpeed, delta * 0.35);

    this.updateMatrix();
  }

  /** 手动平移（用于跟随呼吸或交互）。 */
  offset(x: number, y: number, z: number): void {
    this.position.add(new THREE.Vector3(x, y, z));
    this.group.position.copy(this.position);
    this.updateMatrix();
  }

  private updateMatrix(): void {
    const s = this.baseScale * this.breathe;
    this.scaleVector.set(s, s, s);
    this.matrix.compose(this.position, this.quaternion, this.scaleVector);
  }
}

/**
 * 把粒子空间矩阵注入到使用标准顶点管线的材质里。
 * 对 MeshStandardMaterial / PointsMaterial / MeshBasicMaterial 等直接可用。
 */
export function attachParticleSpace(material: THREE.Material, space: ParticleSpace): void {
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous?.(shader, renderer);
    shader.uniforms.particleMatrix = space.uniform;
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', `${PARTICLE_SPACE_GLSL}\nvoid main() {`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\n\ttransformed = particleSpaceTransform( transformed );`,
      );
  };
  material.customProgramCacheKey = () => 'particle-space-v1';
  material.needsUpdate = true;
}

/** 可复现的伪随机数发生器（mulberry32）。 */
export function createRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 生成一片「无限循环」的粒子场。
 *
 * 粒子在半径 `radius` 的立方体内生成（而非球体，避免中心密度过高），
 * 并在每帧被折回边界内，因此粒子场看起来永无边际、永不消失。
 */
export function createWrappedPointField(
  space: ParticleSpace,
  count: number,
  options: {
    /** 每颗粒子的尺寸。 */
    size?: number;
    /** 随机种子。 */
    seed?: number;
    /** 颜色（顶点色）。 */
    color?: THREE.Color;
    /** 透明度。 */
    opacity?: number;
    /** 是否写入颜色属性。 */
    vertexColors?: boolean;
    /** 是否启用尺寸衰减。 */
    sizeAttenuation?: boolean;
    /** 加性混合（发光尘埃用）。 */
    additive?: boolean;
  } = {},
): THREE.Points {
  const random = createRandom(options.seed ?? 20240711);
  const size = options.size ?? 0.035;
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const phases = new Float32Array(count);
  const colors = options.vertexColors ? new Float32Array(count * 3) : null;
  const half = space.radius;

  const color = options.color ?? new THREE.Color(0xffffff);

  for (let i = 0; i < count; i += 1) {
    positions[i * 3] = (random() * 2 - 1) * half;
    positions[i * 3 + 1] = (random() * 2 - 1) * half;
    positions[i * 3 + 2] = (random() * 2 - 1) * half;
    sizes[i] = size * (0.55 + random() * 0.9);
    phases[i] = random() * Math.PI * 2;
    if (colors) {
      const tint = 0.72 + random() * 0.28;
      colors[i * 3] = color.r * tint;
      colors[i * 3 + 1] = color.g * tint;
      colors[i * 3 + 2] = color.b * tint;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  if (colors) geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const material = new THREE.PointsMaterial({
    size,
    color: options.color ?? 0xffffff,
    transparent: true,
    opacity: options.opacity ?? 0.55,
    depthWrite: false,
    sizeAttenuation: options.sizeAttenuation ?? true,
    vertexColors: options.vertexColors ?? false,
    blending: options.additive === false ? THREE.NormalBlending : THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.name = 'particle-field';
  points.frustumCulled = false;
  attachParticleSpace(material, space);
  return points;
}

/**
 * 把超出边界的粒子折回，形成无缝循环的粒子场。
 * 每帧调用，delta 越大折回越快（可用于「流动」方向）。
 */
export function wrapParticleField(
  points: THREE.Points,
  radius: number,
  delta: number,
  speed = 0.12,
): void {
  const attribute = points.geometry.getAttribute('position') as THREE.BufferAttribute;
  const array = attribute.array as Float32Array;
  const half = radius * 2;
  const step = speed * delta;

  for (let i = 0; i < array.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      let v = array[i + axis] + step;
      // 折回 [-radius, radius)
      if (v >= radius) v -= half;
      else if (v < -radius) v += half;
      array[i + axis] = v;
    }
  }
  attribute.needsUpdate = true;
}
