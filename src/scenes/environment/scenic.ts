/**
 * 三个「真实环境」场景（雾松林 / 港湾黄昏 / 梯田晨光）共用的辅助。
 *
 * 全部资源都由代码生成，不依赖任何外部素材：
 * - 天空调色板：同一组 uniform 既喂给天穹，也喂给水面反射，两者永远一致；
 * - 贴地雾粒：走核心层的粒子空间（ParticleSpace），整片雾场靠一个矩阵整体呼吸；
 * - 风摆：给标准材质挂上 aSway 属性，按世界坐标错开相位，整片林子不会同步摆动；
 * - 霜：按世界坐标的噪声给朝上的面加一层薄白；
 * - 远山剪影：程序化生成带 alpha 的山脊贴图；
 * - 远处的钟声：用振荡器现场合成，不依赖任何音频文件。
 */
import * as THREE from 'three';
import { GLSL_HASH, GLSL_NOISE2, GLSL_OUTPUT, GLSL_OUTPUT_FUNCS, PARTICLE_SPACE_GLSL, fbm2D } from './lib.js';
import type { ParticleSpace } from '../../core/particle-space.js';
import type { SceneContext } from '../types.js';

/* ------------------------------------------------------------------ *
 * 天空
 * ------------------------------------------------------------------ */

/** 天空调色板：天穹与水面反射共用同一份数据。 */
export interface SkyPalette {
  zenith: THREE.ColorRepresentation;
  horizon: THREE.ColorRepresentation;
  ground: THREE.ColorRepresentation;
  /** 地平线附近的雾光带（晨光 / 余晖）。 */
  band?: THREE.ColorRepresentation;
  bandStrength?: number;
  bandY?: number;
  bandWidth?: number;
  /** 太阳方向（世界坐标，无需归一化）。 */
  sunDir?: THREE.Vector3;
  sunColor?: THREE.ColorRepresentation;
  sunStrength?: number;
}

/** 天空 uniform 组：天穹材质与水面材质共享同一批对象，改一处两处都变。 */
export interface SkyUniformSet {
  uSkyZenith: { value: THREE.Color };
  uSkyHorizon: { value: THREE.Color };
  uSkyGround: { value: THREE.Color };
  uSkyBand: { value: THREE.Color };
  uSkyBandStrength: { value: number };
  uSkyBandY: { value: number };
  uSkyBandWidth: { value: number };
  uSkySunDir: { value: THREE.Vector3 };
  uSkySunColor: { value: THREE.Color };
  uSkySunStrength: { value: number };
}

/** 天空求值的 GLSL 片段（全局作用域，含 uniform 声明）。 */
export const GLSL_SKY = /* glsl */ `
#ifndef SCENIC_SKY_GUARD
#define SCENIC_SKY_GUARD
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyGround;
uniform vec3 uSkyBand;
uniform float uSkyBandStrength;
uniform float uSkyBandY;
uniform float uSkyBandWidth;
uniform vec3 uSkySunDir;
uniform vec3 uSkySunColor;
uniform float uSkySunStrength;

vec3 scenicSkyColor( vec3 dir ) {
  vec3 d = normalize( dir );
  float h = d.y;

  vec3 col = mix( uSkyHorizon, uSkyZenith, smoothstep( -0.04, 0.55, h ) );
  col = mix( col, uSkyGround, smoothstep( 0.0, -0.26, h ) );

  // 地平线上的雾光带
  float band = exp( -abs( h - uSkyBandY ) / max( uSkyBandWidth, 0.001 ) );
  col = mix( col, uSkyBand, clamp( band * uSkyBandStrength, 0.0, 1.0 ) );

  // 太阳：核心的亮斑 + 周围的一圈晕
  float s = max( dot( d, normalize( uSkySunDir ) ), 0.0 );
  col += uSkySunColor * pow( s, 26.0 ) * uSkySunStrength;
  col += uSkySunColor * pow( s, 7.0 ) * uSkySunStrength * 0.12;

  return col;
}
#endif
`;

