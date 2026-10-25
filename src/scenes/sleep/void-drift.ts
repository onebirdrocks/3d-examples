/**
 * 虚空漂流 / Void Drift
 * ---------------------------------------------------------------
 * 无边深空里缓慢漂浮：密集却极慢的星尘铺满四周，中央一团暗色星云
 * 缓慢自转，远处散着几颗亮星。构图刻意把主体放在画面中心偏上，
 * 四周留出大片黑，让视线有喘息的地方。
 *
 * 音乐如何驱动画面：
 * - `bass` → 整片星尘潮水般涌动（径向推开 + 粒子空间轻微膨胀）；
 * - `pulse` → 星云核心微微明灭，同时核心球体轻微呼吸式缩放；
 * - `level` → 星尘整体亮度；
 * - `treble` → 远处亮星的细微闪烁。
 */
import * as THREE from 'three';
import type { SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { disposeObject } from '../../core/loader.js';
import { ParticleSpace, createRandom } from '../../core/particle-space.js';
import { GLSL_HASH, GLSL_NOISE3, GLSL_OUTPUT, GLSL_OUTPUT_FUNCS } from './glsl.js';
import { SLEEP_CATEGORY, dimLights } from './palette.js';
import { SleepAudioDrive } from './audio-drive.js';
import { createPointGeometry, createPointMaterial, updatePointScale } from './points.js';

const BREATHING = { inhale: 6, hold: 2, exhale: 8 };

const FOV = 55;

/** 星云中心高度（略高于视线，构图偏上）。 */
const NEBULA_Y = 2.05;

/* ------------------------------------------------------------------ *
 * 背景穹顶：几乎纯黑，只留一点冷调渐变
 * ------------------------------------------------------------------ */

const BACKDROP_VERT = /* glsl */ `
varying vec3 vDir;

void main() {
  vDir = normalize( position );
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const BACKDROP_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;

varying vec3 vDir;

${GLSL_OUTPUT_FUNCS}

void main() {
  float y = vDir.y;
  vec3 col = mix( uHorizon, uZenith, smoothstep( -0.05, 0.7, y ) );
  col = mix( col, uGround, smoothstep( 0.0, -0.3, y ) );
  gl_FragColor = vec4( col, 1.0 );
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * 星云：fbm 噪声塑形 + 边缘菲涅尔
 * ------------------------------------------------------------------ */

const NEBULA_VERT = /* glsl */ `
varying vec3 vLocal;
varying vec3 vNormalV;
varying vec3 vViewV;

void main() {
  vLocal = position;
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  vNormalV = normalize( normalMatrix * normal );
  vViewV = normalize( -mv.xyz );
  gl_Position = projectionMatrix * mv;
}
`;

const NEBULA_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uPulse;
uniform float uIntensity;
uniform vec3 uColorDeep;
uniform vec3 uColorWarm;
uniform vec3 uColorCore;

varying vec3 vLocal;
varying vec3 vNormalV;
varying vec3 vViewV;

${GLSL_HASH}
${GLSL_NOISE3}
${GLSL_OUTPUT_FUNCS}

void main() {
  // 极缓慢流动的密度场
  float n = fbm3( vLocal * 1.05 + vec3( uTime * 0.012, uTime * 0.008, -uTime * 0.01 ) );
  float n2 = fbm3( vLocal * 2.7 - vec3( uTime * 0.02, 0.0, uTime * 0.014 ) );
  float density = smoothstep( 0.34, 0.88, n * 0.72 + n2 * 0.36 );

  float ndv = clamp( dot( normalize( vNormalV ), normalize( vViewV ) ), 0.0, 1.0 );

  // 朝向观察者的中心厚实，边缘溶进虚空，避免出现一个硬邦邦的球
  float shape = pow( ndv, 1.35 );

  float alpha = density * shape * uIntensity;
  if ( alpha < 0.004 ) discard;

  vec3 col = mix( uColorDeep, uColorWarm, smoothstep( 0.3, 0.92, n2 ) );

  // 核心：随音乐脉冲微微明灭
  float core = pow( ndv, 2.6 ) * density;
  col += uColorCore * core * ( 0.5 + 2.6 * uPulse );

  gl_FragColor = vec4( col, alpha );
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * 星尘：跑在粒子空间里，被低频推成潮汐
 * ------------------------------------------------------------------ */

const DUST_VERT = /* glsl */ `
attribute float aSize;
attribute float aPhase;

uniform float uTime;
uniform float uScale;
uniform float uBass;
uniform float uLevel;
uniform float uPulse;

varying float vAlpha;
varying vec3 vTint;

void main() {
  vec3 p = position;

  // 极缓慢的个体游动，周期在 60 秒以上
  p.x += sin( uTime * 0.055 + aPhase * 6.2831 ) * 0.38;
  p.y += sin( uTime * 0.041 + aPhase * 10.13 ) * 0.30;
  p.z += cos( uTime * 0.047 + aPhase * 8.37 ) * 0.38;

  // 低频：整片星尘潮水般涌动
  float len = length( p );
  float tide = sin( uTime * 0.13 - len * 0.32 + aPhase * 3.1 );
  p += ( p / max( len, 0.0001 ) ) * tide * ( uBass * 0.55 + uPulse * 0.3 );

  vec4 mv = modelViewMatrix * vec4( particleSpaceTransform( p ), 1.0 );
  gl_Position = projectionMatrix * mv;

  // 明暗起伏极缓，绝不闪烁
  float shimmer = 0.86 + 0.14 * sin( uTime * 0.19 + aPhase * 12.9 );
  vAlpha = shimmer * ( 0.45 + 0.8 * uLevel );
  vTint = mix( vec3( 0.60, 0.68, 0.92 ), vec3( 0.94, 0.86, 0.74 ), aPhase );

  // 限制最大屏幕尺寸：靠近镜头的尘埃不能变成巨大的光斑
  float size = uScale * aSize * ( 0.88 + 0.30 * uBass ) / max( 1.0, -mv.z );
  gl_PointSize = min( size, 6.0 );
}
`;

const DUST_FRAG = /* glsl */ `
precision highp float;

uniform float uOpacity;

varying float vAlpha;
varying vec3 vTint;

${GLSL_OUTPUT_FUNCS}

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot( c, c );
  if ( d2 > 0.25 ) discard;
  float falloff = exp( -d2 * 11.0 );
  float alpha = falloff * vAlpha * uOpacity;
  if ( alpha < 0.004 ) discard;
  gl_FragColor = vec4( vTint, alpha );
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * 远处亮星
 * ------------------------------------------------------------------ */

const STAR_VERT = /* glsl */ `
attribute float aSize;
attribute float aPhase;

uniform float uTime;
uniform float uScale;
uniform float uTreble;

varying float vAlpha;
varying vec3 vTint;

void main() {
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  gl_Position = projectionMatrix * mv;

  // 高频只带来一点极细微的闪动
  float twinkle = 0.72 + 0.28 * sin( uTime * 0.23 + aPhase * 18.4 );
  float sparkle = 1.0 + uTreble * 0.35 * sin( uTime * 0.9 + aPhase * 41.0 );
  vAlpha = twinkle * sparkle;
  vTint = mix( vec3( 0.86, 0.90, 1.0 ), vec3( 1.0, 0.93, 0.82 ), aPhase );

  gl_PointSize = uScale * aSize / max( 1.0, -mv.z );
}
`;

const STAR_FRAG = /* glsl */ `
precision highp float;

uniform float uOpacity;

varying float vAlpha;
varying vec3 vTint;

${GLSL_OUTPUT_FUNCS}

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot( c, c );
  if ( d2 > 0.25 ) discard;
  float core = exp( -d2 * 26.0 );
  float halo = exp( -d2 * 6.0 ) * 0.35;
  float alpha = ( core + halo ) * vAlpha * uOpacity;
  if ( alpha < 0.004 ) discard;
  gl_FragColor = vec4( vTint, alpha );
  ${GLSL_OUTPUT}
}
`;

/** 在远处球壳上撒几颗亮星。 */
function createStarField(count: number): THREE.Points {
  const random = createRandom(90210);
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const phases = new Float32Array(count);

  for (let i = 0; i < count; i += 1) {
    // 球壳上的均匀分布
    const u = random() * 2 - 1;
    const theta = random() * Math.PI * 2;
    const r = Math.sqrt( Math.max( 0, 1 - u * u ) );
    const dist = 46 + random() * 26;
    positions[i * 3] = Math.cos( theta ) * r * dist;
    positions[i * 3 + 1] = u * dist * 0.7 + 6;
    positions[i * 3 + 2] = Math.sin( theta ) * r * dist;
    sizes[i] = 0.34 + random() * 0.5;
    phases[i] = random();
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
  geometry.setAttribute( 'aSize', new THREE.BufferAttribute( sizes, 1 ) );
  geometry.setAttribute( 'aPhase', new THREE.BufferAttribute( phases, 1 ) );

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uScale: { value: 600 },
      uTreble: { value: 0 },
      uOpacity: { value: 0.75 },
    },
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  } );

  const points = new THREE.Points( geometry, material );
  points.name = 'stars';
  points.frustumCulled = false;
  return points;
}

