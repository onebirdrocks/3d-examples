import * as THREE from 'three';
import type { SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { disposeObject } from '../../core/loader.js';
import { GLSL_HASH, GLSL_NOISE, GLSL_OUTPUT } from './lib/noise.js';
import { mulberry32 } from './lib/math.js';

/**
 * 星河漩涡
 * 数十万颗加性混合的 Points 组成对数螺线旋臂，中心有致密亮核，
 * 外侧叠加半透明星云盘、核心辉光与包围用户的球状星晕，背景是完整星空。
 */

const ARM_COUNT = 4;
const SPIRAL_TIGHTNESS = 2.35;
const DISK_RADIUS = 46;
const GALAXY_CENTER = new THREE.Vector3(0, 0, -58);

const STAR_VERT = /* glsl */ `
attribute float aSize;
attribute float aPhase;
attribute vec3 aColor;

uniform float uScale;
uniform float uTime;

varying vec3 vColor;
varying float vTwinkle;

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = max(1.0, -mv.z);
  gl_PointSize = aSize * uScale / dist;
  vColor = aColor;
  vTwinkle = 0.78 + 0.22 * sin(uTime * 1.6 + aPhase * 6.2831);
}
`;

const STAR_FRAG = /* glsl */ `
precision highp float;

varying vec3 vColor;
varying float vTwinkle;

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot(c, c);
  if (d2 > 0.25) discard;
  float a = exp(-d2 * 11.0);
  gl_FragColor = vec4(vColor * a * vTwinkle, 1.0);
  ${GLSL_OUTPUT}
}
`;

const NEBULA_VERT = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const NEBULA_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uSeed;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uOpacity;

varying vec2 vUv;

${GLSL_HASH}
${GLSL_NOISE}

void main() {
  vec2 uv = vUv - 0.5;
  float r = length(uv) * 2.0;
  float fall = 1.0 - smoothstep(0.15, 1.0, r);
  if (fall <= 0.001) discard;

  vec2 p = vUv * 2.6 + vec2(uSeed * 7.3, uSeed * 3.1);
  float n1 = fbm2(p + vec2(uTime * 0.012, uTime * 0.006));
  float n2 = fbm2(p * 2.4 - vec2(uTime * 0.017, uTime * 0.004));

  float cloud = fall * smoothstep(0.26, 0.86, n1 * 0.75 + n2 * 0.5);
  if (cloud <= 0.002) discard;

  vec3 col = mix(uColorA, uColorB, clamp(n2 * 1.6, 0.0, 1.0));
  gl_FragColor = vec4(col * cloud * uOpacity, 1.0);
  ${GLSL_OUTPUT}
}
`;

const GLOW_VERT = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const GLOW_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uColor;
uniform float uTime;

varying vec2 vUv;

void main() {
  vec2 p = vUv - 0.5;
  float r = length(p) * 2.0;
  if (r > 1.0) discard;
  float window = 1.0 - smoothstep(0.55, 1.0, r);
  float core = exp(-r * r * 18.0) * 0.34;
  float halo = exp(-r * 3.0) * 0.16;
  float streak = exp(-abs(p.y) * 62.0) * exp(-abs(p.x) * 3.4) * 0.22;
  float glow = (core + halo + streak) * window;
  gl_FragColor = vec4(uColor * glow, 1.0);
  ${GLSL_OUTPUT}
}
`;

interface PointBuffers {
  positions: Float32Array;
  colors: Float32Array;
  sizes: Float32Array;
  phases: Float32Array;
}

function createPointBuffers(count: number): PointBuffers {
  return {
    positions: new Float32Array(count * 3),
    colors: new Float32Array(count * 3),
    sizes: new Float32Array(count),
    phases: new Float32Array(count),
  };
}

function createGalaxy(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'galaxy-scene';

  const camera = new THREE.PerspectiveCamera(58, 1, 0.05, 3000);
  camera.position.set(0, 1.7, 6);
  camera.lookAt(0, 1.4, 0);

  const quality = THREE.MathUtils.clamp(ctx.quality, 0.4, 2);
  const rng = mulberry32(20240517);

  const starUniforms = {
    uScale: { value: 400 },
    uTime: { value: 0 },
  };

  const starMaterial = new THREE.ShaderMaterial({
    uniforms: starUniforms,
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  // ── 旋臂粒子 ──────────────────────────────────────────────────────────
  const armCount = Math.round(150000 * quality);
  const arm = createPointBuffers(armCount);
  const colorCore = new THREE.Color(0xfff0d2);
  const colorMid = new THREE.Color(0x9dc2ff);
  const colorOuter = new THREE.Color(0x8f5cff);
  const tempColor = new THREE.Color();

  for (let i = 0; i < armCount; i++) {
    const i3 = i * 3;
    const armIndex = Math.floor(rng() * ARM_COUNT);
    const u = Math.pow(rng(), 0.62);
    const r = 2.4 + u * (DISK_RADIUS - 2.4);

    const theta = (armIndex * Math.PI * 2) / ARM_COUNT + Math.log(r + 1.6) * SPIRAL_TIGHTNESS;
    const spread = (0.12 + 0.36 * (r / DISK_RADIUS)) * (0.5 + rng() * 0.85);
    const angle = theta + (rng() - 0.5) * spread;
    const rr = r * (0.92 + rng() * 0.17);

    const gauss = (rng() + rng() + rng() + rng() - 2) * 0.85;
    const thickness = 1.4 + 5.6 * Math.pow(rr / DISK_RADIUS, 1.4);

    arm.positions[i3] = Math.cos(angle) * rr;
    arm.positions[i3 + 1] = Math.sin(angle) * rr;
    arm.positions[i3 + 2] = gauss * thickness;

    const t = Math.min(1, rr / DISK_RADIUS);
    if (t < 0.22) {
      tempColor.copy(colorCore).lerp(colorMid, t / 0.22);
    } else {
      tempColor.copy(colorMid).lerp(colorOuter, (t - 0.22) / 0.78);
    }
    const bright = (0.82 - 0.48 * t) * (0.55 + rng() * 0.85);
    arm.colors[i3] = tempColor.r * bright;
    arm.colors[i3 + 1] = tempColor.g * bright;
    arm.colors[i3 + 2] = tempColor.b * bright;

    arm.sizes[i] = (0.42 - 0.2 * t) * (0.6 + rng() * 1.0);
    arm.phases[i] = rng();
  }

  const armGeometry = new THREE.BufferGeometry();
  armGeometry.setAttribute('position', new THREE.BufferAttribute(arm.positions, 3));
  armGeometry.setAttribute('aColor', new THREE.BufferAttribute(arm.colors, 3));
  armGeometry.setAttribute('aSize', new THREE.BufferAttribute(arm.sizes, 1));
  armGeometry.setAttribute('aPhase', new THREE.BufferAttribute(arm.phases, 1));
  const armPoints = new THREE.Points(armGeometry, starMaterial);
  armPoints.name = 'spiral-arms';
  armPoints.frustumCulled = false;

  // ── 核心球状聚集 ──────────────────────────────────────────────────────
  const bulgeCount = Math.round(24000 * quality);
  const bulge = createPointBuffers(bulgeCount);
  const bulgeColor = new THREE.Color(0xffd9a0);
  for (let i = 0; i < bulgeCount; i++) {
    const i3 = i * 3;
    const radius = 2.2 + Math.pow(rng(), 2.3) * 11.5;
    const cosT = rng() * 2 - 1;
    const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
    const phi = rng() * Math.PI * 2;
    bulge.positions[i3] = Math.cos(phi) * sinT * radius;
    bulge.positions[i3 + 1] = Math.sin(phi) * sinT * radius;
    bulge.positions[i3 + 2] = cosT * radius * 0.62;

    const bright = (0.72 - 0.28 * (radius / 14)) * (0.6 + rng() * 0.8);
    bulge.colors[i3] = bulgeColor.r * bright;
    bulge.colors[i3 + 1] = bulgeColor.g * bright;
    bulge.colors[i3 + 2] = bulgeColor.b * bright;
    bulge.sizes[i] = 0.14 + rng() * 0.3;
    bulge.phases[i] = rng();
  }

  const bulgeGeometry = new THREE.BufferGeometry();
  bulgeGeometry.setAttribute('position', new THREE.BufferAttribute(bulge.positions, 3));
  bulgeGeometry.setAttribute('aColor', new THREE.BufferAttribute(bulge.colors, 3));
  bulgeGeometry.setAttribute('aSize', new THREE.BufferAttribute(bulge.sizes, 1));
  bulgeGeometry.setAttribute('aPhase', new THREE.BufferAttribute(bulge.phases, 1));
  const bulgePoints = new THREE.Points(bulgeGeometry, starMaterial);
  bulgePoints.name = 'core-bulge';
  bulgePoints.frustumCulled = false;

  // ── 球状星晕（包围用户） ──────────────────────────────────────────────
  const haloCount = Math.round(26000 * quality);
  const halo = createPointBuffers(haloCount);
  const haloColor = new THREE.Color(0xa8c4ff);
  for (let i = 0; i < haloCount; i++) {
    const i3 = i * 3;
    const radius = 60 + Math.pow(rng(), 0.55) * 280;
    const cosT = rng() * 2 - 1;
    const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
    const phi = rng() * Math.PI * 2;
    halo.positions[i3] = Math.cos(phi) * sinT * radius;
    halo.positions[i3 + 1] = Math.sin(phi) * sinT * radius * 0.72;
    halo.positions[i3 + 2] = cosT * radius;

    const bright = 0.22 + rng() * 0.38;
    halo.colors[i3] = haloColor.r * bright;
    halo.colors[i3 + 1] = haloColor.g * bright;
    halo.colors[i3 + 2] = haloColor.b * bright;
    halo.sizes[i] = 0.4 + rng() * 0.7;
    halo.phases[i] = rng();
  }

  const haloGeometry = new THREE.BufferGeometry();
  haloGeometry.setAttribute('position', new THREE.BufferAttribute(halo.positions, 3));
  haloGeometry.setAttribute('aColor', new THREE.BufferAttribute(halo.colors, 3));
  haloGeometry.setAttribute('aSize', new THREE.BufferAttribute(halo.sizes, 1));
  haloGeometry.setAttribute('aPhase', new THREE.BufferAttribute(halo.phases, 1));
  const haloPoints = new THREE.Points(haloGeometry, starMaterial);
  haloPoints.name = 'halo';
  haloPoints.frustumCulled = false;

  const galaxy = new THREE.Group();
  galaxy.name = 'galaxy';
  galaxy.position.copy(GALAXY_CENTER);
  galaxy.rotation.set(0.14, 0.2, -0.26);
  galaxy.add(armPoints, bulgePoints);
  root.add(galaxy);
  root.add(haloPoints);

  // ── 核心辉光 ──────────────────────────────────────────────────────────
  const glowMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0xffe3b0) },
      uTime: { value: 0 },
    },
    vertexShader: GLOW_VERT,
    fragmentShader: GLOW_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
  const coreGlow = new THREE.Mesh(new THREE.PlaneGeometry(42, 42), glowMaterial);
  coreGlow.name = 'core-glow';
  coreGlow.renderOrder = 2;
  galaxy.add(coreGlow);

  // ── 星云盘 ────────────────────────────────────────────────────────────
  const nebulaSpecs: {
    pos: [number, number, number];
    size: number;
    a: number;
    b: number;
    seed: number;
    opacity: number;
  }[] = [
    { pos: [-16, 11, 4], size: 44, a: 0x5a2f8f, b: 0x2f6fd0, seed: 0.21, opacity: 0.5 },
    { pos: [19, -13, -3], size: 38, a: 0x7a2350, b: 0x2b4fa8, seed: 0.57, opacity: 0.42 },
    { pos: [8, 24, -8], size: 52, a: 0x1f4f8f, b: 0x6a2f9f, seed: 0.83, opacity: 0.36 },
    { pos: [-24, -18, 6], size: 34, a: 0x8f3a6a, b: 0x2a3f9c, seed: 0.44, opacity: 0.34 },
    { pos: [30, 6, 2], size: 30, a: 0x3a2f9f, b: 0x1f6f8f, seed: 0.69, opacity: 0.3 },
  ];

  const nebulae: { mesh: THREE.Mesh; material: THREE.ShaderMaterial }[] = [];
  for (const spec of nebulaSpecs) {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSeed: { value: spec.seed },
        uColorA: { value: new THREE.Color(spec.a) },
        uColorB: { value: new THREE.Color(spec.b) },
        uOpacity: { value: spec.opacity },
      },
      vertexShader: NEBULA_VERT,
      fragmentShader: NEBULA_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(spec.size, spec.size * 0.78), material);
    mesh.name = 'nebula';
    mesh.position.set(spec.pos[0], spec.pos[1], spec.pos[2]);
    mesh.renderOrder = 1;
    nebulae.push({ mesh, material });
    galaxy.add(mesh);
  }

  // ── 背景星空 ──────────────────────────────────────────────────────────
  const bgCount = Math.round(2800 * quality);
  const bg = createPointBuffers(bgCount);
  for (let i = 0; i < bgCount; i++) {
    const i3 = i * 3;
    const radius = 900 + rng() * 500;
    const cosT = rng() * 2 - 1;
    const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
    const phi = rng() * Math.PI * 2;
    bg.positions[i3] = Math.cos(phi) * sinT * radius;
    bg.positions[i3 + 1] = Math.sin(phi) * sinT * radius;
    bg.positions[i3 + 2] = cosT * radius;

    const warm = rng();
    const bright = 0.5 + Math.pow(rng(), 2.2) * 2.0;
    bg.colors[i3] = (warm > 0.7 ? 1 : 0.78) * bright;
    bg.colors[i3 + 1] = (warm > 0.7 ? 0.88 : 0.85) * bright;
    bg.colors[i3 + 2] = (warm > 0.7 ? 0.74 : 1) * bright;
    bg.sizes[i] = 2.6 + Math.pow(rng(), 2.4) * 8.0;
    bg.phases[i] = rng();
  }

  const bgGeometry = new THREE.BufferGeometry();
  bgGeometry.setAttribute('position', new THREE.BufferAttribute(bg.positions, 3));
  bgGeometry.setAttribute('aColor', new THREE.BufferAttribute(bg.colors, 3));
  bgGeometry.setAttribute('aSize', new THREE.BufferAttribute(bg.sizes, 1));
  bgGeometry.setAttribute('aPhase', new THREE.BufferAttribute(bg.phases, 1));
  const bgPoints = new THREE.Points(bgGeometry, starMaterial);
  bgPoints.name = 'background-stars';
  bgPoints.frustumCulled = false;
  bgPoints.renderOrder = 0;
  root.add(bgPoints);

  // ── 灯光（星空中几乎不参与照明，仅保留少量补光以维持材质一致性） ──
  const lights = ctx.env.createStudioLights();
  lights.traverse((child) => {
    if (child instanceof THREE.Light) {
      child.intensity *= 0.18;
      child.castShadow = false;
    }
  });
  root.add(lights);

  const glowUniforms = glowMaterial.uniforms;

  return {
    root,
    camera,
    immersive: true,
    xrDistance: 3,
    framing: { distance: 6, height: 1.7, targetY: 1.4 },
    update(time: number, _delta: number, context: SceneContext): void {
      starUniforms.uTime.value = time;
      starUniforms.uScale.value = context.height * 0.5 * context.renderer.getPixelRatio();
      glowUniforms.uTime.value = time;

      // 星云与核心辉光始终朝向观察者（XR 中也会跟随头部姿态）
      for (const entry of nebulae) {
        entry.mesh.lookAt(camera.position);
        entry.material.uniforms.uTime.value = time;
      }
      coreGlow.lookAt(camera.position);

      // 星系整体极缓慢自转
      galaxy.rotation.z = -0.26 + time * 0.012;
    },
    dispose(): void {
      disposeObject(root);
    },
  };
}

export const galaxyScene: SceneDefinition = {
  id: 'galaxy',
  title: '星河漩涡',
  subtitle: 'Spiral Galaxy',
  description: '数十万颗恒星沿对数螺线铺开，中心亮核与星云盘在深空中缓缓旋转。',
  tags: ['粒子', '星系', '太空'],
  accent: '#8f6bff',
  gradient: ['#241a4d', '#05060f'],
  category: 'procedural',
  create(ctx: SceneContext): SceneInstance {
    return createGalaxy(ctx);
  },
};

export default galaxyScene;
