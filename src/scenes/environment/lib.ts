/**
 * 真实环境场景（雨夜街道 / 林间溪流 / 海崖 / 旷野雪原 / 沙漠星夜）共用的辅助。
 *
 * 全部资源都由代码生成，不依赖任何外部素材：
 * - GLSL 片段：哈希、值噪声 / fbm，以及统一的收尾（色调映射 + 色彩空间）；
 * - AudioDriver：把 `ctx.audio` 的瞬时值抹平成稳定的驱动量（音乐驱动画面）；
 * - applyHaze：给标准材质注入距离雾，做出空气透视；
 * - createSkyDome：渐变天穹；
 * - createRainStreaks：粒子空间里的雨丝（线段，灯下更亮）。
 */
import * as THREE from 'three';
import { PARTICLE_SPACE_GLSL } from '../../core/particle-space.js';
import type { ParticleSpace } from '../../core/particle-space.js';
import type { SceneContext } from '../types.js';

/* ------------------------------------------------------------------ *
 * GLSL 片段
 * ------------------------------------------------------------------ */

/** 哈希函数（Dave Hoskins 风格）。 */
export const GLSL_HASH = /* glsl */ `
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

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

/** 2D 值噪声与 fbm。 */
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

float fbm2(vec2 p, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    sum += amp * vnoise2(p);
    p *= 2.07;
    amp *= 0.5;
  }
  return sum;
}
`;

/** 3D 值噪声与 fbm。 */
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

float fbm3(vec3 p, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    sum += amp * vnoise3(p);
    p *= 2.03;
    amp *= 0.5;
  }
  return sum;
}
`;

/**
 * 收尾函数：色调映射 + 色彩空间。
 *
 * 注意：three r186 会把所有 ShaderMaterial 转成 GLSL ES 3.00，
 * `<tonemapping_fragment>` / `<colorspace_fragment>` 是赋值语句，只能写在 main() 内部。
 * 因此这里拆成两份：全局作用域的函数定义 + main() 内的调用。
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

/** 粒子空间矩阵（核心层提供）。 */
export { PARTICLE_SPACE_GLSL };

/* ------------------------------------------------------------------ *
 * 音频驱动
 * ------------------------------------------------------------------ */

/**
 * 把 `ctx.audio` 的瞬时值抹平成稳定的驱动量。
 *
 * - pulse：主脉冲。音乐开启时跟随低频起音，未播放时回落到场景声明的呼吸节奏。
 *   这里再叠一层「快起慢落」的平滑，避免画面抖动。
 * - level / bass / mid / treble：响度与三个频段，分别用于亮度、雾、细节。
 */
export class AudioDriver {
  /** 主脉冲 0~1（已平滑）。 */
  pulse = 0;
  /** 整体响度 0~1。 */
  level = 0;
  /** 低频能量 0~1。 */
  bass = 0;
  /** 中频能量 0~1。 */
  mid = 0;
  /** 高频能量 0~1。 */
  treble = 0;

  update(ctx: SceneContext, delta: number): void {
    const audio = ctx.audio;
    const target = audio.pulse;
    // 快起慢落：起音迅速跟上，衰减缓慢回落
    const lambda = target > this.pulse ? 4.2 : 0.85;
    this.pulse = THREE.MathUtils.damp(this.pulse, target, lambda, delta);
    this.level = THREE.MathUtils.damp(this.level, audio.level, 1.1, delta);
    this.bass = THREE.MathUtils.damp(this.bass, audio.bass, 1.5, delta);
    this.mid = THREE.MathUtils.damp(this.mid, audio.mid, 1.0, delta);
    this.treble = THREE.MathUtils.damp(this.treble, audio.treble, 1.7, delta);
  }
}

/* ------------------------------------------------------------------ *
 * CPU 噪声
 * ------------------------------------------------------------------ */

function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** 2D 值噪声，返回 0~1。 */
export function valueNoise2D(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  const top = a + (b - a) * ux;
  const bottom = c + (d - c) * ux;
  return top + (bottom - top) * uy;
}

/** 2D 分形噪声，返回 0~1。 */
export function fbm2D(x: number, y: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let freq = 1;
  for (let i = 0; i < octaves; i += 1) {
    sum += amp * valueNoise2D(x * freq, y * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

/* ------------------------------------------------------------------ *
 * 空气透视
 * ------------------------------------------------------------------ */

export interface HazeOptions {
  /** 远处物体褪到的颜色。 */
  color: THREE.ColorRepresentation;
  /** 开始出现雾的距离（米）。 */
  near: number;
  /** 完全被雾覆盖的距离（米）。 */
  far: number;
  /** 雾的强度 0~1。 */
  strength?: number;
}

/**
 * 给标准材质注入一层距离雾。
 *
 * 用自己的 varying 计算视距深度，因此对 MeshStandardMaterial /
 * MeshBasicMaterial 都成立；雾色、强度可以直接被音频驱动（能见度）。
 */
export function applyHaze(material: THREE.Material, options: HazeOptions): void {
  const hazeColor = new THREE.Color(options.color);
  const strength = options.strength ?? 1;
  const previous = material.onBeforeCompile;

  material.onBeforeCompile = (shader, renderer) => {
    previous?.(shader, renderer);

    shader.uniforms.uHazeColor = { value: hazeColor };
    shader.uniforms.uHazeNear = { value: options.near };
    shader.uniforms.uHazeFar = { value: options.far };
    shader.uniforms.uHazeStrength = { value: strength };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vHazeDepth;')
      .replace('#include <project_vertex>', '#include <project_vertex>\n\tvHazeDepth = -mvPosition.z;');

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying float vHazeDepth;\nuniform vec3 uHazeColor;\nuniform float uHazeNear;\nuniform float uHazeFar;\nuniform float uHazeStrength;',
      )
      .replace(
        '#include <tonemapping_fragment>',
        `{
  float hazeMix = smoothstep( uHazeNear, uHazeFar, vHazeDepth ) * uHazeStrength;
  gl_FragColor.rgb = mix( gl_FragColor.rgb, uHazeColor, hazeMix );
}
#include <tonemapping_fragment>`,
      );
  };
  material.needsUpdate = true;
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

