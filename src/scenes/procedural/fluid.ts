import * as THREE from 'three';
import type { SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { disposeObject } from '../../core/loader.js';
import { GLSL_HASH, GLSL_NOISE, GLSL_CURL, GLSL_OUTPUT } from './lib/noise.js';
import { fbm3D, mulberry32 } from './lib/math.js';

/**
 * 流光水面
 * 自定义材质 + onBeforeCompile 注入：卷曲噪声驱动的大涌浪在顶点位移与片元法线上流动，
 * 菲涅尔混合天空反射，程序化海床深度场决定水色层次，波峰与礁石边缘生成泡沫。
 */

const SUN_DIR = new THREE.Vector3(-0.42, 0.26, -0.87).normalize();
const ROCK_COUNT = 6;

const GLSL_SKY = /* glsl */ `
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSunDir;
uniform vec3 uSunColor;

vec3 skyColor(vec3 dir) {
  float h = dir.y;
  vec3 col = mix(uSkyHorizon, uSkyZenith, smoothstep(-0.02, 0.3, h));
  float sun = max(dot(dir, uSunDir), 0.0);
  col += uSunColor * pow(sun, 26.0) * 0.55;
  col += uSunColor * pow(sun, 2400.0) * 9.0;
  col = mix(col, uSkyHorizon, exp(-abs(h) * 16.0) * 0.5);
  return col;
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

${GLSL_SKY}

varying vec3 vWorldPos;

void main() {
  vec3 dir = normalize(vWorldPos - cameraPosition);
  gl_FragColor = vec4(skyColor(dir), 1.0);
  ${GLSL_OUTPUT}
}
`;

const WATER_VERT_PARS = /* glsl */ `
uniform float uTime;
uniform float uAmp;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying float vCrest;
varying vec2 vFlow;

${GLSL_HASH}
${GLSL_NOISE}
${GLSL_CURL}

float waveHeight(vec2 p, vec2 flow, float t) {
  vec2 q = p + flow * 3.4;
  float h = 0.0;
  h += sin(dot(q, vec2(0.93, 0.36)) * 0.105 + t * 0.82) * 0.58;
  h += sin(dot(q, vec2(-0.42, 0.91)) * 0.205 - t * 1.12) * 0.31;
  h += sin(dot(q, vec2(0.71, -0.70)) * 0.46 + t * 1.78) * 0.13;
  h += fbm3oct(vec3(q * 0.032, t * 0.1), 3) * 1.45;
  return h;
}
`;

const WATER_FRAG_PARS = /* glsl */ `
uniform float uTime;
uniform vec3 uDeepColor;
uniform vec3 uShallowColor;
uniform vec3 uFoamColor;
uniform vec3 uRocks[${ROCK_COUNT}];

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying float vCrest;
varying vec2 vFlow;

${GLSL_HASH}
${GLSL_NOISE}
${GLSL_CURL}
${GLSL_SKY}
`;

const WATER_VERT_NORMAL = /* glsl */ `
vec3 objectNormal = vec3( normal );
#ifdef USE_TANGENT
  vec3 objectTangent = vec3( tangent.xyz );
#endif

vec2 flow = curl2(position.xz * 0.045, uTime * 0.06);
vFlow = flow;
float ampFade = 1.0 - smoothstep(58.0, 98.0, length(position.xz));

float waveH = waveHeight(position.xz, flow, uTime) * uAmp * ampFade;
float waveHx = waveHeight(position.xz + vec2(0.7, 0.0), flow, uTime) * uAmp * ampFade;
float waveHz = waveHeight(position.xz + vec2(0.0, 0.7), flow, uTime) * uAmp * ampFade;

vec3 waveNormal = normalize(vec3(waveH - waveHx, 0.72, waveH - waveHz));
objectNormal = waveNormal;
vWorldNormal = waveNormal;
`;

const WATER_VERT_POSITION = /* glsl */ `
vec3 transformed = vec3( position );
transformed.y += waveH;
vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vCrest = waveH / max(uAmp, 0.001);
`;

const WATER_FRAG_NORMAL = /* glsl */ `
// 流场在顶点着色器里算好并插值过来，省掉逐像素的 curl 噪声
vec2 q = vWorldPos.xz * 1.15 + vFlow * 9.0 + vec2(uTime * 0.045, uTime * 0.028);

float n0 = fbm2oct(q, 2);
float nx = fbm2oct(q + vec2(0.4, 0.0), 2);
float nz = fbm2oct(q + vec2(0.0, 0.4), 2);
vec3 detail = vec3((n0 - nx) * 3.4, 1.0, (n0 - nz) * 3.4);

// 远处的细节法线随距离衰减，避免地平线出现高频闪烁
float camDist = length(vWorldPos - cameraPosition);
float detailFade = 1.0 - smoothstep(45.0, 220.0, camDist);

vec3 waterNormal = normalize(vWorldNormal + vec3(detail.x, 0.0, detail.z) * 0.75 * detailFade);
normal = normalize(mat3(viewMatrix) * waterNormal);
`;

const WATER_FRAG_ROUGH = /* glsl */ `
float roughnessFactor = roughness;
roughnessFactor = mix(roughnessFactor, 0.55, smoothstep(0.2, 1.0, vCrest));
`;

const WATER_FRAG_OPAQUE = /* glsl */ `
vec3 V = normalize(cameraPosition - vWorldPos);
vec3 N = normalize(waterNormal);
float ndv = clamp(dot(N, V), 0.0, 1.0);
float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);

// 程序化海床：深浅不同的水色层次
float bed = fbm2oct(vWorldPos.xz * 0.0125 + vec2(11.3, 4.7), 3);
float depth = smoothstep(0.28, 0.78, bed);
vec3 body = mix(uShallowColor, uDeepColor, depth);

vec3 sky = skyColor(reflect(-V, N));
vec3 lit = outgoingLight;

vec3 col = mix(body * 0.55, sky, clamp(fres * 1.05, 0.0, 1.0));
col += lit * 0.32 * (1.0 - fres * 0.7);

// 太阳高光
vec3 H = normalize(uSunDir + V);
float spec = pow(clamp(dot(N, H), 0.0, 1.0), 320.0) * 3.4;
col += uSunColor * spec;

// 泡沫：波峰 + 礁石边缘
float foamNoise = fbm2oct(vWorldPos.xz * 2.6 + vec2(uTime * 0.12, -uTime * 0.09), 3);
float crestFoam = smoothstep(0.62, 1.0, vCrest) * smoothstep(0.34, 0.72, foamNoise);
float rockFoam = 0.0;
for (int i = 0; i < ${ROCK_COUNT}; i++) {
  float d = distance(vWorldPos.xz, uRocks[i].xz);
  rockFoam = max(rockFoam, (1.0 - smoothstep(1.2, 3.4, d)) * smoothstep(0.3, 0.7, foamNoise));
}
float foam = clamp(crestFoam * 0.8 + rockFoam * 0.9, 0.0, 1.0);
col = mix(col, uFoamColor, foam * 0.72);

gl_FragColor = vec4(col, diffuseColor.a);
`;

function createRock(radius: number, seed: number): THREE.Mesh {
  const geometry = new THREE.IcosahedronGeometry(radius, 3);
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const rng = mulberry32(seed);
  const offset = rng() * 100;

  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const n = fbm3D(x * 0.9 + offset, y * 0.9, z * 0.9, 4);
    const k = 0.72 + n * 0.62;
    position.setXYZ(i, x * k, y * k * 0.78, z * k);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    color: 0x1d2128,
    roughness: 0.94,
    metalness: 0.04,
    flatShading: true,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function createFluid(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'fluid-scene';

  const camera = new THREE.PerspectiveCamera(56, 1, 0.05, 5000);
  camera.position.set(0, 1.75, 5.4);
  camera.lookAt(0, 0.9, 0);

  const quality = THREE.MathUtils.clamp(ctx.quality, 0.4, 2);

  // ── 天空 ──────────────────────────────────────────────────────────────
  const skyUniforms = {
    uSkyZenith: { value: new THREE.Color(0x2f6fb8) },
    uSkyHorizon: { value: new THREE.Color(0xf0a864) },
    uSunDir: { value: SUN_DIR.clone() },
    uSunColor: { value: new THREE.Color(0xffd9a0) },
  };
  const skyMaterial = new THREE.ShaderMaterial({
    uniforms: skyUniforms,
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(2600, 40, 24), skyMaterial);
  sky.name = 'sky';
  sky.renderOrder = -1000;
  sky.frustumCulled = false;
  root.add(sky);

  // ── 水面材质 ──────────────────────────────────────────────────────────
  const uniforms = {
    uTime: { value: 0 },
    uAmp: { value: 0.42 },
    uDeepColor: { value: new THREE.Color(0x04101f) },
    uShallowColor: { value: new THREE.Color(0x0e5a6b) },
    uFoamColor: { value: new THREE.Color(0xdfeef5) },
    uSkyZenith: skyUniforms.uSkyZenith,
    uSkyHorizon: skyUniforms.uSkyHorizon,
    uSunDir: skyUniforms.uSunDir,
    uSunColor: skyUniforms.uSunColor,
    uRocks: { value: Array.from({ length: ROCK_COUNT }, () => new THREE.Vector3()) },
  };

  const waterMaterial = new THREE.MeshStandardMaterial({
    color: 0x0b2733,
    roughness: 0.08,
    metalness: 0,
    envMapIntensity: 0.35,
  });
  // 显式挂 envMap，否则 scene.environment 会以满强度参与 IBL
  waterMaterial.envMap = ctx.env.envMap;

  waterMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uAmp = uniforms.uAmp;
    shader.uniforms.uDeepColor = uniforms.uDeepColor;
    shader.uniforms.uShallowColor = uniforms.uShallowColor;
    shader.uniforms.uFoamColor = uniforms.uFoamColor;
    shader.uniforms.uSkyZenith = uniforms.uSkyZenith;
    shader.uniforms.uSkyHorizon = uniforms.uSkyHorizon;
    shader.uniforms.uSunDir = uniforms.uSunDir;
    shader.uniforms.uSunColor = uniforms.uSunColor;
    shader.uniforms.uRocks = uniforms.uRocks;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${WATER_VERT_PARS}`)
      .replace('#include <beginnormal_vertex>', WATER_VERT_NORMAL)
      .replace('#include <begin_vertex>', WATER_VERT_POSITION);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${WATER_FRAG_PARS}`)
      .replace('#include <normal_fragment_maps>', WATER_FRAG_NORMAL)
      .replace('#include <roughnessmap_fragment>', WATER_FRAG_ROUGH)
      .replace('#include <opaque_fragment>', WATER_FRAG_OPAQUE);
  };
  waterMaterial.customProgramCacheKey = () => 'lumen-fluid-water-v1';

  const segments = Math.round(THREE.MathUtils.clamp(200 * quality, 80, 280));
  const nearGeometry = new THREE.PlaneGeometry(220, 220, segments, segments);
  nearGeometry.rotateX(-Math.PI / 2);
  const water = new THREE.Mesh(nearGeometry, waterMaterial);
  water.name = 'water';
  water.receiveShadow = true;
  root.add(water);

  const farGeometry = new THREE.PlaneGeometry(3000, 3000, 1, 1);
  farGeometry.rotateX(-Math.PI / 2);
  const farWater = new THREE.Mesh(farGeometry, waterMaterial);
  farWater.name = 'far-water';
  farWater.position.y = -0.05;
  root.add(farWater);

  // ── 浮石 ──────────────────────────────────────────────────────────────
  const rockSpecs: { pos: [number, number, number]; radius: number; seed: number }[] = [
    { pos: [-7.5, 0.1, -9.5], radius: 1.5, seed: 11 },
    { pos: [9.2, -0.2, -14.5], radius: 2.3, seed: 27 },
    { pos: [-14.5, -0.35, -21.0], radius: 1.15, seed: 43 },
    { pos: [16.5, 0.05, -26.0], radius: 1.8, seed: 61 },
    { pos: [-3.0, -0.15, -33.0], radius: 2.9, seed: 79 },
    { pos: [24.0, -0.45, -38.0], radius: 1.35, seed: 97 },
  ];

  for (let i = 0; i < rockSpecs.length; i++) {
    const spec = rockSpecs[i];
    const rock = createRock(spec.radius, spec.seed);
    rock.position.set(spec.pos[0], spec.pos[1], spec.pos[2]);
    rock.rotation.set(Math.random() * 0.5, Math.random() * Math.PI, Math.random() * 0.4);
    rock.scale.set(1, 0.82 + Math.random() * 0.5, 1);
    root.add(rock);
    uniforms.uRocks.value[i].set(spec.pos[0], spec.pos[1], spec.pos[2]);
  }

  // ── 灯光 ──────────────────────────────────────────────────────────────
  const lights = ctx.env.createStudioLights();
  lights.traverse((child) => {
    if (child instanceof THREE.Light) {
      child.intensity *= 0.55;
    }
  });
  root.add(lights);

  const sun = new THREE.DirectionalLight(0xffd2a0, 2.4);
  sun.position.copy(SUN_DIR).multiplyScalar(60);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 140;
  sun.shadow.camera.left = -40;
  sun.shadow.camera.right = 40;
  sun.shadow.camera.top = 40;
  sun.shadow.camera.bottom = -40;
  sun.shadow.bias = -0.0008;
  sun.shadow.normalBias = 0.05;
  root.add(sun);
  root.add(sun.target);

  const fill = new THREE.HemisphereLight(0x8fb6ff, 0x14202c, 0.5);
  root.add(fill);

  return {
    root,
    camera,
    immersive: true,
    xrDistance: 3,
    framing: { distance: 5.4, height: 1.75, targetY: 0.9 },
    update(time: number, _delta: number, _context: SceneContext): void {
      uniforms.uTime.value = time;
    },
    dispose(): void {
      disposeObject(root);
    },
  };
}

export const fluidScene: SceneDefinition = {
  id: 'fluid',
  title: '流光水面',
  subtitle: 'Liquid Surface',
  description: '卷曲噪声推动的涌浪在海面上流动，菲涅尔反射天空，浪尖泛起白沫。',
  tags: ['流体', '水面', '反射'],
  accent: '#4fd0d8',
  gradient: ['#0d3a52', '#06121e'],
  category: 'procedural',
  create(ctx: SceneContext): SceneInstance {
    return createFluid(ctx);
  },
};

export default fluidScene;
