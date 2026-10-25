/**
 * 冥想场景共用的图形辅助。
 *
 * 全部资源都是代码生成的（不依赖任何外部素材），并且刻意保持低开销：
 * - 漂浮颗粒统一走核心层的「粒子空间」机制（ParticleSpace），
 *   整片粒子场用一个 4x4 矩阵作用到世界，旋转与呼吸缩放都是零 CPU 成本；
 * - 渐变、砂砾、石面等贴图用一次性生成的 CanvasTexture；
 * - 背景穹顶用一个 ShaderMaterial，避免大面积纯黑。
 */
import * as THREE from 'three';
import { PARTICLE_SPACE_GLSL, createWrappedPointField } from '../../../core/particle-space.js';
import type { ParticleSpace } from '../../../core/particle-space.js';
import type { SceneContext } from '../../types.js';

/* ------------------------------------------------------------------ *
 * GLSL 片段
 * ------------------------------------------------------------------ */

/** 哈希函数。 */
export const GLSL_HASH = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
`;

/** 3D 值噪声与 fbm，用于缓慢流动的体积感。 */
export const GLSL_NOISE3 = /* glsl */ `
float vnoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i + vec3(0.0, 0.0, 0.0));
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
  float x00 = mix(n000, n100, u.x);
  float x10 = mix(n010, n110, u.x);
  float x01 = mix(n001, n101, u.x);
  float x11 = mix(n011, n111, u.x);
  float y0 = mix(x00, x10, u.y);
  float y1 = mix(x01, x11, u.y);
  return mix(y0, y1, u.z);
}

float fbm3(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 3; i++) {
    sum += amp * vnoise3(p);
    p *= 2.07;
    amp *= 0.5;
  }
  return sum;
}
`;

/** 2D 值噪声与 fbm，用于雾面、凝结等细节。 */
export const GLSL_NOISE2 = /* glsl */ `
float vnoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm2(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 3; i++) {
    sum += amp * vnoise2(p);
    p *= 2.07;
    amp *= 0.5;
  }
  return sum;
}
`;

/** 抖动：给暗部渐变加一点噪声，避免出现色带。 */
export const GLSL_DITHER = /* glsl */ `
float dither(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453123);
}
`;

/**
 * 统一的色调映射与色彩空间处理。
 *
 * 注意：three r186 会把所有 ShaderMaterial 转成 GLSL ES 3.00，
 * `<tonemapping_fragment>` / `<colorspace_fragment>` 这两个 chunk 只能出现在
 * `main()` 内部（它们是赋值语句）。因此这里拆成两份：
 * - GLSL_OUTPUT_FUNCS 放在 main() 之前的全局作用域，负责定义收尾函数；
 * - GLSL_OUTPUT 放在 main() 内、gl_FragColor 赋值之后，负责调用它。
 */
export const GLSL_OUTPUT_FUNCS = /* glsl */ `
vec4 finalizeOutput( vec4 c ) {
  #if defined( TONE_MAPPING )
    c.rgb = toneMapping( c.rgb );
  #endif
  return linearToOutputTexel( c );
}
`;

/** 放在 main() 内、gl_FragColor 赋值之后。 */
export const GLSL_OUTPUT = /* glsl */ `
  gl_FragColor = finalizeOutput( gl_FragColor );
