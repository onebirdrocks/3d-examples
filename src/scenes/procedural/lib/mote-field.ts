/**
 * 自定义粒子场
 * ---------------------------------------------------------------
 * 核心层的 `createWrappedPointField` 负责「在粒子空间里生成并循环」，
 * 这里把默认的 PointsMaterial 换成自定义 ShaderMaterial，
 * 让每颗粒子拥有独立的节奏：
 *
 * - dust   尘埃：极缓慢的三维漂移 + 几乎察觉不到的明暗；
 * - firefly 萤火：每个个体有自己的漂移速度与明灭频率；
 * - steam  热气：自底部升起，越高越散、越淡。
 *
 * 顶点位置依旧走 `particleMatrix`（核心层的粒子空间矩阵），
 * 旋转 / 缩放 / 位移全部在顶点着色器里完成，CPU 每帧只更新几个 uniform。
 */
import * as THREE from 'three';
import {
  PARTICLE_SPACE_GLSL,
  createRandom,
  createWrappedPointField,
} from '../../../core/particle-space.js';
import type { ParticleSpace } from '../../../core/particle-space.js';
import type { SceneContext } from '../../types.js';

/** 粒子的行为模式。 */
export type MoteMode = 'dust' | 'firefly' | 'steam';

const MODE_VALUE: Record<MoteMode, number> = { dust: 0, firefly: 1, steam: 2 };

const MOTE_VERT = /* glsl */ `
attribute float aSize;
attribute float aPhase;
attribute float aRate;
attribute float aSeed;

uniform float uTime;
uniform float uScale;
uniform float uOpacity;
uniform float uMode;
uniform float uWander;
uniform float uBlinkRate;
uniform float uRiseSpeed;
uniform float uRiseHeight;
uniform float uFalloff;
uniform float uMirror;
uniform float uFloor;

varying vec3 vTint;
varying float vAlpha;
varying float vPulse;

${PARTICLE_SPACE_GLSL}

void main() {
  vec3 p = position;
  float phase = aPhase;
  float height01 = 0.0;

  if ( uMode < 0.5 ) {
    // 尘埃：周期在 50 秒以上的缓慢漂移
    p.x += sin( uTime * 0.11 + phase ) * uWander;
    p.y += cos( uTime * 0.083 + phase * 1.7 ) * uWander * 0.7;
    p.z += sin( uTime * 0.093 + phase * 2.3 ) * uWander;
  } else if ( uMode < 1.5 ) {
    // 萤火：每个个体的漂移节奏都不同
    p.x += sin( uTime * 0.19 * aRate + phase ) * uWander;
    p.y += sin( uTime * 0.14 * aRate + phase * 1.7 ) * uWander * 0.55;
    p.z += cos( uTime * 0.17 * aRate + phase * 2.1 ) * uWander;
  } else {
    // 热气：自底部升起，越高越散
    float h = mod( uTime * uRiseSpeed * aRate + aSeed * uRiseHeight, uRiseHeight );
    height01 = h / uRiseHeight;
    p.y = h;
    p.x *= 0.2 + 0.9 * height01;
    p.z *= 0.2 + 0.9 * height01;
    p.x += sin( uTime * 0.7 + phase ) * 0.008 * height01;
    p.z += cos( uTime * 0.6 + phase ) * 0.008 * height01;
  }

  vec3 world = particleSpaceTransform( p );
  // 贴地钳制：粒子不会沉到地面以下；倒影沿地面对称
  if ( uMirror < 0.0 ) world.y = -max( world.y, uFloor );
  else world.y = max( world.y, uFloor );

  vec4 mv = modelViewMatrix * vec4( world, 1.0 );
  gl_Position = projectionMatrix * mv;

  float alpha = uOpacity;
  float pulse = 0.0;

  if ( uMode < 0.5 ) {
    alpha *= 0.76 + 0.24 * sin( uTime * 0.45 + phase * 3.1 );
  } else if ( uMode < 1.5 ) {
    float s = sin( uTime * uBlinkRate * aRate + phase * 6.2831 );
    pulse = pow( max( s, 0.0 ), 3.0 );
    alpha *= 0.03 + 0.97 * pulse;
  } else {
    alpha *= smoothstep( 0.0, 0.16, height01 ) * ( 1.0 - height01 );
  }

  // 球形衰减：让粒子聚成一团，而不是铺满整个立方体
  if ( uFalloff > 0.0 ) {
    alpha *= 1.0 - smoothstep( uFalloff * 0.3, uFalloff, length( p ) );
  }

  vAlpha = alpha;
  vPulse = pulse;
  vTint = color;
  gl_PointSize = aSize * uScale / max( 1.0, -mv.z );
}
`;