/** 按调色板建立天空 uniform 组。 */
export function createSkyUniforms(palette: SkyPalette): SkyUniformSet {
  return {
    uSkyZenith: { value: new THREE.Color(palette.zenith) },
    uSkyHorizon: { value: new THREE.Color(palette.horizon) },
    uSkyGround: { value: new THREE.Color(palette.ground) },
    uSkyBand: { value: new THREE.Color(palette.band ?? palette.horizon) },
    uSkyBandStrength: { value: palette.bandStrength ?? 0 },
    uSkyBandY: { value: palette.bandY ?? 0 },
    uSkyBandWidth: { value: palette.bandWidth ?? 0.08 },
    uSkySunDir: { value: (palette.sunDir ?? new THREE.Vector3(0, 1, 0)).clone() },
    uSkySunColor: { value: new THREE.Color(palette.sunColor ?? palette.horizon) },
    uSkySunStrength: { value: palette.sunStrength ?? 0 },
  };
}

const SKY_VERT = /* glsl */ `
varying vec3 vDir;

void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const SKY_FRAG = /* glsl */ `
precision highp float;

varying vec3 vDir;

${GLSL_SKY}
${GLSL_OUTPUT_FUNCS}

void main() {
  gl_FragColor = vec4( scenicSkyColor( vDir ), 1.0 );
  ${GLSL_OUTPUT}
}
`;

export interface ScenicSky {
  mesh: THREE.Mesh;
  uniforms: SkyUniformSet;
}

/**
 * 渐变天穹。与水面反射共用同一组 uniform，
 * 所以「天上的颜色」和「水里的倒影」永远是一致的。
 */
export function createScenicSky(palette: SkyPalette, radius = 400): ScenicSky {
  const uniforms = createSkyUniforms(palette);
  const material = new THREE.ShaderMaterial({
    uniforms: { ...uniforms },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 40, 24), material);
  mesh.name = 'sky-dome';
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;

  return { mesh, uniforms };
}

/* ------------------------------------------------------------------ *
 * 程序化贴图
 * ------------------------------------------------------------------ */

/** 柔和的雾团（白色 RGB + 云絮状 alpha）。 */
export function createMistTexture(size = 256, seed = 1): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');

  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = (x / size) * 4 + seed * 3.1;
      const v = (y / size) * 4 + seed * 1.7;
      const cloud = fbm2D(u, v, 4);
      const fine = fbm2D(u * 3.1 + 5.3, v * 3.1 + 2.9, 3);
      const alpha = THREE.MathUtils.clamp(cloud * 1.7 + fine * 0.42 - 0.62, 0, 1);
      const i = (y * size + x) * 4;
      image.data[i] = 255;
      image.data[i + 1] = 255;
      image.data[i + 2] = 255;
      image.data[i + 3] = Math.round(alpha * 255);
    }
  }
  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'mist-cloud';
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
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

export interface RidgeTextureOptions {
  width?: number;
  height?: number;
  /** 山体颜色（带 alpha 的 PNG）。 */
  color?: string;
  seed?: number;
  /** 山脊起伏的层数，越多越碎。 */
  layers?: number;
  /** 山峰高度（占画布高度的比例）。 */
  amplitude?: number;
  /** 山脚高度（占画布高度的比例，从下往上）。 */
  base?: number;
}

/**
 * 远山 / 远岸的剪影贴图：山脊线以下不透明，以上透明。
 * 用 fbm 叠正弦生成，形状自然又不规则。
 */
export function createRidgeTexture(options: RidgeTextureOptions = {}): THREE.CanvasTexture {
  const width = options.width ?? 512;
  const height = options.height ?? 256;
  const layers = options.layers ?? 5;
  const amplitude = options.amplitude ?? 0.62;
  const base = options.base ?? 0.06;
  const random = createRandom(options.seed ?? 90210);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');

  const phases = new Float32Array(layers);
  const freqs = new Float32Array(layers);
  for (let i = 0; i < layers; i += 1) {
    phases[i] = random() * Math.PI * 2;
    freqs[i] = 0.6 + i * 1.35 + random() * 0.8;
  }

  const image = ctx.createImageData(width, height);
  const rgb = new THREE.Color(options.color ?? '#1b2430');
  // THREE.Color 内部存的是线性值，画布要的却是 sRGB 字节，这里要换算回去
  const srgb = rgb.clone().convertLinearToSRGB();

  for (let x = 0; x < width; x += 1) {
    let h = 0;
    let norm = 0;
    for (let i = 0; i < layers; i += 1) {
      const amp = 1 / (i + 1.4);
      h += Math.sin((x / width) * Math.PI * 2 * freqs[i] + phases[i]) * amp;
      norm += amp;
    }
    h /= norm;
    const peak = base + amplitude * (0.5 + 0.5 * h);
    const lineY = height * (1 - peak);

    for (let y = 0; y < height; y += 1) {
      const i = (y * width + x) * 4;
      if (y < lineY) {
        image.data[i] = 0;
        image.data[i + 1] = 0;
        image.data[i + 2] = 0;
        image.data[i + 3] = 0;
      } else {
        // 越靠近山脚越暗一点，避免死板的平涂
        const depth = THREE.MathUtils.clamp((y - lineY) / Math.max(1, height - lineY), 0, 1);
        const shade = 1 - depth * 0.22;
        image.data[i] = Math.round(srgb.r * 255 * shade);
        image.data[i + 1] = Math.round(srgb.g * 255 * shade);
        image.data[i + 2] = Math.round(srgb.b * 255 * shade);
        image.data[i + 3] = 255;
      }
    }
  }
  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'ridge-silhouette';
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/* ------------------------------------------------------------------ *
 * 贴地雾粒（粒子空间）
 * ------------------------------------------------------------------ */

const MIST_FIELD_VERT = /* glsl */ `
#ifndef SCENIC_MIST_VERT_GUARD
#define SCENIC_MIST_VERT_GUARD
attribute float aSize;
attribute float aPhase;
attribute float aSeed;

