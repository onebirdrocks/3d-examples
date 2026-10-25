/**
 * 深海之眼 / Abyss
 * ---------------------------------------------------------------
 * 沉在深海里：头顶一道极缓慢移动的微弱光柱斜插下来，水体是深蓝近黑的渐变，
 * 远处有几只缓慢脉动的发光生物，近处是极慢上浮的气泡。
 * 画面要的是「深不见底」的静——所有运动都以分钟计。
 *
 * 音乐如何驱动画面：
 * - `bass` → 远处发光生物的明灭幅度（低频一沉，它们就亮一下）；
 * - `pulse` → 光柱的强度与整片水体的呼吸；
 * - `level` → 整体亮度与气泡的可见度；
 * - `drive` → 光柱漂移的幅度（无音乐时由呼吸节奏兜底）。
 */
import * as THREE from 'three';
import type { SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { disposeObject } from '../../core/loader.js';
import { ParticleSpace, createRandom } from '../../core/particle-space.js';
import { GLSL_HASH, GLSL_NOISE2, GLSL_OUTPUT, GLSL_OUTPUT_FUNCS } from './glsl.js';
import { SLEEP_CATEGORY, dimLights } from './palette.js';
import { SleepAudioDrive } from './audio-drive.js';
import { createPointGeometry, createPointMaterial, updatePointScale } from './points.js';
import { createMoteField, createNightDome } from './shared.js';

const BREATHING = { inhale: 6, hold: 2, exhale: 8 };

const FOV = 62;

/** 光柱顶端（远处的水面）高度。 */
const SHAFT_TOP = 17;

/** 光柱底端（没入黑暗的深处）。 */
const SHAFT_BOTTOM = -3.5;

/* ------------------------------------------------------------------ *
 * 光柱：加性混合的空心锥体
 * ------------------------------------------------------------------ */

const SHAFT_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vNormalV;
varying vec3 vViewV;

void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  vNormalV = normalize( normalMatrix * normal );
  vViewV = normalize( -mv.xyz );
  gl_Position = projectionMatrix * mv;
}
`;

const SHAFT_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uPulse;
uniform float uIntensity;
uniform vec3 uColor;

varying vec2 vUv;
varying vec3 vNormalV;
varying vec3 vViewV;

${GLSL_HASH}
${GLSL_NOISE2}
${GLSL_OUTPUT_FUNCS}

void main() {
  // 越靠近顶端越亮，越往下越淡
  float height = clamp( vUv.y, 0.0, 1.0 );
  float fall = pow( height, 1.45 );

  // 光柱里的浮游物：极缓慢流动的噪声
  float n = fbm2( vec2( vUv.x * 7.0, vUv.y * 2.4 - uTime * 0.022 ) );
  float streak = 0.35 + 0.9 * n;

  // 边缘更亮：让锥体看起来是一束光，而不是一张纸
  float grazing = 1.0 - abs( dot( normalize( vNormalV ), normalize( vViewV ) ) );
  float rim = 0.22 + 0.78 * pow( clamp( grazing, 0.0, 1.0 ), 1.6 );

  float alpha = fall * streak * rim * uIntensity;
  if ( alpha < 0.003 ) discard;

  gl_FragColor = vec4( uColor * alpha, alpha );
  ${GLSL_OUTPUT}
}
`;

/** 水面透下来的那一小片微光。 */
const SURFACE_VERT = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const SURFACE_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uPulse;
uniform float uIntensity;
uniform vec3 uColor;

varying vec2 vUv;

${GLSL_HASH}
${GLSL_NOISE2}
${GLSL_OUTPUT_FUNCS}