`;

/* ------------------------------------------------------------------ *
 * CPU 侧噪声
 * ------------------------------------------------------------------ */

function hash3(x: number, y: number, z: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453123;
  return s - Math.floor(s);
}

/** 3D 值噪声，返回 0~1。 */
export function valueNoise3(x: number, y: number, z: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);

  const c000 = hash3(ix, iy, iz);
  const c100 = hash3(ix + 1, iy, iz);
  const c010 = hash3(ix, iy + 1, iz);
  const c110 = hash3(ix + 1, iy + 1, iz);
  const c001 = hash3(ix, iy, iz + 1);
  const c101 = hash3(ix + 1, iy, iz + 1);
  const c011 = hash3(ix, iy + 1, iz + 1);
  const c111 = hash3(ix + 1, iy + 1, iz + 1);

  const x00 = c000 + (c100 - c000) * ux;
  const x10 = c010 + (c110 - c010) * ux;
  const x01 = c001 + (c101 - c001) * ux;
  const x11 = c011 + (c111 - c011) * ux;
  const y0 = x00 + (x10 - x00) * uy;
  const y1 = x01 + (x11 - x01) * uy;
  return y0 + (y1 - y0) * uz;
}

/** 3D 分形噪声，返回 0~1。 */
export function fbm3D(x: number, y: number, z: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise3(x * f, y * f, z * f);
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return sum / norm;
}

/* ------------------------------------------------------------------ *
 * 可平铺的 2D 噪声（用于砂砾与石面贴图）
 * ------------------------------------------------------------------ */

function tileHash(x: number, y: number, period: number): number {
  const xi = ((x % period) + period) % period;
  const yi = ((y % period) + period) % period;
  const s = Math.sin(xi * 127.1 + yi * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

function tileNoise(x: number, y: number, period: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = tileHash(ix, iy, period);
  const b = tileHash(ix + 1, iy, period);
  const c = tileHash(ix, iy + 1, period);
  const d = tileHash(ix + 1, iy + 1, period);
  const top = a + (b - a) * ux;
  const bottom = c + (d - c) * ux;
  return top + (bottom - top) * uy;
}

function tileFbm(x: number, y: number, basePeriod: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * tileNoise(x * freq, y * freq, basePeriod * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/* ------------------------------------------------------------------ *
 * 贴图
 * ------------------------------------------------------------------ */

function createCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');
  return { canvas, ctx };
}

/** 柔和的径向光斑（中心实、边缘归零）。 */
export function createRadialGlowTexture(size = 128, falloff = 2.2): THREE.CanvasTexture {
  const { canvas, ctx } = createCanvas(size);
  const image = ctx.createImageData(size, size);
  const half = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - half) / half;
      const dy = (y + 0.5 - half) / half;
      const d = Math.min(1, Math.sqrt(dx * dx + dy * dy));
      const alpha = Math.pow(1 - d, falloff);
      const i = (y * size + x) * 4;
      image.data[i] = 255;
      image.data[i + 1] = 255;
      image.data[i + 2] = 255;
      image.data[i + 3] = Math.round(alpha * 255);
    }
  }
  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'radial-glow';
  texture.needsUpdate = true;
  return texture;
}

/** 径向渐隐遮罩：中心透明、边缘不透明，用来藏住大片地面的边界。 */
export function createRadialFadeTexture(size = 256): THREE.CanvasTexture {
  const { canvas, ctx } = createCanvas(size);
  const image = ctx.createImageData(size, size);
  const half = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - half) / half;
      const dy = (y + 0.5 - half) / half;
      const d = Math.min(1, Math.sqrt(dx * dx + dy * dy));
      const alpha = Math.pow(THREE.MathUtils.smoothstep(d, 0.22, 0.82), 1.4);
      const i = (y * size + x) * 4;
      image.data[i] = 0;
      image.data[i + 1] = 0;
      image.data[i + 2] = 0;
      image.data[i + 3] = Math.round(alpha * 255);
    }
  }
  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'radial-fade';
  texture.needsUpdate = true;
  return texture;
}

/** 深色砂砾地面（可平铺）。 */
export function createGravelTexture(size = 512): THREE.CanvasTexture {
  const { canvas, ctx } = createCanvas(size);
  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const grain = tileFbm(u * 8, v * 8, 8, 4);
      const fine = tileNoise(u * 48, v * 48, 48);
      const speck = Math.pow(tileNoise(u * 96 + 13.3, v * 96 + 7.1, 96), 10);
      const value = 15 + grain * 13 + fine * 6 + speck * 46;
      const i = (y * size + x) * 4;
      image.data[i] = Math.round(value);
      image.data[i + 1] = Math.round(value * 1.02);
      image.data[i + 2] = Math.round(value * 1.09);
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'gravel';
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

/** 石头表面：斑驳的灰底 + 极淡的苔痕与水渍（可平铺）。 */
export function createStoneTexture(
  size = 256,
  options: { base?: [number, number, number]; moss?: [number, number, number] } = {},
): THREE.CanvasTexture {
  const base = options.base ?? [92, 94, 98];
  const moss = options.moss ?? [118, 132, 110];
  const { canvas, ctx } = createCanvas(size);
  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const mottle = tileFbm(u * 4, v * 4, 4, 4);
      const micro = tileFbm(u * 16, v * 16, 16, 3);
      const mossMask = THREE.MathUtils.smoothstep(tileFbm(u * 6 + 3.3, v * 6 + 1.7, 6, 3), 0.56, 0.8);
      const stainMask = THREE.MathUtils.smoothstep(tileFbm(u * 3 + 9.1, v * 3 + 4.4, 3, 3), 0.62, 0.86);
      const shade = (0.66 + mottle * 0.52) * (0.9 + micro * 0.2) * (1 - stainMask * 0.22);
      const i = (y * size + x) * 4;
      const r = base[0] * shade;
      const g = base[1] * shade;
      const b = base[2] * shade;
      image.data[i] = Math.round(THREE.MathUtils.lerp(r, moss[0], mossMask * 0.42));
      image.data[i + 1] = Math.round(THREE.MathUtils.lerp(g, moss[1], mossMask * 0.42));
      image.data[i + 2] = Math.round(THREE.MathUtils.lerp(b, moss[2], mossMask * 0.42));
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'stone';
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

/* ------------------------------------------------------------------ *
 * 背景穹顶
 * ------------------------------------------------------------------ */

export interface BackdropDome {
  mesh: THREE.Mesh;
  uniforms: {
    uTime: { value: number };
    uBreath: { value: number };
    uZenith: { value: THREE.Color };
    uHorizon: { value: THREE.Color };
    uGround: { value: THREE.Color };
  };
}

const DOME_VERT = /* glsl */ `
varying vec3 vDir;