function createVoidDrift(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'void-drift-scene';

  const camera = new THREE.PerspectiveCamera( FOV, 1, 0.05, 400 );
  camera.position.set( 0, 1.6, 6.4 );
  camera.lookAt( 0, NEBULA_Y, 0 );

  // ── 背景 ──────────────────────────────────────────────────────────────
  const backdropUniforms = {
    uZenith: { value: new THREE.Color( 0x04050b ) },
    uHorizon: { value: new THREE.Color( 0x090a15 ) },
    uGround: { value: new THREE.Color( 0x010103 ) },
  };
  const backdrop = new THREE.Mesh(
    new THREE.SphereGeometry( 180, 32, 20 ),
    new THREE.ShaderMaterial({
      uniforms: backdropUniforms,
      vertexShader: BACKDROP_VERT,
      fragmentShader: BACKDROP_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    } ),
  );
  backdrop.name = 'backdrop';
  backdrop.renderOrder = -1000;
  backdrop.frustumCulled = false;
  root.add( backdrop );

  // ── 星云 ──────────────────────────────────────────────────────────────
  const nebulaUniforms = {
    uTime: { value: 0 },
    uPulse: { value: 0 },
    uIntensity: { value: 0.62 },
    uColorDeep: { value: new THREE.Color( 0x241a3f ) },
    uColorWarm: { value: new THREE.Color( 0x5a3352 ) },
    uColorCore: { value: new THREE.Color( 0x8f6f9c ) },
  };
  const nebula = new THREE.Mesh(
    new THREE.IcosahedronGeometry( 1.45, 5 ),
    new THREE.ShaderMaterial({
      uniforms: nebulaUniforms,
      vertexShader: NEBULA_VERT,
      fragmentShader: NEBULA_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    } ),
  );
  nebula.name = 'nebula';
  nebula.position.set( 0, NEBULA_Y, 0 );
  nebula.renderOrder = 2;
  root.add( nebula );

  // ── 星尘 ──────────────────────────────────────────────────────────────
  const space = new ParticleSpace({
    radius: 6.5,
    spin: 0.007,
    tilt: 0.16,
    position: [ 0, NEBULA_Y, 0 ],
  });

  const dustUniforms = {
    uTime: { value: 0 },
    uScale: { value: 600 },
    uOpacity: { value: 0.5 },
    uBass: { value: 0 },
    uLevel: { value: 0 },
    uPulse: { value: 0 },
  };
  const dustGeometry = createPointGeometry( {
    count: Math.floor( 4200 * ctx.quality ),
    seed: 5150,
    radius: 5.6,
    size: 0.026,
  } );
  const dustMaterial = createPointMaterial( space, {
    vertexShader: DUST_VERT,
    fragmentShader: DUST_FRAG,
    uniforms: dustUniforms,
  } );
  const dust = new THREE.Points( dustGeometry, dustMaterial );
  dust.name = 'stardust';
  dust.frustumCulled = false;
  root.add( dust );

  // ── 远处亮星 ──────────────────────────────────────────────────────────
  const stars = createStarField( Math.floor( 46 * ctx.quality ) );
  root.add( stars );

  // ── 灯光 ──────────────────────────────────────────────────────────────
  const lights = ctx.env.createStudioLights();
  dimLights( lights, 0.03, 0x2b3352 );
  root.add( lights );

  const audio = new SleepAudioDrive( BREATHING );

  return {
    root,
    camera,
    immersive: true,
    xrDistance: 3,
    framing: { distance: 6.4, height: 1.6, targetY: NEBULA_Y, width: 9 },
    update( time: number, delta: number, context: SceneContext ): void {
      audio.update( time, delta, context );
      const state = audio.state;

      // 粒子空间：低频让整片星尘潮汐般呼吸
      space.breathe = 1 + state.bass * 0.1 + state.drive * 0.04;
      space.breathPhase = state.breath;
      space.update( delta, time );

      dustUniforms.uTime.value = time;
      dustUniforms.uBass.value = state.bass;
      dustUniforms.uLevel.value = state.level;
      dustUniforms.uPulse.value = state.pulse;
      dustUniforms.uOpacity.value = 0.46 + state.level * 0.4;
      updatePointScale( dustUniforms.uScale, context, FOV );

      // 星云：脉冲驱动核心明灭与轻微缩放
      nebulaUniforms.uTime.value = time;
      nebulaUniforms.uPulse.value = state.pulse;
      nebulaUniforms.uIntensity.value = 0.5 + state.drive * 0.2 + state.pulse * 0.16;
      nebula.rotation.y = time * 0.012;
      nebula.rotation.x = Math.sin( time * 0.006 ) * 0.12;
      const nebulaScale = 1 + state.pulse * 0.11;
      nebula.scale.setScalar( nebulaScale );

      const starMaterial = stars.material as THREE.ShaderMaterial;
      starMaterial.uniforms.uTime.value = time;
      starMaterial.uniforms.uTreble.value = state.treble;
      updatePointScale( starMaterial.uniforms.uScale, context, FOV );
    },
    dispose(): void {
      disposeObject( root );
    },
  };
}

export const voidDriftScene: SceneDefinition = {
  id: 'void-drift',
  title: '虚空漂流',
  subtitle: 'Void Drift',
  description: '在无边的深空里缓慢漂浮，星尘随低频潮水般涌动，唯有中心那团星云在微微明灭。',
  tags: [ '深空', '星尘', '冥想' ],
  accent: '#7b6bb0',
  gradient: [ '#160f28', '#03030a' ],
  category: SLEEP_CATEGORY,
  audio: 'deep-drone.mp3',
  breathing: BREATHING,
  lighting: {
    autoExposure: true,
    autoExposureKey: 0.05,
  },
  create(ctx: SceneContext): SceneInstance {
    return createVoidDrift(ctx);
  },
};

export default voidDriftScene;
