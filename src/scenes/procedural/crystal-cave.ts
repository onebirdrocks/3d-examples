import * as THREE from 'three';

import type { SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { disposeObject } from '../../core/loader.js';
import { mulberry32 } from './lib/math.js';
import { createRadialTexture } from './lib/scene-kit.js';
import { GLSL_OUTPUT, GLSL_OUTPUT_FUNCS } from './lib/glsl-output.js';

/**
 * SDF 晶体洞穴 / Crystal Cave
 *
 * 整个世界由一个 fragment shader 画出来：three 只提供一个铺满视野的四边形，
 * 片元里做 SDF raymarching —— 洞穴内壁是一层球壳（用正弦凹凸打散），
 * 若干根八面体晶体从壁面长出来，用 smooth min 和内壁融合成簇。
 *
 * 光照：单一光源 + 阴影射线步进（软阴影）+ 距离雾 + 一次弹射的间接光近似
 * （法线半球采样）。晶体内部的辉光用体积近似：行进途中累积自发光密度。
 *
 * XR：全屏片元 raymarching 在 XR 里天然可用（每只眼各跑一遍），
 * 但步进次数要收着走，所以 XR 下步数再降一档，用 ctx.quality 做总控。
 *
 * 音乐驱动：
 * - pulse → 晶体辉光明灭 + smooth min 融合半径（一次「呼吸」形变）+ 辉光流动速度；
 * - bass  → 洞内低频震颤（整个洞穴轻微位移）；
 * - level → 整体亮度。
 */

const FOV = 62;
const BREATHING = { inhale: 6, hold: 2, exhale: 8 };
const CRYSTAL_COUNT = 6;
const CAVE_RADIUS = 6.2;

/* ------------------------------------------------------------------ *
 * 着色器
 * ------------------------------------------------------------------ */

const CAVE_VERT = /* glsl */ `
varying vec2 vNdc;
varying vec2 vTanHalf;

void main() {
  // 铺满视野：直接输出裁剪空间坐标，模型矩阵不参与
  vNdc = position.xy;
  // 透视投影的对角元 = 1 / tan(halfFov)，用它把 NDC 还原成视线方向
  vTanHalf = vec2(1.0 / projectionMatrix[0][0], 1.0 / projectionMatrix[1][1]);
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

const CAVE_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uPulse;
uniform float uLevel;
uniform int uSteps;
uniform float uBlend;
uniform vec3 uTremor;

uniform vec3 uCrysPos[${CRYSTAL_COUNT}];
uniform vec3 uCrysRight[${CRYSTAL_COUNT}];
uniform vec3 uCrysUp[${CRYSTAL_COUNT}];
uniform vec3 uCrysAxis[${CRYSTAL_COUNT}];
uniform vec2 uCrysSize[${CRYSTAL_COUNT}];

uniform vec3 uLightPos;
uniform vec3 uLightColor;
uniform vec3 uRockColor;
uniform vec3 uCrystalColor;
uniform vec3 uGlowColor;
uniform vec3 uFogColor;

varying vec2 vNdc;
varying vec2 vTanHalf;

${GLSL_OUTPUT_FUNCS}

const int MAX_STEPS = 96;
const int SHADOW_STEPS = 24;
const float CAVE_RADIUS = ${CAVE_RADIUS.toFixed(2)};
const float FAR_DIST = 34.0;

/* ---------- SDF 基元 ---------- */

float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

float sdOcta(vec3 p, float s) {
  p = abs(p);
  return (p.x + p.y + p.z - s) * 0.57735027;
}

// 单根晶体：沿轴向拉长的八面体
float crystalDist(vec3 p, int i) {
  vec3 q = p - uCrysPos[i];
  vec3 lq = vec3(dot(q, uCrysRight[i]), dot(q, uCrysUp[i]), dot(q, uCrysAxis[i]));
  vec3 s = vec3(uCrysSize[i].x, uCrysSize[i].x, uCrysSize[i].y);
  return sdOcta(lq / s, 1.0) * min(s.x, min(s.y, s.z));
}

// 洞壁：球壳 + 多频凹凸
float wallDist(vec3 p) {
  float lump = 0.55 * sin(p.x * 0.62 + 1.7) * sin(p.y * 0.81) * sin(p.z * 0.57 + 0.6)
             + 0.26 * sin(p.x * 1.87 - 0.4) * sin(p.z * 1.63 + 2.1)
             + 0.10 * sin(p.x * 3.31 + 0.7) * sin(p.y * 2.87 - 1.2) * sin(p.z * 3.73 + 2.4)
             + 0.028 * sin(p.x * 7.13 + 1.1) * sin(p.y * 6.31) * sin(p.z * 5.97 - 0.5);
  return CAVE_RADIUS + lump - length(p);
}

// 岩层纹理：沿高度分带，配合凹凸让洞壁有可读的结构
float strata(vec3 p) {
  float band = sin(p.y * 2.6 + sin(p.x * 0.9) * 1.4 + sin(p.z * 1.1) * 1.2);
  float fine = sin(p.x * 5.3 + p.z * 4.1) * sin(p.y * 4.7 - 0.8);
  return 0.5 + 0.5 * (band * 0.75 + fine * 0.25);
}

// 场景距离场；crystalMin 输出到最近晶体的距离（体积辉光用）
float mapScene(vec3 p, out float crystalMin) {
  vec3 q = p - uTremor;
  float d = wallDist(q);
  crystalMin = 1e9;
  for (int i = 0; i < ${CRYSTAL_COUNT}; i++) {
    float dc = crystalDist(q, i);
    crystalMin = min(crystalMin, dc);
    d = smin(d, dc, uBlend);
  }
  return d;
}

float mapDist(vec3 p) {
  float cd;
  return mapScene(p, cd);
}

/* ---------- 行进 ---------- */

float march(vec3 ro, vec3 rd, out vec3 glow, out float hitT) {
  float t = 0.02;
  glow = vec3(0.0);

  for (int i = 0; i < MAX_STEPS; i++) {
    if (i >= uSteps) break;

    vec3 p = ro + rd * t;
    float cd;
    float d = mapScene(p, cd);

    // 体积辉光：只在晶体附近明显，并沿轴向缓慢流动
    float dens = exp(-max(cd, 0.0) * 2.4);
    float flow = 0.5 + 0.5 * sin(p.y * 1.15 - uTime * (0.55 + uPulse * 1.8) + p.x * 0.75);

    float step = max(d * 0.82, 0.004);
    glow += uGlowColor * dens * flow * step * (0.32 + uPulse * 1.7);
    t += step;

    if (d < 0.0022 * (1.0 + t)) {
      hitT = t;
      return t;
    }
    if (t > FAR_DIST) break;
  }

  hitT = -1.0;
  return t;
}

/* ---------- 法线 / 阴影 / AO ---------- */

vec3 calcNormal(vec3 p) {
  const float e = 0.0024;
  const vec2 k = vec2(1.0, -1.0);
  return normalize(
    k.xyy * mapDist(p + k.xyy * e) +
    k.yyx * mapDist(p + k.yyx * e) +
    k.yxy * mapDist(p + k.yxy * e) +
    k.xxx * mapDist(p + k.xxx * e)
  );
}

float softShadow(vec3 ro, vec3 rd) {
  float res = 1.0;
  float t = 0.07;
  for (int i = 0; i < SHADOW_STEPS; i++) {
    float h = mapDist(ro + rd * t);
    res = min(res, 11.0 * h / t);
    if (res < 0.004) break;
    t += clamp(h, 0.06, 0.6);
    if (t > 10.0) break;
  }
  return clamp(res, 0.0, 1.0);
}

float calcAO(vec3 p, vec3 n) {
  float occ = 0.0;
  float sca = 1.0;
  for (int i = 0; i < 5; i++) {
    float h = 0.035 + 0.15 * float(i) / 4.0;
    float d = mapDist(p + n * h);
    occ += (h - d) * sca;
    sca *= 0.72;
  }
  return clamp(1.0 - 2.6 * occ, 0.0, 1.0);
}

/* ---------- 主流程 ---------- */

void main() {
  // 用 viewMatrix 还原相机基向量（XR 下每只眼各一份）
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 camFwd = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);

  vec3 rd = normalize(
    camRight * (vNdc.x * vTanHalf.x) +
    camUp * (vNdc.y * vTanHalf.y) +
    camFwd
  );
  vec3 ro = cameraPosition;

  vec3 glow;
  float hitT;
  float t = march(ro, rd, glow, hitT);

  vec3 col;

  if (hitT > 0.0) {
    vec3 p = ro + rd * hitT;
    vec3 n = calcNormal(p);

    vec3 toLight = uLightPos - p;
    float lightDist = length(toLight);
    vec3 l = toLight / max(lightDist, 0.0001);

    float diff = max(dot(n, l), 0.0);
    float shadow = softShadow(p + n * 0.03, l);
    float ao = calcAO(p, n);
    vec3 h = normalize(l - rd);
    float spec = pow(max(dot(n, h), 0.0), 46.0);

    // 靠近晶体的表面偏青绿，越远越像岩石
    float cd;
    mapScene(p, cd);
    float crysMask = 1.0 - smoothstep(0.0, 0.9, max(cd, 0.0));
    vec3 rock = uRockColor * (0.62 + 0.55 * strata(p));
    vec3 base = mix(rock, uCrystalColor, crysMask);

    // 直接光
    col = base * diff * shadow * uLightColor * (2.1 + uLevel * 1.8);
    col += base * 0.16 * ao;

    // 高光（晶体更亮更滑）
    col += uLightColor * spec * shadow * (0.25 + crysMask * 0.85) * (0.6 + uLevel * 0.8);

    // 晶体边缘的菲涅尔亮边
    float fres = pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 3.0);
    col += uGlowColor * fres * (0.12 + crysMask * 0.75) * (0.5 + uLevel * 0.6);

    // 一次弹射的间接光：法线半球采样
    vec3 ambient = mix(uFogColor, uCrystalColor * 0.55, n.y * 0.5 + 0.5);
    col += ambient * 0.6 * ao;

    // 晶体自发光
    col += uGlowColor * crysMask * (0.16 + uPulse * 0.7) * (0.5 + uLevel * 0.7);

    // 距离雾
    col = mix(col, uFogColor, 1.0 - exp(-hitT * 0.055));
  } else {
    col = uFogColor * (0.7 + uLevel * 0.5);
  }

  // 行进途中累积的体积辉光
  col += glow * (0.4 + uLevel * 0.7);

  gl_FragColor = vec4(max(col, 0.0), 1.0);
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * 晶体布局
 * ------------------------------------------------------------------ */

interface CrystalSpec {
  dir: [number, number, number];
  radius: number;
  length: number;
}

/** 晶体都长在洞壁附近，长轴指向洞心。 */
const CRYSTAL_SPECS: readonly CrystalSpec[] = [
  { dir: [0.0, 0.62, -0.78], radius: 1.05, length: 2.7 },
  { dir: [-0.78, 0.28, -0.55], radius: 0.78, length: 2.1 },
  { dir: [0.72, 0.22, -0.66], radius: 0.92, length: 2.4 },
  { dir: [-0.5, -0.55, -0.67], radius: 0.66, length: 1.7 },
  { dir: [0.62, -0.35, 0.7], radius: 0.72, length: 1.9 },
  { dir: [-0.66, 0.5, 0.56], radius: 0.6, length: 1.6 },
];

function createCrystalCave(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'crystal-cave-scene';

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 60);
  camera.position.set(0, 1.45, 2.8);

  const quality = THREE.MathUtils.clamp(ctx.quality, 0.4, 2);
  const random = mulberry32(778811);

  /* ---------------- 晶体数据 ---------------- */

  const crysPos: THREE.Vector3[] = [];
  const crysRight: THREE.Vector3[] = [];
  const crysUp: THREE.Vector3[] = [];
  const crysAxis: THREE.Vector3[] = [];
  const crysSize: THREE.Vector2[] = [];

  const upRef = new THREE.Vector3(0, 1, 0);
  const axis = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();

  for (const spec of CRYSTAL_SPECS) {
    axis.set(spec.dir[0], spec.dir[1], spec.dir[2]).normalize();
    // 晶体根在壁面附近，尖端朝洞心
    const base = axis.clone().multiplyScalar(CAVE_RADIUS - 0.25);
    crysPos.push(base.clone());

    // 长轴指向洞心
    const long = axis.clone().negate();
    crysAxis.push(long.clone());

    // 正交基（只为把点变换到晶体局部空间）
    const seedAxis = Math.abs(long.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : upRef;
    right.crossVectors(long, seedAxis).normalize();
    up.crossVectors(right, long).normalize();
    crysRight.push(right.clone());
    crysUp.push(up.clone());

    crysSize.push(new THREE.Vector2(spec.radius, spec.length));
  }

  /* ---------------- 全屏 raymarch 面片 ---------------- */

  const uniforms = {
    uTime: { value: 0 },
    uPulse: { value: 0 },
    uLevel: { value: 0 },
    uSteps: { value: 64 },
    uBlend: { value: 0.3 },
    uTremor: { value: new THREE.Vector3() },
    uCrysPos: { value: crysPos },
    uCrysRight: { value: crysRight },
    uCrysUp: { value: crysUp },
    uCrysAxis: { value: crysAxis },
    uCrysSize: { value: crysSize },
    uLightPos: { value: new THREE.Vector3(0.45, 1.95, -1.1) },
    uLightColor: { value: new THREE.Color(0x9fe8ff) },
    uRockColor: { value: new THREE.Color(0x151d36) },
    uCrystalColor: { value: new THREE.Color(0x1c6f7a) },
    uGlowColor: { value: new THREE.Color(0x2ad9c8) },
    uFogColor: { value: new THREE.Color(0x070e24) },
  };

  const caveMaterial = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: CAVE_VERT,
    fragmentShader: CAVE_FRAG,
    depthTest: false,
    depthWrite: false,
    fog: false,
  });

  const screen = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), caveMaterial);
  screen.name = 'crystal-cave-screen';
  screen.frustumCulled = false;
  screen.renderOrder = -1000;
  root.add(screen);

  /* ---------------- 浮尘（提供空间视差） ---------------- */

  const moteTexture = createRadialTexture(64, 2.0);
  const moteCount = Math.max(60, Math.round(220 * quality));
  const motePositions = new Float32Array(moteCount * 3);
  for (let i = 0; i < moteCount; i += 1) {
    const r = 1.2 + Math.pow(random(), 0.6) * 3.6;
    const theta = random() * Math.PI * 2;
    const phi = Math.acos(2 * random() - 1);
    motePositions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    motePositions[i * 3 + 1] = r * Math.cos(phi) * 0.75;
    motePositions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  const moteGeometry = new THREE.BufferGeometry();
  moteGeometry.setAttribute('position', new THREE.BufferAttribute(motePositions, 3));

  const moteMaterial = new THREE.PointsMaterial({
    map: moteTexture,
    color: 0x9ff5e8,
    size: 0.055,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const motes = new THREE.Points(moteGeometry, moteMaterial);
  motes.name = 'cave-motes';
  motes.frustumCulled = false;
  motes.renderOrder = 10;
  root.add(motes);

  /* ---------------- 灯光 ---------------- */

  // 洞内只有一盏「核心光」，它只存在于着色器里，场景中没有受光的材质
  const lights = ctx.env.createStudioLights();
  lights.traverse((child) => {
    if (child instanceof THREE.Light) {
      child.intensity *= 0.04;
      child.castShadow = false;
    }
  });
  root.add(lights);

  /* ---------------- 运行时状态 ---------------- */

  const webSteps = Math.round(THREE.MathUtils.clamp(64 * quality, 28, 96));
  const tremor = uniforms.uTremor.value;

  return {
    root,
    camera,
    immersive: true,
    xrDistance: 3,
    framing: { distance: 2.8, height: 1.45, targetY: 1.2 },

    update(time: number, _delta: number, sceneCtx: SceneContext): void {
      const audio = sceneCtx.audio;
      const pulse = audio.pulse;
      const level = audio.level;
      const bass = audio.bass;

      uniforms.uTime.value = time;
      uniforms.uPulse.value = pulse;
      uniforms.uLevel.value = level;

      // 融合半径随脉冲呼吸 —— 晶簇之间的过渡会一张一合
      uniforms.uBlend.value = 0.2 + pulse * 0.55;

      // 低频震颤：整个洞穴一起轻轻抖
      const shake = bass * 0.075;
      tremor.set(
        Math.sin(time * 7.3) * shake,
        Math.sin(time * 5.1 + 1.2) * shake * 0.8,
        Math.cos(time * 6.7 + 0.4) * shake,
      );

      // 步进次数：画质总控，XR 再降一档保证头显帧率
      uniforms.uSteps.value = sceneCtx.isXR ? Math.round(webSteps * 0.62) : webSteps;

      // 核心光与浮尘跟着呼吸
      moteMaterial.opacity = 0.32 + level * 0.4 + pulse * 0.18;
      motes.rotation.y = time * 0.018;
      motes.rotation.x = Math.sin(time * 0.05) * 0.12;
    },

    dispose(): void {
      moteTexture.dispose();
      disposeObject(root);
    },
  };
}

export const crystalCaveScene: SceneDefinition = {
  id: 'crystal-cave',
  title: 'SDF 晶体洞穴',
  subtitle: 'Crystal Cave',
  description: '整个世界由一个片元着色器用 SDF raymarching 画出来：晶体从洞壁长出，内部流动着辉光。',
  tags: ['SDF', '光线步进', '晶体', '体积光'],
  accent: '#3ce0d0',
  gradient: ['#0a2f3c', '#04060f'],
  category: 'procedural',
  audio: 'underwater-sleep.mp3',
  breathing: BREATHING,
  create(ctx: SceneContext): SceneInstance {
    return createCrystalCave(ctx);
  },
};

export default crystalCaveScene;