void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const DOME_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform float uTime;
uniform float uBreath;

varying vec3 vDir;

${GLSL_DITHER}
${GLSL_OUTPUT_FUNCS}

void main() {
  float y = vDir.y;
  vec3 col = mix(uHorizon, uZenith, smoothstep(-0.04, 0.62, y));
  col = mix(col, uGround, smoothstep(0.0, -0.32, y));

  // 地平线附近一层极淡的雾光，随呼吸缓慢明灭
  float band = exp(-abs(y) * 8.0);
  col += uHorizon * band * (0.09 + 0.05 * uBreath);
  col += (dither(gl_FragCoord.xy) - 0.5) * 0.006;

  gl_FragColor = vec4(col, 1.0);
  ${GLSL_OUTPUT}
}
`;

/** 一个缓慢呼吸的深色背景穹顶，避免出现大面积纯黑。 */
export function createBackdropDome(options: {
  zenith: number;
  horizon: number;
  ground: number;
  radius?: number;
}): BackdropDome {
  const uniforms = {
    uTime: { value: 0 },
    uBreath: { value: 0 },
    uZenith: { value: new THREE.Color(options.zenith) },
    uHorizon: { value: new THREE.Color(options.horizon) },
    uGround: { value: new THREE.Color(options.ground) },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: DOME_VERT,
    fragmentShader: DOME_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(options.radius ?? 120, 40, 24), material);
  mesh.name = 'backdrop';
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;
  return { mesh, uniforms };
}

/* ------------------------------------------------------------------ *
 * 粒子场（粒子空间）
 * ------------------------------------------------------------------ */

const PARTICLE_VERT = /* glsl */ `
attribute float aSize;
attribute float aPhase;

uniform float uTime;
uniform float uScale;
uniform float uOpacity;
uniform float uBreath;
uniform float uSizeMul;
uniform float uWander;

varying vec3 vTint;
varying float vAlpha;

${PARTICLE_SPACE_GLSL}

void main() {
  vec3 p = position;

  // 极缓慢的个体游动（周期 50 秒以上），在粒子空间里发生
  p.x += sin(uTime * 0.083 + aPhase) * uWander;
  p.y += sin(uTime * 0.061 + aPhase * 1.7) * uWander * 0.8;
  p.z += cos(uTime * 0.047 + aPhase * 2.3) * uWander;

  vec4 mv = modelViewMatrix * vec4(particleSpaceTransform(p), 1.0);
  gl_Position = projectionMatrix * mv;

  // 明暗只有 ±12% 的缓慢起伏，绝不出现闪烁
  float shimmer = 0.88 + 0.12 * sin(uTime * 0.13 + aPhase * 3.1);
  vAlpha = uOpacity * shimmer;
  vTint = color * (0.78 + 0.34 * uBreath);
  gl_PointSize = uSizeMul * aSize * (0.93 + 0.14 * uBreath) * uScale / max(1.0, -mv.z);
}
`;

const PARTICLE_FRAG = /* glsl */ `
precision highp float;