uniform float uTime;
uniform float uScale;
uniform float uOpacity;
uniform float uHeight;
uniform float uRadius;
uniform float uWind;

varying float vAlpha;
varying float vSoft;

${PARTICLE_SPACE_GLSL}

void main() {
  vec3 p = position;

  // 高度始终压在贴地的一层里，只在很窄的范围内起伏
  float h = fract( aSeed * 3.77 );
  p.y = 0.04 + h * uHeight + sin( uTime * 0.17 + aPhase * 6.2831853 ) * 0.05;

  // 缓慢横移，越界处循环，所以雾永远「流」不完
  p.x = mod( p.x + uTime * uWind + uRadius, uRadius * 2.0 ) - uRadius;
  p.z = mod( p.z + uRadius + sin( uTime * 0.043 + aPhase ) * 0.7, uRadius * 2.0 ) - uRadius;

  vec3 world = particleSpaceTransform( p );
  vec4 mv = modelViewMatrix * vec4( world, 1.0 );
  gl_Position = projectionMatrix * mv;

  // 边缘淡出，避免粒子在边界上突然出现
  float d = length( p.xz ) / uRadius;
  float fade = smoothstep( 1.0, 0.7, d ) * smoothstep( 0.0, 0.09, d );
  float shimmer = 0.85 + 0.15 * sin( uTime * 0.19 + aPhase * 3.1 );
  // 贴到镜头上的雾粒要让开，否则会糊住整个画面
  float nearFade = smoothstep( 0.6, 2.4, -mv.z );
  vAlpha = uOpacity * fade * shimmer * nearFade;
  vSoft = 0.5 + 0.5 * fract( aSeed * 7.31 );

  gl_PointSize = aSize * uScale / max( 1.0, -mv.z );
}
#endif
`;

const MIST_FIELD_FRAG = /* glsl */ `
#ifndef SCENIC_MIST_FRAG_GUARD
#define SCENIC_MIST_FRAG_GUARD
precision highp float;

uniform vec3 uColor;

varying float vAlpha;
varying float vSoft;

