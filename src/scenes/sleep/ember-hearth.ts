/**
 * 壁炉余烬 / Hearth Embers
 * ---------------------------------------------------------------
 * 一间暗室里的壁炉。火焰是一个用噪声塑形的着色器形状（不是粒子堆出来的），
 * 随音乐的脉冲长高、变亮；炉膛里堆着缓慢明灭的余烬；火星与灰烬从火里缓缓升起；
 * 壁炉口透出的暖光在墙上晃。神秘、温暖，适合入睡前的最后几分钟。
 *
 * 音乐如何驱动画面：
 * - `pulse` → 火焰高度与亮度（画面最主要的运动）；
 * - `bass` → 壁炉口在墙上的暖光晃动幅度；
 * - `level` → 余烬的可见度与火星数量感；
 * - `treble` → 火星的细碎闪动。
 */
import * as THREE from 'three';
import type { SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { disposeObject, assetUrl } from '../../core/loader.js';
import { attachSpatialSource } from '../../core/spatial-audio.js';
import { ParticleSpace } from '../../core/particle-space.js';
import { GLSL_HASH, GLSL_NOISE2, GLSL_NOISE3, GLSL_OUTPUT, GLSL_OUTPUT_FUNCS } from './glsl.js';
import { SLEEP_CATEGORY, configureStandard, dimLights } from './palette.js';
import { SleepAudioDrive } from './audio-drive.js';
import { createPointGeometry, createPointMaterial, updatePointScale } from './points.js';

const BREATHING = { inhale: 4, hold: 4, exhale: 6 };

const FOV = 46;

/** 壁炉口中心（世界坐标）。 */
const HEARTH_X = 0;
const HEARTH_Y = 0.62;
const HEARTH_Z = -1.55;

/** 壁炉口尺寸。 */
const OPENING_W = 0.86;
const OPENING_H = 0.62;

/* ------------------------------------------------------------------ *
 * 火焰：噪声驱动的形状
 * ------------------------------------------------------------------ */

const FLAME_VERT = /* glsl */ `
uniform float uTime;
uniform float uHeight;
uniform float uSway;
uniform float uPulse;

varying float vHeight;
varying float vNoise;
varying vec2 vUv;

${GLSL_HASH}
${GLSL_NOISE3}

void main() {
  vUv = uv;
  vec3 p = position;

  // 高度归一：0 在炉底，1 在火舌顶端
  float h = clamp( p.y / max( uHeight, 0.001 ), 0.0, 1.0 );
  vHeight = h;

  // 噪声塑形：火舌向上撕裂、左右摇曳
  float n = fbm3( vec3( p.x * 5.0, p.y * 3.2 - uTime * 1.15, uTime * 0.35 ) );
  float n2 = fbm3( vec3( p.z * 5.0 + 4.1, p.y * 3.6 - uTime * 1.4, 2.7 ) );
  vNoise = n * 0.62 + n2 * 0.38;

  float sway = ( n - 0.5 ) * uSway * ( 0.25 + h * h );
  p.x += sway;
  p.z += ( n2 - 0.5 ) * uSway * 0.6 * ( 0.2 + h * h );

  // 顶端被撕开，越往上越散
  float tear = h * h * 0.22 * ( n - 0.45 );
  p.x += tear * 1.6;
  p.z += tear;

  gl_Position = projectionMatrix * modelViewMatrix * vec4( p, 1.0 );
}
`;

const FLAME_FRAG = /* glsl */ `
precision highp float;

uniform float uIntensity;
uniform float uPulse;
uniform vec3 uColorHot;
uniform vec3 uColorMid;
uniform vec3 uColorEdge;

varying float vHeight;
varying float vNoise;
varying vec2 vUv;

${GLSL_OUTPUT_FUNCS}

void main() {
  float h = vHeight;

  // 火焰本体：底部实、顶部散
  float body = 1.0 - smoothstep( 0.05, 0.92, h );
  float flicker = 0.55 + 0.75 * vNoise;

  // 火舌的横向轮廓：底部宽、往上收窄
  float width = 0.5 * ( 1.0 - 0.5 * h );
  float lateral = abs( vUv.x - 0.5 ) / max( width, 0.001 );
  float shape = 1.0 - smoothstep( 0.35, 1.0, lateral );

  float alpha = body * shape * flicker * uIntensity;
  if ( alpha < 0.006 ) discard;

  // 由内到外：白黄 → 橙 → 暗红
  vec3 col = mix( uColorHot, uColorMid, smoothstep( 0.0, 0.55, h ) );
  col = mix( col, uColorEdge, smoothstep( 0.45, 1.0, h ) );
  col += uColorHot * ( 1.0 - smoothstep( 0.0, 0.34, h ) ) * 0.7;

  gl_FragColor = vec4( col, alpha );
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * 余烬：炉膛底部缓慢明灭
 * ------------------------------------------------------------------ */

const EMBER_VERT = /* glsl */ `
attribute float aSize;
attribute float aPhase;
attribute float aGlow;

uniform float uTime;
uniform float uScale;
uniform float uLevel;
uniform float uPulse;

varying float vAlpha;
varying vec3 vTint;

void main() {
  vec3 p = position;

  // 余烬极缓地起伏，像还有余温在呼吸
  p.y += sin( uTime * 0.13 + aPhase * 6.2831 ) * 0.012;
  p.x += cos( uTime * 0.09 + aPhase * 4.1 ) * 0.01;

  vec4 mv = modelViewMatrix * vec4( particleSpaceTransform( p ), 1.0 );
  gl_Position = projectionMatrix * mv;

  // 明灭周期在 6 秒以上，绝不闪烁
  float breathe = 0.55 + 0.45 * sin( uTime * 0.32 + aPhase * 12.0 );
  vAlpha = ( 0.25 + 0.75 * aGlow ) * breathe * ( 0.45 + 0.7 * uLevel ) + uPulse * 0.12;
  vTint = mix( vec3( 0.85, 0.28, 0.06 ), vec3( 1.0, 0.72, 0.26 ), aGlow );

  gl_PointSize = uScale * aSize / max( 1.0, -mv.z );
}
`;

const EMBER_FRAG = /* glsl */ `
precision highp float;

uniform float uOpacity;

varying float vAlpha;
varying vec3 vTint;

${GLSL_OUTPUT_FUNCS}

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot( c, c );
  if ( d2 > 0.25 ) discard;
  float falloff = exp( -d2 * 16.0 );
  float alpha = falloff * vAlpha * uOpacity;
  if ( alpha < 0.005 ) discard;
  gl_FragColor = vec4( vTint, alpha );
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * 火星与灰烬：缓缓升腾
 * ------------------------------------------------------------------ */

const SPARK_VERT = /* glsl */ `
attribute float aSize;
attribute float aPhase;
attribute float aRise;
attribute float aAsh;

uniform float uTime;
uniform float uScale;
uniform float uLevel;
uniform float uTreble;
uniform float uPulse;

varying float vAlpha;
varying vec3 vTint;

void main() {
  vec3 p = position;

  // 缓慢上升，途中左右轻摆
  float rise = mod( uTime * ( 0.055 + 0.075 * aRise ), 2.6 );
  p.y += rise;
  float sway = sin( uTime * 0.42 + aPhase * 6.2831 ) * 0.045 * ( 0.3 + rise );
  p.x += sway;
  p.z += cos( uTime * 0.36 + aPhase * 4.7 ) * 0.035 * ( 0.3 + rise );

  vec4 mv = modelViewMatrix * vec4( particleSpaceTransform( p ), 1.0 );
  gl_Position = projectionMatrix * mv;

  // 越升越暗、越小；灰烬始终偏灰
  float fade = 1.0 - smoothstep( 0.2, 2.5, rise );
  float flicker = 0.6 + 0.4 * sin( uTime * ( 1.1 + 2.4 * aRise ) + aPhase * 18.0 );
  float ash = aAsh;

  vec3 ember = mix( vec3( 1.0, 0.55, 0.14 ), vec3( 1.0, 0.84, 0.5 ), flicker * 0.6 );
  vec3 ashCol = vec3( 0.42, 0.40, 0.40 );
  vTint = mix( ember, ashCol, ash );

  vAlpha = fade * flicker * ( 0.3 + 0.8 * uLevel ) * mix( 1.0, 0.42, ash );
  vAlpha *= 1.0 + uTreble * 0.5 * ( 1.0 - ash );

  gl_PointSize = uScale * aSize * ( 0.6 + 0.7 * fade ) / max( 1.0, -mv.z );
}
`;

const SPARK_FRAG = /* glsl */ `
precision highp float;

uniform float uOpacity;

varying float vAlpha;
varying vec3 vTint;

${GLSL_OUTPUT_FUNCS}

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot( c, c );
  if ( d2 > 0.25 ) discard;
  float falloff = exp( -d2 * 14.0 );
  float alpha = falloff * vAlpha * uOpacity;
  if ( alpha < 0.005 ) discard;
  gl_FragColor = vec4( vTint, alpha );
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * 炉膛内的暖光：投在墙上的晃动的光斑
 * ------------------------------------------------------------------ */

const WALL_GLOW_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uWarm;
uniform float uPulse;
uniform float uBass;
uniform float uTime;

varying vec2 vUv;

${GLSL_HASH}
${GLSL_NOISE2}
${GLSL_OUTPUT_FUNCS}

void main() {
  vec2 p = vUv - 0.5;
  p.x *= 1.0;

  // 光斑不是圆的，随呼吸轻微变形
  float wob = sin( uTime * 0.31 ) * 0.012 + sin( uTime * 0.17 ) * 0.008;
  vec2 q = p - vec2( wob * 1.4, wob );
  float d = length( q );
  float core = exp( -d * d * 11.0 );
  float halo = exp( -d * d * 3.2 ) * 0.35;

  // 火苗在墙上投下的摇曳：用平滑噪声，不用逐格哈希（会出现方块）
  float flick = 0.84 + 0.16 * fbm2( p * 9.0 + vec2( uTime * 0.6, uTime * 0.35 ) );
  float amp = ( 0.55 + 0.55 * uPulse ) * ( 0.8 + 0.45 * uBass ) * flick;

  float alpha = ( core + halo ) * amp;
  if ( alpha < 0.004 ) discard;

  gl_FragColor = vec4( uWarm * alpha, alpha );
  ${GLSL_OUTPUT}
}
`;

const WALL_GLOW_VERT = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

/** 火焰的外形：几片交叉的薄片，用噪声撕出火舌。 */
function createFlameGeometry(): THREE.BufferGeometry {
  const plane = new THREE.PlaneGeometry(0.42, 0.9, 6, 12);
  plane.translate(0, 0.45, 0);
  return plane;
}

function createEmberHearth(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'ember-hearth-scene';

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 120);
  camera.position.set(0, 1.05, 1.85);
  camera.lookAt(HEARTH_X, HEARTH_Y, HEARTH_Z);

  // ── 暗室 ──────────────────────────────────────────────────────────────
  const wallMaterial = new THREE.MeshStandardMaterial({
    color: 0x14100e,
    roughness: 0.97,
    metalness: 0,
  });
  configureStandard(wallMaterial, ctx.env.envMap, 0.05);

  const backWall = new THREE.Mesh(new THREE.PlaneGeometry(12, 7), wallMaterial);
  backWall.name = 'back-wall';
  backWall.position.set(0, 2.1, HEARTH_Z - 0.06);
  backWall.receiveShadow = true;
  root.add(backWall);

  const ground = ctx.env.createGround(14) as THREE.Mesh;
  const groundMaterial = new THREE.MeshStandardMaterial({
    color: 0x120d0b,
    roughness: 1,
    metalness: 0,
  });
  configureStandard(groundMaterial, ctx.env.envMap, 0.05);
  ground.material = groundMaterial;
  ground.name = 'hearth-ground';
  root.add(ground);

  // ── 壁炉体 ────────────────────────────────────────────────────────────
  const stoneMaterial = new THREE.MeshStandardMaterial({
    color: 0x1a1512,
    roughness: 0.94,
    metalness: 0,
  });
  configureStandard(stoneMaterial, ctx.env.envMap, 0.08);

  // 炉台：一块矮台
  const hearthBase = new THREE.Mesh(new THREE.BoxGeometry(1.66, 0.26, 0.72), stoneMaterial);
  hearthBase.name = 'hearth-base';
  hearthBase.position.set(HEARTH_X, 0.13, HEARTH_Z + 0.04);
  hearthBase.castShadow = true;
  hearthBase.receiveShadow = true;
  root.add(hearthBase);

  // ── 空间音源：炉火噼啪声从炉膛里传来 ────────────────────────────
  const crackle = attachSpatialSource(root, ctx.listener, {
    url: assetUrl('audio/sfx-fire.mp3'),
    position: [0, 0.62, 0],
    volume: 0.4,
    refDistance: 1.4,
    maxDistance: 22,
  });

  // 炉膛：只在炉台后面留出一个凹进去的暗腔，正面完全敞开给火
  const cavityMaterial = new THREE.MeshStandardMaterial({
    color: 0x0a0605,
    roughness: 1,
    metalness: 0,
    side: THREE.BackSide,
  });
  configureStandard(cavityMaterial, ctx.env.envMap, 0.02);
  const cavity = new THREE.Mesh(
    new THREE.BoxGeometry(OPENING_W, OPENING_H, 0.44),
    cavityMaterial,
  );
  cavity.name = 'hearth-cavity';
  cavity.position.set(HEARTH_X, HEARTH_Y, HEARTH_Z - 0.21);
  root.add(cavity);

  // 炉拱：左右两根立柱 + 顶部横梁，中间留空
  const archMaterial = new THREE.MeshStandardMaterial({
    color: 0x231b16,
    roughness: 0.9,
    metalness: 0,
  });
  configureStandard(archMaterial, ctx.env.envMap, 0.1);

  const jambGeometry = new THREE.BoxGeometry(0.26, OPENING_H + 0.3, 0.68);
  for (const side of [-1, 1]) {
    const jamb = new THREE.Mesh(jambGeometry, archMaterial);
    jamb.name = 'hearth-jamb';
    jamb.position.set(HEARTH_X + side * (OPENING_W * 0.5 + 0.13), HEARTH_Y - 0.06, HEARTH_Z + 0.02);
    jamb.castShadow = true;
    root.add(jamb);
  }

  const lintel = new THREE.Mesh(
    new THREE.BoxGeometry(OPENING_W + 0.52, 0.22, 0.7),
    archMaterial,
  );
  lintel.name = 'hearth-lintel';
  lintel.position.set(HEARTH_X, HEARTH_Y + OPENING_H * 0.5 + 0.09, HEARTH_Z + 0.02);
  lintel.castShadow = true;
  root.add(lintel);

  // 炉膛地面（炉灰）
  const ashMaterial = new THREE.MeshStandardMaterial({
    color: 0x191512,
    roughness: 1,
    metalness: 0,
  });
  configureStandard(ashMaterial, ctx.env.envMap, 0.04);
  const hearthFloor = new THREE.Mesh(new THREE.BoxGeometry(OPENING_W, 0.06, 0.5), ashMaterial);
  hearthFloor.name = 'hearth-floor';
  hearthFloor.position.set(HEARTH_X, HEARTH_Y - OPENING_H * 0.5, HEARTH_Z - 0.16);
  root.add(hearthFloor);

  // ── 火焰 ──────────────────────────────────────────────────────────────
  const flameGeometry = createFlameGeometry();
  const flameUniforms = {
    uTime: { value: 0 },
    uHeight: { value: 0.78 },
    uSway: { value: 0.09 },
    uIntensity: { value: 0.9 },
    uPulse: { value: 0 },
    uColorHot: { value: new THREE.Color(0xfff0c0) },
    uColorMid: { value: new THREE.Color(0xff8a2a) },
    uColorEdge: { value: new THREE.Color(0x8c1f06) },
  };
  const flameMaterial = new THREE.ShaderMaterial({
    uniforms: flameUniforms,
    vertexShader: FLAME_VERT,
    fragmentShader: FLAME_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });

  const flameGroup = new THREE.Group();
  flameGroup.name = 'flame';
  flameGroup.position.set(HEARTH_X, HEARTH_Y - 0.2, HEARTH_Z);
  root.add(flameGroup);

  // 三片交叉的薄片，从各个方向都看得到火
  for (let i = 0; i < 3; i += 1) {
    const sheet = new THREE.Mesh(flameGeometry, flameMaterial);
    sheet.name = `flame-sheet-${i}`;
    sheet.rotation.y = (i / 3) * Math.PI;
    sheet.renderOrder = 4;
    flameGroup.add(sheet);
  }

  // ── 余烬 ──────────────────────────────────────────────────────────────
  const emberSpace = new ParticleSpace({
    radius: 0.4,
    spin: 0,
    tilt: 0,
    position: [HEARTH_X, HEARTH_Y - 0.24, HEARTH_Z],
  });
  const emberUniforms = {
    uTime: { value: 0 },
    uScale: { value: 600 },
    uOpacity: { value: 0.85 },
    uLevel: { value: 0 },
    uPulse: { value: 0 },
  };
  const emberGeometry = createPointGeometry({
    count: Math.floor(90 * ctx.quality),
    seed: 3312,
    radius: 0.33,
    size: 0.02,
    attributes: [{ name: 'aGlow', size: 1, min: 0, max: 1 }],
  });
  const emberMaterial = createPointMaterial(emberSpace, {
    vertexShader: EMBER_VERT,
    fragmentShader: EMBER_FRAG,
    uniforms: emberUniforms,
  });
  const embers = new THREE.Points(emberGeometry, emberMaterial);
  embers.name = 'embers';
  embers.frustumCulled = false;
  root.add(embers);

  // ── 火星与灰烬 ────────────────────────────────────────────────────────
  const sparkSpace = new ParticleSpace({
    radius: 0.34,
    spin: 0,
    tilt: 0,
    position: [HEARTH_X, HEARTH_Y - 0.22, HEARTH_Z],
  });
  const sparkUniforms = {
    uTime: { value: 0 },
    uScale: { value: 600 },
    uOpacity: { value: 0.9 },
    uLevel: { value: 0 },
    uTreble: { value: 0 },
    uPulse: { value: 0 },
  };
  const sparkGeometry = createPointGeometry({
    count: Math.floor(150 * ctx.quality),
    seed: 9182,
    radius: 0.3,
    size: 0.016,
    attributes: [
      { name: 'aRise', size: 1, min: 0, max: 1 },
      { name: 'aAsh', size: 1, min: 0, max: 1 },
    ],
  });
  const sparkMaterial = createPointMaterial(sparkSpace, {
    vertexShader: SPARK_VERT,
    fragmentShader: SPARK_FRAG,
    uniforms: sparkUniforms,
  });
  const sparks = new THREE.Points(sparkGeometry, sparkMaterial);
  sparks.name = 'sparks';
  sparks.frustumCulled = false;
  root.add(sparks);

  // ── 墙上的暖光 ────────────────────────────────────────────────────────
  const wallGlowUniforms = {
    uWarm: { value: new THREE.Color(0xff9640) },
    uPulse: { value: 0 },
    uBass: { value: 0 },
    uTime: { value: 0 },
  };
  const wallGlowMaterial = new THREE.ShaderMaterial({
    uniforms: wallGlowUniforms,
    vertexShader: WALL_GLOW_VERT,
    fragmentShader: WALL_GLOW_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const wallGlow = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 3.0), wallGlowMaterial);
  wallGlow.name = 'wall-glow';
  wallGlow.position.set(HEARTH_X, HEARTH_Y + 0.1, HEARTH_Z - 0.04);
  wallGlow.renderOrder = 1;
  root.add(wallGlow);

  // 炉口的点光源：跟着火苗晃
  const fireLight = new THREE.PointLight(0xff9440, 3.2, 6.5, 2);
  fireLight.name = 'fire-light';
  fireLight.position.set(HEARTH_X, HEARTH_Y, HEARTH_Z + 0.08);
  root.add(fireLight);

  const lights = ctx.env.createStudioLights();
  dimLights(lights, 0.04, 0x4a3126);
  root.add(lights);

  const audio = new SleepAudioDrive(BREATHING);

  return {
    root,
    camera,
    immersive: false,
    xrDistance: 2.2,
    framing: { distance: 1.85, height: 1.05, targetY: HEARTH_Y, width: 2.6 },
    update(time: number, delta: number, context: SceneContext): void {
      audio.update(time, delta, context);
      const state = audio.state;

      emberSpace.update(delta, time);
      sparkSpace.update(delta, time);

      // ── 火焰：脉冲直接驱动高度与亮度 ──────────────────────────────
      const pulse = state.pulse;
      flameUniforms.uTime.value = time;
      flameUniforms.uPulse.value = pulse;
      flameUniforms.uHeight.value = 0.66 + pulse * 0.26 + state.drive * 0.08;
      flameUniforms.uSway.value = 0.06 + state.bass * 0.1 + state.drive * 0.03;
      flameUniforms.uIntensity.value = 0.72 + pulse * 0.42 + state.level * 0.16;
      flameGroup.scale.set(0.94 + pulse * 0.1, 1, 0.94 + pulse * 0.1);

      // ── 余烬与火星 ─────────────────────────────────────────────────
      emberUniforms.uTime.value = time;
      emberUniforms.uLevel.value = state.level;
      emberUniforms.uPulse.value = pulse;
      emberUniforms.uOpacity.value = 0.5 + state.level * 0.55;
      updatePointScale(emberUniforms.uScale, context, FOV);

      sparkUniforms.uTime.value = time;
      sparkUniforms.uLevel.value = state.level;
      sparkUniforms.uTreble.value = state.treble;
      sparkUniforms.uPulse.value = pulse;
      sparkUniforms.uOpacity.value = 0.45 + state.level * 0.6;
      updatePointScale(sparkUniforms.uScale, context, FOV);

      // ── 墙上的暖光：低频让晃动的幅度更大 ─────────────────────────
      wallGlowUniforms.uTime.value = time;
      wallGlowUniforms.uPulse.value = pulse;
      wallGlowUniforms.uBass.value = state.bass;
      wallGlow.scale.setScalar(0.96 + pulse * 0.08 + state.bass * 0.05);
      wallGlow.position.x = HEARTH_X + Math.sin(time * 0.24) * 0.03 * (1 + state.bass * 2);

      fireLight.intensity = 2.4 + pulse * 2.2 + state.level * 0.9;
      fireLight.position.x = HEARTH_X + Math.sin(time * 0.37) * 0.03;
      fireLight.position.y = HEARTH_Y + 0.04 + pulse * 0.03;
    },
    dispose(): void {
      crackle.stop();
      crackle.disconnect();
      disposeObject(root);
    },
  };
}

export const emberHearthScene: SceneDefinition = {
  id: 'ember-hearth',
  title: '壁炉余烬',
  subtitle: 'Hearth Embers',
  description: '壁炉里的火随着音乐的起伏轻轻跳动，余烬一颗颗亮起来又暗下去。',
  tags: ['壁炉', '火焰', '暖光'],
  accent: '#e0894a',
  gradient: ['#2a160c', '#080503'],
  category: SLEEP_CATEGORY,
  audio: 'enigma-sadness.mp3',
  breathing: BREATHING,
  create(ctx: SceneContext): SceneInstance {
    return createEmberHearth(ctx);
  },
};

export default emberHearthScene;
