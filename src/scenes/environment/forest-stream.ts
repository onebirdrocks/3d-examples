import * as THREE from 'three';
import type { SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { disposeObject } from '../../core/loader.js';
import {
  AudioDriver,
  GLSL_HASH,
  GLSL_NOISE2,
  GLSL_OUTPUT,
  GLSL_OUTPUT_FUNCS,
  applyHaze,
  createGlowTexture,
  createSkyDome,
  fbm2D,
} from './lib.js';

/**
 * 林间溪流 / Forest Stream
 *
 * 清晨的森林：浅水在卵石间缓慢流过，水面由法线扰动 + 泡沫噪声组成；
 * 两岸是覆着苔藓的石头与垂落的蕨叶；晨雾在林间浮动，几束阳光透过树冠
 * 形成体积光柱。
 *
 * 音乐驱动：
 * - pulse → 水流的速度与水量；
 * - bass → 水面起伏的幅度；mid → 晨雾的流动；treble → 泡沫的细碎闪烁；
 * - level → 整体亮度与能见度（雾的浓度）。
 */

const BREATHING = { inhale: 5, hold: 3, exhale: 7 };
const FOV = 50;

const ROCK_COUNT = 8;

/* ------------------------------------------------------------------ *
 * 水面
 * ------------------------------------------------------------------ */

const WATER_VERT = /* glsl */ `
uniform float uTime;
uniform float uAmp;
uniform float uFlow;

varying vec3 vWorld;
varying float vWave;

${GLSL_HASH}
${GLSL_NOISE2}

float waveHeight(vec2 p, float t) {
  vec2 q = vec2(p.x * 1.15, p.y * 0.42 - t * 0.55);
  float h = fbm2(q, 3) - 0.5;
  h += 0.22 * sin(p.y * 2.1 + t * 1.35 + fbm2(q * 0.6, 2) * 4.0);
  h += 0.12 * sin(p.x * 3.7 - p.y * 0.8 + t * 2.1);
  return h;
}

void main() {
  vec3 p = position;
  float wave = waveHeight(p.xz, uTime) * uAmp;
  p.y += wave;

  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorld = wp.xyz;
  vWave = wave;

  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const WATER_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uAmp;
uniform vec3 uDeepColor;
uniform vec3 uShallowColor;
uniform vec3 uFoamColor;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform vec3 uRocks[${ROCK_COUNT}];
uniform float uSparkle;

varying vec3 vWorld;
varying float vWave;

${GLSL_HASH}
${GLSL_NOISE2}
${GLSL_OUTPUT_FUNCS}

float waveHeight(vec2 p, float t) {
  vec2 q = vec2(p.x * 1.15, p.y * 0.42 - t * 0.55);
  float h = fbm2(q, 3) - 0.5;
  h += 0.22 * sin(p.y * 2.1 + t * 1.35 + fbm2(q * 0.6, 2) * 4.0);
  h += 0.12 * sin(p.x * 3.7 - p.y * 0.8 + t * 2.1);
  return h;
}

void main() {
  vec2 p = vWorld.xz;

  // 细碎涟漪的法线（有限差分）
  float e = 0.12;
  float h = waveHeight(p, uTime);
  float hx = waveHeight(p + vec2(e, 0.0), uTime);
  float hz = waveHeight(p + vec2(0.0, e), uTime);
  vec3 N = normalize(vec3((h - hx) * uAmp / e, 1.0, (h - hz) * uAmp / e));

  // 中间深、两侧浅
  float center = smoothstep(1.7, 0.45, abs(vWorld.x));
  vec3 col = mix(uShallowColor, uDeepColor, center);

  // 河床的卵石透上来
  float bed = fbm2(p * 2.6, 3);
  col *= 0.72 + 0.55 * bed;

  // 泡沫：波峰 + 石块边缘
  float crest = smoothstep(0.16, 0.55, vWave / max(uAmp, 0.001));
  float fn = fbm2(p * 3.4 + vec2(0.0, uTime * 0.8), 3);
  float foam = crest * smoothstep(0.42, 0.78, fn);
  for (int i = 0; i < ${ROCK_COUNT}; i++) {
    float d = distance(vWorld.xz, uRocks[i].xy);
    float ring = 1.0 - smoothstep(0.25, 1.05, d);
    foam += ring * ring * smoothstep(0.34, 0.72, fn);
  }
  foam = clamp(foam, 0.0, 1.0);
  col = mix(col, uFoamColor, foam * 0.8);

  // 晨光的高光
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 H = normalize(uSunDir + V);
  float spec = pow(max(dot(N, H), 0.0), 110.0);
  col += uSunColor * spec * 1.1;

  // 高频的细碎水光
  float sparkle = pow(fbm2(p * 26.0 + vec2(uTime * 0.7, 0.0), 2), 7.0);
  col += uSunColor * sparkle * uSparkle * 1.4;

  gl_FragColor = vec4(col, 1.0);
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * 晨雾
 * ------------------------------------------------------------------ */

const MIST_VERT = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const MIST_FRAG = /* glsl */ `
precision highp float;

uniform sampler2D uMap;
uniform float uTime;
uniform float uOpacity;
uniform vec3 uColor;

varying vec2 vUv;

${GLSL_OUTPUT_FUNCS}

void main() {
  vec2 uv1 = vUv * 1.3 + vec2(uTime * 0.009, uTime * 0.004);
  vec2 uv2 = vUv * 2.4 - vec2(uTime * 0.014, uTime * 0.007);
  float a = texture2D(uMap, uv1).a * 0.72 + texture2D(uMap, uv2).a * 0.5;
  a = smoothstep(0.22, 0.82, a);
  a *= smoothstep(0.0, 0.3, vUv.y) * smoothstep(1.0, 0.62, vUv.y);
  a *= uOpacity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a);
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * 体积光柱
 * ------------------------------------------------------------------ */

const SHAFT_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorld;

void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SHAFT_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uColor;
uniform float uTime;
uniform float uIntensity;
uniform float uSeed;

varying vec2 vUv;
varying vec3 vWorld;

${GLSL_HASH}
${GLSL_NOISE2}
${GLSL_OUTPUT_FUNCS}

void main() {
  // 顶端亮、落地淡出
  float along = smoothstep(0.0, 0.42, vUv.y) * smoothstep(1.0, 0.55, vUv.y);
  float n = fbm2(vec2(vUv.x * 3.0 + uSeed, vUv.y * 1.4 - uTime * 0.05), 3);
  float a = along * (0.35 + 0.9 * n) * uIntensity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor * a, a);
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * 贴图
 * ------------------------------------------------------------------ */

/** 苔藓覆盖的林地表面。 */
function createForestFloorTexture(size = 256): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');

  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = (x / size) * 6;
      const v = (y / size) * 6;
      const moss = fbm2D(u * 1.6, v * 1.6, 4);
      const dirt = fbm2D(u * 4.5 + 11.3, v * 4.5 + 7.7, 3);
      const speck = Math.pow(fbm2D(u * 16 + 3.1, v * 16 + 9.4, 2), 6);
      const i = (y * size + x) * 4;
      const mossAmount = THREE.MathUtils.smoothstep(moss, 0.42, 0.78);
      const r = THREE.MathUtils.lerp(64 + dirt * 30, 86 + moss * 18, mossAmount);
      const g = THREE.MathUtils.lerp(58 + dirt * 26, 94 + moss * 18, mossAmount);
      const b = THREE.MathUtils.lerp(48 + dirt * 20, 76 + moss * 12, mossAmount);
      image.data[i] = Math.round(r + speck * 70);
      image.data[i + 1] = Math.round(g + speck * 80);
      image.data[i + 2] = Math.round(b + speck * 60);
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'forest-floor';
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

/** 一片蕨叶（带 alpha）。 */
function createFernTexture(size = 128): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');
  ctx.clearRect(0, 0, size, size);

  const midX = size * 0.5;
  ctx.strokeStyle = '#5c6b45';
  ctx.lineWidth = Math.max(1.5, size / 42);
  ctx.beginPath();
  ctx.moveTo(midX, size);
  ctx.quadraticCurveTo(midX + size * 0.06, size * 0.5, midX, size * 0.04);
  ctx.stroke();

  for (let i = 0; i < 16; i += 1) {
    const t = i / 15;
    const y = size * (0.96 - t * 0.9);
    const len = size * 0.34 * Math.sin(Math.PI * (0.15 + t * 0.8));
    const droop = size * 0.06 * t;
    for (const dir of [-1, 1]) {
      ctx.fillStyle = `rgba(${64 + t * 30}, ${88 + t * 34}, ${56 + t * 22}, ${0.85 - t * 0.25})`;
      ctx.beginPath();
      ctx.moveTo(midX, y);
      ctx.quadraticCurveTo(midX + dir * len * 0.55, y - droop * 0.6, midX + dir * len, y + droop);
      ctx.quadraticCurveTo(midX + dir * len * 0.5, y + droop * 1.1, midX, y + size * 0.02);
      ctx.closePath();
      ctx.fill();
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'fern';
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** 柔和的雾团（白色 RGB + 云絮状 alpha）。 */
function createMistTexture(size = 256): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');
  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const n = fbm2D((x / size) * 4, (y / size) * 4, 4);
      const fine = fbm2D((x / size) * 13 + 5.1, (y / size) * 13 + 2.7, 3);
      const alpha = THREE.MathUtils.clamp(n * 1.5 + fine * 0.35 - 0.42, 0, 1);
      const i = (y * size + x) * 4;
      image.data[i] = 255;
      image.data[i + 1] = 255;
      image.data[i + 2] = 255;
      image.data[i + 3] = Math.round(alpha * 255);
    }
  }
  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'mist';
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

/* ------------------------------------------------------------------ *
 * 地形与石头
 * ------------------------------------------------------------------ */

/** 溪谷两岸的地形：中间是水沟，越往两边越高。 */
function createBankGeometry(width: number, length: number, segX: number, segZ: number): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(width, length, segX, segZ);
  geometry.rotateX(-Math.PI / 2);
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;

  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const z = position.getZ(i);
    const ax = Math.abs(x);
    const valley = THREE.MathUtils.smoothstep(ax, 1.5, 7.0) * 1.05;
    const ripple = (fbm2D(x * 0.32, z * 0.32, 3) - 0.5) * 0.34;
    const dune = (fbm2D(x * 0.07 + 11, z * 0.07 + 5, 3) - 0.5) * 1.1;
    position.setY(i, valley + ripple + dune - 0.32);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

/** 覆着苔藓的卵石。 */
function createMossRock(
  radius: number,
  seed: number,
  mossy: number,
  envMap: THREE.Texture,
): THREE.Mesh {
  const geometry = new THREE.IcosahedronGeometry(radius, 2);
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const offset = seed * 3.7;

  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const n = fbm2D(x * 1.4 + offset, z * 1.4 + offset * 0.5, 4);
    const k = 0.74 + n * 0.52;
    position.setXYZ(i, x * k, y * k * 0.72, z * k);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x7b7d73).lerp(new THREE.Color(0x626a58), mossy),
    roughness: 0.92,
    metalness: 0.02,
    flatShading: true,
  });
  material.envMap = envMap;
  material.envMapIntensity = 0.07;
  applyHaze(material, { color: 0x9fb6ae, near: 7, far: 44 });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}