${GLSL_OUTPUT_FUNCS}

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot( c, c );
  if ( d2 > 0.25 ) discard;
  // 柔和的云团：中心浓、边缘完全化开，不留硬边
  float radial = smoothstep( 0.25, 0.04 + vSoft * 0.07, d2 );
  float falloff = exp( -d2 * 3.2 ) * radial;
  float a = falloff * vAlpha;
  if ( a < 0.004 ) discard;
  gl_FragColor = vec4( uColor, a );
  ${GLSL_OUTPUT}
}
#endif
`;

export interface GroundMistOptions {
  count: number;
  /** 雾场半径（米）。 */
  radius: number;
  /** 贴地厚度（米）。 */
  height?: number;
  /** 每颗雾粒的直径（米）。 */
  size?: number;
  opacity?: number;
  color?: THREE.ColorRepresentation;
  seed?: number;
}

export interface GroundMistField {
  points: THREE.Points;
  material: THREE.ShaderMaterial;
  uniforms: {
    uTime: { value: number };
    uScale: { value: number };
    uOpacity: { value: number };
    uHeight: { value: number };
    uRadius: { value: number };
    uWind: { value: number };
    uColor: { value: THREE.Color };
  };
}

/**
 * 一片贴地的雾粒。
 *
 * 粒子在粒子空间里生成与漂移，整片雾场通过一个 4x4 矩阵作用到世界，
 * 旋转与呼吸缩放都是零 CPU 成本。
 */
export function createGroundMistField(
  space: ParticleSpace,
  options: GroundMistOptions,
): GroundMistField {
  const count = Math.max(1, Math.round(options.count));
  const radius = options.radius;
  const random = createRandom(options.seed ?? 5150);

  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const phases = new Float32Array(count);
  const seeds = new Float32Array(count);

  for (let i = 0; i < count; i += 1) {
    positions[i * 3] = (random() * 2 - 1) * radius;
    positions[i * 3 + 1] = random();
    positions[i * 3 + 2] = (random() * 2 - 1) * radius;
    sizes[i] = (options.size ?? 2.6) * (0.6 + random() * 0.9);
    phases[i] = random() * Math.PI * 2;
    seeds[i] = random();
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));

  const uniforms = {
    uTime: { value: 0 },
    uScale: { value: 600 },
    uOpacity: { value: options.opacity ?? 0.16 },
    uHeight: { value: options.height ?? 0.7 },
    uRadius: { value: radius },
    uWind: { value: 0.18 },
    uColor: { value: new THREE.Color(options.color ?? 0xdfe9e6) },
  };

  const material = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, particleMatrix: space.uniform },
    vertexShader: MIST_FIELD_VERT,
    fragmentShader: MIST_FIELD_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.name = 'ground-mist';
  points.frustumCulled = false;
  points.renderOrder = 3;

  return { points, material, uniforms };
}

/* ------------------------------------------------------------------ *
 * 风摆
 * ------------------------------------------------------------------ */

export interface WindSwayUniforms {
  uSwayTime: { value: number };
  uSwayStrength: { value: number };
  uSwaySpeed: { value: number };
}

export function createWindSwayUniforms(): WindSwayUniforms {
  return {
    uSwayTime: { value: 0 },
    uSwayStrength: { value: 0.05 },
    uSwaySpeed: { value: 1.05 },
  };
}

/**
 * 给标准材质注入风摆。
 *
 * 几何体需要带一个 `aSway` 属性（根部 0、梢头 1）。
 * 相位由世界坐标决定，所以同一片林子里的每棵树摆动的相位都不一样，
 * 不会出现「整排树同步摇摆」的塑料感。
 */
export function attachWindSway(material: THREE.Material, uniforms: WindSwayUniforms): void {
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous?.(shader, renderer);
    shader.uniforms.uSwayTime = uniforms.uSwayTime;
    shader.uniforms.uSwayStrength = uniforms.uSwayStrength;
    shader.uniforms.uSwaySpeed = uniforms.uSwaySpeed;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float aSway;
uniform float uSwayTime;
uniform float uSwayStrength;
uniform float uSwaySpeed;`,
      )
      .replace(
        '#include <project_vertex>',
        `vec4 mvPosition = vec4( transformed, 1.0 );

#ifdef USE_BATCHING
  mvPosition = batchingMatrix * mvPosition;
#endif

#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
#endif

mvPosition = modelViewMatrix * mvPosition;

{
  // 世界坐标决定相位：每棵树都错开一点点
  vec3 worldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
  float phase = worldPos.x * 0.23 + worldPos.z * 0.14;
  float gust = sin( uSwayTime * uSwaySpeed + phase ) * 0.62
             + sin( uSwayTime * uSwaySpeed * 0.47 + phase * 2.31 ) * 0.38;
  float w = aSway * aSway;
  vec3 offset = vec3( gust * w * uSwayStrength, 0.0, gust * w * uSwayStrength * 0.55 );
  // 世界空间的偏移换算到观察空间
  mvPosition.xyz += ( viewMatrix * vec4( offset, 0.0 ) ).xyz;
}

gl_Position = projectionMatrix * mvPosition;`,
      );
  };
  material.needsUpdate = true;
}

