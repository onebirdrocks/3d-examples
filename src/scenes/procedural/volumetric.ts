import * as THREE from 'three';
import type { SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { disposeObject } from '../../core/loader.js';
import { GLSL_HASH, GLSL_NOISE, GLSL_OUTPUT } from './lib/noise.js';

/**
 * 体积光（God Rays）
 * 一个包围盒内做 raymarching，累积被 3D 噪声扰动的尘埃密度场，
 * 配合光柱、浮尘粒子层与地面光斑，形成暖金 + 冷蓝的暗室氛围。
 */

const BEAM_COUNT = 5;
const BEAM_SPACING = 1.42;
const MAX_STEPS = 72;

const LIGHT_POS = new THREE.Vector3(0.4, 11.4, -1.6);
const LIGHT_DIR = new THREE.Vector3(0.16, -1, 0.26).normalize();

/** 光柱与尘埃共用的密度函数。 */
const GLSL_BEAMS = /* glsl */ `
const int BEAM_COUNT = ${BEAM_COUNT};
const float BEAM_SPACING = ${BEAM_SPACING};

vec3 beamRight() {
  return normalize(cross(uLightDir, vec3(0.0, 1.0, 0.0)));
}

float beamMask(vec3 p) {
  vec3 rel = p - uLightPos;
  float t = dot(rel, uLightDir);
  if (t < 0.0) return 0.0;
  vec3 perp = rel - uLightDir * t;
  float d = length(perp);
  float radius = mix(0.16, 0.62, clamp(t / 15.0, 0.0, 1.0));
  float lateral = 1.0 - smoothstep(radius * 0.12, radius, d);
  float along = smoothstep(0.0, 1.4, t) * (1.0 - smoothstep(11.5, 16.5, t));
  return lateral * along;
}

float beams(vec3 p) {
  vec3 right = beamRight();
  float total = 0.0;
  for (int i = 0; i < BEAM_COUNT; i++) {
    float off = (float(i) - float(BEAM_COUNT - 1) * 0.5) * BEAM_SPACING;
    total += beamMask(p - right * off);
  }
  return total;
}
`;

const VOLUME_VERT = /* glsl */ `
varying vec3 vWorldPos;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const VOLUME_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uLightPos;
uniform vec3 uLightDir;
uniform vec3 uBeamColor;
uniform vec3 uAmbientColor;
uniform vec3 uBoxMin;
uniform vec3 uBoxMax;
uniform float uTime;
uniform float uSteps;
uniform float uDensity;

varying vec3 vWorldPos;

${GLSL_HASH}
${GLSL_NOISE}
${GLSL_BEAMS}

vec2 hitBox(vec3 ro, vec3 rd, vec3 bmin, vec3 bmax) {
  vec3 safe = mix(rd, vec3(1e-5), lessThan(abs(rd), vec3(1e-5)));
  vec3 inv = 1.0 / safe;
  vec3 t0 = (bmin - ro) * inv;
  vec3 t1 = (bmax - ro) * inv;
  vec3 lo = min(t0, t1);
  vec3 hi = max(t0, t1);
  return vec2(max(max(lo.x, lo.y), lo.z), min(min(hi.x, hi.y), hi.z));
}

void main() {
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vWorldPos - ro);
  vec2 hit = hitBox(ro, rd, uBoxMin, uBoxMax);
  float t0 = max(hit.x, 0.0);
  float t1 = hit.y;
  if (t1 <= t0) discard;

  float dt = (t1 - t0) / uSteps;
  float t = t0 + hash12(gl_FragCoord.xy + vec2(uTime * 13.0)) * dt;

  vec3 acc = vec3(0.0);
  float trans = 1.0;

  for (int i = 0; i < ${MAX_STEPS}; i++) {
    if (float(i) >= uSteps) break;
    vec3 p = ro + rd * t;

    float shaft = beams(p);

    // 只有光束内部才需要计算湍流噪声，束外直接跳过，省下大量采样
    float turb = 1.0;
    if (shaft > 0.003) {
      float n = fbm3oct(p * 0.26 + vec3(0.0, uTime * 0.04, uTime * 0.025), 3);
      turb = 0.62 + 0.62 * (n + 0.5);
    }

    vec3 lit = uBeamColor * (0.03 + 2.7 * shaft) + uAmbientColor;
    float dens = uDensity * (0.06 + 2.3 * shaft) * turb;
    acc += trans * lit * dens * dt;
    trans *= exp(-dens * 1.15 * dt);

    t += dt;
  }

  gl_FragColor = vec4(acc, 1.0);
  ${GLSL_OUTPUT}
}
`;

const POOL_VERT = /* glsl */ `
varying vec3 vWorldPos;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const POOL_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uLightPos;
uniform vec3 uLightDir;
uniform vec3 uPoolColor;
uniform float uTime;

varying vec3 vWorldPos;

${GLSL_HASH}
${GLSL_NOISE}
${GLSL_BEAMS}

void main() {
  vec3 right = beamRight();
  vec2 fwd = normalize(uLightDir.xz);

  float t = -uLightPos.y / uLightDir.y;
  vec3 hit = uLightPos + uLightDir * t;

  float glow = 0.0;
  for (int i = 0; i < BEAM_COUNT; i++) {
    float off = (float(i) - float(BEAM_COUNT - 1) * 0.5) * BEAM_SPACING;
    vec2 c = hit.xz + right.xz * off;
    vec2 d = vWorldPos.xz - c;
    float along = dot(d, fwd);
    float across = dot(d, vec2(-fwd.y, fwd.x));
    float r = length(vec2(along * 0.5, across * 1.45));
    glow += exp(-r * r * 2.1);
  }

  // 轻微的颗粒感，避免光斑过于干净
  float grain = 0.82 + 0.36 * fbm2(vWorldPos.xz * 1.6 + vec2(uTime * 0.05, 0.0));
  glow *= grain * 0.42;

  gl_FragColor = vec4(uPoolColor * glow, 1.0);
  ${GLSL_OUTPUT}
}
`;

const DUST_VERT = /* glsl */ `
attribute float aSeed;
attribute float aSize;

uniform float uTime;
uniform float uScale;
uniform vec3 uLightPos;
uniform vec3 uLightDir;

varying float vGlow;

${GLSL_HASH}
${GLSL_NOISE}
${GLSL_BEAMS}

void main() {
  vec3 p = position;
  float s = aSeed;
  p.x += sin(uTime * 0.21 + s * 6.2831) * 0.6;
  p.y += sin(uTime * 0.13 + s * 12.3) * 0.45;
  p.z += cos(uTime * 0.17 + s * 9.11) * 0.6;

  float shaft = beams(p);
  vGlow = 0.03 + 1.15 * shaft;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * uScale / max(0.4, -mv.z);
}
`;

const DUST_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uDustColor;

varying float vGlow;

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot(c, c);
  if (d2 > 0.25) discard;
  float a = exp(-d2 * 13.0);
  gl_FragColor = vec4(uDustColor * a * vGlow, 1.0);
  ${GLSL_OUTPUT}
}
`;

function createVolumetric(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'volumetric-scene';

  const camera = new THREE.PerspectiveCamera(62, 1, 0.05, 220);
  camera.position.set(0, 1.6, 5.6);
  camera.lookAt(0, 1.9, 0);

  const quality = THREE.MathUtils.clamp(ctx.quality, 0.4, 2);

  // ── 暗室 ──────────────────────────────────────────────────────────────
  // 不放房间盒子：纯黑背景能避免箱体棱角在体积光里形成硬边。
  const ground = ctx.env.createGround(140) as THREE.Mesh;
  ground.name = 'volumetric-ground';
  const groundMaterial = ground.material as THREE.MeshStandardMaterial;
  // 直接挂 envMap，envMapIntensity 才会生效（否则 scene.environment 恒为满强度）
  groundMaterial.envMap = ctx.env.envMap;
  groundMaterial.envMapIntensity = 0.07;
  groundMaterial.roughness = 1;
  groundMaterial.color.setHex(0x0b0d13);
  root.add(ground);

  // ── 灯光 ──────────────────────────────────────────────────────────────
  const lights = ctx.env.createStudioLights();
  lights.traverse((child) => {
    if (child instanceof THREE.Light) {
      child.intensity *= 0.03;
    }
  });
  root.add(lights);

  const spot = new THREE.SpotLight(0xffd7a4, 70, 44, 0.5, 0.8, 1.6);
  spot.position.copy(LIGHT_POS);
  spot.target.position.set(LIGHT_POS.x, 0, LIGHT_POS.z);
  root.add(spot);
  root.add(spot.target);

  const rim = new THREE.PointLight(0x5f8dff, 4, 22, 2);
  rim.position.set(-7.5, 4.2, -8.5);
  root.add(rim);

  // ── 体积光 raymarching ────────────────────────────────────────────────
  const volumeSize = new THREE.Vector3(30, 12, 30);
  const volumeGeometry = new THREE.BoxGeometry(volumeSize.x, volumeSize.y, volumeSize.z);
  const volumeUniforms = {
    uLightPos: { value: LIGHT_POS.clone() },
    uLightDir: { value: LIGHT_DIR.clone() },
    uBeamColor: { value: new THREE.Color(0xffb763) },
    uAmbientColor: { value: new THREE.Color(0x0d1830) },
    uBoxMin: { value: new THREE.Vector3() },
    uBoxMax: { value: new THREE.Vector3() },
    uTime: { value: 0 },
    uSteps: { value: Math.round(30 * quality) },
    uDensity: { value: 0.026 },
  };

  const volumeMaterial = new THREE.ShaderMaterial({
    uniforms: volumeUniforms,
    vertexShader: VOLUME_VERT,
    fragmentShader: VOLUME_FRAG,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const volume = new THREE.Mesh(volumeGeometry, volumeMaterial);
  volume.name = 'volume';
  volume.position.y = volumeSize.y * 0.5 + 0.02;
  volume.frustumCulled = false;
  volume.renderOrder = 4;
  root.add(volume);

  const half = volumeSize.clone().multiplyScalar(0.5);
  volumeUniforms.uBoxMin.value.copy(volume.position).sub(half);
  volumeUniforms.uBoxMax.value.copy(volume.position).add(half);

  // ── 地面光斑 ──────────────────────────────────────────────────────────
  const poolGeometry = new THREE.CircleGeometry(17, 72);
  const poolUniforms = {
    uLightPos: { value: LIGHT_POS.clone() },
    uLightDir: { value: LIGHT_DIR.clone() },
    uPoolColor: { value: new THREE.Color(0xffb45e) },
    uTime: { value: 0 },
  };
  const poolMaterial = new THREE.ShaderMaterial({
    uniforms: poolUniforms,
    vertexShader: POOL_VERT,
    fragmentShader: POOL_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const pool = new THREE.Mesh(poolGeometry, poolMaterial);
  pool.name = 'light-pool';
  pool.rotation.x = -Math.PI / 2;
  pool.position.y = 0.03;
  pool.renderOrder = 2;
  root.add(pool);

  // ── 浮尘 ──────────────────────────────────────────────────────────────
  const dustCount = Math.round(1000 * quality);
  const dustPositions = new Float32Array(dustCount * 3);
  const dustSeeds = new Float32Array(dustCount);
  const dustSizes = new Float32Array(dustCount);
  for (let i = 0; i < dustCount; i++) {
    const i3 = i * 3;
    dustPositions[i3] = (Math.random() - 0.5) * 20;
    dustPositions[i3 + 1] = 0.2 + Math.random() * 10.2;
    dustPositions[i3 + 2] = (Math.random() - 0.5) * 20;
    dustSeeds[i] = Math.random();
    dustSizes[i] = 0.08 + Math.random() * 0.14;
  }

  const dustGeometry = new THREE.BufferGeometry();
  dustGeometry.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3));
  dustGeometry.setAttribute('aSeed', new THREE.BufferAttribute(dustSeeds, 1));
  dustGeometry.setAttribute('aSize', new THREE.BufferAttribute(dustSizes, 1));

  const dustUniforms = {
    uTime: { value: 0 },
    uScale: { value: 400 },
    uLightPos: { value: LIGHT_POS.clone() },
    uLightDir: { value: LIGHT_DIR.clone() },
    uDustColor: { value: new THREE.Color(0xffd9a8) },
  };

  const dustMaterial = new THREE.ShaderMaterial({
    uniforms: dustUniforms,
    vertexShader: DUST_VERT,
    fragmentShader: DUST_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const dust = new THREE.Points(dustGeometry, dustMaterial);
  dust.name = 'dust';
  dust.frustumCulled = false;
  dust.renderOrder = 5;
  root.add(dust);

  return {
    root,
    camera,
    immersive: false,
    xrDistance: 3,
    framing: { distance: 5.6, height: 1.6, targetY: 1.9 },
    update(time: number, _delta: number, context: SceneContext): void {
      volumeUniforms.uTime.value = time;
      poolUniforms.uTime.value = time;
      dustUniforms.uTime.value = time;
      dustUniforms.uScale.value = context.height * 0.5 * context.renderer.getPixelRatio();
    },
    dispose(): void {
      disposeObject(root);
    },
  };
}

export const volumetricScene: SceneDefinition = {
  id: 'volumetric',
  title: '体积光',
  subtitle: 'Volumetric Light',
  description: '暗室中穿透尘埃的光柱，噪声密度场在光束里留下流动的絮影。',
  tags: ['体积光', '光影', '粒子'],
  accent: '#ffb45e',
  gradient: ['#3a2410', '#080a12'],
  category: 'procedural',
  create(ctx: SceneContext): SceneInstance {
    return createVolumetric(ctx);
  },
};

export default volumetricScene;