/** 柔和的径向光斑（中心实、边缘归零），用于灯光晕与霓虹辉光。 */
export function createGlowTexture(size = 128, falloff = 2.6): THREE.CanvasTexture {
  const { canvas, ctx } = createCanvas(size);
  const image = ctx.createImageData(size, size);
  const half = size / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x + 0.5 - half) / half;
      const dy = (y + 0.5 - half) / half;
      const d = Math.min(1, Math.hypot(dx, dy));
      const i = (y * size + x) * 4;
      image.data[i] = 255;
      image.data[i + 1] = 255;
      image.data[i + 2] = 255;
      image.data[i + 3] = Math.round(Math.pow(1 - d, falloff) * 255);
    }
  }
  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'glow';
  texture.needsUpdate = true;
  return texture;
}

/** 可平铺的灰度噪声（用来打散光斑、雾与反射的边界）。 */
export function createNoiseTexture(size = 256, seed = 1): THREE.CanvasTexture {
  const { canvas, ctx } = createCanvas(size);
  const image = ctx.createImageData(size, size);

  const hash = (x: number, y: number): number => {
    const s = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const noise = (x: number, y: number): number => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const a = hash(ix, iy);
    const b = hash(ix + 1, iy);
    const c = hash(ix, iy + 1);
    const d = hash(ix + 1, iy + 1);
    const top = a + (b - a) * ux;
    const bottom = c + (d - c) * ux;
    return top + (bottom - top) * uy;
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = (x / size) * 8;
      const v = (y / size) * 8;
      let sum = 0;
      let amp = 0.5;
      let freq = 1;
      let norm = 0;
      for (let o = 0; o < 4; o += 1) {
        sum += amp * noise(u * freq, v * freq);
        norm += amp;
        amp *= 0.5;
        freq *= 2;
      }
      const value = Math.round((sum / norm) * 255);
      const i = (y * size + x) * 4;
      image.data[i] = value;
      image.data[i + 1] = value;
      image.data[i + 2] = value;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'noise';
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

/* ------------------------------------------------------------------ *
 * 天穹
 * ------------------------------------------------------------------ */

export interface SkyDomeOptions {
  zenith: THREE.ColorRepresentation;
  horizon: THREE.ColorRepresentation;
  ground: THREE.ColorRepresentation;
  radius?: number;
  /** 地平线雾光颜色（海崖的雾白、沙漠的余光）。 */
  bandColor?: THREE.ColorRepresentation;
  /** 地平线雾光强度。 */
  bandStrength?: number;
  /** 雾光带中心高度（方向 y）。 */
  bandY?: number;
  /** 雾光带宽度。 */
  bandWidth?: number;
}

export interface SkyDome {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  uniforms: {
    uZenith: { value: THREE.Color };
    uHorizon: { value: THREE.Color };
    uGround: { value: THREE.Color };
    uBandColor: { value: THREE.Color };
    uBandStrength: { value: number };
    uBandY: { value: number };
    uBandWidth: { value: number };
    uTime: { value: number };
    uLevel: { value: number };
  };
}

const SKY_VERT = /* glsl */ `
varying vec3 vDir;

void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SKY_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uBandColor;
uniform float uBandStrength;
uniform float uBandY;
uniform float uBandWidth;
uniform float uTime;
uniform float uLevel;

varying vec3 vDir;

${GLSL_OUTPUT_FUNCS}

void main() {
  vec3 dir = normalize(vDir);
  float h = dir.y;

  vec3 col = mix(uHorizon, uZenith, smoothstep(-0.03, 0.68, h));
  col = mix(col, uGround, smoothstep(0.0, -0.22, h));

  // 地平线上的雾光带（远处的天光）
  float band = exp(-abs(h - uBandY) / max(uBandWidth, 0.001));
  col = mix(col, uBandColor, clamp(band * uBandStrength * (0.82 + 0.36 * uLevel), 0.0, 1.0));

  // 极缓慢的呼吸式明灭，避免天空死板
  col *= 0.97 + 0.05 * uLevel;

  gl_FragColor = vec4(col, 1.0);
  ${GLSL_OUTPUT}
}
`;

/** 一个渐变天穹：远处更淡更蓝，负责整体的天光基调。 */
export function createSkyDome(options: SkyDomeOptions): SkyDome {
  const uniforms = {
    uZenith: { value: new THREE.Color(options.zenith) },
    uHorizon: { value: new THREE.Color(options.horizon) },
    uGround: { value: new THREE.Color(options.ground) },
    uBandColor: { value: new THREE.Color(options.bandColor ?? options.horizon) },
    uBandStrength: { value: options.bandStrength ?? 0 },
    uBandY: { value: options.bandY ?? 0 },
    uBandWidth: { value: options.bandWidth ?? 0.08 },
    uTime: { value: 0 },
    uLevel: { value: 0 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(options.radius ?? 400, 40, 24), material);
  mesh.name = 'sky-dome';
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;

  return { mesh, material, uniforms };
}

/* ------------------------------------------------------------------ *
 * 雨丝
 * ------------------------------------------------------------------ */

export interface RainStreakOptions {
  /** 雨丝数量。 */
  count: number;
  /** 粒子空间半径（米）。 */
  radius: number;
  /** 雨丝下落的高度（米）。 */
  height?: number;
  /** 世界坐标下的灯位：雨丝在灯下更亮（最多 4 个）。 */
  lights?: THREE.Vector3[];
  color?: THREE.Color;
  seed?: number;
  /** 远处雨丝褪到的颜色（雾）。 */
  fogColor?: THREE.Color;
  /** 雾的起始距离。 */
  fogNear?: number;
  /** 雾的完全距离。 */
  fogFar?: number;
}

export interface RainStreakField {
  lines: THREE.LineSegments;
  material: THREE.ShaderMaterial;
  uniforms: {
    uTime: { value: number };
    uOpacity: { value: number };
    uLength: { value: number };
    uSpeed: { value: number };
    uIntensity: { value: number };
    uColor: { value: THREE.Color };
    uLightPos: { value: THREE.Vector3[] };
    uFogColor: { value: THREE.Color };
    uFogNear: { value: number };
    uFogFar: { value: number };
  };
}

const RAIN_VERT = /* glsl */ `
attribute float aTail;
attribute float aSpeed;
attribute float aPhase;

uniform float uTime;
uniform float uLength;
uniform float uSpeed;
uniform float uIntensity;
uniform float uHeight;
uniform vec3 uLightPos[4];

varying float vAlpha;
varying float vTail;

${PARTICLE_SPACE_GLSL}

void main() {
  vec3 p = position;

  // 下落：在粒子空间里循环，永远不会落到地面以下
  float fall = uTime * uSpeed * aSpeed;
  float y = mod( p.y - fall, uHeight );
  p.y = y - uHeight * 0.5;

  // 风带来的横向漂移
  p.x += sin( uTime * 0.22 + aPhase ) * 0.25;

  // 线段的尾端沿 y 方向拉长，形成细长雨丝
  p.y += aTail * uLength * ( 0.65 + 0.7 * uIntensity );

  vec3 world = particleSpaceTransform( p );
  vec4 mv = modelViewMatrix * vec4( world, 1.0 );
  gl_Position = projectionMatrix * mv;

  // 灯下的雨丝更亮
  float lit = 0.0;
  for ( int i = 0; i < 4; i++ ) {
    float d = distance( world, uLightPos[i] );
    lit += 1.0 / ( 1.0 + d * d * 0.5 );
  }
  vAlpha = ( 0.12 + 0.95 * lit ) * uIntensity;
  vTail = aTail;

  // 极远处的雨丝几乎看不见
  vAlpha *= 1.0 - smoothstep( 26.0, 46.0, length( world - cameraPosition ) );
}
`;

const RAIN_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uColor;
uniform float uOpacity;

varying float vAlpha;
varying float vTail;

${GLSL_OUTPUT_FUNCS}

void main() {
  float a = vAlpha * uOpacity * ( 1.0 - vTail * 0.9 );
  if ( a < 0.004 ) discard;
  // 加性混合：alpha 固定为 1，颜色直接按亮度给出
  gl_FragColor = vec4( uColor * a, 1.0 );
  ${GLSL_OUTPUT}
}
`;

/**
 * 一片雨丝。
 *
 * 每滴雨是线段的一个头尾两个顶点，下落、循环、随风漂移全部在顶点着色器里完成，
 * 位置仍然走核心层的粒子空间矩阵，因此整片雨可以整体旋转 / 缩放而没有 CPU 开销。
 */
export function createRainStreaks(
  space: ParticleSpace,
  options: RainStreakOptions,
): RainStreakField {
  const count = Math.max(1, Math.round(options.count));
  const radius = options.radius;
  const height = options.height ?? 14;
  const seed = options.seed ?? 4242;

  const positions = new Float32Array(count * 2 * 3);
  const tails = new Float32Array(count * 2);
  const speeds = new Float32Array(count * 2);
  const phases = new Float32Array(count * 2);

  let state = seed >>> 0;
  const random = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };

  for (let i = 0; i < count; i += 1) {
    const x = (random() * 2 - 1) * radius;
    const z = (random() * 2 - 1) * radius;
    const y = random() * height;
    const speed = 0.75 + random() * 0.6;
    const phase = random() * Math.PI * 2;

    for (let v = 0; v < 2; v += 1) {
      const index = i * 2 + v;
      positions[index * 3] = x;
      positions[index * 3 + 1] = y;
      positions[index * 3 + 2] = z;
      tails[index] = v;
      speeds[index] = speed;
      phases[index] = phase;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aTail', new THREE.BufferAttribute(tails, 1));
  geometry.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));

  const uniforms = {
    uTime: { value: 0 },
    uOpacity: { value: 0.5 },
    uLength: { value: 0.5 },
    uSpeed: { value: 7.5 },
    uIntensity: { value: 0.5 },
    uHeight: { value: height },
    uColor: { value: options.color ?? new THREE.Color(0xbcd2e6) },
    // 固定 4 个灯位：着色器里按固定长度循环
    uLightPos: {
      value: [
        options.lights?.[0] ?? new THREE.Vector3(0, -9999, 0),
        options.lights?.[1] ?? new THREE.Vector3(0, -9999, 0),
        options.lights?.[2] ?? new THREE.Vector3(0, -9999, 0),
        options.lights?.[3] ?? new THREE.Vector3(0, -9999, 0),
      ],
    },
    uFogColor: { value: options.fogColor ?? new THREE.Color(0x0a1018) },
    uFogNear: { value: options.fogNear ?? 12 },
    uFogFar: { value: options.fogFar ?? 40 },
    particleMatrix: space.uniform,
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: RAIN_VERT,
    fragmentShader: RAIN_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const lines = new THREE.LineSegments(geometry, material);
  lines.name = 'rain-streaks';
  lines.frustumCulled = false;
  lines.renderOrder = 3;

  return {
    lines,
    material,
    uniforms: {
      uTime: uniforms.uTime,
      uOpacity: uniforms.uOpacity,
      uLength: uniforms.uLength,
      uSpeed: uniforms.uSpeed,
      uIntensity: uniforms.uIntensity,
      uColor: uniforms.uColor,
      uLightPos: uniforms.uLightPos,
      uFogColor: uniforms.uFogColor,
      uFogNear: uniforms.uFogNear,
      uFogFar: uniforms.uFogFar,
    },
  };
}
