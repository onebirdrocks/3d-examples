/**
 * 助眠场景共用的粒子场工具。
 *
 * 所有漂浮粒子都跑在核心层的「粒子空间」（ParticleSpace）里：
 * 粒子在自己的空间里生成与演化，整片场再用一个 4x4 矩阵作用到世界上，
 * 旋转与呼吸缩放都在顶点着色器里完成，CPU 每帧几乎不做事。
 *
 * 这里在核心之上再包一层：
 * - `createPointGeometry`：生成带逐粒子属性的点云几何；
 * - `createPointMaterial`：拼装自定义 ShaderMaterial，并自动注入粒子空间矩阵；
 * - `updatePointScale`：按视口与视场角把「米」换算成屏幕像素。
 */
import * as THREE from 'three';
import { PARTICLE_SPACE_GLSL, createRandom } from '../../core/particle-space.js';
import type { ParticleSpace } from '../../core/particle-space.js';
import type { SceneContext } from '../types.js';

/**
 * uniform 的最小结构。
 * `@types/three` 没有从根导出 `IUniform`，所以这里自己声明一份。
 */
export interface UniformValue<T = unknown> {
  value: T;
}

/** uniform 集合。 */
export type UniformMap = Record<string, UniformValue>;

/** 逐粒子随机属性的声明。 */
export interface PointAttributeSpec {
  /** 属性名（着色器里用 attribute <name> 声明）。 */
  name: string;
  /** 分量数。 */
  size: number;
  /** 随机下界。 */
  min: number;
  /** 随机上界。 */
  max: number;
}

export interface PointGeometryOptions {
  /** 粒子数量。 */
  count: number;
  /** 随机种子。 */
  seed?: number;
  /** 位置分布半径（立方体半边长，米）。 */
  radius?: number;
  /** 基础点尺寸（米）。 */
  size?: number;
  /** 额外的逐粒子随机属性。 */
  attributes?: PointAttributeSpec[];
}

/**
 * 生成一片点云几何。
 *
 * 内建属性：
 * - `position`：粒子空间里的初始位置（半径内的立方体里均匀分布）；
 * - `aSize`：颗粒尺寸（米），带一点随机；
 * - `aPhase`：0~1 的随机相位，用来错开各自的游动与闪烁。
 */
export function createPointGeometry(options: PointGeometryOptions): THREE.BufferGeometry {
  const random = createRandom(options.seed ?? 20240711);
  const count = Math.max(1, Math.floor(options.count));
  const radius = options.radius ?? 5;
  const size = options.size ?? 0.035;

  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const phases = new Float32Array(count);
  const extras = (options.attributes ?? []).map((spec) => ({
    spec,
    data: new Float32Array(count * spec.size),
  }));

  for (let i = 0; i < count; i += 1) {
    positions[i * 3] = (random() * 2 - 1) * radius;
    positions[i * 3 + 1] = (random() * 2 - 1) * radius;
    positions[i * 3 + 2] = (random() * 2 - 1) * radius;
    sizes[i] = size * (0.55 + random() * 0.9);
    phases[i] = random();

    for (const extra of extras) {
      for (let c = 0; c < extra.spec.size; c += 1) {
        extra.data[i * extra.spec.size + c] =
          extra.spec.min + random() * (extra.spec.max - extra.spec.min);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  for (const extra of extras) {
    geometry.setAttribute(extra.spec.name, new THREE.BufferAttribute(extra.data, extra.spec.size));
  }
  return geometry;
}

export interface PointMaterialOptions {
  /** 顶点着色器（不要自己声明 particleMatrix，由本函数注入）。 */
  vertexShader: string;
  /** 片段着色器。 */
  fragmentShader: string;
  /** 额外 uniform。 */
  uniforms?: UniformMap;
  /** 是否使用加性混合。 */
  additive?: boolean;
  /** 是否写入深度。 */
  depthWrite?: boolean;
}

/**
 * 拼装一个跑在粒子空间里的 Points 材质。
 *
 * 顶点着色器里可以直接调用 `particleSpaceTransform( p )` 把粒子空间坐标搬到世界坐标。
 */
export function createPointMaterial(
  space: ParticleSpace,
  options: PointMaterialOptions,
): THREE.ShaderMaterial {
  const uniforms: UniformMap = {
    particleMatrix: space.uniform,
    ...(options.uniforms ?? {}),
  };

  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `${PARTICLE_SPACE_GLSL}\n${options.vertexShader}`,
    fragmentShader: options.fragmentShader,
    transparent: true,
    depthWrite: options.depthWrite ?? false,
    blending: options.additive === false ? THREE.NormalBlending : THREE.AdditiveBlending,
  });
}

/** 依据视口尺寸与视场角更新颗粒的屏幕尺寸（米 → 像素）。 */
export function updatePointScale(uniform: { value: number }, ctx: SceneContext, fovDeg: number): void {
  const halfFov = THREE.MathUtils.degToRad(fovDeg) * 0.5;
  uniform.value = (ctx.height * 0.5 * ctx.renderer.getPixelRatio()) / Math.tan(halfFov);
}
