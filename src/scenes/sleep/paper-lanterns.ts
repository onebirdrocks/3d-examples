/**
 * 孔明灯 / Paper Lanterns
 * ---------------------------------------------------------------
 * 夜空里一片纸灯笼缓缓升起。每盏灯笼有独立的亮度与摆动相位，
 * 整体随音乐的低频起伏而明暗。灯是 InstancedMesh（每盏一片小面片），
 * 位置与漂移全部跑在核心层的粒子空间里。
 *
 * 音乐如何驱动画面：
 * - `bass` → 整片灯的明暗（低频一沉，一整片灯笼一起亮起来）；
 * - `pulse` → 每盏灯各自相位上的那一下「被吹旺」；
 * - `level` → 整体亮度与灯的大小；
 * - `drive` → 上升的速度。
 */
import * as THREE from 'three';
import type { SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { disposeObject } from '../../core/loader.js';
import { PARTICLE_SPACE_GLSL, ParticleSpace, createRandom } from '../../core/particle-space.js';
import { GLSL_NOISE2, GLSL_OUTPUT, GLSL_OUTPUT_FUNCS } from './glsl.js';
import { SLEEP_CATEGORY, configureStandard, dimLights } from './palette.js';
import { SleepAudioDrive } from './audio-drive.js';
import { updatePointScale } from './points.js';
import { createMoteField, createNightDome } from './shared.js';

const BREATHING = { inhale: 6, hold: 2, exhale: 8 };

const FOV = 55;

/** 灯笼上升循环的高度（米）。 */
const RISE_RANGE = 7.5;

/* ------------------------------------------------------------------ *
 * 灯笼：InstancedMesh + 自定义着色器
 * ------------------------------------------------------------------ */

const LANTERN_VERT = /* glsl */ `
attribute vec3 aOffset;
attribute float aPhase;
attribute float aScale;
attribute float aSpeed;
attribute float aWarm;

uniform float uTime;
uniform float uRise;
uniform float uSize;

varying vec2 vUv;
varying float vWarm;
varying float vFade;

${PARTICLE_SPACE_GLSL}

void main() {
  vec3 p = aOffset;

  // 缓缓上升，到顶后从下面重新出现（看不到接缝）
  float rise = mod( uTime * aSpeed + aPhase * uRise, uRise );
  p.y += rise;

  // 各自不同相位的轻摆
  p.x += sin( uTime * 0.085 + aPhase * 12.0 ) * 0.32;
  p.z += cos( uTime * 0.062 + aPhase * 9.0 ) * 0.32;

  vec3 world = particleSpaceTransform( p );
  vec4 mv = modelViewMatrix * vec4( world, 1.0 );

  // 面向相机的小面片
  mv.xy += position.xy * uSize * aScale;

  gl_Position = projectionMatrix * mv;

  vUv = uv;
  vWarm = aWarm;

  // 两头淡入淡出
  vFade = smoothstep( 0.0, 0.9, rise ) * ( 1.0 - smoothstep( uRise - 1.4, uRise, rise ) );
}
`;

const LANTERN_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uBass;
uniform float uPulse;
uniform float uLevel;
uniform float uOpacity;
uniform vec3 uColorHot;
uniform vec3 uColorMid;
uniform vec3 uColorEdge;

varying vec2 vUv;
varying float vWarm;
varying float vFade;

${GLSL_NOISE2}
${GLSL_OUTPUT_FUNCS}

void main() {
  // 灯笼本体：上半部略宽的椭圆
  vec2 q = vUv - vec2( 0.5, 0.46 );
  float body = 1.0 - smoothstep( 0.0, 1.0, length( q / vec2( 0.17, 0.23 ) ) );

  // 顶上的小盖
  float cap = ( 1.0 - smoothstep( 0.0, 0.02, abs( vUv.y - 0.715 ) ) ) *
              ( 1.0 - smoothstep( 0.05, 0.08, abs( vUv.x - 0.5 ) ) );

  float shape = clamp( body + cap * 0.9, 0.0, 1.0 );

  // 纸面上的竖骨
  float ribs = 0.88 + 0.12 * sin( q.x * 92.0 );

  // 每盏灯自己的呼吸（周期 8 秒以上）与音乐带来的那一下
  float own = 0.72 + 0.28 * sin( uTime * ( 0.12 + 0.1 * vWarm ) + vWarm * 40.0 );
  float lit = own * ( 0.55 + 0.65 * uBass + 0.35 * uPulse + 0.25 * uLevel );

  // 灯笼周围的一圈光晕
  vec2 g = vUv - 0.5;
  float halo = exp( -dot( g, g ) * 7.0 ) * 0.42;

  float alpha = clamp( shape * 0.92 + halo * 0.45, 0.0, 1.0 ) * uOpacity * vFade;
  if ( alpha < 0.004 ) discard;

  vec3 col = mix( uColorEdge, uColorMid, smoothstep( 0.0, 0.55, shape ) );
  col = mix( col, uColorHot, smoothstep( 0.55, 1.0, shape ) * ( 0.3 + 0.4 * lit ) );
  col *= ribs * lit;

  gl_FragColor = vec4( col, alpha );
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * 地面的薄雾
 * ------------------------------------------------------------------ */

const MIST_VERT = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const MIST_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uBass;
uniform float uLevel;
uniform float uOpacity;
uniform vec3 uColor;

varying vec2 vUv;

${GLSL_NOISE2}
${GLSL_OUTPUT_FUNCS}

void main() {
  vec2 p = vUv - 0.5;
  float d = length( p ) * 2.0;
  if ( d > 1.0 ) discard;

  // 雾极慢地飘
  float n = fbm2( p * 3.2 + vec2( uTime * 0.011, uTime * 0.007 ) );
  float n2 = fbm2( p * 6.5 - vec2( uTime * 0.008, uTime * 0.013 ) );
  float mask = ( 1.0 - smoothstep( 0.25, 1.0, d ) ) * ( 0.35 + 0.85 * n ) * ( 0.5 + 0.7 * n2 );

  float alpha = mask * uOpacity * ( 0.55 + 0.6 * uLevel + 0.3 * uBass );
  if ( alpha < 0.004 ) discard;

  gl_FragColor = vec4( uColor * alpha, alpha );
  ${GLSL_OUTPUT}
}
`;

/** 在一个圆盘上撒灯：靠近中心的少、远处的多。 */
function createLanternField(count: number, seed: number): {
  offsets: Float32Array;
  phases: Float32Array;
  scales: Float32Array;
  speeds: Float32Array;
  warms: Float32Array;
} {
  const random = createRandom(seed);
  const offsets = new Float32Array(count * 3);
  const phases = new Float32Array(count);
  const scales = new Float32Array(count);
  const speeds = new Float32Array(count);
  const warms = new Float32Array(count);

  for (let i = 0; i < count; i += 1) {
    const angle = random() * Math.PI * 2;
    const radius = 1.6 + Math.pow(random(), 0.62) * 8.4;
    offsets[i * 3] = Math.cos(angle) * radius;
    offsets[i * 3 + 1] = -1.2 + random() * 1.0;
    offsets[i * 3 + 2] = Math.sin(angle) * radius;

    phases[i] = random();
    scales[i] = 0.62 + random() * 0.72;
    speeds[i] = 0.055 + random() * 0.05;
    warms[i] = random();
  }

  return { offsets, phases, scales, speeds, warms };
}

function createPaperLanterns(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'paper-lanterns-scene';

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 200);
  camera.position.set(0, 1.7, 10.5);
  camera.lookAt(0, 4.6, 0);

  // ── 夜空 ────────────────────────────────────────────────────────────
  const dome = createNightDome({
    zenith: 0x050a16,
    horizon: 0x111c30,
    ground: 0x070a10,
    radius: 110,
  });
  root.add(dome.mesh);

  // ── 地面：一片极暗的夜地 ────────────────────────────────────────────
  const ground = ctx.env.createGround(40) as THREE.Mesh;
  const groundMaterial = new THREE.MeshStandardMaterial({
    color: 0x0a0d12,
    roughness: 1,
    metalness: 0,
  });
  configureStandard(groundMaterial, ctx.env.envMap, 0.05);
  ground.material = groundMaterial;
  ground.name = 'night-ground';
  root.add(ground);

  // ── 灯笼 ────────────────────────────────────────────────────────────
  const lanternSpace = new ParticleSpace({
    radius: 10,
    spin: 0.0025,
    tilt: 0.1,
    position: [0, 0, 0],
  });

  const count = Math.max(8, Math.floor(112 * ctx.quality));
  const field = createLanternField(count, 9021);

  const lanternGeometry = new THREE.PlaneGeometry(1, 1);
  lanternGeometry.setAttribute(
    'aOffset',
    new THREE.InstancedBufferAttribute(field.offsets, 3),
  );
  lanternGeometry.setAttribute(
    'aPhase',
    new THREE.InstancedBufferAttribute(field.phases, 1),
  );
  lanternGeometry.setAttribute(
    'aScale',
    new THREE.InstancedBufferAttribute(field.scales, 1),
  );
  lanternGeometry.setAttribute(
    'aSpeed',
    new THREE.InstancedBufferAttribute(field.speeds, 1),
  );
  lanternGeometry.setAttribute(
    'aWarm',
    new THREE.InstancedBufferAttribute(field.warms, 1),
  );

  const lanternUniforms = {
    uTime: { value: 0 },
    uRise: { value: RISE_RANGE },
    uSize: { value: 0.42 },
    uBass: { value: 0 },
    uPulse: { value: 0 },
    uLevel: { value: 0 },
    uOpacity: { value: 0.9 },
    uColorHot: { value: new THREE.Color(0xffe7b0) },
    uColorMid: { value: new THREE.Color(0xff9d3c) },
    uColorEdge: { value: new THREE.Color(0xc4451a) },
    particleMatrix: lanternSpace.uniform,
  };
  const lanternMaterial = new THREE.ShaderMaterial({
    uniforms: lanternUniforms,
    vertexShader: LANTERN_VERT,
    fragmentShader: LANTERN_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });

  const lanterns = new THREE.InstancedMesh(lanternGeometry, lanternMaterial, count);
  lanterns.name = 'paper-lanterns';
  lanterns.frustumCulled = false;
  const identity = new THREE.Matrix4();
  for (let i = 0; i < count; i += 1) lanterns.setMatrixAt(i, identity);
  lanterns.instanceMatrix.needsUpdate = true;
  root.add(lanterns);

  // ── 地面的薄雾 ──────────────────────────────────────────────────────
  const mistUniforms = {
    uTime: { value: 0 },
    uBass: { value: 0 },
    uLevel: { value: 0 },
    uOpacity: { value: 0.2 },
    uColor: { value: new THREE.Color(0x6a7488) },
  };
  const mist = new THREE.Mesh(
    new THREE.PlaneGeometry(26, 26),
    new THREE.ShaderMaterial({
      uniforms: mistUniforms,
      vertexShader: MIST_VERT,
      fragmentShader: MIST_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    }),
  );
  mist.name = 'ground-mist';
  mist.rotation.x = -Math.PI * 0.5;
  mist.position.set(0, 0.08, 0);
  mist.renderOrder = 1;
  root.add(mist);

  // ── 稀疏的星 ────────────────────────────────────────────────────────
  const starSpace = new ParticleSpace({
    radius: 30,
    spin: 0.001,
    tilt: 0.2,
    position: [0, 12, 0],
  });
  const stars = createMoteField(starSpace, Math.floor(220 * ctx.quality), {
    color: 0xbfcde6,
    size: 0.09,
    seed: 1729,
    opacity: 0.45,
  });
  root.add(stars.points);

  // ── 灯光：几乎全灭，只留一点极弱的暖底光 ────────────────────────────
  const lights = ctx.env.createStudioLights();
  dimLights(lights, 0.035, 0x3a2c1e);
  root.add(lights);

  const audio = new SleepAudioDrive(BREATHING);

  return {
    root,
    camera,
    immersive: false,
    xrDistance: 3.4,
    framing: { distance: 10.5, height: 1.7, targetY: 4.6, width: 17 },
    update(time: number, delta: number, context: SceneContext): void {
      audio.update(time, delta, context);
      const state = audio.state;

      lanternSpace.update(delta, time);
      starSpace.update(delta, time);

      // ── 灯笼：低频让整片一起明暗，呼吸推着它们上升 ──────────────────
      lanternUniforms.uTime.value = time;
      lanternUniforms.uBass.value = state.bass;
      lanternUniforms.uPulse.value = state.pulse;
      lanternUniforms.uLevel.value = state.level;
      lanternUniforms.uOpacity.value = 0.62 + state.level * 0.3 + state.bass * 0.18;
      lanternUniforms.uSize.value = 0.46 + state.drive * 0.08 + state.level * 0.05;

      // ── 薄雾 ────────────────────────────────────────────────────────
      mistUniforms.uTime.value = time;
      mistUniforms.uBass.value = state.bass;
      mistUniforms.uLevel.value = state.level;
      mistUniforms.uOpacity.value = 0.15 + state.level * 0.08;

      // ── 星 ──────────────────────────────────────────────────────────
      stars.uniforms.uTime.value = time;
      stars.uniforms.uLevel.value = state.level * 0.4;
      stars.uniforms.uBreath.value = state.breath;
      updatePointScale(stars.uniforms.uScale, context, FOV);

      // ── 穹顶 ────────────────────────────────────────────────────────
      dome.uniforms.uTime.value = time;
      dome.uniforms.uBreath.value = state.breath;
    },
    dispose(): void {
      // InstancedMesh 额外持有 instanceMatrix 的 GPU buffer
      lanterns.dispose();
      disposeObject(root);
    },
  };
}

export const paperLanternsScene: SceneDefinition = {
  id: 'paper-lanterns',
  title: '孔明灯',
  subtitle: 'Paper Lanterns',
  description: '一片纸灯笼在夜空里缓缓升起，每一盏的明暗都跟着自己的节拍与音乐的低频。',
  tags: ['灯火', '夜空', '冥想'],
  accent: '#e0913f',
  gradient: ['#1b1408', '#05070d'],
  category: SLEEP_CATEGORY,
  audio: 'lantern-rise.mp3',
  breathing: BREATHING,
  lighting: {
    autoExposure: true,
    autoExposureKey: 0.075,
  },
  create(ctx: SceneContext): SceneInstance {
    return createPaperLanterns(ctx);
  },
};

export default paperLanternsScene;
