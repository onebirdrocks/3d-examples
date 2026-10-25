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
 * 海崖听涛 / Sea Cliff
 *
 * 站在海崖边：下方是大尺度涌浪叠加高频细浪，白色的浪花在礁石上碎开，
 * 远处的地平线在雾里发白，天空是黄昏前的冷调。风很大，画面很静。
 *
 * 音乐驱动：
 * - pulse → 涌浪的高低与推进速度（画面最主要的运动）；
 * - bass → 波面的整体幅度；mid → 泡沫的缓慢漂移；treble → 浪花的细碎闪烁；
 * - level → 地平线的雾光与整体亮度。
 */

const BREATHING = { inhale: 6, hold: 2, exhale: 8 };
const FOV = 55;

const SEA_LEVEL = -9;
const ROCK_COUNT = 6;
/** 远处地平线的雾色（空气透视的终点）。 */
const HAZE = 0xb9c7d2;

/* ------------------------------------------------------------------ *
 * 海面
 * ------------------------------------------------------------------ */

const SEA_VERT = /* glsl */ `
uniform float uTime;
uniform float uAmp;
uniform float uSwell;
uniform float uFadeNear;
uniform float uFadeFar;

varying vec3 vWorld;
varying float vCrest;
varying float vSwell;

${GLSL_HASH}
${GLSL_NOISE2}

void main() {
  vec3 p = position;

  // 大尺度涌浪：两列方向不同的长波
  vec2 d1 = normalize(vec2(0.88, 0.47));
  vec2 d2 = normalize(vec2(-0.42, 0.91));
  float swell = sin(dot(p.xz, d1) * 0.052 + uTime * 0.58) * 1.0;
  swell += sin(dot(p.xz, d2) * 0.029 - uTime * 0.41) * 0.72;
  swell += sin(dot(p.xz, d1) * 0.014 + uTime * 0.19) * 0.5;

  // 高频细浪
  float chop = fbm2(vec2(p.x * 0.11, p.z * 0.15 - uTime * 0.42), 3) - 0.5;
  chop += 0.28 * sin(p.x * 0.62 + uTime * 1.35);

  float wave = (swell * uSwell + chop * 0.34) * uAmp;
  vSwell = swell;

  // 远处逐渐平静，避免远处的高频闪烁
  float fade = 1.0 - smoothstep(uFadeNear, uFadeFar, distance(p.xz, cameraPosition.xz));
  wave *= fade;

  p.y += wave;

  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorld = wp.xyz;
  vCrest = wave / max(uAmp * uSwell, 0.001);

  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SEA_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform vec3 uDeepColor;
uniform vec3 uShallowColor;
uniform vec3 uFoamColor;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uHazeColor;
uniform float uHazeNear;
uniform float uHazeFar;
uniform vec3 uRocks[${ROCK_COUNT}];
uniform float uSparkle;

varying vec3 vWorld;
varying float vCrest;
varying float vSwell;

${GLSL_HASH}
${GLSL_NOISE2}
${GLSL_OUTPUT_FUNCS}

void main() {
  vec2 p = vWorld.xz;
  vec3 V = normalize(cameraPosition - vWorld);

  // 细浪的法线扰动
  vec2 q = p * 0.9 + vec2(uTime * 0.03, uTime * 0.017);
  float e = 0.6;
  float n0 = fbm2(q, 2);
  float nx = fbm2(q + vec2(e, 0.0), 2);
  float nz = fbm2(q + vec2(0.0, e), 2);
  float camDist = distance(vWorld, cameraPosition);
  float detailFade = 1.0 - smoothstep(26.0, 110.0, camDist);
  vec3 N = normalize(vec3((n0 - nx) * 1.5 * detailFade, 1.0, (n0 - nz) * 1.5 * detailFade));

  float fres = 0.04 + 0.96 * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.5);

  vec3 sky = mix(uSkyHorizon, uSkyZenith, 0.35);
  vec3 col = mix(uDeepColor, uShallowColor, smoothstep(0.1, 0.9, vCrest * 0.5 + 0.5));
  col = mix(col, sky, clamp(fres, 0.0, 1.0) * 0.75);

  // 浪峰的泡沫
  float fn = fbm2(p * 0.85 + vec2(uTime * 0.07, -uTime * 0.05), 3);
  float foam = smoothstep(0.72, 1.75, vSwell) * smoothstep(0.48, 0.86, fn);

  // 礁石边缘的碎浪
  for (int i = 0; i < ${ROCK_COUNT}; i++) {
    float d = distance(vWorld.xz, uRocks[i].xy);
    float ring = 1.0 - smoothstep(1.4, 4.6, d);
    foam += ring * ring * smoothstep(0.3, 0.68, fn);
  }
  foam = clamp(foam, 0.0, 1.0);
  col = mix(col, uFoamColor, foam * 0.8);

  // 高频的碎浪微光
  float sparkle = pow(fbm2(p * 5.5 + vec2(uTime * 0.4, 0.0), 2), 6.0);
  col += vec3(0.9, 0.95, 1.0) * sparkle * uSparkle * foam * 0.8;

  // 空气透视：远处融进发白的地平线
  float haze = smoothstep(uHazeNear, uHazeFar, camDist);
  col = mix(col, uHazeColor, haze);

  gl_FragColor = vec4(col, 1.0);
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * 浪花片
 * ------------------------------------------------------------------ */

const FOAM_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorld;

void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FOAM_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uIntensity;
uniform vec3 uColor;

varying vec2 vUv;
varying vec3 vWorld;

${GLSL_HASH}
${GLSL_NOISE2}
${GLSL_OUTPUT_FUNCS}

void main() {
  float n = fbm2(vUv * 3.4 + vec2(uTime * 0.06, -uTime * 0.04), 3);
  float edge = smoothstep(0.0, 0.32, vUv.y) * smoothstep(1.0, 0.55, vUv.y);
  float a = edge * smoothstep(0.42, 0.8, n) * uIntensity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor * a, a);
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * 地形
 * ------------------------------------------------------------------ */

/** 崖顶：中间是平地，前缘（-z 方向）突然塌成崖壁。 */
function createCliffGeometry(width: number, length: number, segX: number, segZ: number): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(width, length, segX, segZ);
  geometry.rotateX(-Math.PI / 2);
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;

  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const z = position.getZ(i);
    const noise = (fbm2D(x * 0.16 + 3.1, z * 0.16 + 7.7, 4) - 0.5) * 1.15;
    const coarse = (fbm2D(x * 0.05, z * 0.05, 3) - 0.5) * 2.2;
    // 前缘塌下去（局部 z = -7.5 处起坡，也就是世界坐标 z = -1.5 的崖边）
    const drop = THREE.MathUtils.smoothstep(-z, 7.5, 13.5);
    const height = noise + coarse - drop * 17.0;
    position.setY(i, height);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

/** 被海水磨圆的礁石。 */
function createSeaRock(radius: number, seed: number, envMap: THREE.Texture): THREE.Mesh {
  const geometry = new THREE.IcosahedronGeometry(radius, 2);
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const offset = seed * 2.3;

  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const n = fbm2D(x * 0.9 + offset, z * 0.9 + offset, 4);
    const k = 0.78 + n * 0.46;
    position.setXYZ(i, x * k, y * k * 1.15, z * k);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    color: 0x3f464e,
    roughness: 0.86,
    metalness: 0.04,
    flatShading: true,
  });
  material.envMap = envMap;
  material.envMapIntensity = 0.06;
  applyHaze(material, { color: HAZE, near: 24, far: 150 });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = false;
  return mesh;
}

/* ------------------------------------------------------------------ *
 * 场景
 * ------------------------------------------------------------------ */

function createSeaCliff(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'sea-cliff-scene';

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 4000);
  camera.position.set(0, 3.4, 7);

  const quality = THREE.MathUtils.clamp(ctx.quality, 0.4, 2);
  const driver = new AudioDriver();

  let state = 33113;
  const random = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };

  // ── 天空 ─────────────────────────────────────────────────────────────
  const sky = createSkyDome({
    zenith: 0x2e4a68,
    horizon: 0xa3b7c6,
    ground: 0x2a3038,
    radius: 1800,
    bandColor: 0xdde5ea,
    bandStrength: 0.85,
    bandY: 0.0,
    bandWidth: 0.035,
  });
  root.add(sky.mesh);

  // ── 崖顶 ─────────────────────────────────────────────────────────────
  // 这里不放「地面」：脚下是悬崖，下方就是海，任何平面都会把海挡住。
  const cliffMaterial = new THREE.MeshStandardMaterial({
    color: 0x4b5158,
    roughness: 0.95,
    metalness: 0.02,
    flatShading: true,
  });
  cliffMaterial.envMap = ctx.env.envMap;
  cliffMaterial.envMapIntensity = 0.07;
  applyHaze(cliffMaterial, { color: HAZE, near: 20, far: 130 });

  const cliff = new THREE.Mesh(
    createCliffGeometry(70, 46, Math.round(80 * quality), Math.round(60 * quality)),
    cliffMaterial,
  );
  cliff.name = 'cliff';
  cliff.position.set(0, 0, 6);
  root.add(cliff);

  // 崖边近景的碎石
  for (let i = 0; i < 14; i += 1) {
    const rock = createSeaRock(0.3 + random() * 0.9, 7 + i * 5, ctx.env.envMap);
    rock.position.set((random() * 2 - 1) * 12, -0.25 + random() * 0.4, 1.6 - random() * 3.1);
    root.add(rock);
  }

  // ── 海面 ─────────────────────────────────────────────────────────────
  const seaUniforms = {
    uTime: { value: 0 },
    uAmp: { value: 0.55 },
    uSwell: { value: 1 },
    uFadeNear: { value: 55 },
    uFadeFar: { value: 95 },
    uDeepColor: { value: new THREE.Color(0x2b4055) },
    uShallowColor: { value: new THREE.Color(0x4c6a80) },
    uFoamColor: { value: new THREE.Color(0xdde7ec) },
    uSkyZenith: { value: new THREE.Color(0x2e4a68) },
    uSkyHorizon: { value: new THREE.Color(0xa3b7c6) },
    uHazeColor: { value: new THREE.Color(HAZE) },
    uHazeNear: { value: 38 },
    uHazeFar: { value: 420 },
    uRocks: { value: Array.from({ length: ROCK_COUNT }, () => new THREE.Vector3()) },
    uSparkle: { value: 0.2 },
  };

  const seaMaterial = new THREE.ShaderMaterial({
    uniforms: seaUniforms,
    vertexShader: SEA_VERT,
    fragmentShader: SEA_FRAG,
  });

  const nearSegments = Math.round(180 * quality);
  const nearGeometry = new THREE.PlaneGeometry(180, 190, nearSegments, nearSegments);
  nearGeometry.rotateX(-Math.PI / 2);
  const nearSea = new THREE.Mesh(nearGeometry, seaMaterial);
  nearSea.name = 'sea-near';
  nearSea.position.set(0, SEA_LEVEL, -70);
  root.add(nearSea);

  const farGeometry = new THREE.PlaneGeometry(2600, 2600, 48, 48);
  farGeometry.rotateX(-Math.PI / 2);
  const farSea = new THREE.Mesh(farGeometry, seaMaterial);
  farSea.name = 'sea-far';
  farSea.position.set(0, SEA_LEVEL - 0.02, -400);
  root.add(farSea);

  // ── 礁石 ─────────────────────────────────────────────────────────────
  const rockSpecs: { x: number; z: number; r: number }[] = [
    { x: -6.5, z: -23.0, r: 1.7 },
    { x: 6.8, z: -29.0, r: 1.2 },
    { x: -15.0, z: -38.0, r: 2.6 },
    { x: 13.5, z: -49.0, r: 3.2 },
    { x: -5.0, z: -62.0, r: 2.0 },
    { x: 19.5, z: -78.0, r: 3.8 },
  ];
  for (let i = 0; i < ROCK_COUNT; i += 1) {
    const spec = rockSpecs[i];
    const rock = createSeaRock(spec.r, 31 + i * 9, ctx.env.envMap);
    rock.position.set(spec.x, SEA_LEVEL + spec.r * 0.22, spec.z);
    rock.scale.set(1 + (i % 3) * 0.18, 0.72 + (i % 2) * 0.3, 1 + ((i + 1) % 3) * 0.16);
    root.add(rock);
    seaUniforms.uRocks.value[i].set(spec.x, spec.z, spec.r);
  }

  // ── 碎浪片 ───────────────────────────────────────────────────────────
  const foamMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uIntensity: { value: 0.35 },
      uColor: { value: new THREE.Color(0xe6eef2) },
    },
    vertexShader: FOAM_VERT,
    fragmentShader: FOAM_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  for (const spec of rockSpecs) {
    const foam = new THREE.Mesh(new THREE.PlaneGeometry(spec.r * 7, spec.r * 5), foamMaterial);
    foam.name = 'foam';
    foam.rotation.x = -Math.PI / 2;
    foam.position.set(spec.x, SEA_LEVEL + 0.22, spec.z);
    root.add(foam);
  }
  // 崖脚的一排碎浪
  const shoreFoam = new THREE.Mesh(new THREE.PlaneGeometry(46, 8), foamMaterial);
  shoreFoam.name = 'shore-foam';
  shoreFoam.rotation.x = -Math.PI / 2;
  shoreFoam.position.set(-1, SEA_LEVEL + 0.24, -9);
  root.add(shoreFoam);

  // ── 远处的岬角 ───────────────────────────────────────────────────────
  const headlandMaterial = new THREE.MeshStandardMaterial({
    color: 0x4d5966,
    roughness: 1,
    metalness: 0,
  });
  headlandMaterial.envMap = ctx.env.envMap;
  headlandMaterial.envMapIntensity = 0.05;
  applyHaze(headlandMaterial, { color: HAZE, near: 120, far: 480 });

  const headland = new THREE.Mesh(new THREE.ConeGeometry(60, 34, 7, 1), headlandMaterial);
  headland.name = 'headland';
  headland.position.set(-160, -6, -340);
  headland.scale.set(2.2, 0.42, 0.7);
  root.add(headland);

  const farIslet = new THREE.Mesh(new THREE.ConeGeometry(26, 16, 6, 1), headlandMaterial);
  farIslet.name = 'far-islet';
  farIslet.position.set(104, -4, -258);
  farIslet.scale.set(1.8, 0.38, 0.6);
  root.add(farIslet);

  // 地平线上的一点余光
  const glowTexture = createGlowTexture(128, 1.8);
  const afterglow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture,
      color: 0xd9c9ad,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  afterglow.name = 'afterglow';
  afterglow.scale.set(300, 40, 1);
  afterglow.position.set(64, 6, -620);
  root.add(afterglow);

  // ── 灯光 ─────────────────────────────────────────────────────────────
  const lights = ctx.env.createStudioLights();
  lights.traverse((child) => {
    if (child instanceof THREE.Light) {
      child.intensity *= 0.35;
      child.castShadow = false;
      child.color.setHex(0x9db6cc);
    }
  });
  root.add(lights);

  const skyLight = new THREE.HemisphereLight(0xa9c0d6, 0x2b3844, 1.7);
  root.add(skyLight);

  return {
    root,
    camera,
    immersive: true,
    xrDistance: 3,
    framing: { distance: 7, height: 3.4, targetY: 1.4, width: 12 },
    update(time: number, delta: number, context: SceneContext): void {
      driver.update(context, delta);

      const pulse = driver.pulse;
      const level = driver.level;

      sky.uniforms.uTime.value = time;
      sky.uniforms.uLevel.value = level;

      // 涌浪：脉冲决定浪的高低与推进，低频决定整体幅度
      seaUniforms.uTime.value = time;
      seaUniforms.uSwell.value = 0.85 + pulse * 0.6;
      seaUniforms.uAmp.value = 0.42 + driver.bass * 0.5;
      seaUniforms.uSparkle.value = 0.1 + driver.treble * 0.8;

      // 泡沫：中频推动漂移，脉冲决定碎浪的多少
      foamMaterial.uniforms.uTime.value = time * (1 + driver.mid * 0.6);
      foamMaterial.uniforms.uIntensity.value = 0.22 + pulse * 0.34 + driver.mid * 0.12;

      // 地平线的雾光随响度变亮（能见度）
      sky.uniforms.uBandStrength.value = 0.7 + level * 0.35;
      afterglow.material.opacity = 0.1 + level * 0.16;

      skyLight.intensity = 1.45 + level * 0.6;
    },
    dispose(): void {
      glowTexture.dispose();
      disposeObject(root);
    },
  };
}

export const seaCliffScene: SceneDefinition = {
  id: 'sea-cliff',
  title: '海崖听涛',
  subtitle: 'Sea Cliff',
  description: '涌浪一层层推上礁石，远处的地平线在雾里发白。',
  tags: ['海崖', '海浪', '黄昏'],
  accent: '#8fb6cf',
  gradient: ['#2d4356', '#0d141b'],
  category: 'environment',
  audio: 'night-tides.mp3',
  breathing: BREATHING,
  create(ctx: SceneContext): SceneInstance {
    return createSeaCliff(ctx);
  },
};

export default seaCliffScene;
