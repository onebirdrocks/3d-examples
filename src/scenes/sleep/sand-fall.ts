/**
 * 沙漏 / Hourglass of Sand
 * ---------------------------------------------------------------
 * 一只悬浮的沙漏。玻璃壳是 transmission 材质，里面是一柱极慢下落的沙，
 * 落到底部会堆成越来越大的沙堆。玻璃上有一点微弱的月光反射。
 *
 * 音乐如何驱动画面：
 * - `bass` → 沙的流速（低频一沉，沙就落得快一点点）；
 * - `pulse` → 沙堆的明暗与悬浮高度的一点点起伏；
 * - `level` → 月光的反射强度；
 * - `drive` → 沙流的整体节奏（无音乐时由呼吸兜底）。
 */
import * as THREE from 'three';
import type { SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { disposeObject } from '../../core/loader.js';
import { ParticleSpace } from '../../core/particle-space.js';
import { GLSL_HASH, GLSL_OUTPUT, GLSL_OUTPUT_FUNCS } from './glsl.js';
import { SLEEP_CATEGORY, configureStandard, dimLights } from './palette.js';
import { SleepAudioDrive } from './audio-drive.js';
import { createPointGeometry, updatePointScale } from './points.js';
import { createMoteField, createNightDome, createRadialTexture } from './shared.js';

const BREATHING = { inhale: 5, hold: 3, exhale: 7 };

const FOV = 42;

/** 沙漏悬浮的高度（米）。 */
const FLOAT_Y = 1.02;

/** 玻璃半高。 */
const GLASS_HALF = 0.15;

/** 沙堆底部高度（相对沙漏中心）。 */
const PILE_BOTTOM = -0.142;

/** 沙堆的最大高度。 */
const PILE_MAX = 0.115;

/** 沙堆的斜率（底半径 / 高）。 */
const PILE_SLOPE = 1.5;

/* ------------------------------------------------------------------ *
 * 玻璃的菲涅尔边光（把沙漏的轮廓从夜色里勾出来）
 * ------------------------------------------------------------------ */

const RIM_VERT = /* glsl */ `
varying vec3 vNormalV;
varying vec3 vViewV;

void main() {
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  vNormalV = normalize( normalMatrix * normal );
  vViewV = normalize( -mv.xyz );
  gl_Position = projectionMatrix * mv;
}
`;

const RIM_FRAG = /* glsl */ `
precision highp float;

uniform float uIntensity;
uniform vec3 uColor;

varying vec3 vNormalV;
varying vec3 vViewV;

${GLSL_OUTPUT_FUNCS}

void main() {
  float grazing = 1.0 - abs( dot( normalize( vNormalV ), normalize( vViewV ) ) );
  float rim = pow( clamp( grazing, 0.0, 1.0 ), 3.4 );

  float alpha = rim * uIntensity;
  if ( alpha < 0.004 ) discard;

  gl_FragColor = vec4( uColor * alpha, alpha );
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * 沙流：从颈口极慢地落下
 * ------------------------------------------------------------------ */

const STREAM_VERT = /* glsl */ `
attribute float aSize;
attribute float aPhase;

uniform float uTime;
uniform float uScale;
uniform float uSpeed;
uniform float uLevel;
uniform float uBottom;
uniform float uHeight;

varying float vAlpha;

${GLSL_HASH}

void main() {
  vec3 p = position;

  // 从颈口（y = 0）落到沙堆顶：整个过程好几秒，慢得几乎察觉不到
  float fall = fract( uTime * uSpeed + aPhase );
  float floor = uBottom + uHeight;
  float y = mix( 0.004, floor, fall );

  // 沙柱：靠近颈口细，往下微微散开。
  // 角度必须和下落相位无关，否则一柱沙会拧成一条弹簧。
  float jitter = hash12( vec2( aPhase * 53.7, 3.71 ) );
  float radius = 0.006 + fall * 0.012 * jitter;
  float angle = jitter * 62.83;
  p.x = cos( angle ) * radius;
  p.z = sin( angle ) * radius;
  p.y = y;

  vec4 mv = modelViewMatrix * vec4( p, 1.0 );
  gl_Position = projectionMatrix * mv;

  // 两头淡入淡出
  vAlpha = smoothstep( 0.0, 0.08, fall ) * ( 1.0 - smoothstep( 0.9, 1.0, fall ) ) * ( 0.3 + 0.8 * uLevel );

  gl_PointSize = min( uScale * aSize / max( 1.0, -mv.z ), 5.0 );
}
`;

const STREAM_FRAG = /* glsl */ `
precision highp float;

uniform float uOpacity;

varying float vAlpha;

${GLSL_OUTPUT_FUNCS}

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot( c, c );
  if ( d2 > 0.25 ) discard;

  float falloff = exp( -d2 * 13.0 );
  float alpha = falloff * vAlpha * uOpacity;
  if ( alpha < 0.005 ) discard;

  gl_FragColor = vec4( vec3( 0.86, 0.72, 0.48 ) * alpha, alpha );
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * 沙堆上的颗粒
 * ------------------------------------------------------------------ */

const GRAIN_VERT = /* glsl */ `
attribute float aSize;
attribute float aPhase;
attribute float aDepth;

uniform float uTime;
uniform float uScale;
uniform float uHeight;
uniform float uBottom;
uniform float uSlope;
uniform float uLevel;

varying float vAlpha;

void main() {
  // 颗粒的高度是固定的：沙堆长高时它才被「埋进去」
  float y = uBottom + aDepth * ${PILE_MAX.toFixed(3)};

  // 沙堆的斜面半径（随堆高变化）
  float radius = uSlope * ( uHeight - ( y - uBottom ) );

  float angle = aPhase * 62.83;
  vec3 p = vec3( cos( angle ) * radius * 0.99, y, sin( angle ) * radius * 0.99 );

  // 堆太高之前，这颗沙还不在堆上
  float grown = smoothstep( 0.0, 0.012, radius );

  vec4 mv = modelViewMatrix * vec4( p, 1.0 );
  gl_Position = projectionMatrix * mv;

  vAlpha = grown * ( 0.35 + 0.75 * uLevel );

  gl_PointSize = min( uScale * aSize / max( 1.0, -mv.z ), 6.0 );
}
`;

const GRAIN_FRAG = /* glsl */ `
precision highp float;

uniform float uOpacity;

varying float vAlpha;

${GLSL_OUTPUT_FUNCS}

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot( c, c );
  if ( d2 > 0.25 ) discard;

  float falloff = exp( -d2 * 16.0 );
  float alpha = falloff * vAlpha * uOpacity;
  if ( alpha < 0.005 ) discard;

  gl_FragColor = vec4( vec3( 0.72, 0.60, 0.40 ) * alpha, alpha );
  ${GLSL_OUTPUT}
}
`;

/** 沙漏的玻璃外形（旋转体）：上腹 → 颈 → 下腹。 */
function createGlassProfile(): THREE.Vector2[] {
  const points: THREE.Vector2[] = [];
  const half = [
    [0.140, 0.150],
    [0.158, 0.128],
    [0.163, 0.100],
    [0.157, 0.072],
    [0.138, 0.048],
    [0.100, 0.026],
    [0.055, 0.010],
    [0.022, 0.002],
    [0.016, 0.000],
    [0.022, -0.002],
    [0.055, -0.010],
    [0.100, -0.026],
    [0.138, -0.048],
    [0.157, -0.072],
    [0.163, -0.100],
    [0.158, -0.128],
    [0.140, -0.150],
  ];
  for (const [r, y] of half) points.push(new THREE.Vector2(r, y));
  return points;
}

function createSandFall(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'sand-fall-scene';

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.02, 60);
  camera.position.set(0, 1.12, 0.92);
  camera.lookAt(0, FLOAT_Y, 0);

  // ── 夜色 ────────────────────────────────────────────────────────────
  const dome = createNightDome({
    zenith: 0x060a14,
    horizon: 0x0d1424,
    ground: 0x04050a,
    radius: 40,
  });
  root.add(dome.mesh);

  // ── 地面与落影 ──────────────────────────────────────────────────────
  const ground = ctx.env.createGround(10) as THREE.Mesh;
  const groundMaterial = new THREE.MeshStandardMaterial({
    color: 0x0b0d12,
    roughness: 1,
    metalness: 0,
  });
  configureStandard(groundMaterial, ctx.env.envMap, 0.05);
  ground.material = groundMaterial;
  ground.name = 'sand-ground';
  root.add(ground);

  const shadowTexture = createRadialTexture(256, 'rgba(0,0,0,0.75)', 'rgba(0,0,0,0.28)');
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(0.62, 0.62),
    new THREE.MeshBasicMaterial({
      map: shadowTexture,
      transparent: true,
      depthWrite: false,
      opacity: 0.6,
    }),
  );
  shadow.name = 'hourglass-shadow';
  shadow.rotation.x = -Math.PI * 0.5;
  shadow.position.set(0, 0.008, 0);
  root.add(shadow);

  // ── 悬浮的沙漏 ──────────────────────────────────────────────────────
  const hourglass = new THREE.Group();
  hourglass.name = 'hourglass';
  hourglass.position.set(0, FLOAT_Y, 0);
  root.add(hourglass);

  const glassGeometry = new THREE.LatheGeometry(createGlassProfile(), 56);

  const glassMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xdfeaf5,
    metalness: 0,
    roughness: 0.06,
    transmission: 0.96,
    thickness: 0.05,
    ior: 1.45,
    transparent: false,
    depthWrite: false,
  });
  glassMaterial.envMap = ctx.env.envMap;
  glassMaterial.envMapIntensity = 0.28;
  glassMaterial.needsUpdate = true;

  const glass = new THREE.Mesh(glassGeometry, glassMaterial);
  glass.name = 'glass-shell';
  glass.renderOrder = 2;
  hourglass.add(glass);

  // 玻璃的菲涅尔边光：月光在玻璃边缘的一点反光
  const rimUniforms = {
    uIntensity: { value: 0.32 },
    uColor: { value: new THREE.Color(0x9fb8e0) },
  };
  const rim = new THREE.Mesh(
    glassGeometry,
    new THREE.ShaderMaterial({
      uniforms: rimUniforms,
      vertexShader: RIM_VERT,
      fragmentShader: RIM_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    }),
  );
  rim.name = 'glass-rim';
  rim.scale.setScalar(1.012);
  rim.renderOrder = 3;
  hourglass.add(rim);

  // 上下两个木盘与三根立柱
  const frameMaterial = new THREE.MeshStandardMaterial({
    color: 0x332c22,
    roughness: 0.82,
    metalness: 0.08,
  });
  configureStandard(frameMaterial, ctx.env.envMap, 0.12);

  const capGeometry = new THREE.CylinderGeometry(0.178, 0.168, 0.026, 40);
  for (const sign of [1, -1]) {
    const cap = new THREE.Mesh(capGeometry, frameMaterial);
    cap.name = `hourglass-cap-${sign > 0 ? 'top' : 'bottom'}`;
    cap.position.y = sign * (GLASS_HALF + 0.012);
    hourglass.add(cap);
  }

  const postGeometry = new THREE.CylinderGeometry(0.011, 0.011, GLASS_HALF * 2 + 0.03, 12);
  for (let i = 0; i < 3; i += 1) {
    const angle = (i / 3) * Math.PI * 2 + 0.5;
    const post = new THREE.Mesh(postGeometry, frameMaterial);
    post.name = `hourglass-post-${i}`;
    post.position.set(Math.cos(angle) * 0.158, 0, Math.sin(angle) * 0.158);
    hourglass.add(post);
  }

  // ── 沙：下堆 / 上堆 / 沙柱 ──────────────────────────────────────────
  const sandMaterial = new THREE.MeshStandardMaterial({
    color: 0x6e6248,
    roughness: 0.98,
    metalness: 0,
    flatShading: true,
  });
  configureStandard(sandMaterial, ctx.env.envMap, 0.12);

  // 底部的沙堆：固定斜率，高度随时间长大
  const pile = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 40, 1), sandMaterial);
  pile.name = 'sand-pile';
  hourglass.add(pile);

  // 顶部的沙：倒过来的锥体，越漏越矮
  const topSand = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 28, 1), sandMaterial);
  topSand.name = 'sand-top';
  topSand.rotation.x = Math.PI;
  hourglass.add(topSand);

  // 沙柱：GPU 粒子。
  // 沙活在沙漏自己的局部空间里（跟着沙漏一起悬浮、一起转），
  // 所以这里用普通 ShaderMaterial，不叠粒子空间的全局矩阵。
  const streamUniforms = {
    uTime: { value: 0 },
    uScale: { value: 600 },
    uSpeed: { value: 0.1 },
    uLevel: { value: 0 },
    uBottom: { value: PILE_BOTTOM },
    uHeight: { value: 0 },
    uOpacity: { value: 0.7 },
  };
  const streamGeometry = createPointGeometry({
    count: Math.floor(760 * ctx.quality),
    seed: 4242,
    radius: 0.004,
    size: 0.006,
  });
  const streamMaterial = new THREE.ShaderMaterial({
    uniforms: streamUniforms,
    vertexShader: STREAM_VERT,
    fragmentShader: STREAM_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const stream = new THREE.Points(streamGeometry, streamMaterial);
  stream.name = 'sand-stream';
  stream.frustumCulled = false;
  hourglass.add(stream);

  // 沙堆表面的颗粒
  const grainUniforms = {
    uTime: { value: 0 },
    uScale: { value: 600 },
    uHeight: { value: 0 },
    uBottom: { value: PILE_BOTTOM },
    uSlope: { value: PILE_SLOPE },
    uLevel: { value: 0 },
    uOpacity: { value: 0.7 },
  };
  const grainGeometry = createPointGeometry({
    count: Math.floor(900 * ctx.quality),
    seed: 8899,
    radius: 0.12,
    size: 0.0075,
    attributes: [{ name: 'aDepth', size: 1, min: 0, max: 1 }],
  });
  const grainMaterial = new THREE.ShaderMaterial({
    uniforms: grainUniforms,
    vertexShader: GRAIN_VERT,
    fragmentShader: GRAIN_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const grains = new THREE.Points(grainGeometry, grainMaterial);
  grains.name = 'sand-grains';
  grains.frustumCulled = false;
  hourglass.add(grains);

  // ── 空气里的浮尘 ────────────────────────────────────────────────────
  const moteSpace = new ParticleSpace({
    radius: 1.4,
    spin: 0.005,
    tilt: 0.2,
    position: [0, FLOAT_Y, 0],
  });
  const motes = createMoteField(moteSpace, Math.floor(120 * ctx.quality), {
    color: 0xa9bdd8,
    size: 0.014,
    seed: 2024,
    opacity: 0.3,
  });
  root.add(motes.points);

  // ── 灯光：一点月光 + 极弱的底光 ─────────────────────────────────────
  const lights = ctx.env.createStudioLights();
  dimLights(lights, 0.05, 0x2c3a52);
  root.add(lights);

  const moonLight = new THREE.DirectionalLight(0xa6bce0, 1.4);
  moonLight.name = 'moon-light';
  moonLight.position.set(-1.6, 2.6, -1.9);
  moonLight.castShadow = false;
  root.add(moonLight);

  const warmLight = new THREE.PointLight(0xffb066, 0.22, 1.1, 2);
  warmLight.name = 'sand-warmth';
  warmLight.position.set(0.12, FLOAT_Y - 0.08, 0.16);
  root.add(warmLight);

  const audio = new SleepAudioDrive(BREATHING);

  // 已经漏掉的沙（0~1）：一开始就有一小堆，底座不会空着
  let spilled = 0.12;

  return {
    root,
    camera,
    immersive: false,
    xrDistance: 1.1,
    framing: { distance: 0.92, height: 1.12, targetY: FLOAT_Y, width: 0.62 },
    update(time: number, delta: number, context: SceneContext): void {
      audio.update(time, delta, context);
      const state = audio.state;

      moteSpace.update(delta, time);

      // ── 沙流：低频让流速微微变化 ────────────────────────────────────
      const flow = 0.78 + state.bass * 0.55 + state.drive * 0.12;
      spilled = Math.min(0.96, spilled + delta * 0.0011 * flow);

      const pileHeight = Math.max(0.001, spilled * PILE_MAX);
      const pileRadius = PILE_SLOPE * pileHeight;

      pile.scale.set(pileRadius, pileHeight, pileRadius);
      pile.position.y = PILE_BOTTOM + pileHeight * 0.5;

      // 上半球的沙越来越少，最后收成一条漏到颈口的细流
      const topHeight = Math.max(0.004, (1 - spilled) * 0.125);
      const topRadius = topHeight * 1.05;
      topSand.scale.set(topRadius, topHeight, topRadius);
      topSand.position.y = GLASS_HALF - 0.012 - topHeight * 0.5;

      // ── 沙柱与沙粒 ──────────────────────────────────────────────────
      streamUniforms.uTime.value = time;
      streamUniforms.uSpeed.value = 0.085 * flow;
      streamUniforms.uLevel.value = state.level;
      streamUniforms.uHeight.value = pileHeight;
      streamUniforms.uOpacity.value = 0.45 + state.level * 0.45;
      updatePointScale(streamUniforms.uScale, context, FOV);

      grainUniforms.uTime.value = time;
      grainUniforms.uHeight.value = pileHeight;
      grainUniforms.uLevel.value = state.level;
      grainUniforms.uOpacity.value = 0.4 + state.level * 0.4;
      updatePointScale(grainUniforms.uScale, context, FOV);

      // ── 悬浮：极慢地起伏与转动 ──────────────────────────────────────
      hourglass.position.y = FLOAT_Y + Math.sin(time * 0.11) * 0.014 + state.pulse * 0.004;
      hourglass.rotation.y = time * 0.021 + Math.sin(time * 0.05) * 0.05;
      hourglass.rotation.z = Math.sin(time * 0.037) * 0.018;
      shadow.position.set(hourglass.position.x, 0.008, hourglass.position.z);
      shadow.scale.setScalar(1 + (hourglass.position.y - FLOAT_Y) * 1.5);
      (shadow.material as THREE.MeshBasicMaterial).opacity = 0.5 - (hourglass.position.y - FLOAT_Y) * 2.2;

      // ── 月光反射 ────────────────────────────────────────────────────
      rimUniforms.uIntensity.value = 0.26 + state.level * 0.16 + state.drive * 0.06;
      moonLight.intensity = 1.2 + state.level * 0.5;
      warmLight.intensity = 0.18 + state.drive * 0.1;

      // ── 浮尘 ────────────────────────────────────────────────────────
      motes.uniforms.uTime.value = time;
      motes.uniforms.uLevel.value = state.level;
      motes.uniforms.uBreath.value = state.breath;
      updatePointScale(motes.uniforms.uScale, context, FOV);

      dome.uniforms.uTime.value = time;
      dome.uniforms.uBreath.value = state.breath;
    },
    dispose(): void {
      shadowTexture.dispose();
      disposeObject(root);
    },
  };
}

export const sandFallScene: SceneDefinition = {
  id: 'sand-fall',
  title: '沙漏',
  subtitle: 'Hourglass of Sand',
  description: '一只悬浮的沙漏，沙以几乎看不见的速度落下，在底部堆成越来越高的沙丘。',
  tags: ['沙漏', '悬浮', '冥想'],
  accent: '#c2a46b',
  gradient: ['#1a1610', '#06070b'],
  category: SLEEP_CATEGORY,
  audio: 'sand-fall.mp3',
  breathing: BREATHING,
  lighting: {
    autoExposure: true,
    autoExposureKey: 0.06,
  },
  create(ctx: SceneContext): SceneInstance {
    return createSandFall(ctx);
  },
};

export default sandFallScene;
