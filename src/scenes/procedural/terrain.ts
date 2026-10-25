import * as THREE from 'three';
import type { SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { disposeObject } from '../../core/loader.js';
import { GLSL_HASH, GLSL_NOISE, GLSL_OUTPUT } from './lib/noise.js';
import { fbm3D, smoothstep, valueNoise3 } from './lib/math.js';

/**
 * 云海群山
 * CPU 生成的分形地形（脊状噪声 + fbm 高度场，法线由几何体计算），
 * 山顶之上叠加多层体积云海平面，暖橙地平线与冷蓝高空形成日出色调。
 */

const TERRAIN_SIZE = 2600;
const SUN_DIR = new THREE.Vector3(-0.58, 0.2, -0.79).normalize();
const CLOUD_LAYERS = [
  { y: -58, scale: 0.0125, speed: 0.9, seed: 0.21, opacity: 1 },
  { y: -44, scale: 0.0105, speed: 1.5, seed: 0.57, opacity: 0.95 },
  { y: -32, scale: 0.0088, speed: 2.3, seed: 0.83, opacity: 0.88 },
  { y: -21, scale: 0.0072, speed: 3.4, seed: 0.41, opacity: 0.74 },
  { y: -12, scale: 0.0058, speed: 4.8, seed: 0.69, opacity: 0.52 },
];

function ridgedHeight(x: number, z: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let freq = 0.0021;
  for (let o = 0; o < octaves; o++) {
    const n = valueNoise3(x * freq + 11.3, z * freq + 7.7, o * 3.17) * 2 - 1;
    const ridge = 1 - Math.abs(n);
    sum += ridge * ridge * amp;
    norm += amp;
    amp *= 0.52;
    freq *= 2.07;
  }
  return sum / norm;
}

/** 山体高度场：脊状主峰 + 缓慢起伏，原点附近压低成云谷。 */
function terrainHeight(x: number, z: number): number {
  let h = ridgedHeight(x, z, 5) * 360;
  h += (fbm3D(x * 0.00085, 3.1, z * 0.00085, 3) - 0.45) * 140;
  const d = Math.hypot(x, z);
  // 脚下留出深谷，山峰从更远处升起
  h = h * smoothstep(330, 950, d) - 78;
  return h;
}

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
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uGround;

varying vec3 vWorldPos;

${GLSL_HASH}
${GLSL_NOISE}

void main() {
  vec3 dir = normalize(vWorldPos - cameraPosition);
  float h = dir.y;

  vec3 col = mix(uHorizon, uZenith, smoothstep(-0.05, 0.24, h));

  float sun = max(dot(dir, uSunDir), 0.0);
  col += uSunColor * pow(sun, 22.0) * 0.45;
  col += uSunColor * pow(sun, 2600.0) * 8.0;

  // 地平线附近的暖色带
  col = mix(col, uHorizon * 1.25, exp(-abs(h) * 16.0) * 0.65);

  // 地平线以下渐暗
  col = mix(col, uGround, smoothstep(0.0, -0.25, h));

  gl_FragColor = vec4(col, 1.0);
  ${GLSL_OUTPUT}
}
`;

const TERRAIN_FRAG_PARS = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uRimColor;
uniform vec3 uFogWarm;
uniform vec3 uFogCool;
uniform float uFogDensity;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying float vAo;
`;

const TERRAIN_FRAG_NORMAL = /* glsl */ `
vec3 terrainN = normalize(vWorldNormal);
normal = normalize(mat3(viewMatrix) * terrainN);

float th = vWorldPos.y;
float tslope = 1.0 - clamp(terrainN.y, 0.0, 1.0);

vec3 rock = vec3(0.085, 0.078, 0.086);
vec3 earth = vec3(0.17, 0.125, 0.082);
vec3 grass = vec3(0.1, 0.125, 0.08);
vec3 snow = vec3(0.72, 0.78, 0.9);

vec3 albedo = mix(rock, earth, smoothstep(-70.0, 40.0, th));
albedo = mix(albedo, grass, smoothstep(20.0, 110.0, th) * (1.0 - smoothstep(0.28, 0.6, tslope)));
float snowMask = smoothstep(215.0, 320.0, th) * (1.0 - smoothstep(0.24, 0.55, tslope));
albedo = mix(albedo, snow, snowMask);

diffuseColor.rgb = albedo;
`;

const TERRAIN_FRAG_OPAQUE = /* glsl */ `
vec3 sunCol = uSunColor;
float ndl = clamp(dot(terrainN, uSunDir), 0.0, 1.0);
float sky = clamp(terrainN.y, 0.0, 1.0);

// 直接控制光照，避免 IBL 把远山洗白
vec3 lit = albedo * (uAmbient * (0.3 + 0.7 * sky) + sunCol * ndl * 1.9);
lit += sunCol * pow(ndl, 3.0) * 0.06;

// 雪面镜面高光
vec3 V = normalize(cameraPosition - vWorldPos);
vec3 H = normalize(uSunDir + V);
lit += sunCol * pow(clamp(dot(terrainN, H), 0.0, 1.0), 56.0) * snowMask * 0.45;

// 背光的山脊边缘（冷色轮廓）
lit += uRimColor * pow(1.0 - ndl, 4.0) * 0.05;

// 谷底自遮蔽
lit *= 0.42 + 0.58 * vAo;

vec3 viewDir = normalize(vWorldPos - cameraPosition);
float dist = length(vWorldPos - cameraPosition);
vec3 fogCol = mix(uFogCool, uFogWarm, smoothstep(0.05, 0.9, dot(viewDir, uSunDir)));
float fogAmount = 1.0 - exp(-dist * uFogDensity);
lit = mix(lit, fogCol, clamp(fogAmount, 0.0, 1.0));

gl_FragColor = vec4(lit, diffuseColor.a);
`;

const CLOUD_VERT = /* glsl */ `
varying vec3 vWorldPos;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const CLOUD_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uSeed;
uniform float uScale;
uniform float uSpeed;
uniform float uOpacity;
uniform vec3 uLitColor;
uniform vec3 uShadowColor;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uFogWarm;
uniform vec3 uFogCool;

varying vec3 vWorldPos;

${GLSL_HASH}
${GLSL_NOISE}

void main() {
  vec2 p = vWorldPos.xz * uScale + vec2(uTime * uSpeed * 0.012, uTime * uSpeed * 0.008) + uSeed * 21.0;
  float n = fbm2oct(p, 5);

  // 高频细节随距离淡出，避免远处闪烁
  float camDist = length(vWorldPos - cameraPosition);
  float detailFade = 1.0 - smoothstep(90.0, 460.0, camDist);
  float detail = fbm2oct(p * 7.0 + 4.0, 3) * detailFade;

  float alpha = smoothstep(0.3, 0.58, n + detail * 0.3);
  alpha *= 1.0 - smoothstep(700.0, 1150.0, length(vWorldPos.xz));
  if (alpha <= 0.004) discard;

  // 用密度梯度模拟体积感：密的地方暗（厚），薄的地方被照亮
  float density = smoothstep(0.34, 0.82, n + detail * 0.3);
  vec3 col = mix(uLitColor, uShadowColor, density * 0.72);
  col += uSunColor * pow(1.0 - density, 3.0) * 0.4;

  // 远处的云海融入地平线雾
  vec3 viewDir = normalize(vWorldPos - cameraPosition);
  vec3 fogCol = mix(uFogCool, uFogWarm, smoothstep(0.05, 0.9, dot(viewDir, uSunDir)));
  float fogAmount = 1.0 - exp(-camDist * 0.00075);
  col = mix(col, fogCol, clamp(fogAmount, 0.0, 0.92));

  gl_FragColor = vec4(col, alpha * uOpacity);
  ${GLSL_OUTPUT}
}
`;

function createTerrain(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'terrain-scene';

  const camera = new THREE.PerspectiveCamera(60, 1, 0.08, 7000);
  camera.position.set(0, 1.8, 6.5);
  camera.lookAt(0, 1.2, 0);

  const quality = THREE.MathUtils.clamp(ctx.quality, 0.4, 2);

  // ── 天空 ──────────────────────────────────────────────────────────────
  const skyUniforms = {
    uZenith: { value: new THREE.Color(0x2b4f8c) },
    uHorizon: { value: new THREE.Color(0xd8813f) },
    uSunDir: { value: SUN_DIR.clone() },
    uSunColor: { value: new THREE.Color(0xffc07a) },
    uGround: { value: new THREE.Color(0x1b1a26) },
  };
  const skyMaterial = new THREE.ShaderMaterial({
    uniforms: skyUniforms,
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(4200, 40, 24), skyMaterial);
  sky.name = 'sky';
  sky.renderOrder = -1000;
  sky.frustumCulled = false;
  root.add(sky);

  // ── 地形 ──────────────────────────────────────────────────────────────
  const segments = Math.round(THREE.MathUtils.clamp(200 * quality, 96, 288));
  const terrainGeometry = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, segments, segments);
  terrainGeometry.rotateX(-Math.PI / 2);

  const position = terrainGeometry.getAttribute('position') as THREE.BufferAttribute;
  const aoValues = new Float32Array(position.count);
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const z = position.getZ(i);
    const h = terrainHeight(x, z);
    position.setY(i, h);
    aoValues[i] = smoothstep(-70, 150, h);
  }
  position.needsUpdate = true;
  terrainGeometry.computeVertexNormals();

  const normals = terrainGeometry.getAttribute('normal') as THREE.BufferAttribute;
  const worldNormals = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    worldNormals[i * 3] = normals.getX(i);
    worldNormals[i * 3 + 1] = normals.getY(i);
    worldNormals[i * 3 + 2] = normals.getZ(i);
  }
  terrainGeometry.setAttribute('aWorldNormal', new THREE.BufferAttribute(worldNormals, 3));
  terrainGeometry.setAttribute('aAo', new THREE.BufferAttribute(aoValues, 1));

  const terrainUniforms = {
    uSunDir: { value: SUN_DIR.clone() },
    uSunColor: { value: new THREE.Color(0xffb877) },
    uAmbient: { value: new THREE.Color(0x4a6296) },
    uRimColor: { value: new THREE.Color(0x8fb6ff) },
    uFogWarm: { value: new THREE.Color(0xd8813f) },
    uFogCool: { value: new THREE.Color(0x46598a) },
    uFogDensity: { value: 0.00038 },
  };

  const terrainMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.92,
    metalness: 0,
    envMapIntensity: 0.09,
  });
  // 显式挂 envMap，否则 scene.environment 会以满强度参与 IBL
  terrainMaterial.envMap = ctx.env.envMap;

  terrainMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.uSunDir = terrainUniforms.uSunDir;
    shader.uniforms.uSunColor = terrainUniforms.uSunColor;
    shader.uniforms.uAmbient = terrainUniforms.uAmbient;
    shader.uniforms.uRimColor = terrainUniforms.uRimColor;
    shader.uniforms.uFogWarm = terrainUniforms.uFogWarm;
    shader.uniforms.uFogCool = terrainUniforms.uFogCool;
    shader.uniforms.uFogDensity = terrainUniforms.uFogDensity;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec3 aWorldNormal;
