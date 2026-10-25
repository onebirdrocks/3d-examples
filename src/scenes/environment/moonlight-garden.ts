/**
 * 月夜庭院 / Moonlight Garden
 * ---------------------------------------------------------------
 * 深夜的日式庭院：一片镜面般的静池映着远山之上的满月，池边一座木构小亭
 * 挂着几盏很暗的暖色纸灯笼，樱花与红枫的暗色树冠从上方与两侧框住画面，
 * 汀步踏过苔地通向水面，水面上漂着极慢的萤火与一层柔雾。
 *
 * 画面全部程序化生成，没有任何外部素材：
 * - 水面是自定义着色器：程序化法线 + 菲涅尔混合「天空 / 月亮」与
 *   「岸边树线」的近似反射，叠加极缓慢扩散的同心涟漪、雨点与细碎月光；
 * - 天空是一个方向函数（天穹与水面反射共用），月亮 = 加性圆盘 + 大范围光晕；
 * - 远山是 2~3 层带 alpha 的山脊剪纸，靠雾度递进做空气透视；
 * - 树是程序化生长的分叉枝干 + 大量小面片叶片，顶点着色器按高度做极小的风摆；
 * - 萤火走核心层的粒子空间（ParticleSpace）。
 *
 * 环境预设（晴夜 / 雨夜）由 setMode 切换：云量、雨强、雾浓度、月亮亮度与风力
 * 会同时改变画面（云遮月、水面雨点、雾更浓、树摆幅更大、灯笼相对更明显）。
 */

import * as THREE from 'three';
import type { SceneContext, SceneDefinition, SceneInstance, SceneMode } from '../types.js';
import { disposeObject } from '../../core/loader.js';
import { PARTICLE_SPACE_GLSL, ParticleSpace } from '../../core/particle-space.js';
import {
  GLSL_HASH,
  GLSL_NOISE2,
  GLSL_OUTPUT,
  GLSL_OUTPUT_FUNCS,
  createGlowTexture,
  createRainStreaks,
  fbm2D,
} from './lib.js';
import { createGroundMistField, createRandom, createRidgeTexture } from './scenic.js';

/* ------------------------------------------------------------------ *
 * 常量与布局
 * ------------------------------------------------------------------ */

/** 视场角（度）。 */
const FOV = 52;
/** 相机到注视点的距离（米）。 */
const CAMERA_DISTANCE = 17.5;
/** 视线向下俯视的角度（度）：留出前景的苔地与汀步。 */
const PITCH_DEG = 7.8;
/** 坐姿视高：眼睛离本地地面 1.2 米。 */
const EYE_HEIGHT = 1.2;
/** 池子近岸（相机这一侧）的 z 基准。 */
const SHORE_Z = 10.8;
/** 亭子与灯笼在世界里的位置（暖色锚点，多处引用）。 */
const PAVILION_POS = new THREE.Vector3(11.2, 0, -11);
const STONE_LANTERN_POS = new THREE.Vector3(10.6, 0, -1);
/** 画面中心的水面世界坐标基准。 */
const MOON_AZIMUTH = 0.118;
const MOON_ELEVATION = 0.205;
/** 月亮在天空中的方向（未归一化，着色器里再归一化）。 */
const MOON_DIR = new THREE.Vector3(MOON_AZIMUTH, MOON_ELEVATION, -0.97).normalize();
/** 月亮的世界坐标（用于云层遮挡与光晕精灵）。 */
const MOON_DISTANCE = 380;
const MOON_WORLD = MOON_DIR.clone().multiplyScalar(MOON_DISTANCE);

/** 配色：午夜蓝 / 靛青 / 月光银 / 暗玉绿 / 极少量琥珀。 */
const SKY_ZENITH = 0x060c17;
const SKY_HORIZON = 0x153649;
const SKY_GROUND = 0x030709;
const HORIZON_GLOW = 0x1c5b68;
const MOON_COLOR = 0xe9f2ff;
const WATER_DEEP = 0x030c14;
const WATER_SHALLOW = 0x0b2430;
const SHORE_COLOR = 0x06121a;
const FOG_COLOR = 0x16323f;
const MOSS_COLOR = 0x6f8f76;
const CHERRY_LEAF = 0x584049;
const MAPLE_LEAF = 0x4d2c2c;
const LANTERN_COLOR = 0xffa54d;

/** 画面参数（由 setMode 写入目标值，逐帧平滑逼近）。 */
interface GardenParams {
  /** 云量 0~1：越大月亮越被遮住，天空越冷越闷。 */
  cloud: number;
  /** 雨强 0~1：水面雨点、雨丝与整体变暗。 */
  rain: number;
  /** 雾浓度 0~1：水面薄雾与远景雾度。 */
  mist: number;
  /** 月亮亮度 0~1。 */
  moon: number;
  /** 风力 0~1：树叶摆幅、云的漂移速度、涟漪强度。 */
  wind: number;
}

const DEFAULT_PARAMS: GardenParams = { cloud: 0.25, rain: 0, mist: 0.35, moon: 1, wind: 0.35 };

/** 声音图层：核心层负责实际混音，这里保存「场景自己的图层音量基线」。 */
interface LayerBaseline {
  readonly id: string;
  readonly base: number;
  /** 叠加当前环境预设的倍率后的音量基线。 */
  mix: number;
}

/* ------------------------------------------------------------------ *
 * GLSL：天空 / 月亮
 * ------------------------------------------------------------------ */

const GLSL_SKY = /* glsl */ `
#ifndef MOONLIGHT_SKY_GUARD
#define MOONLIGHT_SKY_GUARD
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyGround;
uniform vec3 uHorizonGlow;
uniform vec3 uMoonDir;
uniform vec3 uMoonColor;
uniform float uMoonBrightness;
uniform float uMoonRadius;
uniform float uCloud;

vec3 moonlitSky( vec3 dir ) {
  vec3 d = normalize( dir );
  float h = d.y;

  vec3 col = mix( uSkyHorizon, uSkyZenith, smoothstep( -0.03, 0.64, h ) );
  col = mix( col, uSkyGround, smoothstep( 0.0, -0.20, h ) );

  // 地平线上一层青碧色的夜雾余光
  col += uHorizonGlow * exp( -abs( h ) * 6.5 ) * 0.45;

  // 极淡的星屑（云厚时消失）
  vec3 starCell = floor( d * 240.0 );
  float starSeed = hash13( starCell );
  float star = smoothstep( 0.9972, 1.0, starSeed )
             * smoothstep( 0.34, 0.0, length( fract( d * 240.0 ) - 0.5 ) );
  col += vec3( 0.55, 0.68, 0.86 ) * star * ( 1.0 - clamp( uCloud, 0.0, 1.0 ) * 0.9 ) * 0.75;

  // 月亮：盘面 + 大范围光晕
  float md = clamp( dot( d, uMoonDir ), -1.0, 1.0 );
  float ang = acos( md );
  float disc = smoothstep( uMoonRadius, uMoonRadius * 0.78, ang );
  float halo = exp( -ang * 4.2 ) * 0.42 + exp( -ang * 1.15 ) * 0.045;
  float cover = mix( 1.0, 0.16, clamp( uCloud, 0.0, 1.0 ) );
  col += uMoonColor * ( disc * 2.8 + halo ) * uMoonBrightness * cover;

  return col;
}
#endif
`;

/* ------------------------------------------------------------------ *
 * GLSL：水面
 * ------------------------------------------------------------------ */

const GLSL_WATER_WAVE = /* glsl */ `
#ifndef MOONLIGHT_WAVE_GUARD
#define MOONLIGHT_WAVE_GUARD
uniform float uRippleAmp;

// 一个缓慢扩散的同心波源
float rippleRing( vec2 p, vec2 c, float t, float speed, float period ) {
  float d = distance( p, c );
  float f = fract( ( d - t * speed ) / period );
  float w = exp( -pow( ( f - 0.5 ) * 5.0, 2.0 ) );
  return w * exp( -d * 0.055 ) / ( 1.0 + d * 0.30 );
}

// 水面高度（米）：极缓慢的同心涟漪 + 两层细微起伏
float waterHeight( vec2 p, float t ) {
  float h = 0.0;
  h += rippleRing( p, vec2( -3.5, 3.0 ), t, 0.085, 2.8 ) * 0.016;
  h += rippleRing( p, vec2( 8.0, -9.0 ), t, 0.062, 3.7 ) * 0.013;
  h += rippleRing( p, vec2( -12.0, -24.0 ), t, 0.105, 2.4 ) * 0.010;
  h += ( fbm2( p * 0.40 + vec2( t * 0.013, t * 0.007 ), 3 ) - 0.5 ) * 0.024;
  h += ( fbm2( p * 1.85 + vec2( t * 0.048, -t * 0.031 ), 2 ) - 0.5 ) * 0.0065;
  return h * uRippleAmp;
}
#endif
`;

