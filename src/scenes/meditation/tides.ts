import * as THREE from 'three';
import type { SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { disposeObject } from '../../core/loader.js';
import { ParticleSpace, wrapParticleField } from '../../core/particle-space.js';
import { createBreathSample, sampleBreath } from './lib/breath.js';
import {
  GLSL_DITHER,
  GLSL_HASH,
  GLSL_NOISE2,
  GLSL_OUTPUT,
  GLSL_OUTPUT_FUNCS,
  createSoftParticleField,
  dimStudioLights,
  updateParticleScale,
} from './lib/gfx.js';

/**
 * 夜潮
 *
 * 月光下的夜海：低频大波长的涌浪极缓慢地起伏，波面被月光拉出长长的银色倒影，
 * 远处地平线与夜空之间浮着一层薄雾。浪的高度随呼吸缓缓升降。
 */

const BREATHING = { inhale: 6, hold: 2, exhale: 8 };

const FOV = 50;

/** 月亮的方向：几乎正对用户，略高于视线。 */
const MOON_DIR = new THREE.Vector3(0.07, 0.3, -0.95).normalize();

const SKY_VERT = /* glsl */ `
varying vec3 vDir;

void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SKY_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uMoonColor;
uniform vec3 uMoonDir;
uniform float uTime;
uniform float uBreath;

varying vec3 vDir;

${GLSL_HASH}
${GLSL_DITHER}
${GLSL_OUTPUT_FUNCS}

// 稀疏的星点：用三维格子采样，缓慢明灭
float starField(vec3 dir) {
  vec3 p = dir * 58.0;
  vec3 cell = floor(p);
  vec3 f = fract(p) - 0.5;
  float h = hash13(cell);
  float on = step(0.9915, h);
  float d = length(f);
  float twinkle = 0.7 + 0.3 * sin(uTime * 0.11 + h * 40.0);
  return on * exp(-d * d * 55.0) * twinkle;
}

void main() {
  vec3 dir = normalize(vDir);
  vec3 col = mix(uHorizon, uZenith, smoothstep(-0.01, 0.6, dir.y));
  col = mix(col, uGround, smoothstep(0.0, -0.25, dir.y));

  // 星点
  col += vec3(0.72, 0.78, 0.9) * starField(dir) * 0.55 * smoothstep(0.03, 0.3, dir.y);

  // 月亮与月晕
  float m = max(dot(dir, uMoonDir), 0.0);
  col += uMoonColor * pow(m, 4200.0) * (2.0 + 0.5 * uBreath);
  col += uMoonColor * pow(m, 26.0) * 0.12;

  // 地平线上的薄雾
  float band = exp(-abs(dir.y) * 11.0);
  col = mix(col, uHorizon * 1.12, band * 0.55);

  col += (dither(gl_FragCoord.xy) - 0.5) * 0.007;
  gl_FragColor = vec4(col, 1.0);
  ${GLSL_OUTPUT}
}
`;

const WATER_VERT = /* glsl */ `
uniform float uTime;
uniform float uAmp;

varying vec3 vWorldPos;
varying vec3 vNormalW;

float waveHeight(vec2 p, float t) {
  float h = 0.0;
  h += sin(dot(p, vec2(0.94, 0.34)) * 0.21 + t * 0.14) * 0.9;
  h += sin(dot(p, vec2(-0.32, 0.95)) * 0.47 - t * 0.17) * 0.42;
  h += sin(dot(p, vec2(0.71, -0.70)) * 1.03 + t * 0.13) * 0.15;
  return h;
}

void main() {
  vec3 p = position;
  float dist = length(p.xz - cameraPosition.xz);
  float fade = 1.0 - smoothstep(45.0, 190.0, dist);

  float h = waveHeight(p.xz, uTime) * uAmp * fade;
  float hx = waveHeight(p.xz + vec2(0.8, 0.0), uTime) * uAmp * fade;
  float hz = waveHeight(p.xz + vec2(0.0, 0.8), uTime) * uAmp * fade;
  p.y += h;

  vec3 n = normalize(vec3(h - hx, 0.9, h - hz));
  vNormalW = normalize(mat3(modelMatrix) * n);

  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const WATER_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uDeep;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uMoonColor;
uniform vec3 uMoonDir;
uniform float uTime;
uniform float uBreath;

varying vec3 vWorldPos;
varying vec3 vNormalW;

${GLSL_HASH}
${GLSL_NOISE2}
${GLSL_DITHER}
${GLSL_OUTPUT_FUNCS}

vec3 skyColor(vec3 dir) {
  vec3 col = mix(uSkyHorizon, uSkyZenith, smoothstep(-0.01, 0.6, dir.y));
  float m = max(dot(dir, uMoonDir), 0.0);
  col += uMoonColor * pow(m, 4200.0) * 2.2;
  col += uMoonColor * pow(m, 26.0) * 0.1;
  return col;
}

void main() {
  vec3 V = normalize(cameraPosition - vWorldPos);
  float dist = length(vWorldPos - cameraPosition);

  // 波面上的细碎涟漪（远处淡出，避免高频闪烁）
  vec2 q = vWorldPos.xz * 0.8 + vec2(uTime * 0.045, uTime * 0.028);
  float n0 = fbm2(q);
  float nx = fbm2(q + vec2(0.35, 0.0));
  float nz = fbm2(q + vec2(0.0, 0.35));
  float detailFade = 1.0 - smoothstep(25.0, 130.0, dist);

  vec3 N = normalize(vNormalW + vec3((n0 - nx) * 2.0, 0.0, (n0 - nz) * 2.0) * detailFade);

  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float fres = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);

  vec3 sky = skyColor(normalize(reflect(-V, N)));
  vec3 col = mix(uDeep, sky, clamp(fres, 0.0, 0.9));

  // 月光在水面拉出的银色长路
  vec3 flatMoon = normalize(vec3(uMoonDir.x, 0.0, uMoonDir.z));
  vec3 flatView = normalize(vec3(-V.x, 0.0, -V.z));
  float path = pow(clamp(dot(flatMoon, flatView), 0.0, 1.0), 22.0);
  vec3 H = normalize(uMoonDir + V);
  float glint = pow(clamp(dot(N, H), 0.0, 1.0), 190.0);

  col += uMoonColor * path * 0.1;
  col += uMoonColor * glint * path * 2.2 * detailFade;

  // 远处溶进地平线的薄雾
  col = mix(col, uSkyHorizon * 1.1, 1.0 - exp(-dist * 0.016));

  // 呼吸：水面亮度极轻地起伏
  col *= 0.96 + 0.07 * uBreath;
  col += (dither(gl_FragCoord.xy) - 0.5) * 0.007;

  gl_FragColor = vec4(col, 1.0);
  ${GLSL_OUTPUT}
}
`;

function createTides(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'tides-scene';

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 6000);
  camera.position.set(0, 1.6, 6.5);
  camera.lookAt(0, 1.25, 0);

  // ── 夜空 ──────────────────────────────────────────────────────────────
  const skyUniforms = {
    uZenith: { value: new THREE.Color(0x08101f) },
    uHorizon: { value: new THREE.Color(0x1b2c44) },
    uGround: { value: new THREE.Color(0x0a121c) },
    uMoonColor: { value: new THREE.Color(0xc9d6e2) },
    uMoonDir: { value: MOON_DIR.clone() },
    uTime: { value: 0 },
    uBreath: { value: 0 },
  };
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(2400, 40, 24),
    new THREE.ShaderMaterial({
      uniforms: skyUniforms,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    }),
  );
  sky.name = 'sky';
  sky.renderOrder = -1000;
  sky.frustumCulled = false;
  root.add(sky);

  // ── 海面 ──────────────────────────────────────────────────────────────
  const waterUniforms = {
    uDeep: { value: new THREE.Color(0x060d16) },
    uSkyZenith: { value: skyUniforms.uZenith.value },
    uSkyHorizon: { value: skyUniforms.uHorizon.value },
    uMoonColor: { value: skyUniforms.uMoonColor.value },
    uMoonDir: { value: skyUniforms.uMoonDir.value },
    uTime: { value: 0 },
    uAmp: { value: 0.2 },
    uBreath: { value: 0 },
  };
  const waterMaterial = new THREE.ShaderMaterial({
    uniforms: waterUniforms,
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
  });

  const segments = Math.round(THREE.MathUtils.clamp(140 * ctx.quality, 60, 170));
  const nearGeometry = new THREE.PlaneGeometry(300, 300, segments, segments);
  nearGeometry.rotateX(-Math.PI / 2);
  const water = new THREE.Mesh(nearGeometry, waterMaterial);
  water.name = 'water';
  root.add(water);

  // 远处的大平面，把海面一直铺到地平线
  const farGeometry = new THREE.PlaneGeometry(4000, 4000, 1, 1);
  farGeometry.rotateX(-Math.PI / 2);
  const farWater = new THREE.Mesh(farGeometry, waterMaterial);
  farWater.name = 'far-water';
  farWater.position.y = -0.03;
  root.add(farWater);

  // ── 海面上的薄雾与微粒 ────────────────────────────────────────────────
  const space = new ParticleSpace({
    radius: 5.5,
    spin: 0.009,
    tilt: 0.12,
    position: [0, 0.9, -2.5],
  });
  const mist = createSoftParticleField(space, Math.floor(320 * ctx.quality), {
    size: 0.05,
    color: new THREE.Color(0x9fb6c8),
    opacity: 0.2,
    seed: 5521,
    wander: 0.12,
  });
  root.add(mist.points);

  // ── 灯光 ──────────────────────────────────────────────────────────────
  const lights = ctx.env.createStudioLights();
  dimStudioLights(lights, 0.05, 0x2a3a52);
  root.add(lights);

  const moonLight = new THREE.DirectionalLight(0xb9cde0, 0.32);
  moonLight.position.copy(MOON_DIR).multiplyScalar(40);
  root.add(moonLight);

  const breath = createBreathSample();

  return {
    root,
    camera,
    immersive: true,
    framing: { distance: 6.5, height: 1.6, targetY: 1.25, width: 14 },
    update(time: number, delta: number, context: SceneContext): void {
      sampleBreath(BREATHING, time, breath);
      const level = breath.level;

      space.breathe = 1 + level * 0.1;
      space.breathPhase = level;
      space.update(delta, time);
      wrapParticleField(mist.points, space.radius, delta, 0.01);

      mist.uniforms.uTime.value = time;
      mist.uniforms.uBreath.value = level;
      updateParticleScale(mist.uniforms, context, FOV);

      // 浪高随呼吸缓慢升降
      waterUniforms.uTime.value = time;
      waterUniforms.uAmp.value = 0.17 + level * 0.075;
      waterUniforms.uBreath.value = level;

      skyUniforms.uTime.value = time;
      skyUniforms.uBreath.value = level;

      moonLight.intensity = 0.28 + level * 0.09;
    },
    dispose(): void {
      disposeObject(root);
    },
  };
}

export const tidesScene: SceneDefinition = {
  id: 'tides',
  title: '夜潮',
  subtitle: 'Night Tides',
  description: '月光在夜海上铺出一条银色的路，海浪随着你的呼吸缓缓起落。',
  tags: ['海', '月光', '潮汐'],
  accent: '#8fb6c9',
  gradient: ['#16283c', '#050a12'],
  category: 'meditation',
  audio: 'night-tides.mp3',
  breathing: BREATHING,
  create(ctx: SceneContext): SceneInstance {
    return createTides(ctx);
  },
};

export default tidesScene;