const MOTE_FRAG = /* glsl */ `
precision highp float;

uniform float uOpacity;
uniform vec3 uCore;

varying vec3 vTint;
varying float vAlpha;
varying float vPulse;

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot( c, c );
  if ( d2 > 0.25 ) discard;

  float core = exp( -d2 * 26.0 );
  float halo = exp( -d2 * 6.0 );
  vec3 col = mix( vTint, uCore, core * ( 0.3 + 0.7 * vPulse ) );
  float a = ( core * ( 0.7 + 0.5 * vPulse ) + halo * 0.26 ) * vAlpha * uOpacity;
  if ( a < 0.002 ) discard;

  gl_FragColor = vec4( col * ( 0.65 + 0.55 * vPulse ), a );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface MoteFieldOptions {
  /** 粒子尺寸（米）。 */
  size?: number;
  /** 主体颜色。 */
  color?: THREE.Color;
  /** 亮核颜色（萤火的热心）。 */
  core?: THREE.Color;
  /** 整体不透明度。 */
  opacity?: number;
  /** 随机种子。 */
  seed?: number;
  /** 行为模式。 */
  mode?: MoteMode;
  /** 个体游动幅度（米）。 */
  wander?: number;
  /** 萤火明灭的基础频率（Hz）。 */
  blinkRate?: number;
  /** 热气上升速度（米/秒）。 */
  riseSpeed?: number;
  /** 热气柱高度（米）。 */
  riseHeight?: number;
  /** 球形衰减半径，0 表示不衰减。 */
  falloff?: number;
  /** 贴地高度（米）：粒子不会低于这个高度；默认不钳制。 */
  floor?: number;
}

export interface MoteField {
  points: THREE.Points;
  geometry: THREE.BufferGeometry;
  material: THREE.ShaderMaterial;
  uniforms: {
    uTime: { value: number };
    uScale: { value: number };
    uOpacity: { value: number };
  };
}

/**
 * 在粒子空间里生成一片自定义着色的粒子场。
 */
export function createMoteField(
  space: ParticleSpace,
  count: number,
  options: MoteFieldOptions = {},
): MoteField {
  const mode = options.mode ?? 'dust';
  const seed = options.seed ?? 20240711;
  const color = options.color ?? new THREE.Color(0xffffff);

  const points = createWrappedPointField(space, count, {
    size: options.size ?? 0.03,
    color,
    opacity: options.opacity ?? 0.5,
    seed,
    vertexColors: true,
    additive: true,
  });

  const geometry = points.geometry;
  // 默认的 PointsMaterial 用不上，直接换掉
  (points.material as THREE.PointsMaterial).dispose();

  // 个体属性：节奏与初始相位
  const random = createRandom(seed ^ 0x9e3779b9);
  const rates = new Float32Array(count);
  const seeds = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    rates[i] = 0.6 + random() * 0.85;
    seeds[i] = random();
  }
  geometry.setAttribute('aRate', new THREE.BufferAttribute(rates, 1));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));

  const uniforms = {
    uTime: { value: 0 },
    uScale: { value: 600 },
    uOpacity: { value: 1 },
    uMode: { value: MODE_VALUE[mode] },
    uWander: { value: options.wander ?? 0.05 },
    uBlinkRate: { value: options.blinkRate ?? 0.6 },
    uRiseSpeed: { value: options.riseSpeed ?? 0.06 },
    uRiseHeight: { value: options.riseHeight ?? 0.3 },
    uFalloff: { value: options.falloff ?? 0 },
    uMirror: { value: 1 },
    uFloor: { value: options.floor ?? -1e6 },
    uCore: { value: options.core ?? new THREE.Color(0xffffff) },
    particleMatrix: space.uniform,
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: MOTE_VERT,
    fragmentShader: MOTE_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexColors: true,
  });

  points.material = material;
  points.name = 'mote-field';
  points.frustumCulled = false;

  return {
    points,
    geometry,
    material,
    uniforms: {
      uTime: uniforms.uTime,
      uScale: uniforms.uScale,
      uOpacity: uniforms.uOpacity,
    },
  };
}

/**
 * 用同一批粒子数据造一份「倒影」：世界空间里沿地面对称。
 * uniform 与原场共享，所以时间与尺寸永远同步。
 */
export function createMoteMirror(field: MoteField): {
  points: THREE.Points;
  material: THREE.ShaderMaterial;
} {
  const material = new THREE.ShaderMaterial({
    uniforms: { ...field.material.uniforms, uMirror: { value: -1 } },
    vertexShader: MOTE_VERT,
    fragmentShader: MOTE_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexColors: true,
  });

  const points = new THREE.Points(field.geometry, material);
  points.name = 'mote-mirror';
  points.frustumCulled = false;
  points.renderOrder = -1;
  return { points, material };
}

/** 依据视口尺寸与视场角更新颗粒的屏幕尺寸（米 → 像素）。 */
export function updateMoteScale(
  uniforms: { uScale: { value: number } },
  ctx: SceneContext,
  fovDeg: number,
): void {
  const halfFov = THREE.MathUtils.degToRad(fovDeg) * 0.5;
  uniforms.uScale.value = (ctx.height * 0.5 * ctx.renderer.getPixelRatio()) / Math.tan(halfFov);
}