const WATER_VERT = /* glsl */ `
uniform float uTime;

varying vec3 vWorld;
varying float vViewDist;

${GLSL_HASH}
${GLSL_NOISE2}
${GLSL_WATER_WAVE}

void main() {
  vec3 p = position;
  p.y += waterHeight( p.xz, uTime );

  vec4 wp = modelMatrix * vec4( p, 1.0 );
  vWorld = wp.xyz;
  vec4 mv = viewMatrix * wp;
  vViewDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const WATER_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uRain;
uniform float uMist;
uniform float uSparkle;
uniform float uFogNear;
uniform float uFogFar;
uniform vec3 uWaterDeep;
uniform vec3 uWaterShallow;
uniform vec3 uShoreColor;
uniform vec3 uFogColor;
uniform vec3 uMoonPathDir;

varying vec3 vWorld;
varying float vViewDist;

${GLSL_HASH}
${GLSL_NOISE2}
${GLSL_SKY}
${GLSL_WATER_WAVE}
${GLSL_OUTPUT_FUNCS}

// 雨点：细密的小涟漪
float rainDimple( vec2 p, float t ) {
  float sum = 0.0;
  vec2 cell = floor( p * 1.7 );
  for ( int j = -1; j <= 1; j++ ) {
    for ( int i = -1; i <= 1; i++ ) {
      vec2 c = cell + vec2( float( i ), float( j ) );
      float rx = hash12( c );
      float ry = hash12( c + 7.31 );
      vec2 pos = ( c + vec2( rx, ry ) ) / 1.7;
      float phase = fract( t * 1.15 + rx * 3.17 + ry * 5.11 );
      float d = distance( p, pos );
      float r = phase * 0.26;
      sum += exp( -pow( ( d - r ) * 26.0, 2.0 ) ) * ( 1.0 - phase );
    }
  }
  return sum;
}

void main() {
  vec2 p = vWorld.xz;

  // 法线：中心差分
  float e = 0.10;
  float h0 = waterHeight( p, uTime );
  float hx = waterHeight( p + vec2( e, 0.0 ), uTime );
  float hz = waterHeight( p + vec2( 0.0, e ), uTime );
  float dx = ( hx - h0 ) / e;
  float dz = ( hz - h0 ) / e;

  if ( uRain > 0.001 ) {
    float r0 = rainDimple( p, uTime );
    float rx = rainDimple( p + vec2( 0.05, 0.0 ), uTime );
    float rz = rainDimple( p + vec2( 0.0, 0.05 ), uTime );
    dx += ( rx - r0 ) / 0.05 * uRain * 0.020;
    dz += ( rz - r0 ) / 0.05 * uRain * 0.020;
  }

  vec3 N = normalize( vec3( -dx, 1.0, -dz ) );
  vec3 V = normalize( cameraPosition - vWorld );
  float ndv = max( dot( N, V ), 0.0 );

  // 菲涅尔：远处接近全反射，近处几乎是水色
  float fres = 0.02 + 0.98 * pow( 1.0 - ndv, 5.0 );

  vec3 R = reflect( -V, N );
  R.y = abs( R.y ) + 0.0015;
  vec3 sky = moonlitSky( R );

  // 岸边树线的近似反射：反射方向低于树线高度时看到的是树的剪影
  float az = atan( R.x, -R.z );
  float treeTop = 0.011 + ( fbm2( vec2( az * 2.4 + 3.3, 1.9 ), 3 ) - 0.5 ) * 0.075;
  float mask = smoothstep( treeTop + 0.007, treeTop - 0.007, R.y );
  vec3 refl = mix( sky, uShoreColor, mask * 0.92 );

  // 水体本色：近处更深，远处泛青
  float body = 0.85 + 0.32 * fbm2( p * 0.085 + 3.7, 3 );
  vec3 base = mix( uWaterDeep, uWaterShallow, exp( -vViewDist * 0.020 ) ) * body;

  vec3 col = mix( base, refl, fres );

  // 月光碎光：月亮方位上的高光带
  vec3 H = normalize( uMoonDir + V );
  float ndh = max( dot( N, H ), 0.0 );
  float broad = pow( ndh, 24.0 );
  float tight = pow( ndh, 300.0 );
  float grain = fbm2( p * 7.0 + vec2( uTime * 0.26, uTime * 0.10 ), 3 );
  float sparkle = smoothstep( 0.46, 0.86, grain );

  // 月光路径：垂直于月亮方位线的距离
  vec2 toMoon = normalize( uMoonPathDir.xz );
  vec2 perp = vec2( -toMoon.y, toMoon.x );
  float offset = dot( vWorld.xz - cameraPosition.xz, perp );
  float path = exp( -pow( offset / ( 1.6 + vViewDist * 0.10 ), 2.0 ) );

  float cover = mix( 1.0, 0.22, clamp( uCloud, 0.0, 1.0 ) );
  col += uMoonColor * ( broad * 0.20 + tight * 2.4 * sparkle )
       * uMoonBrightness * cover * uSparkle * ( 0.30 + 1.35 * path );

  // 雨点：细密的亮点
  if ( uRain > 0.001 ) {
    col += uMoonColor * rainDimple( p, uTime ) * uRain * 0.09;
    col *= 1.0 - uRain * 0.18;
  }

  // 薄雾：远处水面褪进雾色
  float fog = smoothstep( uFogNear, uFogFar, vViewDist ) * ( 0.35 + 0.65 * uMist );
  col = mix( col, uFogColor, clamp( fog, 0.0, 0.92 ) );

  gl_FragColor = vec4( col, 1.0 );
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * GLSL：云层
 * ------------------------------------------------------------------ */

const CLOUD_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorld;

void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const CLOUD_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uOpacity;
uniform float uDrift;
uniform float uSeed;
uniform vec3 uColor;
uniform vec3 uMoonWorld;

varying vec2 vUv;
varying vec3 vWorld;

${GLSL_HASH}
${GLSL_NOISE2}
${GLSL_OUTPUT_FUNCS}

void main() {
  vec2 q = vWorld.xz * 0.0055;
  float n = fbm2( q + vec2( uTime * uDrift, uTime * uDrift * 0.42 ) + uSeed, 4 );
  float f = fbm2( q * 2.7 - vec2( uTime * uDrift * 1.6, 0.0 ) + uSeed * 1.7, 3 );

  float a = smoothstep( 0.46, 0.86, n * 0.78 + f * 0.34 );

  // 边缘淡出，避免看见矩形的边界
  vec2 e = abs( vUv - 0.5 ) * 2.0;
  a *= smoothstep( 1.0, 0.45, e.x ) * smoothstep( 1.0, 0.30, e.y );

  // 月亮附近更浓，形成「部分被薄云遮住」
  vec3 toMoon = normalize( uMoonWorld - vWorld );
  float ang = acos( clamp( dot( normalize( vWorld - cameraPosition ), toMoon ), -1.0, 1.0 ) );
  a *= 1.0 + 2.6 * exp( -ang * ang * 130.0 );

  a *= uOpacity;
  if ( a < 0.004 ) discard;

  gl_FragColor = vec4( uColor, a );
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * GLSL：叶片
 * ------------------------------------------------------------------ */

const LEAF_VERT = /* glsl */ `
attribute float aSway;
attribute vec3 aColor;

uniform float uTime;
uniform float uWind;
uniform float uSwaySpeed;

varying vec3 vColor;
varying vec3 vNormalW;
varying vec3 vWorld;

