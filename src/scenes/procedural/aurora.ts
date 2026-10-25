import * as THREE from 'three';
import type { SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { disposeObject } from '../../core/loader.js';
import { GLSL_HASH, GLSL_NOISE, GLSL_OUTPUT } from './lib/noise.js';
import { fbm1, mulberry32 } from './lib/math.js';

/**
 * 极光夜空
 * 多层圆柱幕帘用域扭曲的 fbm 生成垂直光束，水面按反射射线求交幕帘近似镜像，
 * 远处是雪山剪影与完整星空。
 */

const CURTAIN_RADIUS = 118;

/** 幕帘形状与配色，供幕帘本体与水面反射共用。 */
const GLSL_AURORA = /* glsl */ `
uniform float uTime;
uniform float uSeed;
uniform float uBase;
uniform float uTop;
uniform vec3 uColorLow;
uniform vec3 uColorMid;
uniform vec3 uColorHigh;

float auroraRays(float theta, float y, out float mask) {
  vec2 dir = vec2(cos(theta), sin(theta));

  float n = fbm2oct(dir * 2.1 + vec2(uTime * 0.022, uTime * 0.04) + uSeed * 13.0, 3);
  float base = uBase + n * 30.0;
  float top = uTop + n * 46.0;

  mask = smoothstep(base, base + 16.0, y) * (1.0 - smoothstep(top - 52.0, top, y));

  float rays = fbm2oct(dir * 11.0 + vec2(uTime * 0.05, -uTime * 0.02) + uSeed * 7.0, 3);
  rays = smoothstep(0.3, 0.82, rays);

  float fine = fbm2oct(dir * 34.0 + vec2(uTime * 0.09, 0.0) + uSeed * 3.0, 2);
  rays *= 0.55 + 0.75 * fine;

  return mask * rays;
}

vec3 auroraColor(float y) {
  float k = clamp((y - uBase) / max(uTop - uBase, 1.0), 0.0, 1.0);
  vec3 c = mix(uColorLow, uColorMid, smoothstep(0.12, 0.5, k));
  c = mix(c, uColorHigh, smoothstep(0.52, 0.95, k));
  return c;
}
`;

const CURTAIN_VERT = /* glsl */ `
varying vec3 vLocal;

void main() {
  vLocal = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const CURTAIN_FRAG = /* glsl */ `
precision highp float;

uniform float uCenterY;
uniform float uOpacity;

varying vec3 vLocal;

${GLSL_HASH}
${GLSL_NOISE}
${GLSL_AURORA}

void main() {
  float theta = atan(vLocal.z, vLocal.x);
  float y = vLocal.y + uCenterY;

  float mask;
  float rays = auroraRays(theta, y, mask);
  if (rays <= 0.002) discard;

  vec3 col = auroraColor(y) * rays * uOpacity;
  gl_FragColor = vec4(col, 1.0);
  ${GLSL_OUTPUT}
}
`;

const WATER_VERT = /* glsl */ `
varying vec3 vWorldPos;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const WATER_FRAG = /* glsl */ `
precision highp float;

uniform float uCurtainRadius;
uniform float uStretch;
uniform vec3 uWaterDeep;
uniform vec3 uWaterShallow;
uniform float uReflect;

varying vec3 vWorldPos;

${GLSL_HASH}
${GLSL_NOISE}
${GLSL_AURORA}

vec2 cylHit(vec3 ro, vec3 rd, float radius) {
  float a = dot(rd.xz, rd.xz);
  float b = dot(ro.xz, rd.xz);
  float c = dot(ro.xz, ro.xz) - radius * radius;
  float disc = b * b - a * c;
  if (disc < 0.0) return vec2(-1.0, -1.0);
  float s = sqrt(disc);
  return vec2((-b - s) / a, (-b + s) / a);
}

void main() {
  vec3 V = normalize(cameraPosition - vWorldPos);

  // 细碎涟漪的法线扰动
  vec2 q = vWorldPos.xz * 0.42 + vec2(uTime * 0.03, uTime * 0.017);
  float e = 0.5;
  float n0 = fbm2oct(q, 3);
  float nx = fbm2oct(q + vec2(e, 0.0), 3);
  float nz = fbm2oct(q + vec2(0.0, e), 3);
  vec3 N = normalize(vec3((n0 - nx) * 5.5, 1.0, (n0 - nz) * 5.5));

  vec3 R = reflect(-V, N);
  vec3 col = mix(uWaterDeep, uWaterShallow, smoothstep(0.0, 260.0, length(vWorldPos.xz)) * 0.35);

  // 反射幕帘：观察者位于圆柱内部，取射线的正根
  vec2 hit = cylHit(cameraPosition, R, uCurtainRadius);
  float tHit = hit.y > 0.0 ? hit.y : hit.x;
  if (tHit > 0.0) {
    vec3 p = cameraPosition + R * tHit;
    // 反射光带在竖直方向被拉伸，模拟粗糙水面的散射
    float hy = p.y * uStretch;
    float mask;
    float rays = auroraRays(atan(p.z, p.x), hy, mask);
    col += auroraColor(hy) * rays * uReflect;
  }

  // 菲涅尔与水面的镜面高光
  float fres = 0.03 + 0.97 * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.0);
  col = mix(col, col * 1.5 + vec3(0.02, 0.04, 0.08), fres);

  float dist = length(vWorldPos - cameraPosition);
  col = mix(col, vec3(0.012, 0.02, 0.045), 1.0 - exp(-dist * 0.0035));

  gl_FragColor = vec4(col, 1.0);
  ${GLSL_OUTPUT}
}
`;

const SKY_VERT = /* glsl */ `
varying vec3 vWorldPos;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SKY_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uZenith;
uniform vec3 uHorizon;

varying vec3 vWorldPos;

${GLSL_HASH}
${GLSL_NOISE}

void main() {
  vec3 dir = normalize(vWorldPos - cameraPosition);
  float h = dir.y;
  vec3 col = mix(uHorizon, uZenith, smoothstep(-0.02, 0.75, h));

  // 极淡的银河带
  float band = exp(-pow((dir.y - 0.28 + dir.x * 0.22) * 5.5, 2.0));
  float mottle = fbm2oct(vec2(atan(dir.z, dir.x) * 3.0, h * 5.0), 3);
  col += vec3(0.05, 0.055, 0.09) * band * (0.35 + mottle);

  gl_FragColor = vec4(col, 1.0);
  ${GLSL_OUTPUT}
}
`;

const MOUNTAIN_VERT = /* glsl */ `
attribute float aHeight;

varying float vH;
varying vec3 vWorldPos;

void main() {
  vH = aHeight;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const MOUNTAIN_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uBase;
uniform vec3 uPeak;
uniform vec3 uRim;

varying float vH;
varying vec3 vWorldPos;

${GLSL_HASH}
${GLSL_NOISE}

void main() {
  float k = clamp(vH, 0.0, 1.0);
  float grain = fbm2oct(vWorldPos.xz * 0.06, 3);
  vec3 col = mix(uBase, uPeak, pow(k, 1.6));
  col *= 0.82 + 0.36 * grain;
  // 顶缘被极光染上的冷光
  col += uRim * pow(k, 5.0) * 0.6;
  gl_FragColor = vec4(col, 1.0);
  ${GLSL_OUTPUT}
}
`;

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
  gl_PointSize = aSize * uScale / max(1.0, -mv.z);
  vColor = aColor;
  vTwinkle = 0.7 + 0.3 * sin(uTime * 1.7 + aPhase * 6.2831);
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
  float a = exp(-d2 * 12.0);
  gl_FragColor = vec4(vColor * a * vTwinkle, 1.0);
  ${GLSL_OUTPUT}
}
`;

/** 生成一圈锯齿状的山脊剪影。 */
function createMountainRing(
  radius: number,
  segments: number,
  baseHeight: number,
  peakHeight: number,
  seed: number,
): THREE.BufferGeometry {
  const columnCount = segments + 1;
  const rows = 3;
  const positions = new Float32Array(columnCount * rows * 3);
  const heights = new Float32Array(columnCount * rows);
  const indices: number[] = [];

  for (let i = 0; i < columnCount; i++) {
    const t = (i / segments) * Math.PI * 2;
    const ridge = fbm1(i * 0.085 + seed, 5);
    const spike = fbm1(i * 0.42 + seed * 3.1, 3);
    const peak = baseHeight + (peakHeight - baseHeight) * (ridge * 0.75 + spike * 0.35);

    const cos = Math.cos(t);
    const sin = Math.sin(t);
    const rowY = [-40, peak * 0.5, peak];

    for (let r = 0; r < rows; r++) {
      const index = i * rows + r;
      positions[index * 3] = cos * radius;
      positions[index * 3 + 1] = rowY[r];
      positions[index * 3 + 2] = sin * radius;
      heights[index] = r === 0 ? 0 : r === 1 ? 0.5 : 1;
    }
  }

  for (let i = 0; i < segments; i++) {
    for (let r = 0; r < rows - 1; r++) {
      const a = i * rows + r;
      const b = (i + 1) * rows + r;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aHeight', new THREE.BufferAttribute(heights, 1));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function createAurora(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'aurora-scene';

  const camera = new THREE.PerspectiveCamera(62, 1, 0.05, 3200);
  camera.position.set(0, 1.6, 5.2);
  camera.lookAt(0, 2.0, 0);

  const quality = THREE.MathUtils.clamp(ctx.quality, 0.4, 2);
  const rng = mulberry32(31337);

  // ── 夜空 ──────────────────────────────────────────────────────────────
  const skyMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uZenith: { value: new THREE.Color(0x03050e) },
      uHorizon: { value: new THREE.Color(0x0a1830) },
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(2400, 40, 24), skyMaterial);
  sky.name = 'sky';
  sky.renderOrder = -1000;
  sky.frustumCulled = false;
  root.add(sky);

  // ── 星空 ──────────────────────────────────────────────────────────────
  const starCount = Math.round(2400 * quality);
  const starPositions = new Float32Array(starCount * 3);
  const starColors = new Float32Array(starCount * 3);
  const starSizes = new Float32Array(starCount);
  const starPhases = new Float32Array(starCount);
  for (let i = 0; i < starCount; i++) {
    const i3 = i * 3;
    const radius = 1700 + rng() * 400;
    const cosT = rng() * 2 - 1;
    const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
    const phi = rng() * Math.PI * 2;
    starPositions[i3] = Math.cos(phi) * sinT * radius;
    starPositions[i3 + 1] = Math.sin(phi) * sinT * radius;
    starPositions[i3 + 2] = cosT * radius;

    const warm = rng();
    const bright = 0.5 + Math.pow(rng(), 2.4) * 2.1;
    starColors[i3] = (warm > 0.75 ? 1 : 0.8) * bright;
    starColors[i3 + 1] = (warm > 0.75 ? 0.85 : 0.88) * bright;
    starColors[i3 + 2] = (warm > 0.75 ? 0.72 : 1) * bright;
    starSizes[i] = 0.9 + Math.pow(rng(), 2.6) * 4.2;
    starPhases[i] = rng();
  }

  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
  starGeometry.setAttribute('aColor', new THREE.BufferAttribute(starColors, 3));
  starGeometry.setAttribute('aSize', new THREE.BufferAttribute(starSizes, 1));
  starGeometry.setAttribute('aPhase', new THREE.BufferAttribute(starPhases, 1));

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
  const stars = new THREE.Points(starGeometry, starMaterial);
  stars.name = 'stars';
  stars.frustumCulled = false;
  stars.renderOrder = 0;
  root.add(stars);

  // ── 极光幕帘 ──────────────────────────────────────────────────────────
  const curtainSpecs = [
    { radius: 92, height: 210, centerY: 42, base: 12, top: 92, seed: 0.13, opacity: 0.42, low: 0x1fff9a, mid: 0x35e0ff, high: 0xa25bff },
    { radius: CURTAIN_RADIUS, height: 280, centerY: 58, base: 18, top: 124, seed: 0.47, opacity: 0.3, low: 0x18e6c8, mid: 0x4f7bff, high: 0xd34bd8 },
    { radius: 168, height: 330, centerY: 78, base: 24, top: 156, seed: 0.79, opacity: 0.2, low: 0x25f0b0, mid: 0x6f6bff, high: 0xff5fa8 },
  ];

  const curtainMaterials: THREE.ShaderMaterial[] = [];
  for (const spec of curtainSpecs) {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSeed: { value: spec.seed },
        uBase: { value: spec.base },
        uTop: { value: spec.top },
        uCenterY: { value: spec.centerY },
        uOpacity: { value: spec.opacity },
        uColorLow: { value: new THREE.Color(spec.low) },
        uColorMid: { value: new THREE.Color(spec.mid) },
        uColorHigh: { value: new THREE.Color(spec.high) },
      },
      vertexShader: CURTAIN_VERT,
      fragmentShader: CURTAIN_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    curtainMaterials.push(material);

    const geometry = new THREE.CylinderGeometry(
      spec.radius,
      spec.radius,
      spec.height,
      72,
      1,
      true,
    );
    const curtain = new THREE.Mesh(geometry, material);
    curtain.name = 'aurora-curtain';
    curtain.position.y = spec.centerY;
    curtain.renderOrder = 2;
    root.add(curtain);
  }

  // ── 静水（反射极光） ──────────────────────────────────────────────────
  const waterUniforms = {
    uTime: { value: 0 },
    uSeed: { value: curtainSpecs[1].seed },
    uBase: { value: curtainSpecs[1].base },
    uTop: { value: curtainSpecs[1].top },
    uCurtainRadius: { value: curtainSpecs[1].radius },
    uStretch: { value: 3.6 },
    uReflect: { value: 0.95 },
    uWaterDeep: { value: new THREE.Color(0x030a16) },
    uWaterShallow: { value: new THREE.Color(0x0b2038) },
    uColorLow: { value: new THREE.Color(curtainSpecs[1].low) },
    uColorMid: { value: new THREE.Color(curtainSpecs[1].mid) },
    uColorHigh: { value: new THREE.Color(curtainSpecs[1].high) },
  };

  const waterMaterial = new THREE.ShaderMaterial({
    uniforms: waterUniforms,
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    depthWrite: true,
  });
  const water = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000, 1, 1), waterMaterial);
  water.name = 'aurora-water';
  water.rotation.x = -Math.PI / 2;
  water.renderOrder = 1;
  root.add(water);

  // ── 雪山剪影 ──────────────────────────────────────────────────────────
  const farMountain = new THREE.Mesh(
    createMountainRing(430, 240, 18, 86, 3.4),
    new THREE.ShaderMaterial({
      uniforms: {
        uBase: { value: new THREE.Color(0x070c18) },
        uPeak: { value: new THREE.Color(0x2a3a58) },
        uRim: { value: new THREE.Color(0x1d4a55) },
      },
      vertexShader: MOUNTAIN_VERT,
      fragmentShader: MOUNTAIN_FRAG,
      side: THREE.DoubleSide,
    }),
  );
  farMountain.name = 'far-mountains';
  root.add(farMountain);

  const nearMountain = new THREE.Mesh(
    createMountainRing(215, 200, 10, 44, 9.7),
    new THREE.ShaderMaterial({
      uniforms: {
        uBase: { value: new THREE.Color(0x02040a) },
        uPeak: { value: new THREE.Color(0x141f33) },
        uRim: { value: new THREE.Color(0x1d5a63) },
      },
      vertexShader: MOUNTAIN_VERT,
      fragmentShader: MOUNTAIN_FRAG,
      side: THREE.DoubleSide,
    }),
  );
  nearMountain.name = 'near-mountains';
  root.add(nearMountain);

  // ── 灯光 ──────────────────────────────────────────────────────────────
  const lights = ctx.env.createStudioLights();
  lights.traverse((child) => {
    if (child instanceof THREE.Light) {
      child.intensity *= 0.1;
      child.castShadow = false;
    }
  });
  root.add(lights);

  return {
    root,
    camera,
    immersive: true,
    xrDistance: 3,
    framing: { distance: 5.2, height: 1.6, targetY: 2 },
    update(time: number, _delta: number, context: SceneContext): void {
      starUniforms.uTime.value = time;
      starUniforms.uScale.value = context.height * 0.5 * context.renderer.getPixelRatio();
      waterUniforms.uTime.value = time;
      for (const material of curtainMaterials) {
        material.uniforms.uTime.value = time;
      }
    },
    dispose(): void {
      disposeObject(root);
    },
  };
}

export const auroraScene: SceneDefinition = {
  id: 'aurora',
  title: '极光夜空',
  subtitle: 'Aurora Borealis',
  description: '青绿到紫红的极光幕帘在夜空中飘动，静水面把光影倒映成第二道极光。',
  tags: ['极光', '夜空', '反射'],
  accent: '#54ffc4',
  gradient: ['#0b3a44', '#04070f'],
  category: 'procedural',
  create(ctx: SceneContext): SceneInstance {
    return createAurora(ctx);
  },
};

export default auroraScene;
