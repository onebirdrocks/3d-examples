/**
 * 洞穴潮汐 / Tidal Cave
 * ---------------------------------------------------------------
 * 幽蓝的地下洞穴。一汪潮水在洞穴里极缓慢地涨落：音乐的低频抬起水位，
 * 也抬起水面的波纹。洞顶垂下钟乳石的剪影，水面映着洞壁的微光，
 * 偶尔有气泡从水底升起。深潜般的静谧。
 *
 * 音乐如何驱动画面：
 * - `bass` → 水位与波纹幅度（画面最主要的运动）；
 * - `pulse` → 水面反光的整体明灭；
 * - `level` → 洞内幽蓝的辉光强度；
 * - `treble` → 气泡的细碎闪动。
 */
import * as THREE from 'three';
import type { SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { disposeObject } from '../../core/loader.js';
import { ParticleSpace } from '../../core/particle-space.js';
import { GLSL_DITHER, GLSL_HASH, GLSL_NOISE2, GLSL_NOISE3, GLSL_OUTPUT, GLSL_OUTPUT_FUNCS } from './glsl.js';
import { SLEEP_CATEGORY, configureStandard, dimLights } from './palette.js';
import { SleepAudioDrive } from './audio-drive.js';
import { createPointGeometry, createPointMaterial, updatePointScale } from './points.js';

const BREATHING = { inhale: 6, hold: 2, exhale: 8 };

const FOV = 56;

/** 水面基准高度。 */
const WATER_BASE_Y = 0.52;

/** 洞穴半径。 */
const CAVE_RADIUS = 9;

/* ------------------------------------------------------------------ *
 * 洞壁：内向的球壳，噪声塑形的岩壁
 * ------------------------------------------------------------------ */

const CAVE_VERT = /* glsl */ `
varying vec3 vLocal;
varying vec3 vNormalV;
varying vec3 vViewV;
varying vec3 vWorld;

void main() {
  vLocal = position;
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWorld = wp.xyz;
  vNormalV = normalize( normalMatrix * normal );
  vec4 mv = viewMatrix * wp;
  vViewV = normalize( -mv.xyz );
  gl_Position = projectionMatrix * mv;
}
`;

const CAVE_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uLevel;
uniform float uPulse;
uniform vec3 uRockColor;
uniform vec3 uGlowColor;
uniform vec3 uGlowPos;

varying vec3 vLocal;
varying vec3 vNormalV;
varying vec3 vViewV;
varying vec3 vWorld;

${GLSL_HASH}
${GLSL_NOISE3}
${GLSL_DITHER}
${GLSL_OUTPUT_FUNCS}

void main() {
  // 岩壁的粗糙质感
  float n = fbm3( vLocal * 1.35 + vec3( 0.0, uTime * 0.012, 0.0 ) );
  float n2 = fbm3( vLocal * 4.6 - vec3( uTime * 0.02, 0.0, 0.0 ) );
  float rough = n * 0.72 + n2 * 0.28;

  vec3 col = uRockColor * ( 0.42 + 0.75 * rough );

  // 洞壁上的微光源：像深处有一层幽蓝的光在渗出来
  float d = distance( vWorld, uGlowPos );
  float glow = exp( -d * d * 0.09 );
  col += uGlowColor * glow * ( 0.35 + 0.5 * uLevel + 0.25 * uPulse );

  // 顶部的岩壁更暗（过渡要柔，避免出现一条硬地平线）
  col *= 0.42 + 0.58 * smoothstep( 7.0, -1.0, vWorld.y );

  // 边缘的菲涅尔，让洞穴有体积感
  float ndv = clamp( dot( normalize( vNormalV ), normalize( vViewV ) ), 0.0, 1.0 );
  col += uGlowColor * pow( 1.0 - ndv, 3.0 ) * 0.12 * ( 0.4 + 0.8 * uLevel );

  col += ( dither( gl_FragCoord.xy ) - 0.5 ) * 0.005;
  gl_FragColor = vec4( col, 1.0 );
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * 水面：极缓慢的起伏与倒影
 * ------------------------------------------------------------------ */

const WATER_VERT = /* glsl */ `
uniform float uTime;
uniform float uLevel;
uniform float uPulse;

varying vec3 vWorld;
varying vec3 vNormalW;

${GLSL_NOISE2}

float waveHeight( vec2 p, float t ) {
  float h = 0.0;
  h += sin( dot( p, vec2( 0.86, 0.51 ) ) * 0.55 + t * 0.18 ) * 0.55;
  h += sin( dot( p, vec2( -0.42, 0.91 ) ) * 0.92 - t * 0.13 ) * 0.26;
  h += sin( dot( p, vec2( 0.62, -0.78 ) ) * 1.7 + t * 0.09 ) * 0.11;
  return h;
}

void main() {
  vec3 p = position;

  float dist = length( p.xz );
  float fade = 1.0 - smoothstep( 3.0, 9.0, dist );

  // 脉冲：水面被轻轻推起一层细浪（画面里最直接的音乐响应）
  float pulseWave = sin( length( p.xz ) * 2.6 - uTime * 0.5 ) * uPulse * 0.09 * fade;

  float h = waveHeight( p.xz, uTime ) * uLevel * fade + pulseWave;
  float hx = waveHeight( p.xz + vec2( 0.6, 0.0 ), uTime ) * uLevel * fade + pulseWave;
  float hz = waveHeight( p.xz + vec2( 0.0, 0.6 ), uTime ) * uLevel * fade + pulseWave;
  p.y += h;

  vec3 n = normalize( vec3( h - hx, 0.55, h - hz ) );
  vNormalW = normalize( mat3( modelMatrix ) * n );

  vec4 wp = modelMatrix * vec4( p, 1.0 );
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const WATER_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uLevel;
uniform float uPulse;
uniform float uTreble;
uniform vec3 uDeepColor;
uniform vec3 uGlowColor;
uniform vec3 uGlowPos;
uniform vec3 uCaveColor;

varying vec3 vWorld;
varying vec3 vNormalW;

${GLSL_HASH}
${GLSL_NOISE2}
${GLSL_DITHER}
${GLSL_OUTPUT_FUNCS}

void main() {
  vec3 V = normalize( cameraPosition - vWorld );
  float dist = length( vWorld - cameraPosition );

  // 水面上的细碎涟漪（远处淡出，避免高频闪烁）
  vec2 q = vWorld.xz * 1.15 + vec2( uTime * 0.03, uTime * 0.021 );
  float n0 = fbm2( q );
  float nx = fbm2( q + vec2( 0.28, 0.0 ) );
  float nz = fbm2( q + vec2( 0.0, 0.28 ) );
  float detailFade = 1.0 - smoothstep( 4.0, 14.0, dist );

  vec3 N = normalize( vNormalW + vec3( ( n0 - nx ) * 1.5, 0.0, ( n0 - nz ) * 1.5 ) * detailFade );

  float ndv = clamp( dot( N, V ), 0.0, 1.0 );
  float fres = 0.05 + 0.95 * pow( 1.0 - ndv, 4.0 );

  // 洞壁的颜色被水面反射回来（简化的近似）
  vec3 reflected = mix( uCaveColor * 0.5, uCaveColor, fres );
  vec3 col = mix( uDeepColor, reflected, clamp( fres, 0.0, 0.85 ) );

  // 洞壁那点微光在水中的倒影
  vec3 toGlow = uGlowPos - vWorld;
  float gd = length( toGlow );
  vec3 L = toGlow / max( gd, 0.0001 );
  vec3 H = normalize( L + V );
  float spec = pow( clamp( dot( N, H ), 0.0, 1.0 ), 90.0 );
  float pool = exp( -gd * gd * 0.045 );

  col += uGlowColor * spec * pool * ( 0.7 + 1.4 * uPulse ) * detailFade;
  col += uGlowColor * pool * 0.16 * ( 0.6 + 0.6 * uLevel );

  // 高频带来一点点细碎的反光
  float glint = smoothstep( 0.86, 1.0, n0 ) * uTreble * detailFade;
  col += uGlowColor * glint * 0.5;

  // 远处的水面融进黑暗
  float fade = 1.0 - smoothstep( 3.0, 11.0, dist );
  col *= 0.18 + 0.82 * fade;

  col += ( dither( gl_FragCoord.xy ) - 0.5 ) * 0.005;
  gl_FragColor = vec4( col, 1.0 );
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * 钟乳石：自洞顶垂下的剪影
 * ------------------------------------------------------------------ */

const STALACTITE_VERT = /* glsl */ `
attribute float aHeightFrac;

uniform float uTime;
uniform float uSway;

varying float vHeight;
varying vec3 vNormalV;
varying vec3 vViewV;

${GLSL_HASH}

void main() {
  vec3 p = position;
  float h = clamp( aHeightFrac, 0.0, 1.0 );

  // 钟乳石几乎不动，只有极轻的晃动
  float phase = uTime * 0.19 + aHeightFrac * 2.0;
  float wob = ( hash12( vec2( aHeightFrac, 3.0 ) ) - 0.5 ) * 2.0;
  p.x += sin( phase ) * uSway * h * wob;
  p.z += cos( phase * 0.8 ) * uSway * 0.6 * h * wob;

  vHeight = h;
  vNormalV = normalize( normalMatrix * normal );
  vec4 mv = modelViewMatrix * vec4( p, 1.0 );
  vViewV = normalize( -mv.xyz );
  gl_Position = projectionMatrix * mv;
}
`;

const STALACTITE_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uRockColor;
uniform vec3 uGlowColor;
uniform float uLevel;

varying float vHeight;
varying vec3 vNormalV;
varying vec3 vViewV;

${GLSL_OUTPUT_FUNCS}

void main() {
  vec3 col = uRockColor * ( 0.32 + 0.5 * ( 1.0 - vHeight ) );

  // 边缘的微光：石头的轮廓被深处的光勾出来
  float ndv = clamp( dot( normalize( vNormalV ), normalize( vViewV ) ), 0.0, 1.0 );
  col += uGlowColor * pow( 1.0 - ndv, 2.4 ) * 0.22 * ( 0.4 + 0.8 * uLevel );

  gl_FragColor = vec4( col, 1.0 );
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * 气泡：从水底缓缓升起
 * ------------------------------------------------------------------ */

const BUBBLE_VERT = /* glsl */ `
attribute float aSize;
attribute float aPhase;
attribute float aRise;

uniform float uTime;
uniform float uScale;
uniform float uLevel;
uniform float uTreble;

varying float vAlpha;

void main() {
  vec3 p = position;

  // 极慢地上升，途中轻轻摇晃
  float rise = mod( uTime * ( 0.035 + 0.05 * aRise ), 2.2 );
  p.y += rise;
  p.x += sin( uTime * 0.29 + aPhase * 6.2831 ) * 0.035 * ( 0.4 + rise );
  p.z += cos( uTime * 0.24 + aPhase * 4.3 ) * 0.03 * ( 0.4 + rise );

  vec4 mv = modelViewMatrix * vec4( particleSpaceTransform( p ), 1.0 );
  gl_Position = projectionMatrix * mv;

  float fade = 1.0 - smoothstep( 0.3, 2.1, rise );
  float shimmer = 0.7 + 0.3 * sin( uTime * 0.6 + aPhase * 14.0 );
  vAlpha = fade * shimmer * ( 0.28 + 0.75 * uLevel ) * ( 0.85 + 0.45 * uTreble );

  gl_PointSize = uScale * aSize / max( 1.0, -mv.z );
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

  // 气泡：中间几乎透明，边缘一圈亮环
  float ring = smoothstep( 0.5, 0.34, d ) - smoothstep( 0.34, 0.16, d );
  float alpha = ring * vAlpha * uOpacity;
  if ( alpha < 0.005 ) discard;

  vec3 tint = vec3( 0.68, 0.86, 0.95 );
  gl_FragColor = vec4( tint, alpha );
  ${GLSL_OUTPUT}
}
`;

/** 一根钟乳石：从 y=0 向下垂。 */
function createStalactite(radius: number, length: number, seed: number): THREE.BufferGeometry {
  const segments = 8;
  const radial = 7;
  const geometry = new THREE.CylinderGeometry(radius * 0.16, radius, length, radial, segments, false);
  geometry.translate(0, -length * 0.5, 0);

  const position = geometry.getAttribute('position');
  const count = position.count;
  const aHeightFrac = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    const y = position.getY(i);
    // 0 在尖端，1 在根部
    aHeightFrac[i] = Math.min(1, Math.max(0, 1 + y / length));
  }
  geometry.setAttribute('aHeightFrac', new THREE.BufferAttribute(aHeightFrac, 1));
  geometry.userData.seed = seed;
  return geometry;
}

function createTideCave(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'tide-cave-scene';

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 200);
  camera.position.set(0, 1.45, 4.6);
  camera.lookAt(0, 1.1, 0);

  // ── 洞壁 ──────────────────────────────────────────────────────────────
  const glowPos = new THREE.Vector3(-3.2, 1.9, -5.4);
  const caveUniforms = {
    uTime: { value: 0 },
    uLevel: { value: 0 },
    uPulse: { value: 0 },
    uRockColor: { value: new THREE.Color(0x16222c) },
    uGlowColor: { value: new THREE.Color(0x2f6f9c) },
    uGlowPos: { value: glowPos.clone() },
  };
  const cave = new THREE.Mesh(
    new THREE.SphereGeometry(CAVE_RADIUS, 48, 32),
    new THREE.ShaderMaterial({
      uniforms: caveUniforms,
      vertexShader: CAVE_VERT,
      fragmentShader: CAVE_FRAG,
      side: THREE.BackSide,
    }),
  );
  cave.name = 'cave';
  cave.position.y = 1.2;
  root.add(cave);

  // 洞底：核心给的地面（水平大平面），藏在水面之下
  const floor = ctx.env.createGround(CAVE_RADIUS * 2.1) as THREE.Mesh;
  const floorMaterial = new THREE.MeshStandardMaterial({
    color: 0x0d151c,
    roughness: 1,
    metalness: 0,
  });
  configureStandard(floorMaterial, ctx.env.envMap, 0.04);
  floor.material = floorMaterial;
  floor.name = 'cave-floor';
  floor.position.y = 0.02;
  root.add(floor);

  // ── 水面 ──────────────────────────────────────────────────────────────
  const waterUniforms = {
    uTime: { value: 0 },
    uLevel: { value: 0.16 },
    uPulse: { value: 0 },
    uTreble: { value: 0 },
    uDeepColor: { value: new THREE.Color(0x060d14) },
    uGlowColor: { value: new THREE.Color(0x3f88b8) },
    uGlowPos: { value: glowPos.clone() },
    uCaveColor: { value: new THREE.Color(0x1a2a36) },
  };
  const waterSegments = Math.round(THREE.MathUtils.clamp(90 * ctx.quality, 40, 120));
  const waterGeometry = new THREE.PlaneGeometry(19, 19, waterSegments, waterSegments);
  waterGeometry.rotateX(-Math.PI / 2);
  const water = new THREE.Mesh(
    waterGeometry,
    new THREE.ShaderMaterial({
      uniforms: waterUniforms,
      vertexShader: WATER_VERT,
      fragmentShader: WATER_FRAG,
    }),
  );
  water.name = 'water';
  water.position.y = WATER_BASE_Y;
  root.add(water);

  // ── 钟乳石 ────────────────────────────────────────────────────────────
  const stalactiteUniforms = {
    uTime: { value: 0 },
    uSway: { value: 0.012 },
    uRockColor: { value: new THREE.Color(0x121c25) },
    uGlowColor: { value: new THREE.Color(0x2f6f9c) },
    uLevel: { value: 0 },
  };
  const stalactiteMaterial = new THREE.ShaderMaterial({
    uniforms: stalactiteUniforms,
    vertexShader: STALACTITE_VERT,
    fragmentShader: STALACTITE_FRAG,
  });

  const stalactiteGroup = new THREE.Group();
  stalactiteGroup.name = 'stalactites';
  root.add(stalactiteGroup);

  const stalactiteCount = Math.floor(22 * ctx.quality);
  for (let i = 0; i < stalactiteCount; i += 1) {
    const angle = (i / stalactiteCount) * Math.PI * 2 + (i % 3) * 0.4;
    const radius = 2.2 + ((i * 7919) % 100) / 100 * 4.6;
    const length = 0.9 + ((i * 6151) % 100) / 100 * 2.6;
    const thickness = 0.11 + ((i * 4517) % 100) / 100 * 0.19;

    const geometry = createStalactite(thickness, length, i);
    const mesh = new THREE.Mesh(geometry, stalactiteMaterial);
    mesh.name = `stalactite-${i}`;
    // 从洞顶垂下来：位置落在画面上半部，能看见剪影
    const ceiling = 5.6 - ((i * 3571) % 100) / 100 * 1.6;
    mesh.position.set(
      Math.cos(angle) * radius,
      ceiling,
      Math.sin(angle) * radius,
    );
    mesh.rotation.z = (((i * 2731) % 100) / 100 - 0.5) * 0.16;
    stalactiteGroup.add(mesh);
  }

  // ── 气泡 ──────────────────────────────────────────────────────────────
  const bubbleSpace = new ParticleSpace({
    radius: 2.6,
    spin: 0.004,
    tilt: 0.06,
    position: [0, WATER_BASE_Y - 0.05, 0],
  });
  const bubbleUniforms = {
    uTime: { value: 0 },
    uScale: { value: 600 },
    uOpacity: { value: 0.85 },
    uLevel: { value: 0 },
    uTreble: { value: 0 },
  };
  const bubbleGeometry = createPointGeometry({
    count: Math.floor(120 * ctx.quality),
    seed: 2287,
    radius: 2.4,
    size: 0.03,
    attributes: [{ name: 'aRise', size: 1, min: 0, max: 1 }],
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

  // ── 灯光 ──────────────────────────────────────────────────────────────
  const lights = ctx.env.createStudioLights();
  dimLights(lights, 0.035, 0x2b4a66);
  root.add(lights);

  const glowLight = new THREE.PointLight(0x3f88b8, 3.0, 16, 2);
  glowLight.name = 'cave-glow';
  glowLight.position.copy(glowPos);
  root.add(glowLight);

  const audio = new SleepAudioDrive(BREATHING);

  return {
    root,
    camera,
    immersive: true,
    xrDistance: 3,
    framing: { distance: 4.6, height: 1.45, targetY: 1.1, width: 8 },
    update(time: number, delta: number, context: SceneContext): void {
      audio.update(time, delta, context);
      const state = audio.state;

      bubbleSpace.breathe = 1 + state.bass * 0.05;
      bubbleSpace.update(delta, time);

      // ── 洞壁与幽光 ──────────────────────────────────────────────────
      caveUniforms.uTime.value = time;
      caveUniforms.uLevel.value = state.level;
      caveUniforms.uPulse.value = state.pulse;

      stalactiteUniforms.uTime.value = time;
      stalactiteUniforms.uLevel.value = state.level;

      // ── 水位与波纹：低频直接驱动 ───────────────────────────────────
      const tide = state.bass * 0.26 + state.drive * 0.07;
      waterUniforms.uTime.value = time;
      waterUniforms.uLevel.value = 0.12 + tide;
      waterUniforms.uPulse.value = state.pulse;
      waterUniforms.uTreble.value = state.treble;
      water.position.y = WATER_BASE_Y + state.bass * 0.075 + state.drive * 0.02;

      // ── 气泡 ─────────────────────────────────────────────────────────
      bubbleUniforms.uTime.value = time;
      bubbleUniforms.uLevel.value = state.level;
      bubbleUniforms.uTreble.value = state.treble;
      bubbleUniforms.uOpacity.value = 0.4 + state.level * 0.6;
      updatePointScale(bubbleUniforms.uScale, context, FOV);

      // ── 洞内的光 ─────────────────────────────────────────────────────
      glowLight.intensity = 2.2 + state.level * 1.8 + state.pulse * 0.9;
    },
    dispose(): void {
      disposeObject(root);
    },
  };
}

export const tideCaveScene: SceneDefinition = {
  id: 'tide-cave',
  title: '洞穴潮汐',
  subtitle: 'Tidal Cave',
  description: '地下的水潭随着音乐的低频缓缓涨落，气泡从深处一颗颗浮上来。',
  tags: ['洞穴', '潮汐', '幽蓝'],
  accent: '#4f92c4',
  gradient: ['#0e2130', '#03070c'],
  category: SLEEP_CATEGORY,
  audio: 'underwater-sleep.mp3',
  breathing: BREATHING,
  create(ctx: SceneContext): SceneInstance {
    return createTideCave(ctx);
  },
};

export default tideCaveScene;