attribute float aAo;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying float vAo;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWorldNormal = aWorldNormal;
vAo = aAo;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${TERRAIN_FRAG_PARS}`)
      .replace('#include <normal_fragment_maps>', TERRAIN_FRAG_NORMAL)
      .replace('#include <opaque_fragment>', TERRAIN_FRAG_OPAQUE);
  };
  terrainMaterial.customProgramCacheKey = () => 'lumen-terrain-v1';

  const terrain = new THREE.Mesh(terrainGeometry, terrainMaterial);
  terrain.name = 'terrain';
  terrain.receiveShadow = false;
  root.add(terrain);

  // ── 云海 ──────────────────────────────────────────────────────────────
  const cloudMaterials: THREE.ShaderMaterial[] = [];
  CLOUD_LAYERS.forEach((layer, index) => {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSeed: { value: layer.seed },
        uScale: { value: layer.scale },
        uSpeed: { value: layer.speed },
        uOpacity: { value: layer.opacity },
        uLitColor: { value: new THREE.Color(0xf0c6ac) },
        uShadowColor: { value: new THREE.Color(0x57527e) },
        uSunDir: { value: SUN_DIR.clone() },
        uSunColor: { value: new THREE.Color(0xffc48a) },
        uFogWarm: terrainUniforms.uFogWarm,
        uFogCool: terrainUniforms.uFogCool,
      },
      vertexShader: CLOUD_VERT,
      fragmentShader: CLOUD_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    cloudMaterials.push(material);

    const cloud = new THREE.Mesh(new THREE.PlaneGeometry(2600, 2600, 1, 1), material);
    cloud.name = 'cloud-sea';
    cloud.rotation.x = -Math.PI / 2;
    cloud.position.y = layer.y;
    cloud.renderOrder = 10 + index;
    root.add(cloud);
  });

  // ── 灯光 ──────────────────────────────────────────────────────────────
  const lights = ctx.env.createStudioLights();
  lights.traverse((child) => {
    if (child instanceof THREE.Light) {
      child.intensity *= 0.3;
      child.castShadow = false;
    }
  });
  root.add(lights);

  const sun = new THREE.DirectionalLight(0xffc38c, 3.4);
  sun.position.copy(SUN_DIR).multiplyScalar(500);
  root.add(sun);
  root.add(sun.target);

  const skyFill = new THREE.HemisphereLight(0x8fb0ff, 0x33293f, 0.42);
  root.add(skyFill);

  return {
    root,
    camera,
    immersive: true,
    xrDistance: 3,
    framing: { distance: 6.5, height: 1.8, targetY: 1.2 },
    update(time: number, _delta: number, _context: SceneContext): void {
      for (const material of cloudMaterials) {
        material.uniforms.uTime.value = time;
      }
    },
    dispose(): void {
      disposeObject(root);
    },
  };
}

export const terrainScene: SceneDefinition = {
  id: 'terrain',
  title: '云海群山',
  subtitle: 'Cloud Sea Peaks',
  description: '浮在层叠云海之上的分形山脉，日出的暖橙地平线切开冷蓝高空。',
  tags: ['地形', '云海', '日出'],
  accent: '#ff9c52',
  gradient: ['#8a3f22', '#141d38'],
  category: 'procedural',
  lighting: {
    autoExposure: true,
    autoExposureKey: 0.16,
    softShadows: 0.5,
  },
  create(ctx: SceneContext): SceneInstance {
    return createTerrain(ctx);
  },
};

export default terrainScene;