uniform float uOpacity;

varying vec3 vTint;
varying float vAlpha;

${GLSL_OUTPUT_FUNCS}

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot(c, c);
  if (d2 > 0.25) discard;
  float falloff = exp(-d2 * 13.0);
  float alpha = falloff * vAlpha * uOpacity;
  if (alpha < 0.003) discard;
  gl_FragColor = vec4(vTint, alpha);
  ${GLSL_OUTPUT}
}
`;

export interface SoftParticleField {
  points: THREE.Points;
  material: THREE.ShaderMaterial;
  uniforms: {
    uTime: { value: number };
    uScale: { value: number };
    uOpacity: { value: number };
    uBreath: { value: number };
  };
}

export interface SoftParticleOptions {
  /** 每颗粒子的尺寸（米）。 */
  size?: number;
  color?: THREE.Color;
  opacity?: number;
  seed?: number;
  /** 个体游动幅度（米）。 */
  wander?: number;
}

/**
 * 在粒子空间里生成一片柔和的漂浮颗粒。
 *
 * 几何数据来自核心层的 createWrappedPointField（自带循环所需的属性），
 * 这里只把默认的 PointsMaterial 换成自定义着色器，好处是：
 * - 圆形的柔边光点，而不是方块；
 * - 亮度与尺寸跟呼吸相位联动；
 * - 顶点位置走 particleMatrix，旋转 / 缩放全部由核心的粒子空间驱动。
 */
export function createSoftParticleField(
  space: ParticleSpace,
  count: number,
  options: SoftParticleOptions = {},
): SoftParticleField {
  const color = options.color ?? new THREE.Color(0xe8e4dc);
  const points = createWrappedPointField(space, count, {
    size: options.size ?? 0.035,
    color,
    opacity: options.opacity ?? 0.5,
    seed: options.seed ?? 20240711,
    vertexColors: true,
    additive: true,
  });

  const generated = points.material as THREE.PointsMaterial;
  const uniforms = {
    uTime: { value: 0 },
    uScale: { value: 600 },
    uOpacity: { value: 1 },
    uBreath: { value: 0 },
    uSizeMul: { value: 1 },
    uWander: { value: options.wander ?? 0.06 },
    particleMatrix: space.uniform,
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: PARTICLE_VERT,
    fragmentShader: PARTICLE_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexColors: true,
  });
  points.material = material;
  generated.dispose();

  return {
    points,
    material,
    uniforms: {
      uTime: uniforms.uTime,
      uScale: uniforms.uScale,
      uOpacity: uniforms.uOpacity,
      uBreath: uniforms.uBreath,
    },
  };
}

/** 依据视口尺寸与视场角更新颗粒的屏幕尺寸（米 → 像素）。 */
export function updateParticleScale(uniforms: { uScale: { value: number } }, ctx: SceneContext, fovDeg: number): void {
  const halfFov = THREE.MathUtils.degToRad(fovDeg) * 0.5;
  uniforms.uScale.value = (ctx.height * 0.5 * ctx.renderer.getPixelRatio()) / Math.tan(halfFov);
}

/* ------------------------------------------------------------------ *
 * 灯光
 * ------------------------------------------------------------------ */

/**
 * 把核心给的三点布光调暗并去掉阴影，
 * 冥想场景只需要一点极弱的环境底光。
 */
export function dimStudioLights(lights: THREE.Object3D, factor: number, tint?: number): void {
  lights.traverse((child) => {
    if (child instanceof THREE.Light) {
      child.intensity *= factor;
      child.castShadow = false;
      if (tint !== undefined) child.color.setHex(tint);
    }
  });
}

/** 释放网格上原有的材质（换成自定义材质前调用）。 */
export function disposeMeshMaterial(mesh: THREE.Mesh): void {
  const material = mesh.material;
  if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
  else material.dispose();
}