void main() {
  vec3 p = position;

  // 夜风：按高度加权的极小摆幅（每棵树用世界坐标错开相位）
  float phase = position.x * 0.23 + position.z * 0.14;
  float gust = sin( uTime * uSwaySpeed + phase ) * 0.62
             + sin( uTime * uSwaySpeed * 0.43 + phase * 2.31 ) * 0.38;
  float w = aSway * aSway;
  p.x += gust * w * uWind * 0.075;
  p.z += gust * w * uWind * 0.038;

  vec4 wp = modelMatrix * vec4( p, 1.0 );
  vWorld = wp.xyz;
  vNormalW = normalize( mat3( modelMatrix ) * normal );
  vColor = aColor;

  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const LEAF_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uMoonDir;
uniform vec3 uMoonColor;
uniform float uMoonBrightness;
uniform vec3 uSkyFill;
uniform vec3 uLanternPos;
uniform vec3 uLanternColor;
uniform float uLanternIntensity;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;

varying vec3 vColor;
varying vec3 vNormalW;
varying vec3 vWorld;

${GLSL_OUTPUT_FUNCS}

void main() {
  vec3 N = normalize( vNormalW );
  vec3 V = normalize( cameraPosition - vWorld );

  float ndl = max( dot( N, uMoonDir ), 0.0 );
  // 叶片很薄：月光能透过来一点，否则整片树冠会黑成一片剪影
  float back = max( dot( -N, uMoonDir ), 0.0 );
  vec3 lit = uMoonColor * ( ndl * 1.05 + back * 0.34 ) * uMoonBrightness;

  // 天光：朝上的面亮一些
  lit += uSkyFill * ( 0.6 + 0.4 * N.y );

  // 亭子灯笼的暖色补光（只照到很近的地方）
  float d = distance( vWorld, uLanternPos );
  lit += uLanternColor * uLanternIntensity / ( 1.0 + d * d * 0.9 );

  // 一点点边缘光，让暗部不至于糊成一团
  float rim = pow( 1.0 - abs( dot( N, V ) ), 3.0 );
  lit += uSkyFill * rim * 1.6;

  vec3 col = vColor * lit;

  // 空气透视：远处的树线要化进夜色里
  float viewDist = length( cameraPosition - vWorld );
  float fog = smoothstep( uFogNear, uFogFar, viewDist );
  col = mix( col, uFogColor, clamp( fog, 0.0, 0.9 ) );

  gl_FragColor = vec4( col, 1.0 );
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * GLSL：萤火
 * ------------------------------------------------------------------ */

const FIREFLY_VERT = /* glsl */ `
attribute float aSize;
attribute float aPhase;

uniform float uTime;
uniform float uScale;
uniform float uOpacity;
uniform float uBrightness;

varying float vAlpha;
varying float vTone;

${PARTICLE_SPACE_GLSL}

void main() {
  vec3 p = position;

  // 极缓慢的个体漂移
  p.x += sin( uTime * 0.061 + aPhase ) * 0.55;
  p.y += sin( uTime * 0.043 + aPhase * 1.7 ) * 0.22;
  p.z += cos( uTime * 0.037 + aPhase * 2.3 ) * 0.55;

  vec4 mv = modelViewMatrix * vec4( particleSpaceTransform( p ), 1.0 );
  gl_Position = projectionMatrix * mv;

  // 明暗只有极小的起伏，绝不闪烁
  float pulse = 0.80 + 0.20 * sin( uTime * 0.19 + aPhase * 3.1 );
  vAlpha = uOpacity * pulse;
  vTone = fract( aPhase * 0.61803 );
  gl_PointSize = aSize * uScale / max( 1.0, -mv.z );
}
`;

const FIREFLY_FRAG = /* glsl */ `
precision highp float;

uniform float uOpacity;
uniform float uBrightness;

varying float vAlpha;
varying float vTone;

${GLSL_OUTPUT_FUNCS}

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot( c, c );
  if ( d2 > 0.25 ) discard;
  float falloff = exp( -d2 * 12.0 );

  // 一点点青绿的生物荧光
  vec3 col = mix( vec3( 0.62, 1.0, 0.72 ), vec3( 1.0, 0.92, 0.62 ), vTone * 0.7 );

  float a = falloff * vAlpha * uOpacity;
  if ( a < 0.003 ) discard;
  gl_FragColor = vec4( col * uBrightness * ( 0.5 + falloff ), a );
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * 地形：岸线与地面高度
 * ------------------------------------------------------------------ */

/** 近岸（水面这一侧在 z 更小的一侧）。 */
function nearShoreZ(x: number): number {
  return SHORE_Z + Math.sin(x * 0.31) * 0.9 + Math.sin(x * 0.13 + 1.7) * 0.7;
}

/** 远岸。 */
function farShoreZ(x: number): number {
  return -45.5 + Math.sin(x * 0.17 + 0.6) * 2.2 + Math.sin(x * 0.07 + 2.3) * 1.5;
}

/** 左岸。 */
function leftShoreX(z: number): number {
  return -(5.2 + 0.21 * (SHORE_Z - z)) - Math.sin(z * 0.23) * 1.3;
}

/** 右岸。 */
function rightShoreX(z: number): number {
  return 6.0 + 0.20 * (SHORE_Z - z) + Math.sin(z * 0.19 + 1.1) * 1.5;
}

/**
 * 地面高度：四条岸线取最远的一条，越靠近水越低（沉到水下）。
 * 岸线处只略低于水面，抬升很快——走一步就是苔地，前景能看见岸。
 */
function groundHeight(x: number, z: number): number {
  const d = Math.max(
    z - nearShoreZ(x),
    leftShoreX(z) - x,
    x - rightShoreX(z),
    farShoreZ(x) - z,
  );
  const t = THREE.MathUtils.clamp(d / 2.1, 0, 1);
  const s = t * t * (3 - 2 * t);
  const coarse = fbm2D(x * 0.06 + 3.1, z * 0.06 + 7.7, 3);
  const fine = fbm2D(x * 0.34 + 11.3, z * 0.34 + 2.9, 2);
  return -0.24 + s * (0.80 + coarse * 0.80 + fine * 0.16);
}

/* ------------------------------------------------------------------ *
 * 程序化贴图
 * ------------------------------------------------------------------ */

/** 苔藓地面：暗绿、粗糙、带细碎的斑驳。 */
function createMossTexture(size = 256): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');

  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = (x / size) * 7;
      const v = (y / size) * 7;
      const moss = fbm2D(u * 1.8, v * 1.8, 4);
      const dirt = fbm2D(u * 5.5 + 11.3, v * 5.5 + 7.7, 3);
      const speck = Math.pow(fbm2D(u * 19 + 3.1, v * 19 + 9.4, 2), 7);
      const patch = THREE.MathUtils.smoothstep(moss, 0.38, 0.72);
      const i = (y * size + x) * 4;
      const r = THREE.MathUtils.lerp(70 + dirt * 34, 80 + moss * 36, patch);
      const g = THREE.MathUtils.lerp(84 + dirt * 36, 100 + moss * 38, patch);
      const b = THREE.MathUtils.lerp(80 + dirt * 32, 92 + moss * 32, patch);
      image.data[i] = Math.round(r + speck * 48);
      image.data[i + 1] = Math.round(g + speck * 54);
      image.data[i + 2] = Math.round(b + speck * 48);
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'garden-moss';
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

/* ------------------------------------------------------------------ *
 * 程序化几何：树
 * ------------------------------------------------------------------ */

interface BranchPoint {
  x: number;
  y: number;
  z: number;
  r: number;
}

interface LeafInstance {
  x: number;
  y: number;
  z: number;
  size: number;
  rx: number;
  ry: number;
  rz: number;
  r: number;
  g: number;
  b: number;
  sway: number;
}

interface TreeGeometry {
  branches: BranchPoint[][];
  leaves: LeafInstance[];
}

interface TreeOptions {
  /** 树基位置。 */
  x: number;
  y: number;
  z: number;
  /** 树高（米）。 */
  height: number;
  /** 冠幅（米）。 */
  spread: number;
  /** 主干倾角（弧度）。 */
  lean: number;
  /** 主干朝向（弧度）。 */
  yaw: number;
  /** 叶片颜色。 */
  color: THREE.Color;
  /** 单片叶子尺寸（米）。 */
  leafSize: number;
  /** 叶片数量。 */
  leafCount: number;
  /** 随机数。 */
  random: () => number;
}

const UP = new THREE.Vector3(0, 1, 0);

/** 递归生长一棵树，把枝干折线与叶片写进输出。 */
function growTree(
  out: TreeGeometry,
  options: TreeOptions,
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  length: number,
  radius: number,
  depth: number,
  maxDepth: number,
  swayBase: number,
  swaySpan: number,
): void {
  const random = options.random;
  const segments = depth === maxDepth ? 3 : 4;
  const points: BranchPoint[] = [];
  const p = origin.clone();
  const d = direction.clone().normalize();

  for (let i = 0; i <= segments; i += 1) {
    points.push({ x: p.x, y: p.y, z: p.z, r: radius * (1 - (i / segments) * 0.55) });
    d.x += (random() - 0.5) * 0.20;
    d.y += (random() - 0.5) * 0.07 + 0.05;
    d.z += (random() - 0.5) * 0.20;
    d.normalize();
    p.addScaledVector(d, length / segments);
  }
  out.branches.push(points);

  if (depth >= maxDepth) {
    for (let i = 0; i < options.leafCount; i += 1) {
      const t = 0.25 + random() * 0.75;
      const idx = Math.min(points.length - 1, t * (points.length - 1));
      const i0 = Math.floor(idx);
      const i1 = Math.min(points.length - 1, i0 + 1);
      const f = idx - i0;
      const a = points[i0];
      const b = points[i1];
      const spread = options.spread * 0.13;
      const x = a.x + (b.x - a.x) * f + (random() - 0.5) * spread;
      const y = a.y + (b.y - a.y) * f + (random() - 0.5) * spread * 0.7;
      const z = a.z + (b.z - a.z) * f + (random() - 0.5) * spread;
      const tint = 0.78 + random() * 0.44;
      out.leaves.push({
        x,
        y,
        z,
        size: options.leafSize * (0.68 + random() * 0.7),
        rx: random() * Math.PI,
        ry: random() * Math.PI,
        rz: random() * Math.PI,
        r: options.color.r * tint,
        g: options.color.g * tint,
        b: options.color.b * tint,
        sway: THREE.MathUtils.clamp((y - swayBase) / swaySpan, 0, 1),
      });
    }
    return;
  }

  const children = depth === 0 ? 3 : random() < 0.65 ? 2 : 3;
  for (let i = 0; i < children; i += 1) {
    const t = 0.42 + random() * 0.5;
    const idx = Math.min(points.length - 2, Math.floor(t * (points.length - 1)));
    const base = points[idx];
    const axis = new THREE.Vector3(random() - 0.5, random() * 0.5, random() - 0.5).normalize();
    const angle = 0.5 + random() * 0.6;
    const nd = d.clone().applyAxisAngle(axis, angle).normalize();
    nd.y = Math.abs(nd.y) * 0.65 + 0.22;
    nd.normalize();
    growTree(
      out,
      options,
      new THREE.Vector3(base.x, base.y, base.z),
      nd,
      length * (0.60 + random() * 0.22),
      base.r * 0.62,
      depth + 1,
      maxDepth,
      swayBase,
      swaySpan,
    );
  }
}

/** 生成一棵树的几何数据。 */
function buildTree(options: TreeOptions): TreeGeometry {
  const out: TreeGeometry = { branches: [], leaves: [] };
  const direction = new THREE.Vector3(
    Math.sin(options.yaw) * Math.sin(options.lean),
    Math.cos(options.lean),
    Math.cos(options.yaw) * Math.sin(options.lean),
  ).normalize();

  growTree(
    out,
    options,
    new THREE.Vector3(options.x, options.y, options.z),
    direction,
    options.height * 0.42,
    options.height * 0.035,
    0,
    2,
    options.y,
    options.height,
  );
  return out;
}

/** 把枝干折线变成管状几何（position + normal）。 */
function appendTube(
  position: number[],
  normal: number[],
  points: BranchPoint[],
  radialSegments: number,
): void {
  if (points.length < 2) return;

  const tangents: THREE.Vector3[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    tangents.push(new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z).normalize());
  }

  // 平行输运，避免相邻段坐标系翻转
  const ref = Math.abs(tangents[0].y) > 0.9 ? new THREE.Vector3(1, 0, 0) : UP;
  let u = new THREE.Vector3().crossVectors(tangents[0], ref).normalize();
  const frames: { u: THREE.Vector3; v: THREE.Vector3 }[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const t = tangents[i];
    u = u.clone().sub(t.clone().multiplyScalar(u.dot(t))).normalize();
    frames.push({ u: u.clone(), v: new THREE.Vector3().crossVectors(t, u).normalize() });
  }

  const corner = (
    point: BranchPoint,
    frame: { u: THREE.Vector3; v: THREE.Vector3 },
    angle: number,
    out: THREE.Vector3,
  ): void => {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    out.set(
      point.x + (frame.u.x * c + frame.v.x * s) * point.r,
      point.y + (frame.u.y * c + frame.v.y * s) * point.r,
      point.z + (frame.u.z * c + frame.v.z * s) * point.r,
    );
  };

  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const v3 = new THREE.Vector3();
  const n0 = new THREE.Vector3();
  const n1 = new THREE.Vector3();

  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const frame = frames[i];
    for (let j = 0; j < radialSegments; j += 1) {
      const t0 = (j / radialSegments) * Math.PI * 2;
      const t1 = ((j + 1) / radialSegments) * Math.PI * 2;
      corner(a, frame, t0, v0);
      corner(b, frame, t0, v1);
      corner(b, frame, t1, v2);
      corner(a, frame, t1, v3);
      n0.set(
        frame.u.x * Math.cos(t0) + frame.v.x * Math.sin(t0),
        frame.u.y * Math.cos(t0) + frame.v.y * Math.sin(t0),
        frame.u.z * Math.cos(t0) + frame.v.z * Math.sin(t0),
      );
      n1.set(
        frame.u.x * Math.cos(t1) + frame.v.x * Math.sin(t1),
        frame.u.y * Math.cos(t1) + frame.v.y * Math.sin(t1),
        frame.u.z * Math.cos(t1) + frame.v.z * Math.sin(t1),
      );

      position.push(v0.x, v0.y, v0.z, v1.x, v1.y, v1.z, v2.x, v2.y, v2.z);
      normal.push(n0.x, n0.y, n0.z, n0.x, n0.y, n0.z, n1.x, n1.y, n1.z);
      position.push(v0.x, v0.y, v0.z, v2.x, v2.y, v2.z, v3.x, v3.y, v3.z);
      normal.push(n0.x, n0.y, n0.z, n1.x, n1.y, n1.z, n1.x, n1.y, n1.z);
    }
  }
}

/** 把叶片实例变成小面片几何。 */
function appendLeaves(
  position: number[],
  normal: number[],
  color: number[],
  sway: number[],
  leaves: LeafInstance[],
): void {
  const euler = new THREE.Euler();
  const quat = new THREE.Quaternion();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const nrm = new THREE.Vector3();

  for (const leaf of leaves) {
    euler.set(leaf.rx, leaf.ry, leaf.rz);
    quat.setFromEuler(euler);
    right.set(1, 0, 0).applyQuaternion(quat).multiplyScalar(leaf.size * 0.5);
    up.set(0, 1, 0).applyQuaternion(quat).multiplyScalar(leaf.size * 0.42);
    nrm.crossVectors(right, up).normalize();

    const cx = leaf.x;
    const cy = leaf.y;
    const cz = leaf.z;

    const corners: [number, number, number][] = [
      [cx - right.x - up.x, cy - right.y - up.y, cz - right.z - up.z],
      [cx + right.x - up.x, cy + right.y - up.y, cz + right.z - up.z],
      [cx + right.x + up.x, cy + right.y + up.y, cz + right.z + up.z],
      [cx - right.x + up.x, cy - right.y + up.y, cz - right.z + up.z],
    ];
    const order = [0, 1, 2, 0, 2, 3];
    for (const index of order) {
      const c = corners[index];
      position.push(c[0], c[1], c[2]);
      normal.push(nrm.x, nrm.y, nrm.z);
      color.push(leaf.r, leaf.g, leaf.b);
      sway.push(leaf.sway);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 程序化几何：草丛
 * ------------------------------------------------------------------ */

interface GrassBlade {
  /** 根部世界坐标。 */
  x: number;
  y: number;
  z: number;
  /** 叶高（米）。 */
  height: number;
  /** 叶宽（米）。 */
  width: number;
  /** 叶片绕 y 轴的朝向。 */
  yaw: number;
  /** 叶片前倾角（弧度）。 */
  tilt: number;
  /** 明暗系数。 */
  tint: number;
}

const GRASS_BASE_COLOR = new THREE.Color(MOSS_COLOR);

/**
 * 把草叶写成竖着的小面片几何。
 * 顶点色与摆动权重直接写进和树叶一致的缓冲，所以材质可以完全复用。
 */
function appendGrass(
  position: number[],
  normal: number[],
  color: number[],
  sway: number[],
  blades: GrassBlade[],
): void {
  const side = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const base = new THREE.Vector3();
  const mid = new THREE.Vector3();
  const tip = new THREE.Vector3();
  const left = new THREE.Vector3();
  const right = new THREE.Vector3();
  const midLeft = new THREE.Vector3();
  const midRight = new THREE.Vector3();

  const push = (vertex: THREE.Vector3, weight: number, r: number, g: number, b: number): void => {
    position.push(vertex.x, vertex.y, vertex.z);
    normal.push(nrm.x, nrm.y, nrm.z);
    color.push(r, g, b);
    sway.push(weight);
  };

  for (const blade of blades) {
    const c = Math.cos(blade.yaw);
    const s = Math.sin(blade.yaw);
    // 叶片斜着往外长（不是竖直的针），法线因此偏上，吃得到月光
    const lean = Math.cos(blade.tilt);
    const rise = Math.sin(blade.tilt);
    dir.set(s * lean, rise, c * lean).normalize();
    side.set(c, 0, -s);
    nrm.crossVectors(dir, side).normalize();

    base.set(blade.x, blade.y, blade.z);
    mid.copy(base).addScaledVector(dir, blade.height * 0.56);
    tip.copy(base).addScaledVector(dir, blade.height);

    const halfWidth = blade.width * 0.5;
    const tipHalf = halfWidth * 0.35;
    left.copy(base).addScaledVector(side, halfWidth);
    right.copy(base).addScaledVector(side, -halfWidth);
    midLeft.copy(tip).addScaledVector(side, tipHalf);
    midRight.copy(tip).addScaledVector(side, -tipHalf);

    const tint = blade.tint;
    const r = GRASS_BASE_COLOR.r * tint;
    const g = GRASS_BASE_COLOR.g * tint;
    const b = GRASS_BASE_COLOR.b * tint;

    // 一片扁平的叶子：四个角，两片三角形
    push(left, 0, r, g, b);
    push(right, 0, r, g, b);
    push(midRight, 1, r, g, b);
    push(left, 0, r, g, b);
    push(midRight, 1, r, g, b);
    push(midLeft, 1, r, g, b);
  }
}

/* ------------------------------------------------------------------ *
 * 程序化几何：石头
 * ------------------------------------------------------------------ */

/** 一块有厚度的踏步石：多边形柱体 + 顶点扰动，像被凿平的石头。 */
function createSteppingStoneGeometry(radius: number, height: number, seed: number): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(radius, radius * 0.9, height, 9, 2);
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const offset = seed * 5.13;

  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const n = fbm2D(x * 2.4 + offset, z * 2.4 + offset * 0.5, 3);
    const k = 0.86 + n * 0.3;
    // 顶面略微起伏，避免变成一个完美的圆饼
    const bump = y > 0 ? (n - 0.5) * height * 0.55 : 0;
    position.setXYZ(i, x * k, y + bump, z * k);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

/** 一块不规则的踏步石 / 岩石。 */
function createStoneGeometry(radius: number, seed: number, flatten: number): THREE.BufferGeometry {
  const geometry = new THREE.IcosahedronGeometry(radius, 2);
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const offset = seed * 3.77;

  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const n = fbm2D(x * 1.6 + offset, z * 1.6 + offset * 0.5, 3);
    const k = 0.76 + n * 0.46;
    position.setXYZ(i, x * k, y * k * flatten, z * k);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

/* ------------------------------------------------------------------ *
 * 场景
 * ------------------------------------------------------------------ */

function createMoonlightGarden(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'moonlight-garden';

  const quality = THREE.MathUtils.clamp(ctx.quality, 0.5, 2);
  const random = createRandom(88113);
  const textures: THREE.Texture[] = [];

  /* ---------------- 相机（完全固定） ---------------- */

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 600);
  const seatGround = groundHeight(0, CAMERA_DISTANCE);
  const cameraHeight = seatGround + EYE_HEIGHT;
  const targetY = cameraHeight - CAMERA_DISTANCE * Math.tan(THREE.MathUtils.degToRad(PITCH_DEG));
  camera.position.set(0, cameraHeight, CAMERA_DISTANCE);
  camera.lookAt(0, targetY, 0);
  camera.updateProjectionMatrix();

  /* ---------------- 共享 uniform ---------------- */

  const skyUniforms = {
    uSkyZenith: { value: new THREE.Color(SKY_ZENITH) },
    uSkyHorizon: { value: new THREE.Color(SKY_HORIZON) },
    uSkyGround: { value: new THREE.Color(SKY_GROUND) },
    uHorizonGlow: { value: new THREE.Color(HORIZON_GLOW) },
    uMoonDir: { value: MOON_DIR.clone() },
    uMoonColor: { value: new THREE.Color(MOON_COLOR) },
    uMoonBrightness: { value: DEFAULT_PARAMS.moon },
    uMoonRadius: { value: 0.052 },
    uCloud: { value: DEFAULT_PARAMS.cloud },
  };

  const params: GardenParams = { ...DEFAULT_PARAMS };
  const target: GardenParams = { ...DEFAULT_PARAMS };

  /* ---------------- 天穹 ---------------- */

  const skyMaterial = new THREE.ShaderMaterial({
    uniforms: skyUniforms,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vDir;
      ${GLSL_HASH}
      ${GLSL_SKY}
      ${GLSL_OUTPUT_FUNCS}
      void main() {
        gl_FragColor = vec4( moonlitSky( vDir ), 1.0 );
        ${GLSL_OUTPUT}
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });

  const sky = new THREE.Mesh(new THREE.SphereGeometry(460, 48, 28), skyMaterial);
  sky.name = 'night-sky';
  sky.renderOrder = -1000;
  sky.frustumCulled = false;
  root.add(sky);

  // 月亮的柔光精灵：让月心更亮一点
  const glowTexture = createGlowTexture(128, 2.4);
  textures.push(glowTexture);
  const moonGlow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture,
      color: 0xdfeaff,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  moonGlow.name = 'moon-glow';
  moonGlow.position.copy(MOON_WORLD);
  moonGlow.scale.setScalar(190);
  moonGlow.renderOrder = -999;
  root.add(moonGlow);

  /* ---------------- 远山（2~3 层剪影） ---------------- */

  const ridgeTexture = createRidgeTexture({
    width: 512,
    height: 256,
    color: '#1d3448',
    seed: 7712,
    layers: 9,
    amplitude: 0.66,
    base: 0.1,
  });
  const ridgeFarTexture = createRidgeTexture({
    width: 512,
    height: 256,
    color: '#2a475e',
    seed: 3391,
    layers: 5,
    amplitude: 0.5,
    base: 0.08,
  });
  textures.push(ridgeTexture, ridgeFarTexture);

  // 远山的剪影用 alphaTest 切成硬边（写深度），云层才能正确地被山挡住
  const ridgeMaterial = new THREE.MeshBasicMaterial({
    map: ridgeTexture,
    alphaTest: 0.5,
    depthWrite: true,
    fog: true,
  });
  const ridgeFarMaterial = new THREE.MeshBasicMaterial({
    map: ridgeFarTexture,
    alphaTest: 0.5,
    depthWrite: true,
    fog: true,
  });

  const ridgeFar = new THREE.Mesh(new THREE.PlaneGeometry(1100, 150), ridgeFarMaterial);
  ridgeFar.name = 'ridge-far';
  ridgeFar.position.set(0, 30, -330);
  ridgeFar.renderOrder = -902;
  root.add(ridgeFar);

  const ridgeMid = new THREE.Mesh(new THREE.PlaneGeometry(820, 100), ridgeMaterial);
  ridgeMid.name = 'ridge-mid';
  ridgeMid.position.set(0, 22, -250);
  ridgeMid.renderOrder = -901;
  root.add(ridgeMid);

  const ridgeNear = new THREE.Mesh(new THREE.PlaneGeometry(430, 54), ridgeMaterial);
  ridgeNear.name = 'ridge-near';
  ridgeNear.position.set(-20, 11, -168);
  ridgeNear.rotation.y = 0.1;
  ridgeNear.renderOrder = -900;
  root.add(ridgeNear);

  /* ---------------- 地面（苔地 + 岸） ---------------- */

  const mossTexture = createMossTexture(256);
  textures.push(mossTexture);
  mossTexture.repeat.set(84, 76);

  const groundWidth = 150;
  const groundDepth = 130;
  const groundSegments = Math.max(48, Math.round(150 * quality));
  const groundGeometry = new THREE.PlaneGeometry(
    groundWidth,
    groundDepth,
    groundSegments,
    Math.round(groundSegments * (groundDepth / groundWidth)),
  );
  groundGeometry.rotateX(-Math.PI / 2);
  {
    const position = groundGeometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < position.count; i += 1) {
      const x = position.getX(i);
      const z = position.getZ(i) - 22;
      position.setX(i, x);
      position.setZ(i, z);
      position.setY(i, groundHeight(x, z));
    }
    position.needsUpdate = true;
    groundGeometry.computeVertexNormals();
  }

  const groundMaterial = new THREE.MeshStandardMaterial({
    // 颜色由贴图决定，这里只做一点点偏冷的修正
    color: 0xe6ece2,
    map: mossTexture,
    roughness: 0.98,
    metalness: 0,
  });
  groundMaterial.envMap = ctx.env.envMap;
  groundMaterial.envMapIntensity = 0.2;

  const ground = new THREE.Mesh(groundGeometry, groundMaterial);
  ground.name = 'moss-ground';
  ground.receiveShadow = true;
  root.add(ground);

  /* ---------------- 水面 ---------------- */

  const waterUniforms = {
    ...skyUniforms,
    uTime: { value: 0 },
    uRippleAmp: { value: 1 },
    uRain: { value: 0 },
    uMist: { value: DEFAULT_PARAMS.mist },
    uSparkle: { value: 1 },
    uFogNear: { value: 30 },
    uFogFar: { value: 210 },
    uWaterDeep: { value: new THREE.Color(WATER_DEEP) },
    uWaterShallow: { value: new THREE.Color(WATER_SHALLOW) },
    uShoreColor: { value: new THREE.Color(SHORE_COLOR) },
    uFogColor: { value: new THREE.Color(FOG_COLOR) },
    uMoonPathDir: { value: MOON_DIR.clone() },
  };

  const waterMaterial = new THREE.ShaderMaterial({
    uniforms: waterUniforms,
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    side: THREE.FrontSide,
  });

  const waterGeometry = new THREE.PlaneGeometry(
    150,
    150,
    Math.round(90 * quality),
    Math.round(90 * quality),
  );
  waterGeometry.rotateX(-Math.PI / 2);
  const water = new THREE.Mesh(waterGeometry, waterMaterial);
  water.name = 'still-pond';
  water.position.set(0, 0, -45);
  root.add(water);

  /* ---------------- 云层 ---------------- */

  const cloudUniformSets: { uTime: { value: number }; uOpacity: { value: number }; uDrift: { value: number } }[] = [];
  const cloudPlacements: [number, number, number, number][] = [
    // [z, y, width, height]
    [-285, 74, 1200, 130],
    [-235, 62, 900, 100],
    [-180, 52, 700, 78],
  ];
  for (let i = 0; i < cloudPlacements.length; i += 1) {
    const [z, y, width, height] = cloudPlacements[i];
    const uniforms = {
      uTime: { value: 0 },
      uOpacity: { value: 0.0 },
      uDrift: { value: 0.0025 + i * 0.0014 },
      uSeed: { value: i * 13.7 },
      uColor: { value: new THREE.Color(0x2b4a5c) },
      uMoonWorld: { value: MOON_WORLD.clone() },
    };
    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: CLOUD_VERT,
      fragmentShader: CLOUD_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      fog: false,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
    mesh.name = `cloud-layer-${i}`;
    mesh.position.set(0, y, z);
    mesh.renderOrder = -800 + i;
    root.add(mesh);
    cloudUniformSets.push(uniforms);
  }

  /* ---------------- 灯光 ---------------- */

  const moonLight = new THREE.DirectionalLight(0xbcd6f2, 0.78);
  moonLight.position.copy(MOON_DIR).multiplyScalar(60);
  moonLight.target.position.set(0, 0, -6);
  root.add(moonLight);
  root.add(moonLight.target);

  // 天光：几乎垂直落下来的冷色柔光，只负责把地面与前景从死黑里拉出来
  const skyLight = new THREE.DirectionalLight(0x8fb0d6, 0.26);
  skyLight.position.set(9, 26, 6);
  skyLight.target.position.set(0, 0, -8);
  root.add(skyLight);
  root.add(skyLight.target);

  const skyFill = new THREE.HemisphereLight(0x2d5670, 0x0a1410, 0.30);
  root.add(skyFill);

  const ambient = new THREE.AmbientLight(0x16283a, 0.22);
  root.add(ambient);

  // 亭子附近的一点暖色补光（模拟灯笼洒在木构上的光）
  const lanternFill = new THREE.PointLight(0xffa64d, 0.0, 16, 2);
  lanternFill.position.set(PAVILION_POS.x, 2.4, PAVILION_POS.z);
  root.add(lanternFill);

  /* ---------------- 树 ---------------- */

  const branchPosition: number[] = [];
  const branchNormal: number[] = [];
  const leafPosition: number[] = [];
  const leafNormal: number[] = [];
  const leafColor: number[] = [];
  const leafSway: number[] = [];

  const cherryColor = new THREE.Color(CHERRY_LEAF);
  const mapleColor = new THREE.Color(MAPLE_LEAF);

  const plantTree = (
    x: number,
    z: number,
    height: number,
    spread: number,
    kind: 'cherry' | 'maple',
    leafScale: number,
    density = 1,
  ): void => {
    const base = groundHeight(x, z);
    const tree = buildTree({
      x,
      y: base - 0.1,
      z,
      height,
      spread,
      lean: 0.12 + random() * 0.18,
      yaw: random() * Math.PI * 2,
      color: kind === 'cherry' ? cherryColor : mapleColor,
      leafSize: 0.23 * leafScale,
      leafCount: Math.round((kind === 'cherry' ? 1150 : 980) * quality * leafScale * density),
      random,
    });
    for (const branch of tree.branches) appendTube(branchPosition, branchNormal, branch, 6);
    appendLeaves(leafPosition, leafNormal, leafColor, leafSway, tree.leaves);
  };

  // 框住画面的两棵大树：左侧贴着画面左缘，右侧退到亭子外侧
  plantTree(-8.6, 1.6, 10.8, 4.4, 'maple', 1.4, 1.7);
  plantTree(19.6, -9.0, 10.2, 4.0, 'cherry', 1.3, 0.85);

  // 远岸的树线：樱花与红枫交错
  for (let i = 0; i < 24; i += 1) {
    const x = -31 + (i / 23) * 66 + (random() - 0.5) * 2.2;
    const z = farShoreZ(x) - 1.5 - random() * 6.5;
    const kind = i % 2 === 0 ? 'cherry' : 'maple';
    plantTree(x, z, 7.4 + random() * 4.4, 2.6, kind, 0.96, 0.42);
  }

  // 岸边零星的几棵
  plantTree(-12.5, -12, 7.2, 2.6, 'cherry', 1, 0.42);
  plantTree(22.5, -24, 7.4, 2.6, 'maple', 0.96, 0.4);
  plantTree(15.8, -27, 8.6, 3.2, 'cherry', 1.02, 0.5);

  const branchGeometry = new THREE.BufferGeometry();
  branchGeometry.setAttribute('position', new THREE.Float32BufferAttribute(branchPosition, 3));
  branchGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(branchNormal, 3));

  const barkMaterial = new THREE.MeshStandardMaterial({
    color: 0x2b231c,
    roughness: 0.95,
    metalness: 0,
  });
  barkMaterial.envMap = ctx.env.envMap;
  barkMaterial.envMapIntensity = 0.05;

  const branches = new THREE.Mesh(branchGeometry, barkMaterial);
  branches.name = 'tree-branches';
  branches.castShadow = true;
  root.add(branches);

  const leafGeometry = new THREE.BufferGeometry();
  leafGeometry.setAttribute('position', new THREE.Float32BufferAttribute(leafPosition, 3));
  leafGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(leafNormal, 3));
  leafGeometry.setAttribute('aColor', new THREE.Float32BufferAttribute(leafColor, 3));
  leafGeometry.setAttribute('aSway', new THREE.Float32BufferAttribute(leafSway, 1));

  const leafUniforms = {
    uTime: { value: 0 },
    uWind: { value: DEFAULT_PARAMS.wind },
    uSwaySpeed: { value: 0.42 },
    uMoonDir: { value: MOON_DIR.clone() },
    uMoonColor: { value: new THREE.Color(MOON_COLOR) },
    uMoonBrightness: { value: DEFAULT_PARAMS.moon },
    uSkyFill: { value: new THREE.Color(0x16323f) },
    uLanternPos: { value: new THREE.Vector3(PAVILION_POS.x, 2.0, PAVILION_POS.z) },
    uLanternColor: { value: new THREE.Color(0xffa64d) },
    uLanternIntensity: { value: 0 },
    uFogColor: { value: new THREE.Color(FOG_COLOR) },
    uFogNear: { value: 34 },
    uFogFar: { value: 120 },
  };

  const leafMaterial = new THREE.ShaderMaterial({
    uniforms: leafUniforms,
    vertexShader: LEAF_VERT,
    fragmentShader: LEAF_FRAG,
    side: THREE.DoubleSide,
  });

  const leaves = new THREE.Mesh(leafGeometry, leafMaterial);
  leaves.name = 'tree-leaves';
  leaves.frustumCulled = false;
  root.add(leaves);

  /* ---------------- 亭子 ---------------- */

  const pavilion = new THREE.Group();
  pavilion.name = 'pavilion';
  pavilion.position.set(
    PAVILION_POS.x,
    groundHeight(PAVILION_POS.x, PAVILION_POS.z),
    PAVILION_POS.z,
  );
  pavilion.rotation.y = -0.5;
  pavilion.scale.setScalar(1.1);
  root.add(pavilion);

  const woodMaterial = new THREE.MeshStandardMaterial({
    color: 0x6d4e36,
    roughness: 0.88,
    metalness: 0,
  });
  woodMaterial.envMap = ctx.env.envMap;
  woodMaterial.envMapIntensity = 0.05;

  const roofMaterial = new THREE.MeshStandardMaterial({
    color: 0x463d34,
    roughness: 0.92,
    metalness: 0,
  });
  roofMaterial.envMap = ctx.env.envMap;
  roofMaterial.envMapIntensity = 0.05;

  const stoneMaterial = new THREE.MeshStandardMaterial({
    color: 0x555f66,
    roughness: 0.95,
    metalness: 0,
    flatShading: true,
  });
  stoneMaterial.envMap = ctx.env.envMap;
  stoneMaterial.envMapIntensity = 0.06;

  // 台基
  const platform = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.3, 3.6), stoneMaterial);
  platform.name = 'pavilion-platform';
  platform.position.y = 0.15;
  pavilion.add(platform);

  // 柱
  const pillarGeometry = new THREE.CylinderGeometry(0.11, 0.13, 2.3, 8);
  const pillarPositions: [number, number][] = [
    [-1.45, -1.45],
    [1.45, -1.45],
    [-1.45, 1.45],
    [1.45, 1.45],
    [0, -1.45],
    [0, 1.45],
  ];
  for (const [px, pz] of pillarPositions) {
    const pillar = new THREE.Mesh(pillarGeometry, woodMaterial);
    pillar.name = 'pavilion-pillar';
    pillar.position.set(px, 0.3 + 1.15, pz);
    pillar.castShadow = true;
    pavilion.add(pillar);
  }

  // 梁
  const beamLong = new THREE.BoxGeometry(3.3, 0.14, 0.16);
  const beamShort = new THREE.BoxGeometry(0.16, 0.14, 3.3);
  for (const bz of [-1.45, 1.45]) {
    const beam = new THREE.Mesh(beamLong, woodMaterial);
    beam.name = 'pavilion-beam';
    beam.position.set(0, 2.52, bz);
    pavilion.add(beam);
  }
  for (const bx of [-1.45, 1.45]) {
    const beam = new THREE.Mesh(beamShort, woodMaterial);
    beam.name = 'pavilion-beam';
    beam.position.set(bx, 2.52, 0);
    pavilion.add(beam);
  }

  // 屋顶：两段四坡
  const roofLower = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 3.3, 0.85, 4, 1, true), roofMaterial);
  roofLower.name = 'pavilion-roof';
  roofLower.position.y = 2.98;
  roofLower.rotation.y = Math.PI / 4;
  roofLower.castShadow = true;
  pavilion.add(roofLower);

  const roofUpper = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 1.9, 0.7, 4, 1, true), roofMaterial);
  roofUpper.name = 'pavilion-roof';
  roofUpper.position.y = 3.72;
  roofUpper.rotation.y = Math.PI / 4;
  pavilion.add(roofUpper);

  const finial = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), roofMaterial);
  finial.name = 'pavilion-finial';
  finial.position.y = 4.14;
  pavilion.add(finial);

  // 纸灯笼：画面里唯一的暖色
  const lanternGeometry = new THREE.CylinderGeometry(0.17, 0.17, 0.42, 12, 1, true);
  const lanternMaterial = new THREE.MeshStandardMaterial({
    color: 0xd8b184,
    emissive: new THREE.Color(LANTERN_COLOR),
    emissiveIntensity: 1.6,
    roughness: 0.95,
    metalness: 0,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.92,
  });
  lanternMaterial.envMap = ctx.env.envMap;
  lanternMaterial.envMapIntensity = 0.04;

  const lanterns: THREE.Mesh[] = [];
  const lanternSpots: [number, number, number][] = [
    [-0.72, 2.16, -0.72],
    [0.72, 2.16, -0.72],
    [-0.72, 2.16, 0.72],
    [0.72, 2.16, 0.72],
  ];
  for (const [lx, ly, lz] of lanternSpots) {
    const lantern = new THREE.Mesh(lanternGeometry, lanternMaterial);
    lantern.name = 'paper-lantern';
    lantern.position.set(lx, ly, lz);
    pavilion.add(lantern);
    lanterns.push(lantern);

    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture,
        color: 0xffb264,
        transparent: true,
        opacity: 0.34,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    halo.name = 'lantern-halo';
    halo.position.set(lx, ly, lz);
    halo.scale.setScalar(1.5);
    pavilion.add(halo);
  }

  // 灯笼的暖色点光（只有很小的范围）
  const lanternLight = new THREE.PointLight(0xffa54d, 1.6, 9, 2);
  lanternLight.position.set(0, 2.0, 0);
  pavilion.add(lanternLight);

  /* ---------------- 石灯笼（右岸） ---------------- */

  const stoneLantern = new THREE.Group();
  stoneLantern.name = 'stone-lantern';
  stoneLantern.position.set(
    STONE_LANTERN_POS.x,
    groundHeight(STONE_LANTERN_POS.x, STONE_LANTERN_POS.z),
    STONE_LANTERN_POS.z,
  );
  root.add(stoneLantern);

  const lanternBase = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.42, 0.22, 8), stoneMaterial);
  lanternBase.position.y = 0.11;
  stoneLantern.add(lanternBase);

  const lanternPost = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 0.72, 8), stoneMaterial);
  lanternPost.position.y = 0.58;
  stoneLantern.add(lanternPost);

  const lanternBox = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.3, 0.36, 8), stoneMaterial);
  lanternBox.position.y = 1.12;
  stoneLantern.add(lanternBox);

  const lanternRoof = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.46, 0.26, 8), stoneMaterial);
  lanternRoof.position.y = 1.43;
  stoneLantern.add(lanternRoof);

  const lanternCap = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), stoneMaterial);
  lanternCap.position.y = 1.6;
  stoneLantern.add(lanternCap);

  const stoneGlow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture,
      color: LANTERN_COLOR,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  stoneGlow.name = 'stone-lantern-glow';
  stoneGlow.position.y = 1.12;
  stoneGlow.scale.setScalar(0.95);
  stoneLantern.add(stoneGlow);

  // 石灯笼里的那点烛火
  const stoneLanternLight = new THREE.PointLight(0xffa54d, 1.5, 7, 2);
  stoneLanternLight.position.y = 1.12;
  stoneLantern.add(stoneLanternLight);

  /* ---------------- 汀步（踏步石） ---------------- */

  // 一条从脚边踏过苔地、通向水面的石径。石头有厚度，半埋在苔里，
  // 最后一块刚好探到水线。
  const steppingStoneGeometry = createSteppingStoneGeometry(0.31, 0.17, 31);
  const steppingStoneMaterial = new THREE.MeshStandardMaterial({
    color: 0x99a1a7,
    roughness: 0.6,
    metalness: 0,
    flatShading: true,
  });
  steppingStoneMaterial.envMap = ctx.env.envMap;
  steppingStoneMaterial.envMapIntensity = 0.06;

  const steppingStones: THREE.Mesh[] = [];
  const stonePath: { x: number; z: number }[] = [];
  for (let i = 0; i < 10; i += 1) {
    const t = i / 9;
    const z = 14.7 - t * 3.1;
    const x = Math.sin(t * 2.1) * 0.9 - 0.35 + (random() - 0.5) * 0.22;
    stonePath.push({ x, z });
  }
  for (let i = 0; i < stonePath.length; i += 1) {
    const { x, z } = stonePath[i];
    const stone = new THREE.Mesh(steppingStoneGeometry, steppingStoneMaterial);
    stone.name = 'stepping-stone';
    const ground = groundHeight(x, z);
    // 半埋进苔地；靠水的那几块坐在水线上，露出水面一点点
    stone.position.set(x, Math.max(ground, -0.02) + 0.062, z);
    stone.rotation.set((random() - 0.5) * 0.1, random() * Math.PI, (random() - 0.5) * 0.1);
    stone.scale.set(0.85 + random() * 0.35, 0.85 + random() * 0.35, 0.85 + random() * 0.35);
    stone.castShadow = true;
    stone.receiveShadow = true;
    root.add(stone);
    steppingStones.push(stone);
  }

  // 苔地上的草丛：直接复用叶片材质，所以同样吃月光和灯笼的暖光
  const grassPosition: number[] = [];
  const grassNormal: number[] = [];
  const grassColor: number[] = [];
  const grassSway: number[] = [];
  const grassBlades: GrassBlade[] = [];
  for (let i = 0; i < 320; i += 1) {
    const cx = (random() - 0.5) * 21;
    const cz = 12.0 + random() * 5.4;
    const base = groundHeight(cx, cz);
    if (base < 0.05) continue;
    // 让开石径
    let onPath = false;
    for (const step of stonePath) {
      if (Math.abs(step.x - cx) < 0.8 && Math.abs(step.z - cz) < 0.8) {
        onPath = true;
        break;
      }
    }
    if (onPath) continue;
    // 一簇一簇地长，比均匀撒落更像苔地上的草丛
    const bladeCount = 4 + Math.floor(random() * 4);
    for (let b = 0; b < bladeCount; b += 1) {
      const angle = random() * Math.PI * 2;
      const radius = random() * 0.1;
      grassBlades.push({
        x: cx + Math.cos(angle) * radius,
        y: base - 0.02,
        z: cz + Math.sin(angle) * radius,
        height: 0.05 + random() * 0.05,
        width: 0.035 + random() * 0.03,
        yaw: random() * Math.PI * 2,
        tilt: 0.34 + random() * 0.34,
        tint: 0.86 + random() * 0.26,
      });
    }
  }
  appendGrass(grassPosition, grassNormal, grassColor, grassSway, grassBlades);

  if (grassBlades.length > 0) {
    const grassGeometry = new THREE.BufferGeometry();
    grassGeometry.setAttribute('position', new THREE.Float32BufferAttribute(grassPosition, 3));
    grassGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(grassNormal, 3));
    grassGeometry.setAttribute('aColor', new THREE.Float32BufferAttribute(grassColor, 3));
    grassGeometry.setAttribute('aSway', new THREE.Float32BufferAttribute(grassSway, 1));
    const grass = new THREE.Mesh(grassGeometry, leafMaterial);
    grass.name = 'bank-grass';
    grass.frustumCulled = false;
    root.add(grass);
  }

  // 岸边散落的小石头
  const pebbleGeometry = createStoneGeometry(0.22, 57, 0.55);
  const pebbleMaterial = new THREE.MeshStandardMaterial({
    color: 0x6a7176,
    roughness: 0.96,
    metalness: 0,
    flatShading: true,
  });
  pebbleMaterial.envMap = ctx.env.envMap;
  pebbleMaterial.envMapIntensity = 0.05;
  for (let i = 0; i < 18; i += 1) {
    const side = random() < 0.5 ? -1 : 1;
    const x = side * (5 + random() * 16);
    const z = 8 - random() * 52;
    if (Math.abs(x) < 7 && z > nearShoreZ(x)) continue;
    const pebble = new THREE.Mesh(pebbleGeometry, pebbleMaterial);
    pebble.name = 'pebble';
    pebble.position.set(x, groundHeight(x, z) + 0.04, z);
    pebble.rotation.set(random() * 0.6, random() * Math.PI, random() * 0.6);
    pebble.scale.setScalar(0.6 + random() * 0.9);
    root.add(pebble);
  }

  /* ---------------- 水面薄雾 ---------------- */

  const mistSpace = new ParticleSpace({ radius: 24, position: [-2, 0.35, -18], spin: 0.004, tilt: 0.02 });
  const mistField = createGroundMistField(mistSpace, {
    count: Math.round(150 * quality),
    radius: 24,
    height: 0.55,
    size: 3.4,
    opacity: 0.1,
    color: 0x9fc4c8,
    seed: 771,
  });
  mistField.points.name = 'pond-mist';
  root.add(mistField.points);
  root.add(mistSpace.group);

  /* ---------------- 萤火 ---------------- */

  const fireflySpace = new ParticleSpace({ radius: 1, position: [0, 0, 0], spin: 0, tilt: 0 });
  const fireflyCount = Math.round(44 * quality);
  const fireflyPositions = new Float32Array(fireflyCount * 3);
  const fireflySizes = new Float32Array(fireflyCount);
  const fireflyPhases = new Float32Array(fireflyCount);
  for (let i = 0; i < fireflyCount; i += 1) {
    fireflyPositions[i * 3] = -15 + random() * 24;
    fireflyPositions[i * 3 + 1] = 0.15 + random() * 1.7;
    fireflyPositions[i * 3 + 2] = -42 + random() * 50;
    fireflySizes[i] = 0.05 + random() * 0.05;
    fireflyPhases[i] = random() * Math.PI * 2;
  }
  const fireflyGeometry = new THREE.BufferGeometry();
  fireflyGeometry.setAttribute('position', new THREE.BufferAttribute(fireflyPositions, 3));
  fireflyGeometry.setAttribute('aSize', new THREE.BufferAttribute(fireflySizes, 1));
  fireflyGeometry.setAttribute('aPhase', new THREE.BufferAttribute(fireflyPhases, 1));

  const fireflyUniforms = {
    uTime: { value: 0 },
    uScale: { value: 600 },
    uOpacity: { value: 1 },
    uBrightness: { value: 1.4 },
    particleMatrix: fireflySpace.uniform,
  };
  const fireflyMaterial = new THREE.ShaderMaterial({
    uniforms: fireflyUniforms,
    vertexShader: FIREFLY_VERT,
    fragmentShader: FIREFLY_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const fireflies = new THREE.Points(fireflyGeometry, fireflyMaterial);
  fireflies.name = 'fireflies';
  fireflies.frustumCulled = false;
  root.add(fireflies);

  /* ---------------- 雨（雨夜模式） ---------------- */

  const rainSpace = new ParticleSpace({ radius: 20, position: [-1, 7, -12], spin: 0, tilt: 0 });
  const rain = createRainStreaks(rainSpace, {
    count: Math.round(420 * quality),
    radius: 20,
    height: 16,
    color: new THREE.Color(0xa8c6de),
    seed: 5150,
    lights: [new THREE.Vector3(PAVILION_POS.x, 2.0, PAVILION_POS.z)],
    fogColor: new THREE.Color(FOG_COLOR),
    fogNear: 14,
    fogFar: 52,
  });
  rain.lines.name = 'rain';
  rain.lines.visible = false;
  root.add(rain.lines);
  root.add(rainSpace.group);

  /* ---------------- 声音图层基线 ---------------- */

  const layers: LayerBaseline[] = [
    { id: 'wind', base: 0.5, mix: 0.5 },
    { id: 'water', base: 0.45, mix: 0.45 },
    { id: 'insects', base: 0.35, mix: 0.35 },
    { id: 'music', base: 0.4, mix: 0.4 },
    { id: 'rain', base: 0.7, mix: 0 },
  ];

  const layerMix = (id: string): number => layers.find((layer) => layer.id === id)?.mix ?? 0;

  /* ---------------- 每帧更新 ---------------- */

  const updateScale = (context: SceneContext): void => {
    const halfFov = THREE.MathUtils.degToRad(FOV) * 0.5;
    const scale = (context.height * 0.5 * context.renderer.getPixelRatio()) / Math.tan(halfFov);
    mistField.uniforms.uScale.value = scale;
    fireflyUniforms.uScale.value = scale;
  };
  updateScale(ctx);

  const applyParams = (): void => {
    skyUniforms.uCloud.value = params.cloud;
    skyUniforms.uMoonBrightness.value = params.moon;
    waterUniforms.uCloud.value = params.cloud;
    waterUniforms.uMoonBrightness.value = params.moon;
    waterUniforms.uRain.value = params.rain;
    waterUniforms.uMist.value = params.mist;
    waterUniforms.uRippleAmp.value = 0.85 + params.wind * 0.5 + params.rain * 0.25;
    waterUniforms.uSparkle.value = 0.55 + layerMix('water') * 0.9;
    leafUniforms.uWind.value = 0.35 + params.wind * 1.5;
    leafUniforms.uMoonBrightness.value = params.moon;
    leafUniforms.uLanternIntensity.value = 0.16 + (1 - params.moon) * 0.22;
    leafUniforms.uSkyFill.value.setHex(SKY_HORIZON).multiplyScalar(0.7 + params.mist * 0.35);

    const lanternPower = 0.55 + (1 - params.moon) * 0.75 + params.rain * 0.2;
    lanternMaterial.emissiveIntensity = 1.1 * lanternPower;
    lanternLight.intensity = 1.6 * lanternPower;
    lanternFill.intensity = 0.5 * lanternPower;

    for (let i = 0; i < cloudUniformSets.length; i += 1) {
      cloudUniformSets[i].uOpacity.value = params.cloud * (0.34 - i * 0.07);
    }

    mistField.uniforms.uOpacity.value = 0.06 + params.mist * 0.3;
    waterUniforms.uFogFar.value = 95 - params.mist * 45;

    rain.uniforms.uIntensity.value = params.rain;
    rain.uniforms.uOpacity.value = params.rain * 0.75;
    rain.lines.visible = params.rain > 0.01;

    fireflyUniforms.uOpacity.value = 0.35 + layerMix('insects') * 0.9;
    fireflyUniforms.uBrightness.value = 0.9 + layerMix('insects') * 1.4;
  };
  applyParams();

  return {
    root,
    camera,
    framing: { distance: CAMERA_DISTANCE, height: cameraHeight, targetY },
    immersive: false,
    xrDistance: 3,
    update(time: number, delta: number, context: SceneContext): void {
      // 环境预设的过渡：缓慢逼近目标值，绝不突变
      const lambda = 0.9;
      params.cloud = THREE.MathUtils.damp(params.cloud, target.cloud, lambda, delta);
      params.rain = THREE.MathUtils.damp(params.rain, target.rain, lambda, delta);
      params.mist = THREE.MathUtils.damp(params.mist, target.mist, lambda, delta);
      params.moon = THREE.MathUtils.damp(params.moon, target.moon, lambda, delta);
      params.wind = THREE.MathUtils.damp(params.wind, target.wind, lambda, delta);
      applyParams();

      // 水面
      waterUniforms.uTime.value = time;

      // 树叶：极小幅度的慢摆
      leafUniforms.uTime.value = time;
      leafUniforms.uSwaySpeed.value = 0.28 + params.wind * 0.22;

      // 云：极慢地漂移
      for (let i = 0; i < cloudUniformSets.length; i += 1) {
        cloudUniformSets[i].uTime.value = time * (0.6 + params.wind * 1.4);
      }

      // 灯笼摇曳：几乎察觉不到
      for (let i = 0; i < lanterns.length; i += 1) {
        const lantern = lanterns[i];
        lantern.rotation.z = Math.sin(time * 0.19 + i * 1.7) * 0.035 * (0.5 + params.wind);
        lantern.rotation.x = Math.cos(time * 0.15 + i * 2.3) * 0.028 * (0.5 + params.wind);
      }

      // 月光精灵
      moonGlow.material.opacity = 0.42 * params.moon * (1 - params.cloud * 0.55);

      // 雾与萤火
      mistField.uniforms.uTime.value = time * 0.35;
      mistField.uniforms.uWind.value = 0.10 + params.wind * 0.24;
      mistSpace.update(delta, time);

      fireflyUniforms.uTime.value = time;
      fireflySpace.update(delta, time);

      // 雨
      rain.uniforms.uTime.value = time;

      updateScale(context);
    },
    setMode(mode: SceneMode): void {
      const p = mode.params ?? {};
      target.cloud = THREE.MathUtils.clamp(p.cloud ?? DEFAULT_PARAMS.cloud, 0, 1);
      target.rain = THREE.MathUtils.clamp(p.rain ?? DEFAULT_PARAMS.rain, 0, 1);
      target.mist = THREE.MathUtils.clamp(p.mist ?? DEFAULT_PARAMS.mist, 0, 1);
      target.moon = THREE.MathUtils.clamp(p.moon ?? DEFAULT_PARAMS.moon, 0, 1);
      target.wind = THREE.MathUtils.clamp(p.wind ?? DEFAULT_PARAMS.wind, 0, 1);

      // 声音配比：真正的混音由核心层完成，这里更新场景自己的图层音量基线，
      // 并让它驱动与之对应的画面细节（水声 → 水面碎光，虫鸣 → 萤火，风力 → 摆幅）。
      const audio = mode.audio;
      for (const layer of layers) {
        layer.mix = layer.base * (audio?.[layer.id] ?? 1);
      }
    },
    dispose(): void {
      for (const texture of textures) texture.dispose();
      disposeObject(root);
    },
  };
}

/* ------------------------------------------------------------------ *
 * 场景定义
 * ------------------------------------------------------------------ */

export const moonlightGardenScene: SceneDefinition = {
  id: 'moonlight-garden',
  title: '月夜庭院',
  subtitle: 'Moonlight Garden',
  description: '深青蓝的月夜里，一池静水映着远山上的满月，池边木亭里几盏纸灯笼是唯一的暖色。',
  tags: ['月夜', '庭院', '水面', '助眠'],
  accent: '#79c8d4',
  gradient: ['#123444', '#040910'],
  category: 'environment',
  audioLayers: [
    { id: 'wind', label: '风声', urls: ['garden-wind.mp3'], volume: 0.5 },
    { id: 'water', label: '水声', urls: ['garden-water.mp3'], volume: 0.45 },
    { id: 'insects', label: '虫鸣', urls: ['garden-insects.mp3'], volume: 0.35 },
    { id: 'music', label: '乐声', urls: ['garden-music.mp3'], volume: 0.4 },
    { id: 'rain', label: '雨声', urls: ['garden-rain.mp3'], volume: 0.7 },
  ],
  modes: [
    {
      id: 'clear',
      label: '晴夜',
      params: { cloud: 0.25, rain: 0, mist: 0.35, moon: 1.0, wind: 0.35 },
      audio: { wind: 0.5, water: 0.45, insects: 0.4, music: 0.4, rain: 0 },
    },
    {
      id: 'rain',
      label: '雨夜',
      params: { cloud: 0.85, rain: 1, mist: 0.8, moon: 0.35, wind: 0.9 },
      audio: { wind: 0.85, water: 0.8, insects: 0.12, music: 0.25, rain: 1 },
    },
  ],
  lighting: { exposure: 0.58 },
  create(ctx: SceneContext): SceneInstance {
    return createMoonlightGarden(ctx);
  },
};

export default moonlightGardenScene;