/* ------------------------------------------------------------------ *
 * 场景
 * ------------------------------------------------------------------ */

function createForestStream(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'forest-stream-scene';

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 320);
  camera.position.set(0, 1.5, 4.8);

  const quality = THREE.MathUtils.clamp(ctx.quality, 0.4, 2);
  const driver = new AudioDriver();

  let state = 77123;
  const random = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };

  // ── 天光 ─────────────────────────────────────────────────────────────
  const sky = createSkyDome({
    zenith: 0x63839c,
    horizon: 0x9db3bb,
    ground: 0x3c4736,
    radius: 180,
    bandColor: 0xc3d0cc,
    bandStrength: 0.22,
    bandY: 0.06,
    bandWidth: 0.14,
  });
  root.add(sky.mesh);

  // ── 地面 ─────────────────────────────────────────────────────────────
  const baseGround = ctx.env.createGround(120);
  baseGround.position.y = -1.6;
  const baseGroundMaterial = (baseGround as THREE.Mesh).material as THREE.MeshStandardMaterial;
  baseGroundMaterial.envMap = ctx.env.envMap;
  baseGroundMaterial.envMapIntensity = 0.05;
  root.add(baseGround);

  const floorTexture = createForestFloorTexture(256);
  const bankMaterial = new THREE.MeshStandardMaterial({
    color: 0x9c9c92,
    roughness: 0.95,
    metalness: 0.0,
    map: floorTexture,
  });
  bankMaterial.envMap = ctx.env.envMap;
  bankMaterial.envMapIntensity = 0.08;
  applyHaze(bankMaterial, { color: 0x9fb6ae, near: 6, far: 40 });

  const bankGeometry = createBankGeometry(22, 70, Math.round(70 * quality), Math.round(150 * quality));
  const banks = new THREE.Mesh(bankGeometry, bankMaterial);
  banks.name = 'banks';
  banks.position.set(0, 0, -18);
  root.add(banks);

  // ── 水面 ─────────────────────────────────────────────────────────────
  const sunDirection = new THREE.Vector3(-0.45, 0.72, 0.52).normalize();
  const waterUniforms = {
    uTime: { value: 0 },
    uAmp: { value: 0.09 },
    uFlow: { value: 0.5 },
    uDeepColor: { value: new THREE.Color(0x1b3634) },
    uShallowColor: { value: new THREE.Color(0x6b6a55) },
    uFoamColor: { value: new THREE.Color(0xeef5ec) },
    uSunColor: { value: new THREE.Color(0xfff2d0) },
    uSunDir: { value: sunDirection },
    uRocks: { value: Array.from({ length: ROCK_COUNT }, () => new THREE.Vector3()) },
    uSparkle: { value: 0.2 },
  };

  const waterMaterial = new THREE.ShaderMaterial({
    uniforms: waterUniforms,
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    side: THREE.FrontSide,
  });
  const waterGeometry = new THREE.PlaneGeometry(3.4, 68, Math.round(14 * quality), Math.round(150 * quality));
  waterGeometry.rotateX(-Math.PI / 2);
  const water = new THREE.Mesh(waterGeometry, waterMaterial);
  water.name = 'stream';
  water.position.set(0, 0.02, -18);
  root.add(water);

  // ── 石头 ─────────────────────────────────────────────────────────────
  for (let i = 0; i < ROCK_COUNT; i += 1) {
    const x = (random() * 2 - 1) * 1.5;
    const z = 4 - i * 6.4 - random() * 3.2;
    const radius = 0.45 + random() * 0.7;
    const rock = createMossRock(radius, 13 + i * 7, 0.2 + random() * 0.35, ctx.env.envMap);
    rock.position.set(x, radius * 0.28, z);
    rock.rotation.set(random() * 0.6, random() * Math.PI, random() * 0.5);
    root.add(rock);
    waterUniforms.uRocks.value[i].set(x, z, radius);
  }

  // 岸上更大的石头
  for (let i = 0; i < 16; i += 1) {
    const side = random() > 0.5 ? 1 : -1;
    const x = side * (2.2 + random() * 4.4);
    const z = 6 - random() * 52;
    const radius = 0.4 + random() * 1.25;
    const rock = createMossRock(radius, 101 + i * 13, 0.25 + random() * 0.4, ctx.env.envMap);
    rock.position.set(x, radius * 0.2 - 0.15, z);
    rock.rotation.set(random() * 0.8, random() * Math.PI, random() * 0.6);
    root.add(rock);
  }

  // ── 蕨叶 ─────────────────────────────────────────────────────────────
  const fernTexture = createFernTexture(128);
  const fernMaterial = new THREE.MeshStandardMaterial({
    map: fernTexture,
    transparent: true,
    alphaTest: 0.35,
    side: THREE.DoubleSide,
    roughness: 0.85,
    metalness: 0,
  });
  fernMaterial.envMap = ctx.env.envMap;
  fernMaterial.envMapIntensity = 0.1;

  const fernGeometry = new THREE.PlaneGeometry(1.5, 2.4);
  for (let i = 0; i < 22; i += 1) {
    const side = random() > 0.5 ? 1 : -1;
    const fern = new THREE.Mesh(fernGeometry, fernMaterial);
    fern.name = 'fern';
    fern.position.set(side * (2.1 + random() * 4.4), 1.15 + random() * 1.5, 2 - random() * 48);
    // 顶端垂下
    fern.rotation.set(-2.1 - random() * 0.5, random() * Math.PI * 2, random() * 0.4);
    fern.scale.setScalar(0.75 + random() * 0.8);
    root.add(fern);
  }

  // ── 树 ───────────────────────────────────────────────────────────────
  const barkMaterial = new THREE.MeshStandardMaterial({
    color: 0x554a3f,
    roughness: 0.96,
    metalness: 0,
  });
  barkMaterial.envMap = ctx.env.envMap;
  barkMaterial.envMapIntensity = 0.06;

  const canopyMaterial = new THREE.MeshStandardMaterial({
    color: 0x33422f,
    roughness: 0.95,
    metalness: 0,
    flatShading: true,
  });
  canopyMaterial.envMap = ctx.env.envMap;
  canopyMaterial.envMapIntensity = 0.07;
  applyHaze(canopyMaterial, { color: 0x9fb6ae, near: 6, far: 34 });

  const trunkGeometry = new THREE.CylinderGeometry(0.18, 0.34, 12, 8, 1, true);
  for (let i = 0; i < 22; i += 1) {
    const side = random() > 0.5 ? 1 : -1;
    const near = i < 4;
    const x = side * (near ? 3.2 + random() * 2.4 : 5.5 + random() * 12);
    const z = near ? 5 - random() * 9 : 2 - random() * 58;
    const trunk = new THREE.Mesh(trunkGeometry, barkMaterial);
    trunk.name = 'trunk';
    trunk.position.set(x, 5.6, z);
    trunk.rotation.set(random() * 0.12 - 0.06, random() * Math.PI, random() * 0.12 - 0.06);
    trunk.scale.set(0.8 + random() * 0.8, 0.8 + random() * 0.7, 0.8 + random() * 0.8);
    root.add(trunk);
  }

  for (let i = 0; i < 18; i += 1) {
    const side = random() > 0.5 ? 1 : -1;
    const x = side * (4 + random() * 13);
    const z = 2 - random() * 58;
    const blob = new THREE.Mesh(new THREE.IcosahedronGeometry(2.2 + random() * 2.6, 1), canopyMaterial);
    blob.name = 'canopy';
    blob.position.set(x, 9 + random() * 3.4, z);
    blob.scale.set(1, 0.62 + random() * 0.3, 1);
    root.add(blob);
  }

  // ── 晨雾 ─────────────────────────────────────────────────────────────
  const mistTexture = createMistTexture(256);
  const mistMaterials: THREE.ShaderMaterial[] = [];
  const mistGroup = new THREE.Group();
  mistGroup.name = 'mist';
  for (let i = 0; i < 8; i += 1) {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: mistTexture },
        uTime: { value: 0 },
        uOpacity: { value: 0.22 },
        uColor: { value: new THREE.Color(0xdfeae4) },
      },
      vertexShader: MIST_VERT,
      fragmentShader: MIST_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    mistMaterials.push(material);

    const plane = new THREE.Mesh(new THREE.PlaneGeometry(14, 4.4), material);
    plane.name = 'mist-sheet';
    plane.position.set((random() * 2 - 1) * 3.4, 0.9 + random() * 1.6, 2 - i * 7.5 - random() * 4);
    plane.rotation.y = random() * 0.6 - 0.3;
    mistGroup.add(plane);
  }
  root.add(mistGroup);

  // ── 体积光柱 ─────────────────────────────────────────────────────────
  const shaftMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0xfff3cf) },
      uTime: { value: 0 },
      uIntensity: { value: 0.16 },
      uSeed: { value: 3.7 },
    },
    vertexShader: SHAFT_VERT,
    fragmentShader: SHAFT_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  for (let i = 0; i < 5; i += 1) {
    const height = 11;
    const shaft = new THREE.Mesh(new THREE.ConeGeometry(1.5 + random() * 0.9, height, 12, 1, true), shaftMaterial);
    shaft.name = 'light-shaft';
    shaft.position.set((random() * 2 - 1) * 5.5, height / 2 - 0.4, 2 - i * 9 - random() * 5);
    shaft.rotation.set(0.16 + random() * 0.12, random() * Math.PI, 0.1 + random() * 0.1);
    root.add(shaft);
  }

  // 树冠缝隙里的太阳
  const glowTexture = createGlowTexture(128, 2.0);
  const sunGlow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture,
      color: 0xfff0c8,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  sunGlow.name = 'sun-glow';
  sunGlow.scale.setScalar(9);
  sunGlow.position.set(-7.5, 12, -16);
  root.add(sunGlow);

  // ── 灯光 ─────────────────────────────────────────────────────────────
  const lights = ctx.env.createStudioLights();
  lights.traverse((child) => {
    if (child instanceof THREE.Light) {
      child.intensity *= 0.25;
      child.castShadow = false;
      child.color.setHex(0xbcd6e8);
    }
  });
  root.add(lights);

  const sun = new THREE.DirectionalLight(0xfff0cf, 0.85);
  sun.position.copy(sunDirection).multiplyScalar(40);
  root.add(sun);
  root.add(sun.target);

  const ambient = new THREE.HemisphereLight(0xc2d8e0, 0x4a4a3a, 0.45);
  root.add(ambient);

  return {
    root,
    camera,
    immersive: true,
    xrDistance: 3,
    framing: { distance: 4.8, height: 1.5, targetY: 0.6, width: 9 },
    update(time: number, delta: number, context: SceneContext): void {
      driver.update(context, delta);

      const pulse = driver.pulse;
      const level = driver.level;

      sky.uniforms.uTime.value = time;
      sky.uniforms.uLevel.value = level;

      // 水：脉冲决定流速，低频决定起伏幅度
      waterUniforms.uTime.value = time;
      waterUniforms.uFlow.value = 0.36 + pulse * 1.0;
      waterUniforms.uAmp.value = 0.05 + driver.bass * 0.16 + pulse * 0.07;
      waterUniforms.uSparkle.value = 0.12 + driver.treble * 0.9;

      // 雾：中频推动流动，响度决定浓度
      for (const material of mistMaterials) {
        material.uniforms.uTime.value = time * (1 + driver.mid * 0.7);
        material.uniforms.uOpacity.value = 0.12 + level * 0.16 + pulse * 0.05;
      }
      mistGroup.position.x = Math.sin(time * 0.05) * 0.8 + driver.mid * 0.5;

      // 光柱：随呼吸与响度明灭
      shaftMaterial.uniforms.uTime.value = time;
      shaftMaterial.uniforms.uIntensity.value = 0.1 + level * 0.12 + pulse * 0.08;

      sun.intensity = 0.7 + level * 0.45;
      ambient.intensity = 0.38 + level * 0.22;
      sunGlow.material.opacity = 0.28 + level * 0.3;

      // 能见度：雾越浓，远景越淡
      bankMaterial.envMapIntensity = 0.06 + level * 0.05;
    },
    dispose(): void {
      floorTexture.dispose();
      fernTexture.dispose();
      mistTexture.dispose();
      glowTexture.dispose();
      disposeObject(root);
    },
  };
}

export const forestStreamScene: SceneDefinition = {
  id: 'forest-stream',
  title: '林间溪流',
  subtitle: 'Forest Stream',
  description: '浅水在卵石间缓慢流过，晨雾在林间浮动，阳光穿过树冠落下。',
  tags: ['森林', '溪流', '晨雾'],
  accent: '#8fd6a8',
  gradient: ['#2c4a3a', '#0d1613'],
  category: 'environment',
  audio: 'forest-stream.mp3',
  breathing: BREATHING,
  create(ctx: SceneContext): SceneInstance {
    return createForestStream(ctx);
  },
};

export default forestStreamScene;
