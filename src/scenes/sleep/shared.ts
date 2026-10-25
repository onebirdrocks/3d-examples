/**
 * 助眠场景共用的「夜」构件。
 *
 * 四个新场景（深海 / 月井 / 孔明灯 / 沙漏）都需要同样的三样东西：
 * - 一个不会露出纯黑的渐变穹顶（夜空的底色）；
 * - 一片缓慢漂浮的柔光尘埃（用核心层的粒子空间承载）；
 * - 一张程序生成的径向渐隐贴图（用来做柔和的落影 / 光晕）。
 *
 * 这里只放真正共用的部分，场景各自的着色器仍然留在各自文件里。
 */
import * as THREE from 'three';
import { GLSL_HASH, GLSL_NOISE2, GLSL_OUTPUT, GLSL_OUTPUT_FUNCS } from './glsl.js';
import { createPointGeometry, createPointMaterial } from './points.js';
import type { ParticleSpace } from '../../core/particle-space.js';

/* ------------------------------------------------------------------ *
 * 夜空穹顶
 * ------------------------------------------------------------------ */

export interface NightDomeOptions {
  /** 正上方的颜色。 */
  zenith: number;
  /** 水平线附近的颜色。 */
  horizon: number;
  /** 正下方的颜色。 */
  ground: number;
  /** 穹顶半径（米）。 */
  radius?: number;
}

export interface NightDome {
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
  vDir = normalize( position );
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const DOME_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uBreath;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;

varying vec3 vDir;

${GLSL_HASH}
${GLSL_NOISE2}
${GLSL_OUTPUT_FUNCS}

void main() {
  float y = vDir.y;

  vec3 col = mix( uHorizon, uZenith, smoothstep( -0.06, 0.72, y ) );
  col = mix( col, uGround, smoothstep( 0.02, -0.42, y ) );

  // 地平线附近留一层极淡的光晕，避免大面积纯黑
  float band = exp( -abs( y ) * 7.0 );
  col += uHorizon * band * ( 0.16 + 0.07 * uBreath );

  // 极缓慢的云状起伏，周期在几十秒以上
  float cloud = fbm2( vec2( atan( vDir.z, vDir.x ) * 1.6, y * 2.4 ) + vec2( uTime * 0.006, uTime * 0.003 ) );
  col *= 0.9 + 0.2 * cloud;

  // 抖动：暗部渐变不出色带
  col += ( hash12( gl_FragCoord.xy ) - 0.5 ) * 0.004;

  gl_FragColor = vec4( col, 1.0 );
  ${GLSL_OUTPUT}
}
`;

/** 一个深色渐变的夜空穹顶（从内部观看）。 */
export function createNightDome(options: NightDomeOptions): NightDome {
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

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(options.radius ?? 90, 40, 24), material);
  mesh.name = 'night-dome';
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;

  return { mesh, uniforms };
}

/* ------------------------------------------------------------------ *
 * 柔光尘埃
 * ------------------------------------------------------------------ */

const MOTE_VERT = /* glsl */ `
attribute float aSize;
attribute float aPhase;

uniform float uTime;
uniform float uScale;
uniform float uOpacity;
uniform float uBreath;
uniform float uLevel;
uniform vec3 uColor;

varying float vAlpha;
varying vec3 vTint;

void main() {
  vec3 p = position;

  // 极缓慢的游动，周期在 50 秒以上
  p.x += sin( uTime * 0.047 + aPhase * 6.2831 ) * 0.16;
  p.y += sin( uTime * 0.034 + aPhase * 9.1 ) * 0.12;
  p.z += cos( uTime * 0.041 + aPhase * 7.7 ) * 0.16;

  vec4 mv = modelViewMatrix * vec4( particleSpaceTransform( p ), 1.0 );
  gl_Position = projectionMatrix * mv;

  // 明暗起伏只有 ±18%，绝不闪烁
  float shimmer = 0.82 + 0.18 * sin( uTime * 0.11 + aPhase * 17.0 );
  vAlpha = shimmer * ( 0.42 + 0.7 * uLevel + 0.22 * uBreath );
  vTint = uColor;

  gl_PointSize = min( uScale * aSize / max( 1.0, -mv.z ), 16.0 );
}
`;

const MOTE_FRAG = /* glsl */ `
precision highp float;

uniform float uOpacity;

varying float vAlpha;
varying vec3 vTint;

${GLSL_OUTPUT_FUNCS}

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot( c, c );
  if ( d2 > 0.25 ) discard;
  float falloff = exp( -d2 * 12.0 );
  float alpha = falloff * vAlpha * uOpacity;
  if ( alpha < 0.004 ) discard;
  gl_FragColor = vec4( vTint, alpha );
  ${GLSL_OUTPUT}
}
`;

export interface MoteField {
  points: THREE.Points;
  uniforms: {
    uTime: { value: number };
    uScale: { value: number };
    uOpacity: { value: number };
    uBreath: { value: number };
    uLevel: { value: number };
  };
}

export interface MoteFieldOptions {
  /** 尘埃颜色。 */
  color: number;
  /** 颗粒基础尺寸（米）。 */
  size?: number;
  /** 随机种子。 */
  seed?: number;
  /** 初始亮度倍率。 */
  opacity?: number;
}

/** 在粒子空间里生成一片缓慢漂浮的柔光尘埃。 */
export function createMoteField(
  space: ParticleSpace,
  count: number,
  options: MoteFieldOptions,
): MoteField {
  const uniforms = {
    uTime: { value: 0 },
    uScale: { value: 600 },
    uOpacity: { value: options.opacity ?? 0.5 },
    uBreath: { value: 0 },
    uLevel: { value: 0 },
    uColor: { value: new THREE.Color(options.color) },
  };

  const geometry = createPointGeometry({
    count,
    seed: options.seed ?? 4711,
    radius: space.radius * 0.92,
    size: options.size ?? 0.03,
  });

  const material = createPointMaterial(space, {
    vertexShader: MOTE_VERT,
    fragmentShader: MOTE_FRAG,
    uniforms,
  });

  const points = new THREE.Points(geometry, material);
  points.name = 'motes';
  points.frustumCulled = false;

  return {
    points,
    uniforms: {
      uTime: uniforms.uTime,
      uScale: uniforms.uScale,
      uOpacity: uniforms.uOpacity,
      uBreath: uniforms.uBreath,
      uLevel: uniforms.uLevel,
    },
  };
}

/* ------------------------------------------------------------------ *
 * 程序生成的贴图
 * ------------------------------------------------------------------ */

/**
 * 径向渐隐贴图：中心不透明、边缘透明。
 * 用于柔和的落影（黑）或柔和的光晕（白）。
 */
export function createRadialTexture(size: number, inner: string, outer: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');

  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, inner);
  gradient.addColorStop(0.55, outer);
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'radial-texture';
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}