/* ------------------------------------------------------------------ *
 * 霜
 * ------------------------------------------------------------------ */

export interface FrostUniforms {
  uFrostAmount: { value: number };
  uFrostColor: { value: THREE.Color };
  uFrostScale: { value: number };
}

export interface FrostOptions {
  color?: THREE.ColorRepresentation;
  amount?: number;
  /** 噪声的空间尺度（越大越碎）。 */
  scale?: number;
}

export function createFrostUniforms(options: FrostOptions = {}): FrostUniforms {
  return {
    uFrostAmount: { value: options.amount ?? 0.55 },
    uFrostColor: { value: new THREE.Color(options.color ?? 0xdce9ec) },
    uFrostScale: { value: options.scale ?? 1.6 },
  };
}

/**
 * 给标准材质注入一层薄霜。
 *
 * 用世界坐标的噪声打散边界，再用几何法线（屏幕空间导数算出）判断哪些面朝上，
 * 霜只结在朝上的那一侧 —— 清晨背光的那一面。
 */
export function attachFrost(material: THREE.Material, uniforms: FrostUniforms): void {
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous?.(shader, renderer);
    shader.uniforms.uFrostAmount = uniforms.uFrostAmount;
    shader.uniforms.uFrostColor = uniforms.uFrostColor;
    shader.uniforms.uFrostScale = uniforms.uFrostScale;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFrostWorld;')
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\n\tvFrostWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;',
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vFrostWorld;
uniform float uFrostAmount;
uniform vec3 uFrostColor;
uniform float uFrostScale;
${GLSL_HASH}
${GLSL_NOISE2}`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
{
  vec3 fwN = normalize( cross( dFdx( vFrostWorld ), dFdy( vFrostWorld ) ) );
  float up = clamp( fwN.y * 0.5 + 0.5, 0.0, 1.0 );
  float n = fbm2( vFrostWorld.xz * uFrostScale + vec2( vFrostWorld.y * 0.9 ), 3 );
  float frost = smoothstep( 0.46, 0.86, n * 0.72 + up * 0.52 ) * uFrostAmount;
  diffuseColor.rgb = mix( diffuseColor.rgb, uFrostColor, frost );
}`,
      );
  };
  material.needsUpdate = true;
}

/* ------------------------------------------------------------------ *
 * 几何合并
 * ------------------------------------------------------------------ */

/**
 * 给几何体写入 `aSway` 属性（风摆权重）。
 * 权重按顶点高度给出：根部 0、梢头 1。
 */
export function setSwayAttribute(
  geometry: THREE.BufferGeometry,
  weight: (y: number) => number,
): void {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const values = new Float32Array(position.count);
  for (let i = 0; i < position.count; i += 1) {
    values[i] = weight(position.getY(i));
  }
  geometry.setAttribute('aSway', new THREE.BufferAttribute(values, 1));
}

/**
 * 合并若干几何体为一个（position / normal / uv / aSway）。
 * 合并后每棵树只有两个 draw call，几十棵树也不会压垮渲染。
 */
