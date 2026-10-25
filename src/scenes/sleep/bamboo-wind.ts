/**
 * 竹林夜风 / Bamboo Wind
 * ---------------------------------------------------------------
 * 夜里的竹林。细长的竹竿在夜风中极缓慢地摆动——弯曲完全发生在顶点着色器里，
 * 按高度加权（越高摆得越多），所以竹梢动得多、竹根几乎不动。
 * 叶丛是深色剪影，地面浮着一层薄雾，偶有几点萤光。
 * 安静、无人声。
 *
 * 音乐如何驱动画面：
 * - `pulse` → 竹竿的摆动幅度（画面最主要的运动）；
 * - `mid` → 湍流强度：风里多一分不规则的抖动；
 * - `bass` → 地面薄雾的浓度；
 * - `level` → 整体亮度；
 * - `treble` → 萤光的明灭。
 */
import * as THREE from 'three';
import type { SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { disposeObject, assetUrl } from '../../core/loader.js';
import { attachSpatialSource } from '../../core/spatial-audio.js';
import { GLSL_DITHER, GLSL_HASH, GLSL_NOISE2, GLSL_NOISE3, GLSL_OUTPUT, GLSL_OUTPUT_FUNCS } from './glsl.js';
import { SLEEP_CATEGORY, configureStandard, dimLights } from './palette.js';
import { SleepAudioDrive } from './audio-drive.js';
import { createPointGeometry, updatePointScale } from './points.js';

const BREATHING = { inhale: 5, hold: 5, exhale: 5, holdOut: 5 };

const FOV = 54;

/* ------------------------------------------------------------------ *
 * 竹竿：顶点着色器里按高度加权弯曲
 * ------------------------------------------------------------------ */

const BAMBOO_VERT = /* glsl */ `
attribute float aBend;      // 0~1：这根竹子的弯曲相位
attribute float aStiff;     // 0~1：刚性（越高越柔）
attribute float aHeightFrac; // 0~1：顶点在本根竹子上的高度比例

uniform float uTime;
uniform float uSway;        // 摆动幅度
uniform float uTurbulence;  // 湍流（不规则抖动）

varying float vHeight;
varying float vLight;
varying vec3 vWorld;
varying vec3 vNormalW;

${GLSL_HASH}
${GLSL_NOISE3}

void main() {
  vec3 p = position;

  // 高度加权：根部几乎不动，越往上摆幅越大
  float h = clamp( aHeightFrac, 0.0, 1.0 );
  float weight = h * h * ( 1.0 - aStiff * 0.55 );

  // 主摆动：周期约 14 秒，比心跳慢得多
  float phase = uTime * 0.45 + aBend * 6.2831;
  float sway = sin( phase ) * 0.62 + sin( phase * 0.63 + 1.7 ) * 0.38;

  // 湍流：更快的、幅度很小的不规则抖动
  float turb = fbm3( vec3( p.y * 0.6, uTime * 0.16, aBend * 12.0 ) ) - 0.5;

  float amount = ( sway * uSway + turb * uTurbulence ) * weight;
  p.x += amount * 0.9;
  p.z += amount * 0.55;

  vHeight = h;
  vLight = 0.55 + 0.45 * sin( phase * 1.3 + aBend * 4.0 );

  vec4 wp = modelMatrix * vec4( p, 1.0 );
  vWorld = wp.xyz;
  vNormalW = normalize( mat3( modelMatrix ) * normal );
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const BAMBOO_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uColorLow;
uniform vec3 uColorHigh;
uniform vec3 uRimColor;
uniform float uLevel;
uniform vec3 uMoonDir;

varying float vHeight;
varying float vLight;
varying vec3 vWorld;
varying vec3 vNormalW;

${GLSL_OUTPUT_FUNCS}

void main() {
  // 竹身：根部深青，梢部略亮
  vec3 col = mix( uColorLow, uColorHigh, smoothstep( 0.0, 0.85, vHeight ) );
  col *= 0.72 + 0.4 * vLight;
  col *= 0.7 + 0.5 * uLevel;

  // 月光从侧后方来：朝光的一面稍亮，背光的一面更暗，竹身才有圆柱感
  vec3 V = normalize( cameraPosition - vWorld );
  vec3 N = normalize( vNormalW );
  float lambert = max( dot( N, uMoonDir ), 0.0 );
  col *= 0.55 + 0.85 * lambert;

  // 掠射角的一道月光边
  float rim = pow( 1.0 - max( dot( N, V ), 0.0 ), 2.6 );
  col += uRimColor * rim * 0.34;

  gl_FragColor = vec4( col, 1.0 );
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * 叶丛：深色剪影
 * ------------------------------------------------------------------ */

const LEAF_VERT = /* glsl */ `
attribute float aBend;
attribute float aHeightFrac;

uniform float uTime;
uniform float uSway;
uniform float uTurbulence;

varying float vHeight;
varying vec2 vUv;

${GLSL_NOISE3}

void main() {
  vUv = uv;
  vec3 p = position;

  float h = clamp( aHeightFrac, 0.0, 1.0 );
  float weight = h * h;

  float phase = uTime * 0.45 + aBend * 6.2831;
  float sway = sin( phase ) * 0.62 + sin( phase * 0.63 + 1.7 ) * 0.38;
  float turb = fbm3( vec3( p.y * 0.6, uTime * 0.16, aBend * 12.0 ) ) - 0.5;

  float amount = ( sway * uSway + turb * uTurbulence ) * weight;
  p.x += amount * 1.25;
  p.z += amount * 0.72;

  vHeight = h;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( p, 1.0 );
}
`;

const LEAF_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uLeafColor;
uniform float uLevel;
uniform vec3 uMoonDir;

varying float vHeight;
varying vec2 vUv;

${GLSL_OUTPUT_FUNCS}

void main() {
  // 竹叶的轮廓：两头尖的柳叶形，不是矩形
  float x = vUv.x * 2.0 - 1.0;
  float y = vUv.y;
  float halfWidth = sin( y * 3.14159 ) * 0.92;
  float leaf = 1.0 - smoothstep( halfWidth * 0.55, halfWidth, abs( x ) );
  if ( leaf < 0.02 ) discard;

  vec3 col = uLeafColor * ( 0.55 + 0.75 * leaf );
  col *= 0.7 + 0.5 * uLevel;
  gl_FragColor = vec4( col, 1.0 );
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * 地面薄雾
 * ------------------------------------------------------------------ */

const MIST_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uDensity;
uniform float uLevel;
uniform vec3 uMistColor;

varying vec3 vWorld;
varying vec2 vUv;

${GLSL_HASH}
${GLSL_NOISE2}
${GLSL_DITHER}
${GLSL_OUTPUT_FUNCS}

void main() {
  float n = fbm2( vWorld.xz * 0.22 + vec2( uTime * 0.018, uTime * 0.012 ) );
  float density = smoothstep( 0.24, 0.68, n ) * uDensity;

  vec2 e = abs( vUv - 0.5 ) * 2.0;
  float fade = ( 1.0 - smoothstep( 0.35, 1.0, e.x ) ) * ( 1.0 - smoothstep( 0.35, 1.0, e.y ) );

  float alpha = density * fade * ( 0.55 + 0.45 * uLevel );
  if ( alpha < 0.004 ) discard;

  vec3 col = uMistColor * ( 0.75 + 0.45 * uLevel );
  col += ( dither( gl_FragCoord.xy ) - 0.5 ) * 0.004;
  gl_FragColor = vec4( col, alpha );
  ${GLSL_OUTPUT}
}
`;

const MIST_VERT = /* glsl */ `
uniform float uTime;

varying vec3 vWorld;
varying vec2 vUv;

${GLSL_NOISE3}

void main() {
  vUv = uv;
  vec3 p = position;
  // 薄雾层自身极缓地起伏
  float n = fbm3( vec3( p.x * 0.2, uTime * 0.03, p.z * 0.2 ) );
  p.y += ( n - 0.5 ) * 0.16;

  vec4 wp = modelMatrix * vec4( p, 1.0 );
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

/* ------------------------------------------------------------------ *
 * 萤光
 * ------------------------------------------------------------------ */

const FIREFLY_VERT = /* glsl */ `
attribute float aSize;
attribute float aPhase;

uniform float uTime;
uniform float uScale;
uniform float uTreble;
uniform float uLevel;

varying float vAlpha;
varying vec3 vTint;

void main() {
  vec3 p = position;

  // 萤光虫极慢地游动
  p.x += sin( uTime * 0.21 + aPhase * 6.2831 ) * 0.14;
  p.y += sin( uTime * 0.13 + aPhase * 3.7 ) * 0.1;
  p.z += cos( uTime * 0.17 + aPhase * 5.1 ) * 0.14;

  vec4 mv = modelViewMatrix * vec4( p, 1.0 );
  gl_Position = projectionMatrix * mv;

  // 呼吸式明灭，周期 5 秒以上；高频带来一点点额外的闪
  float glow = 0.5 + 0.5 * sin( uTime * 0.42 + aPhase * 12.0 );
  glow = pow( glow, 2.4 );
  vAlpha = glow * ( 0.35 + 0.75 * uLevel ) * ( 0.8 + 0.5 * uTreble );
  vTint = mix( vec3( 0.72, 1.0, 0.48 ), vec3( 0.95, 1.0, 0.62 ), aPhase );

  gl_PointSize = uScale * aSize / max( 1.0, -mv.z );
}
`;

const FIREFLY_FRAG = /* glsl */ `
precision highp float;

uniform float uOpacity;

varying float vAlpha;
varying vec3 vTint;

${GLSL_OUTPUT_FUNCS}

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot( c, c );
  if ( d2 > 0.25 ) discard;
  float core = exp( -d2 * 20.0 );
  float halo = exp( -d2 * 5.0 ) * 0.4;
  float alpha = ( core + halo ) * vAlpha * uOpacity;
  if ( alpha < 0.005 ) discard;
  gl_FragColor = vec4( vTint, alpha );
  ${GLSL_OUTPUT}
}
`;

/** 可复现的伪随机数发生器（mulberry32）。 */
function createRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 生成一根竹子（带弯曲属性）。
 *
 * 竹节用略粗的环表示，整根用 12 段高度分段，让顶点着色器能做出平滑的弯曲。
 */
function createBambooGeometry(
  height: number,
  radius: number,
  bend: number,
  stiffness: number,
): THREE.BufferGeometry {
  const segments = 12;
  const radial = 6;
  const geometry = new THREE.CylinderGeometry(radius * 0.72, radius, height, radial, segments, true);
  geometry.translate(0, height * 0.5, 0);

  const position = geometry.getAttribute('position');
  const count = position.count;
  const aBend = new Float32Array(count);
  const aStiff = new Float32Array(count);
  const aHeightFrac = new Float32Array(count);

  for (let i = 0; i < count; i += 1) {
    const y = position.getY(i);
    const frac = Math.min(1, Math.max(0, y / height));
    aBend[i] = bend;
    aStiff[i] = stiffness;
    aHeightFrac[i] = frac;
  }

  geometry.setAttribute('aBend', new THREE.BufferAttribute(aBend, 1));
  geometry.setAttribute('aStiff', new THREE.BufferAttribute(aStiff, 1));
  geometry.setAttribute('aHeightFrac', new THREE.BufferAttribute(aHeightFrac, 1));

  // 竹节：每隔一段加一个略粗的环
  const nodeCount = Math.max(2, Math.round(height / 1.1));
  const nodes: THREE.BufferGeometry[] = [];
  for (let i = 1; i < nodeCount; i += 1) {
    const y = (i / nodeCount) * height;
    const node = new THREE.CylinderGeometry(radius * 0.8, radius * 0.8, 0.035, radial, 1, true);
    node.translate(0, y, 0);
    const nodePosition = node.getAttribute('position');
    const nodeCount2 = nodePosition.count;
    const nodeBend = new Float32Array(nodeCount2);
    const nodeStiff = new Float32Array(nodeCount2);
    const nodeFrac = new Float32Array(nodeCount2);
    for (let j = 0; j < nodeCount2; j += 1) {
      nodeBend[j] = bend;
      nodeStiff[j] = stiffness;
      nodeFrac[j] = y / height;
    }
    node.setAttribute('aBend', new THREE.BufferAttribute(nodeBend, 1));
    node.setAttribute('aStiff', new THREE.BufferAttribute(nodeStiff, 1));
    node.setAttribute('aHeightFrac', new THREE.BufferAttribute(nodeFrac, 1));
    nodes.push(node);
  }

  if (nodes.length === 0) return geometry;

  const merged = mergeBambooParts([geometry, ...nodes]);
  geometry.dispose();
  nodes.forEach((node) => node.dispose());
  return merged;
}

/**
 * 合并若干带同名属性的几何体。
 * 这里只需要 position / normal / uv + 三个自定义属性，手写合并比引入工具函数更轻。
 */
function mergeBambooParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let vertexCount = 0;
  for (const part of parts) vertexCount += part.getAttribute('position').count;

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const bends = new Float32Array(vertexCount);
  const stiffs = new Float32Array(vertexCount);
  const fracs = new Float32Array(vertexCount);

  let offset = 0;
  for (const part of parts) {
    const position = part.getAttribute('position');
    const normal = part.getAttribute('normal');
    const uv = part.getAttribute('uv');
    const bend = part.getAttribute('aBend');
    const stiff = part.getAttribute('aStiff');
    const frac = part.getAttribute('aHeightFrac');

    for (let i = 0; i < position.count; i += 1) {
      positions[(offset + i) * 3] = position.getX(i);
      positions[(offset + i) * 3 + 1] = position.getY(i);
      positions[(offset + i) * 3 + 2] = position.getZ(i);
      normals[(offset + i) * 3] = normal.getX(i);
      normals[(offset + i) * 3 + 1] = normal.getY(i);
      normals[(offset + i) * 3 + 2] = normal.getZ(i);
      uvs[(offset + i) * 2] = uv.getX(i);
      uvs[(offset + i) * 2 + 1] = uv.getY(i);
      bends[offset + i] = bend.getX(i);
      stiffs[offset + i] = stiff.getX(i);
      fracs[offset + i] = frac.getX(i);
    }

    offset += position.count;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  merged.setAttribute('aBend', new THREE.BufferAttribute(bends, 1));
  merged.setAttribute('aStiff', new THREE.BufferAttribute(stiffs, 1));
  merged.setAttribute('aHeightFrac', new THREE.BufferAttribute(fracs, 1));
  return merged;
}

/** 一丛叶子：几片下垂的细长叶片，深色剪影。 */
function createLeafGeometry(random: () => number, height: number, bend: number): THREE.BufferGeometry {
  const blades = 9;
  const parts: THREE.BufferGeometry[] = [];

  for (let i = 0; i < blades; i += 1) {
    const blade = new THREE.PlaneGeometry(0.62, 0.16, 1, 1);
    // 叶片朝下耷拉，只在水平面上散开
    blade.rotateX(-1.05 + random() * 0.5);
    blade.rotateZ(-0.55 + random() * 1.1);
    blade.rotateY(random() * Math.PI * 2);
    const y = height * (0.58 + random() * 0.38);
    const radius = 0.04 + random() * 0.2;
    const angle = random() * Math.PI * 2;
    blade.translate(Math.cos(angle) * radius, y, Math.sin(angle) * radius);

    const position = blade.getAttribute('position');
    const count = position.count;
    const aBend = new Float32Array(count);
    const aStiff = new Float32Array(count);
    const aHeightFrac = new Float32Array(count);
    for (let j = 0; j < count; j += 1) {
      aBend[j] = bend;
      aStiff[j] = 0.5;
      aHeightFrac[j] = Math.min(1, Math.max(0, position.getY(j) / height));
    }
    blade.setAttribute('aBend', new THREE.BufferAttribute(aBend, 1));
    blade.setAttribute('aStiff', new THREE.BufferAttribute(aStiff, 1));
    blade.setAttribute('aHeightFrac', new THREE.BufferAttribute(aHeightFrac, 1));
    parts.push(blade);
  }

  const merged = mergeBambooParts(parts);
  parts.forEach((part) => part.dispose());
  return merged;
}

function createBambooWind(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'bamboo-wind-scene';

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 160);
  camera.position.set(0, 1.45, 4.4);
  camera.lookAt(0, 2.5, 0);

  const random = createRandom(4451);

  // ── 竹林 ──────────────────────────────────────────────────────────────
  const bambooUniforms = {
    uTime: { value: 0 },
    uSway: { value: 0.1 },
    uTurbulence: { value: 0.05 },
    uLevel: { value: 0 },
    uColorLow: { value: new THREE.Color(0x1b2b24) },
    uColorHigh: { value: new THREE.Color(0x37564a) },
    uRimColor: { value: new THREE.Color(0x9fc0cc) },
    uMoonDir: { value: new THREE.Vector3(0.4, 0.7, 0.6).normalize() },
  };
  const bambooMaterial = new THREE.ShaderMaterial({
    uniforms: bambooUniforms,
    vertexShader: BAMBOO_VERT,
    fragmentShader: BAMBOO_FRAG,
  });

  const leafUniforms = {
    uTime: { value: 0 },
    uSway: { value: 0.1 },
    uTurbulence: { value: 0.05 },
    uLevel: { value: 0 },
    uLeafColor: { value: new THREE.Color(0x14241c) },
  };
  const leafMaterial = new THREE.ShaderMaterial({
    uniforms: leafUniforms,
    vertexShader: LEAF_VERT,
    fragmentShader: LEAF_FRAG,
    side: THREE.DoubleSide,
  });

  const bambooGroup = new THREE.Group();
  bambooGroup.name = 'bamboo';
  root.add(bambooGroup);

  const stalkCount = Math.floor(46 * ctx.quality);
  for (let i = 0; i < stalkCount; i += 1) {
    // 环绕用户的一圈竹林，近处稀、远处密
    const angle = (i / stalkCount) * Math.PI * 2 + random() * 0.6;
    const radius = 4.2 + random() * 6.4;
    const height = 5.2 + random() * 3.2;
    const thickness = 0.085 + random() * 0.055;
    const bend = random();
    const stiffness = random() * 0.7;

    const stalkGeometry = createBambooGeometry(height, thickness, bend, stiffness);
    const stalk = new THREE.Mesh(stalkGeometry, bambooMaterial);
    stalk.name = `bamboo-stalk-${i}`;
    stalk.position.set(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
    stalk.rotation.z = (random() - 0.5) * 0.07;
    stalk.rotation.x = (random() - 0.5) * 0.07;
    bambooGroup.add(stalk);

    const leafGeometry = createLeafGeometry(random, height, bend);
    const leaves = new THREE.Mesh(leafGeometry, leafMaterial);
    leaves.name = `bamboo-leaves-${i}`;
    leaves.position.copy(stalk.position);
    leaves.rotation.z = stalk.rotation.z;
    leaves.rotation.x = stalk.rotation.x;
    bambooGroup.add(leaves);
  }

  // ── 地面 ──────────────────────────────────────────────────────────────
  const ground = ctx.env.createGround(30) as THREE.Mesh;
  const groundMaterial = new THREE.MeshStandardMaterial({
    color: 0x080c0a,
    roughness: 1,
    metalness: 0,
  });
  configureStandard(groundMaterial, ctx.env.envMap, 0.05);
  ground.material = groundMaterial;
  ground.name = 'bamboo-ground';
  root.add(ground);

  // ── 地面薄雾 ──────────────────────────────────────────────────────────
  const mistUniforms = {
    uTime: { value: 0 },
    uDensity: { value: 0.4 },
    uLevel: { value: 0 },
    uMistColor: { value: new THREE.Color(0x4d5f63) },
  };
  const mistMaterial = new THREE.ShaderMaterial({
    uniforms: mistUniforms,
    vertexShader: MIST_VERT,
    fragmentShader: MIST_FRAG,
    transparent: true,
    depthWrite: false,
  });
  for (let i = 0; i < 4; i += 1) {
    const mist = new THREE.Mesh(new THREE.PlaneGeometry(26, 26, 6, 6), mistMaterial);
    mist.name = `ground-mist-${i}`;
    mist.rotation.x = -Math.PI / 2;
    mist.position.y = 0.1 + i * 0.26;
    mist.renderOrder = 2 + i;
    root.add(mist);
  }

  // ── 萤光 ──────────────────────────────────────────────────────────────
  const fireflyUniforms = {
    uTime: { value: 0 },
    uScale: { value: 600 },
    uOpacity: { value: 0.9 },
    uTreble: { value: 0 },
    uLevel: { value: 0 },
  };
  const fireflyGeometry = createPointGeometry({
    count: Math.floor(34 * ctx.quality),
    seed: 6613,
    radius: 5.5,
    size: 0.032,
  });
  // 萤光分布在地上方一点，避免全挤在地面
  {
    const position = fireflyGeometry.getAttribute('position');
    for (let i = 0; i < position.count; i += 1) {
      position.setY(i, position.getY(i) * 0.45 + 0.55);
    }
    position.needsUpdate = true;
  }
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

  // ── 灯光 ──────────────────────────────────────────────────────────────
  const lights = ctx.env.createStudioLights();
  dimLights(lights, 0.04, 0x334a52);
  root.add(lights);

  const moon = new THREE.DirectionalLight(0x9ab8c4, 0.16);
  moon.position.set(4, 7, 6);
  root.add(moon);

  // ── 空间音源：竹叶的沙沙声从林子深处传来 ────────────────────────
  const wind = attachSpatialSource(root, ctx.listener, {
      reverbNode: ctx.reverb,
    url: assetUrl('audio/sfx-wind.mp3'),
    position: [-1.8, 2.4, -2.6],
    volume: 0.4,
    refDistance: 3,
    maxDistance: 40,
  });

  const audio = new SleepAudioDrive(BREATHING);

  return {
    root,
    camera,
    immersive: true,
    xrDistance: 3,
    framing: { distance: 4.4, height: 1.45, targetY: 2.5, width: 9 },
    update(time: number, delta: number, context: SceneContext): void {
      wind.update(context.listener, root, delta);
      audio.update(time, delta, context);
      const state = audio.state;

      // ── 竹竿的摆动：脉冲直接驱动幅度 ────────────────────────────────
      const sway = 0.055 + state.pulse * 0.09 + state.drive * 0.03;
      const turbulence = 0.02 + state.mid * 0.06;
      bambooUniforms.uTime.value = time;
      bambooUniforms.uSway.value = sway;
      bambooUniforms.uTurbulence.value = turbulence;
      bambooUniforms.uLevel.value = state.level;

      leafUniforms.uTime.value = time;
      leafUniforms.uSway.value = sway * 1.1;
      leafUniforms.uTurbulence.value = turbulence * 1.2;
      leafUniforms.uLevel.value = state.level;

      // ── 薄雾：低频让雾更浓 ──────────────────────────────────────────
      mistUniforms.uTime.value = time;
      mistUniforms.uLevel.value = state.level;
      // 低频让雾更浓
      mistUniforms.uDensity.value = 0.55 + state.bass * 0.55 + state.drive * 0.12;

      // ── 萤光 ────────────────────────────────────────────────────────
      fireflyUniforms.uTime.value = time;
      fireflyUniforms.uTreble.value = state.treble;
      fireflyUniforms.uLevel.value = state.level;
      fireflyUniforms.uOpacity.value = 0.5 + state.level * 0.55;
      updatePointScale(fireflyUniforms.uScale, context, FOV);

      moon.intensity = 0.12 + state.level * 0.1;
    },
    dispose(): void {
      wind.dispose();
      disposeObject(root);
    },
  };
}

export const bambooWindScene: SceneDefinition = {
  id: 'bamboo-wind',
  title: '竹林夜风',
  subtitle: 'Bamboo Wind',
  description: '夜风穿过竹林，竹叶轻轻摇动，地上浮着薄雾与几点萤光。',
  tags: ['竹林', '夜风', '萤火'],
  accent: '#6f9a78',
  gradient: ['#122019', '#040705'],
  category: SLEEP_CATEGORY,
  audio: 'bamboo-wind.mp3',
  breathing: BREATHING,
  lighting: {
    autoExposure: true,
    autoExposureKey: 0.065,
  },
  create(ctx: SceneContext): SceneInstance {
    return createBambooWind(ctx);
  },
};

export default bambooWindScene;