void main() {
  vec2 p = vUv - 0.5;
  float d = length( p ) * 2.0;
  if ( d > 1.0 ) discard;

  float core = exp( -d * d * 3.2 );
  float ripple = 0.65 + 0.5 * fbm2( p * 7.0 + vec2( uTime * 0.03, uTime * 0.017 ) );
  float alpha = core * ripple * uIntensity;
  if ( alpha < 0.003 ) discard;

  gl_FragColor = vec4( uColor * alpha, alpha );
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * 远处发光的生物
 * ------------------------------------------------------------------ */

const CREATURE_VERT = /* glsl */ `
attribute float aSize;
attribute float aPhase;

uniform float uTime;
uniform float uScale;
uniform float uBass;
uniform float uPulse;
uniform float uLevel;

varying float vAlpha;
varying vec3 vTint;

void main() {
  vec3 p = position;

  // 各自极缓慢地游动，周期 40 秒以上
  p.x += sin( uTime * 0.031 + aPhase * 6.2831 ) * 0.55;
  p.y += sin( uTime * 0.023 + aPhase * 4.2 ) * 0.38;
  p.z += cos( uTime * 0.027 + aPhase * 5.1 ) * 0.55;

  vec4 mv = modelViewMatrix * vec4( particleSpaceTransform( p ), 1.0 );
  gl_Position = projectionMatrix * mv;

  // 每只生物有自己的呼吸节拍（10 秒以上），低频让它们一起亮起来
  float own = 0.5 + 0.5 * sin( uTime * ( 0.075 + 0.055 * aPhase ) + aPhase * 30.0 );
  float glow = 0.26 + 0.74 * own;

  vAlpha = glow * ( 0.34 + 0.9 * uBass + 0.25 * uPulse ) * ( 0.6 + 0.5 * uLevel );
  vTint = mix( vec3( 0.30, 0.78, 0.92 ), vec3( 0.62, 0.92, 0.74 ), aPhase );

  gl_PointSize = min( uScale * aSize * ( 0.82 + 0.42 * own ) / max( 1.0, -mv.z ), 46.0 );
}
`;

const CREATURE_FRAG = /* glsl */ `
precision highp float;

uniform float uOpacity;

varying float vAlpha;
varying vec3 vTint;

${GLSL_OUTPUT_FUNCS}

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot( c, c );
  if ( d2 > 0.25 ) discard;

  float core = exp( -d2 * 34.0 );
  float halo = exp( -d2 * 7.5 ) * 0.38;
  float alpha = ( core + halo ) * vAlpha * uOpacity;
  if ( alpha < 0.004 ) discard;

  gl_FragColor = vec4( vTint, alpha );
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * 近处上浮的气泡
 * ------------------------------------------------------------------ */

const BUBBLE_VERT = /* glsl */ `
attribute float aSize;
attribute float aPhase;

uniform float uTime;
uniform float uScale;
uniform float uLevel;
uniform float uPulse;

varying float vAlpha;

void main() {
  vec3 p = position;

  // 极慢地上浮：15 秒左右才浮起一小段
  float rise = mod( uTime * ( 0.055 + 0.035 * aPhase ) + aPhase * 5.0, 5.2 );
  p.y += rise;

  // 上浮途中左右轻摆
  p.x += sin( uTime * 0.11 + aPhase * 6.2831 ) * 0.09;
  p.z += cos( uTime * 0.083 + aPhase * 4.7 ) * 0.09;

  vec4 mv = modelViewMatrix * vec4( particleSpaceTransform( p ), 1.0 );
  gl_Position = projectionMatrix * mv;

  // 两头淡入淡出，循环时看不到接缝
  float fade = smoothstep( 0.0, 0.55, rise ) * ( 1.0 - smoothstep( 3.9, 5.2, rise ) );
  vAlpha = fade * ( 0.22 + 0.5 * uLevel + 0.18 * uPulse );

  gl_PointSize = min( uScale * aSize / max( 1.0, -mv.z ), 22.0 );
}
`;

const BUBBLE_FRAG = /* glsl */ `
precision highp float;

uniform float uOpacity;

varying float vAlpha;

${GLSL_OUTPUT_FUNCS}

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length( c );
  if ( d > 0.5 ) discard;

  // 气泡是一圈薄薄的壳，不是实心点
  float shell = exp( -pow( ( d - 0.36 ) * 9.0, 2.0 ) );
  float highlight = exp( -pow( ( d - 0.28 ) * 16.0, 2.0 ) ) * 0.35;

  float alpha = ( shell + highlight ) * vAlpha * uOpacity;
  if ( alpha < 0.005 ) discard;

  gl_FragColor = vec4( vec3( 0.66, 0.86, 0.94 ) * alpha, alpha );
  ${GLSL_OUTPUT}
}
`;

/** 在球壳上撒几只发光的生物。 */
function createCreatureGeometry(count: number, seed: number): THREE.BufferGeometry {
  const random = createRandom(seed);
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const phases = new Float32Array(count);

  for (let i = 0; i < count; i += 1) {
    const u = random() * 2 - 1;
    const theta = random() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - u * u));
    const dist = 5.5 + random() * 7.5;

    positions[i * 3] = Math.cos(theta) * r * dist;
    positions[i * 3 + 1] = u * dist * 0.55 - 1.2;
    positions[i * 3 + 2] = Math.sin(theta) * r * dist;

    sizes[i] = 0.05 + random() * 0.16;
    phases[i] = random();
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  return geometry;
}

function createDeepVoid(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'deep-void-scene';

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 220);
  camera.position.set(0, 1.0, 4.6);
  camera.lookAt(0, 3.4, 0);

  // ── 水体：深蓝近黑的渐变穹顶 ───────────────────────────────────────
  const dome = createNightDome({
    zenith: 0x123c5c,
    horizon: 0x07192c,
    ground: 0x01050c,
    radius: 90,
  });
  root.add(dome.mesh);

  // ── 光柱 ────────────────────────────────────────────────────────────
  const shaftGroup = new THREE.Group();
  shaftGroup.name = 'light-shafts';
  root.add(shaftGroup);

  const shaftUniforms = {
    uTime: { value: 0 },
    uPulse: { value: 0 },
    uIntensity: { value: 0.5 },
    uColor: { value: new THREE.Color(0x8fc6e8) },
  };
  const shaftMaterial = new THREE.ShaderMaterial({
    uniforms: shaftUniforms,
    vertexShader: SHAFT_VERT,
    fragmentShader: SHAFT_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });

  const shaftHeight = SHAFT_TOP - SHAFT_BOTTOM;
  const mainShaft = new THREE.Mesh(
    new THREE.ConeGeometry(2.4, shaftHeight, 40, 1, true),
    shaftMaterial,
  );
  mainShaft.name = 'main-shaft';
  mainShaft.position.set(0, SHAFT_TOP - shaftHeight * 0.5, 0);
  mainShaft.renderOrder = 2;
  shaftGroup.add(mainShaft);

  // 更细、更暗的第二道，制造纵深
  const secondShaft = new THREE.Mesh(
    new THREE.ConeGeometry(1.35, shaftHeight * 0.92, 32, 1, true),
    shaftMaterial,
  );
  secondShaft.name = 'second-shaft';
  secondShaft.position.set(2.6, SHAFT_TOP - shaftHeight * 0.46, -3.2);
  secondShaft.rotation.z = 0.08;
  secondShaft.renderOrder = 2;
  shaftGroup.add(secondShaft);

  // 水面透下来的一小片微光
  const surfaceUniforms = {
    uTime: { value: 0 },
    uPulse: { value: 0 },
    uIntensity: { value: 0.42 },
    uColor: { value: new THREE.Color(0xbcdcf2) },
  };
  const surface = new THREE.Mesh(
    new THREE.PlaneGeometry(7.5, 7.5),
    new THREE.ShaderMaterial({
      uniforms: surfaceUniforms,
      vertexShader: SURFACE_VERT,
      fragmentShader: SURFACE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    }),
  );
  surface.name = 'surface-glow';
  surface.position.set(0, SHAFT_TOP - 0.6, 0);
  surface.rotation.x = Math.PI * 0.5;
  surface.renderOrder = 3;
  shaftGroup.add(surface);

  // ── 远处发光的生物 ──────────────────────────────────────────────────
  const creatureSpace = new ParticleSpace({
    radius: 12,
    spin: 0.0025,
    tilt: 0.12,
    position: [0, 0.6, 0],
  });
  const creatureUniforms = {
    uTime: { value: 0 },
    uScale: { value: 600 },
    uBass: { value: 0 },
    uPulse: { value: 0 },
    uLevel: { value: 0 },
    uOpacity: { value: 0.9 },
  };
  const creatureGeometry = createCreatureGeometry(Math.floor(54 * ctx.quality), 31337);
  const creatureMaterial = createPointMaterial(creatureSpace, {
    vertexShader: CREATURE_VERT,
    fragmentShader: CREATURE_FRAG,
    uniforms: creatureUniforms,
  });
  const creatures = new THREE.Points(creatureGeometry, creatureMaterial);
  creatures.name = 'creatures';
  creatures.frustumCulled = false;
  root.add(creatures);

  // ── 气泡 ────────────────────────────────────────────────────────────
  const bubbleSpace = new ParticleSpace({
    radius: 2.6,
    spin: 0.006,
    tilt: 0.05,
    position: [0, -1.2, 0.6],
  });
  const bubbleUniforms = {
    uTime: { value: 0 },
    uScale: { value: 600 },
    uLevel: { value: 0 },
    uPulse: { value: 0 },
    uOpacity: { value: 0.6 },
  };
  const bubbleGeometry = createPointGeometry({
    count: Math.floor(150 * ctx.quality),
    seed: 8123,
    radius: 2.3,
    size: 0.07,
  });
  const bubbleMaterial = createPointMaterial(bubbleSpace, {
    vertexShader: BUBBLE_VERT,
    fragmentShader: BUBBLE_FRAG,
    uniforms: bubbleUniforms,
  });
  const bubbles = new THREE.Points(bubbleGeometry, bubbleMaterial);
  bubbles.name = 'bubbles';
  bubbles.frustumCulled = false;
  root.add(bubbles);

  // ── 海雪：缓慢下沉的细碎微光 ────────────────────────────────────────
  const snowSpace = new ParticleSpace({
    radius: 7,
    spin: 0.003,
    tilt: 0.2,
    position: [0, 1.5, 0],
  });
  const motes = createMoteField(snowSpace, Math.floor(320 * ctx.quality), {
    color: 0x8fb6cf,
    size: 0.026,
    seed: 6604,
    opacity: 0.34,
  });
  root.add(motes.points);

  // ── 灯光：只留一点极弱的冷色底光 ────────────────────────────────────
  const lights = ctx.env.createStudioLights();
  dimLights(lights, 0.03, 0x18364e);
  root.add(lights);

  const audio = new SleepAudioDrive(BREATHING);

  return {
    root,
    camera,
    immersive: true,
    xrDistance: 3,
    framing: { distance: 4.6, height: 1.0, targetY: 3.4, width: 6.5 },
    update(time: number, delta: number, context: SceneContext): void {
      audio.update(time, delta, context);
      const state = audio.state;

      creatureSpace.update(delta, time);
      bubbleSpace.update(delta, time);
      snowSpace.update(delta, time);

      // ── 光柱：脉冲提亮，随音乐与呼吸极缓地左右漂移 ──────────────────
      shaftUniforms.uTime.value = time;
      shaftUniforms.uPulse.value = state.pulse;
      shaftUniforms.uIntensity.value = 0.46 + state.pulse * 0.3 + state.drive * 0.12;

      surfaceUniforms.uTime.value = time;
      surfaceUniforms.uPulse.value = state.pulse;
      surfaceUniforms.uIntensity.value = 0.3 + state.pulse * 0.22 + state.level * 0.1;

      const drift = state.drive * 0.6;
      shaftGroup.position.x = Math.sin(time * 0.021) * 1.7 + Math.sin(time * 0.007) * 0.4 * drift;
      shaftGroup.position.z = Math.cos(time * 0.017) * 1.1 * (0.5 + drift * 0.5);
      shaftGroup.rotation.y = Math.sin(time * 0.009) * 0.09;

      // ── 生物：低频让它们明灭 ────────────────────────────────────────
      creatureUniforms.uTime.value = time;
      creatureUniforms.uBass.value = state.bass;
      creatureUniforms.uPulse.value = state.pulse;
      creatureUniforms.uLevel.value = state.level;
      updatePointScale(creatureUniforms.uScale, context, FOV);

      // ── 气泡 ────────────────────────────────────────────────────────
      bubbleUniforms.uTime.value = time;
      bubbleUniforms.uLevel.value = state.level;
      bubbleUniforms.uPulse.value = state.pulse;
      bubbleUniforms.uOpacity.value = 0.55 + state.level * 0.45;
      updatePointScale(bubbleUniforms.uScale, context, FOV);

      // ── 海雪 ────────────────────────────────────────────────────────
      motes.uniforms.uTime.value = time;
      motes.uniforms.uLevel.value = state.level;
      motes.uniforms.uBreath.value = state.breath;
      updatePointScale(motes.uniforms.uScale, context, FOV);

      // ── 穹顶随呼吸极缓地明灭 ─────────────────────────────────────────
      dome.uniforms.uTime.value = time;
      dome.uniforms.uBreath.value = state.breath;
    },
    dispose(): void {
      disposeObject(root);
    },
  };
}

export const deepVoidScene: SceneDefinition = {
  id: 'deep-void',
  title: '深海之眼',
  subtitle: 'Abyss',
  description: '沉在深蓝近黑的海水里，头顶一道光柱极缓慢地移动，远处有发光的生物随低频明灭。',
  tags: ['深海', '光柱', '冥想'],
  accent: '#3f7fa8',
  gradient: ['#0a1c2e', '#01040a'],
  category: SLEEP_CATEGORY,
  audio: 'abyss-chant.mp3',
  breathing: BREATHING,
  lighting: {
    autoExposure: true,
    autoExposureKey: 0.055,
  },
  create(ctx: SceneContext): SceneInstance {
    return createDeepVoid(ctx);
  },
};

export default deepVoidScene;
