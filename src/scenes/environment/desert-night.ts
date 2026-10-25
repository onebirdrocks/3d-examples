import * as THREE from 'three';
import type { SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { disposeObject } from '../../core/loader.js';
import { ParticleSpace } from '../../core/particle-space.js';
import {
  AudioDriver,
  GLSL_HASH,
  GLSL_NOISE3,
  GLSL_OUTPUT,
  GLSL_OUTPUT_FUNCS,
  PARTICLE_SPACE_GLSL,
  applyHaze,
  createGlowTexture,
  createSkyDome,
  fbm2D,
} from './lib.js';

/**
 * 沙漠星夜 / Desert Night
 *
 * 起伏的沙丘在星光下只剩剪影，天上是极其清晰的银河（带状分布的星点 +
 * fbm 噪声的银河带），地平线上留一点将熄的余光，空中偶尔有极慢的热浪扰动。
 *
 * 音乐驱动：
 * - pulse → 星光整体的明灭（画面最主要的运动）；
 * - bass → 沙丘极缓慢的起伏；mid → 银河的缓慢流动与热浪；
 * - treble → 星星的细碎闪烁；level → 地平线余光的强弱。
 */

const BREATHING = { inhale: 6, hold: 4, exhale: 8 };
const FOV = 58;

/** 银河带所在平面的法线（决定银河在天空里的走向）。 */
const GALAXY_AXIS = new THREE.Vector3(0.52, -0.76, -0.39).normalize();

/* ------------------------------------------------------------------ *
 * 银河
 * ------------------------------------------------------------------ */

const GALAXY_VERT = /* glsl */ `
varying vec3 vDir;

void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const GALAXY_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uColor;
uniform vec3 uAxis;
uniform float uTime;
uniform float uIntensity;

varying vec3 vDir;

${GLSL_HASH}
${GLSL_NOISE3}
${GLSL_OUTPUT_FUNCS}

void main() {
  vec3 dir = normalize(vDir);
  float band = dot(dir, uAxis);

  // 带状分布：越靠近带心越亮
  float width = exp(-band * band * 22.0);

  // 云絮状的结构
  vec3 q = dir * 9.0 + vec3(0.0, 0.0, uTime * 0.006);
  float clouds = fbm3(q, 4);
  float fine = fbm3(dir * 26.0 + vec3(uTime * 0.01, 0.0, 0.0), 3);

  // 暗尘带：银河中间被尘埃切开
  float dust = fbm3(dir * 14.0 + 19.7, 3);
  float lane = smoothstep(0.42, 0.68, dust);

  float glow = width * (0.12 + 1.05 * clouds) * (0.45 + 0.9 * fine);
  glow *= 1.0 - lane * 0.55;

  vec3 col = mix(uColor, uColor * vec3(1.06, 0.98, 0.92), fine);
  gl_FragColor = vec4(col * glow * uIntensity, 1.0);
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * 星点
 * ------------------------------------------------------------------ */

const STAR_VERT = /* glsl */ `
attribute float aSize;
attribute float aPhase;
attribute float aBright;

uniform float uTime;
uniform float uScale;
uniform float uTwinkle;
uniform vec3 uAxis;

varying float vAlpha;
varying vec3 vTint;

${PARTICLE_SPACE_GLSL}

void main() {
  vec3 p = position;

  vec4 mv = modelViewMatrix * vec4(particleSpaceTransform(p), 1.0);
  gl_Position = projectionMatrix * mv;

  // 银河带里的星更密更亮
  vec3 dir = normalize(p);
  float band = dot(dir, uAxis);
  float bandWeight = 0.35 + 0.95 * exp(-band * band * 18.0);

  // 细碎的闪烁
  float twinkle = 1.0 - uTwinkle * 0.55 * (0.5 + 0.5 * sin(uTime * 2.1 + aPhase * 6.2831));

  vAlpha = aBright * bandWeight * twinkle;
  vTint = color;
  gl_PointSize = aSize * uScale / max(1.0, -mv.z);
}
`;

const STAR_FRAG = /* glsl */ `
precision highp float;

varying float vAlpha;
varying vec3 vTint;

${GLSL_OUTPUT_FUNCS}

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot(c, c);
  if (d2 > 0.25) discard;
  float a = exp(-d2 * 11.0);
  float alpha = a * vAlpha;
  if (alpha < 0.003) discard;
  gl_FragColor = vec4(vTint * alpha, alpha);
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * 热浪
 * ------------------------------------------------------------------ */

const HAZE_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorld;

void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const HAZE_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uIntensity;
uniform vec3 uColor;

varying vec2 vUv;
varying vec3 vWorld;

${GLSL_HASH}
${GLSL_NOISE3}
${GLSL_OUTPUT_FUNCS}

void main() {
  // 极慢的横向扰动，像空气里的热浪
  float n = fbm3(vec3(vUv.x * 9.0, vUv.y * 2.2 - uTime * 0.02, uTime * 0.012), 3);
  float band = smoothstep(0.0, 0.45, vUv.y) * smoothstep(1.0, 0.4, vUv.y);
  float a = band * smoothstep(0.45, 0.85, n) * uIntensity;
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor * a, a);
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * 沙丘
 * ------------------------------------------------------------------ */

/** 沙丘高度场：低频起伏，相机附近压平。 */
function createDuneGeometry(size: number, segments: number): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
  geometry.rotateX(-Math.PI / 2);
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;

  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const z = position.getZ(i);
    const shape = fbm2D(x * 0.0075, z * 0.0075, 4);
    // 沙脊：只有高于某个基准的地方才隆起，脊线更锐
    const crest = Math.pow(THREE.MathUtils.clamp((shape - 0.3) / 0.45, 0, 1), 1.35);
    const dune = fbm2D(x * 0.02 + 5.1, z * 0.02 + 2.3, 3);
    const sand = (fbm2D(x * 0.09, z * 0.09, 2) - 0.5) * 0.7;
    let height = crest * 23.0 + dune * 4.0 + sand;
    height *= THREE.MathUtils.smoothstep(Math.hypot(x, z - 68.0), 20.0, 70.0);
    position.setY(i, height);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

/* ------------------------------------------------------------------ *
 * 场景
 * ------------------------------------------------------------------ */

function createDesertNight(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'desert-night-scene';

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 4000);
  camera.position.set(0, 2.2, 8);

  const quality = THREE.MathUtils.clamp(ctx.quality, 0.4, 2);
  const driver = new AudioDriver();

  let state = 880123;
  const random = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };

  // ── 夜空 ─────────────────────────────────────────────────────────────
  const sky = createSkyDome({
    zenith: 0x02030a,
    horizon: 0x0a1020,
    ground: 0x05060b,
    radius: 1600,
    bandColor: 0x5a3f2c,
    bandStrength: 0.5,
    bandY: 0.0,
    bandWidth: 0.035,
  });
  root.add(sky.mesh);

  // ── 银河 ─────────────────────────────────────────────────────────────
  const galaxyUniforms = {
    uColor: { value: new THREE.Color(0x8ea6d8) },
    uAxis: { value: GALAXY_AXIS.clone() },
    uTime: { value: 0 },
    uIntensity: { value: 0.5 },
  };
  const galaxyMaterial = new THREE.ShaderMaterial({
    uniforms: galaxyUniforms,
    vertexShader: GALAXY_VERT,
    fragmentShader: GALAXY_FRAG,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const galaxy = new THREE.Mesh(new THREE.SphereGeometry(1200, 48, 32), galaxyMaterial);
  galaxy.name = 'milky-way';
  galaxy.renderOrder = -900;
  galaxy.frustumCulled = false;
  root.add(galaxy);

  // ── 星点（粒子空间） ─────────────────────────────────────────────────
  const starSpace = new ParticleSpace({
    radius: 900,
    spin: 0.0016,
    tilt: 0.42,
    position: [0, 0, 0],
  });

  const starCount = Math.round(3200 * quality);
  const starPositions = new Float32Array(starCount * 3);
  const starColors = new Float32Array(starCount * 3);
  const starSizes = new Float32Array(starCount);
  const starPhases = new Float32Array(starCount);
  const starBrights = new Float32Array(starCount);

  for (let i = 0; i < starCount; i += 1) {
    const radius = 820 + random() * 60;
    // 在球面上均匀取点
    const cosT = random() * 2 - 1;
    const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
    const phi = random() * Math.PI * 2;
    starPositions[i * 3] = Math.cos(phi) * sinT * radius;
    starPositions[i * 3 + 1] = cosT * radius;
    starPositions[i * 3 + 2] = Math.sin(phi) * sinT * radius;

    const warm = random();
    const bright = 0.28 + Math.pow(random(), 3.2) * 1.5;
    starColors[i * 3] = bright * (warm > 0.72 ? 1 : 0.82);
    starColors[i * 3 + 1] = bright * (warm > 0.72 ? 0.86 : 0.88);
    starColors[i * 3 + 2] = bright * (warm > 0.72 ? 0.74 : 1);
    starBrights[i] = 0.5 + Math.pow(random(), 1.5) * 1.1;
    starSizes[i] = 1.1 + Math.pow(random(), 2.4) * 4.2;
    starPhases[i] = random();
  }

  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
  starGeometry.setAttribute('color', new THREE.BufferAttribute(starColors, 3));
  starGeometry.setAttribute('aSize', new THREE.BufferAttribute(starSizes, 1));
  starGeometry.setAttribute('aPhase', new THREE.BufferAttribute(starPhases, 1));
  starGeometry.setAttribute('aBright', new THREE.BufferAttribute(starBrights, 1));

  const starUniforms = {
    uTime: { value: 0 },
    uScale: { value: 400 },
    uTwinkle: { value: 0.2 },
    uAxis: { value: GALAXY_AXIS.clone() },
    particleMatrix: starSpace.uniform,
  };
  const starMaterial = new THREE.ShaderMaterial({
    uniforms: starUniforms,
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    transparent: true,
    depthWrite: false,
    vertexColors: true,
    blending: THREE.AdditiveBlending,
  });
  const stars = new THREE.Points(starGeometry, starMaterial);
  stars.name = 'stars';
  stars.frustumCulled = false;
  root.add(stars);

  // ── 沙丘 ─────────────────────────────────────────────────────────────
  const baseGround = ctx.env.createGround(700);
  baseGround.position.y = -3.0;
  const baseGroundMaterial = (baseGround as THREE.Mesh).material as THREE.MeshStandardMaterial;
  baseGroundMaterial.envMap = ctx.env.envMap;
  baseGroundMaterial.envMapIntensity = 0.04;
  root.add(baseGround);

  const duneUniforms = {
    uTime: { value: 0 },
    uRipple: { value: 0 },
  };

  const duneMaterial = new THREE.MeshStandardMaterial({
    color: 0x5d5240,
    roughness: 1,
    metalness: 0,
    flatShading: false,
  });
  duneMaterial.envMap = ctx.env.envMap;
  duneMaterial.envMapIntensity = 0.05;
  applyHaze(duneMaterial, { color: 0x0d1220, near: 60, far: 380 });

  const previousCompile = duneMaterial.onBeforeCompile;
  duneMaterial.onBeforeCompile = (shader, renderer) => {
    previousCompile?.(shader, renderer);
    shader.uniforms.uTime = duneUniforms.uTime;
    shader.uniforms.uRipple = duneUniforms.uRipple;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uRipple;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
  // 极缓慢的沙丘起伏
  transformed.y += sin( transformed.x * 0.021 + uTime * 0.11 ) * cos( transformed.z * 0.017 - uTime * 0.08 ) * uRipple;`,
      );
  };
  duneMaterial.needsUpdate = true;

  const dunes = new THREE.Mesh(
    createDuneGeometry(520, Math.round(170 * quality)),
    duneMaterial,
  );
  dunes.name = 'dunes';
  dunes.position.set(0, 0, -60);
  root.add(dunes);

  // ── 地平线的余光 ─────────────────────────────────────────────────────
  const glowTexture = createGlowTexture(128, 1.7);
  const afterglow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture,
      color: 0x8a5a34,
      transparent: true,
      opacity: 0.36,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  afterglow.name = 'afterglow';
  afterglow.scale.set(240, 54, 1);
  afterglow.position.set(-130, 13, -430);
  root.add(afterglow);

  // ── 热浪 ─────────────────────────────────────────────────────────────
  const hazeUniforms = {
    uTime: { value: 0 },
    uIntensity: { value: 0.1 },
    uColor: { value: new THREE.Color(0x6b7a92) },
  };
  const hazeMaterial = new THREE.ShaderMaterial({
    uniforms: hazeUniforms,
    vertexShader: HAZE_VERT,
    fragmentShader: HAZE_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const heatBand = new THREE.Mesh(new THREE.CylinderGeometry(260, 260, 26, 32, 1, true), hazeMaterial);
  heatBand.name = 'heat-haze';
  heatBand.position.set(0, 6, -60);
  root.add(heatBand);

  // ── 灯光 ─────────────────────────────────────────────────────────────
  const lights = ctx.env.createStudioLights();
  lights.traverse((child) => {
    if (child instanceof THREE.Light) {
      child.intensity *= 0.12;
      child.castShadow = false;
      child.color.setHex(0x9fb6d8);
    }
  });
  root.add(lights);

  const moonlight = new THREE.DirectionalLight(0xa8c0e0, 1.25);
  moonlight.position.set(-30, 40, 18);
  root.add(moonlight);

  const ambient = new THREE.HemisphereLight(0x3d4f7d, 0x2a2116, 1.8);
  root.add(ambient);

  return {
    root,
    camera,
    immersive: true,
    xrDistance: 3,
    framing: { distance: 8, height: 2.2, targetY: 4.6, width: 26 },
    update(time: number, delta: number, context: SceneContext): void {
      driver.update(context, delta);

      const pulse = driver.pulse;
      const level = driver.level;

      sky.uniforms.uTime.value = time;
      sky.uniforms.uLevel.value = level;

      // 银河：中频推动极慢的流动
      galaxyUniforms.uTime.value = time * (1 + driver.mid * 0.4);
      galaxyUniforms.uIntensity.value = 0.16 + level * 0.22 + pulse * 0.24;

      // 星点：脉冲带来整体的明灭，高频带来细碎闪烁
      starUniforms.uTime.value = time;
      starUniforms.uTwinkle.value = 0.12 + driver.treble * 0.7 + pulse * 0.4;
      starUniforms.uScale.value = context.height * context.renderer.getPixelRatio() * 1.55;

      starSpace.breathe = 1 + pulse * 0.01;
      starSpace.breathPhase = pulse;
      starSpace.update(delta, time);

      // 沙丘：低频带来极缓慢的起伏
      duneUniforms.uTime.value = time;
      duneUniforms.uRipple.value = driver.bass * 1.3 + pulse * 0.25;

      // 余光随响度变化（远处将熄的天光）
      sky.uniforms.uBandStrength.value = 0.32 + level * 0.4;
      afterglow.material.opacity = 0.14 + level * 0.3 + pulse * 0.12;

      // 热浪：随中频缓慢起伏
      hazeUniforms.uTime.value = time;
      hazeUniforms.uIntensity.value = 0.06 + driver.mid * 0.1 + pulse * 0.04;

      moonlight.intensity = 1.05 + level * 0.45;
      ambient.intensity = 1.55 + level * 0.5;
    },
    dispose(): void {
      glowTexture.dispose();
      disposeObject(root);
    },
  };
}

export const desertNightScene: SceneDefinition = {
  id: 'desert-night',
  title: '沙漠星夜',
  subtitle: 'Desert Night',
  description: '沙丘只剩剪影，天上的银河清晰得能看见尘埃带，地平线留着一点余光。',
  tags: ['银河', '沙丘', '夜色'],
  accent: '#a9b8ff',
  gradient: ['#1b2547', '#05060d'],
  category: 'environment',
  audio: 'desert-night.mp3',
  breathing: BREATHING,
  create(ctx: SceneContext): SceneInstance {
    return createDesertNight(ctx);
  },
};

export default desertNightScene;