export function mergeSwayGeometries(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const position: number[] = [];
  const normal: number[] = [];
  const uv: number[] = [];
  const sway: number[] = [];
  const color: number[] = [];

  // 顶点色是可选的：所有几何体都有才合并，否则按白色补齐
  const hasColor = list.every((geometry) => geometry.getAttribute('color') !== undefined);

  for (const source of list) {
    const geometry = source.index ? source.toNonIndexed() : source;
    const p = geometry.getAttribute('position') as THREE.BufferAttribute;
    const n = geometry.getAttribute('normal') as THREE.BufferAttribute;
    const u = geometry.getAttribute('uv') as THREE.BufferAttribute;
    const s = geometry.getAttribute('aSway') as THREE.BufferAttribute;
    const c = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;

    for (let i = 0; i < p.count; i += 1) {
      position.push(p.getX(i), p.getY(i), p.getZ(i));
      normal.push(n.getX(i), n.getY(i), n.getZ(i));
      uv.push(u.getX(i), u.getY(i));
      sway.push(s.getX(i));
      if (hasColor) {
        if (c) color.push(c.getX(i), c.getY(i), c.getZ(i));
        else color.push(1, 1, 1);
      }
    }

    if (geometry !== source) geometry.dispose();
    source.dispose();
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  merged.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  merged.setAttribute('aSway', new THREE.Float32BufferAttribute(sway, 1));
  if (hasColor) merged.setAttribute('color', new THREE.Float32BufferAttribute(color, 3));
  merged.computeBoundingSphere();
  return merged;
}

/* ------------------------------------------------------------------ *
 * 程序缓存键
 * ------------------------------------------------------------------ */

/**
 * 给材质一个唯一的 program 缓存键。
 *
 * three 默认用 `onBeforeCompile.toString()` 当缓存键，
 * 而不同材质往往来自同一个注入函数 —— 那会导致着色器程序被错误复用。
 * 凡是注入过自定义 GLSL 的材质，都要显式给一个独一无二的键。
 */
export function setProgramKey(material: THREE.Material, key: string): void {
  material.customProgramCacheKey = () => key;
  material.needsUpdate = true;
}

/* ------------------------------------------------------------------ *
 * 远处的钟声
 * ------------------------------------------------------------------ */

export interface DistantBellOptions {
  /** 两次敲钟之间的间隔（秒）。 */
  interval?: [number, number];
  /** 音量。 */
  volume?: number;
  /** 低通截止频率：越小越像隔着很远的水面传来。 */
  cutoff?: number;
  /** 混响总线（可选）。 */
  reverb?: AudioNode;
}

/**
 * 现场合成的远钟声。
 *
 * 用一组非谐波比例的正弦分音（像管钟 / 铜钟）加上指数衰减包络，
 * 再经低通滤掉高频 —— 听起来就是「隔着水面、隔着距离」的一声钟。
 * 浏览器要求用户手势后才能出声，所以只在 AudioContext 真正 running 时才敲。
 */
export class DistantBell {
  private readonly partials = [1, 2.03, 2.99, 4.11, 5.42];
  private readonly interval: [number, number];
  private readonly volume: number;
  private readonly cutoff: number;
  private readonly reverb?: AudioNode;
  private started = false;
  private nextStrike = 0;
  private disposed = false;
  private readonly timers = new Set<number>();

  constructor(options: DistantBellOptions = {}) {
    this.interval = options.interval ?? [17, 26];
    this.volume = options.volume ?? 0.16;
    this.cutoff = options.cutoff ?? 900;
    this.reverb = options.reverb;
  }

  /** 每帧调用；到点就敲一次钟。 */
  update(ctx: SceneContext): void {
    if (this.disposed) return;
    const context = ctx.listener.context;
    if (!context) return;
    if (!this.started) {
      if (context.state !== 'running') return;
      this.started = true;
      this.nextStrike = context.currentTime + 4;
    }
    if (context.currentTime < this.nextStrike) return;
    this.strike(context);
    const [lo, hi] = this.interval;
    this.nextStrike = context.currentTime + lo + Math.random() * (hi - lo);
  }

  private strike(context: BaseAudioContext): void {
    const now = context.currentTime;
    const out = context.createGain();
    out.gain.value = this.volume;

    const lowpass = context.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = this.cutoff;
    lowpass.Q.value = 0.6;

    out.connect(lowpass);
    if (this.reverb) lowpass.connect(this.reverb);
    else lowpass.connect(context.destination);

    const base = 174 * (0.985 + Math.random() * 0.03);
    let longest = 0;

    for (let i = 0; i < this.partials.length; i += 1) {
      const osc = context.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = base * this.partials[i];

      const gain = context.createGain();
      const amp = 0.55 / (i + 1.2);
      const dur = 5.2 / (1 + i * 0.6);
      longest = Math.max(longest, dur);

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(amp, now + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

      osc.connect(gain);
      gain.connect(out);
      osc.start(now);
      osc.stop(now + dur + 0.05);
    }

    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      try {
        out.disconnect();
        lowpass.disconnect();
      } catch {
        /* 已经断开 */
      }
    }, (longest + 0.6) * 1000);
    this.timers.add(timer);
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers.clear();
  }
}
