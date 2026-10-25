import * as THREE from 'three';
import { GPUComputationRenderer } from 'three/addons/misc/GPUComputationRenderer.js';
import type { Variable } from 'three/addons/misc/GPUComputationRenderer.js';
import type { SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { disposeObject } from '../../core/loader.js';
import { PARTICLE_SPACE_GLSL, ParticleSpace, createWrappedPointField, wrapParticleField } from '../../core/particle-space.js';
import { GLSL_HARDCORE_CURL, GLSL_HARDCORE_NOISE } from './lib/hardcore-glsl.js';
import { GLSL_OUTPUT, GLSL_OUTPUT_FUNCS } from './lib/glsl-output.js';
import { createGradientDome } from './lib/backdrop.js';

/**
 * GPU 粒子潮汐
 *
 * 展示 three.js 的招牌能力之一：GPUComputationRenderer。
 * 二十多万颗粒子的位置与速度全部在 GPU 上迭代（两张 FBO 乒乓纹理），
 * CPU 每帧只更新几个 uniform，然后把位置纹理直接喂给顶点着色器采样，
 * 整个过程没有任何「读回显存」的同步开销。
 *
 * 流场用 curl noise（无散度）驱动，宏观上是一条缓慢起伏的潮汐环面，
 * 微观上被湍流撕扯；音乐通过四个频段分别控制涌动强度、涡旋半径、亮度与闪烁。
 *
 * 若设备不支持浮点纹理 / 顶点纹理，场景会优雅降级到核心层现成的
 * CPU 粒子场（createWrappedPointField），画面不会出现空白。
 */

/** 计算纹理的边长（会随画质缩放），粒子数 = 边长²。 */
const BASE_RESOLUTION = 480;
const MIN_RESOLUTION = 160;
const MAX_RESOLUTION = 640;

/** 潮汐环的世界尺度。 */
const CORE_Y = 1.35;
const BASE_RING_RADIUS = 2.62;
const MIN_RADIUS = 0.85;
const MAX_RADIUS = 4.55;
const MIN_Y = -0.75;
const MAX_Y = 3.35;

/** 潮汐「管」的粗细：每颗粒子在自己的轨道上有一个固定偏移，于是潮面有厚度。 */
const TUBE_RADIUS = 0.85;
const TUBE_HEIGHT = 0.62;

/** 相机视场角（度），用于把「米」换算成屏幕像素。 */
const FOV = 55;

/* ------------------------------------------------------------------ *
 * GPU 计算着色器
 * ------------------------------------------------------------------ */

/**
 * 速度计算：curl noise 湍流 + 潮汐环面的形状约束 + 切向洋流。
 *
 * 注意：compute pass 里没有可用的相机信息，因此这里不引用任何
 * three 的内置相机变量，只用 uniform 与 FBO 纹理。
 */
const VELOCITY_COMPUTE = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uDelta;
uniform float uFlow;
uniform float uSwirl;
uniform float uCenterY;
uniform float uTubeR;
uniform float uTubeY;

${GLSL_HARDCORE_NOISE}
${GLSL_HARDCORE_CURL}

void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;

  vec4 posData = texture2D(texturePosition, uv);
  vec3 pos = posData.xyz;
  vec3 vel = texture2D(textureVelocity, uv).xyz;

  float r = max(length(pos.xz), 0.0001);
  vec3 radial = vec3(pos.x, 0.0, pos.z) / r;
  vec3 tangent = vec3(-radial.z, 0.0, radial.x);
  float theta = atan(pos.z, pos.x);

  // 每颗粒子在潮汐管里有一个固定偏移（由种子决定），潮面因此有厚度而不是一张纸
  float seed = posData.w;
  float offR = sin(seed * 43.0) * uTubeR;
  float offY = sin(seed * 71.0 + 2.1) * uTubeY;

  // 潮汐环面：一圈随时间缓慢起伏的波形
  float waveR = sin(theta * 2.0 - uTime * 0.21) * 0.24
              + sin(theta * 3.0 + uTime * 0.14) * 0.13;
  float targetR = uSwirl + waveR + offR;
  float targetY = uCenterY
                + sin(theta * 2.0 - uTime * 0.28) * 0.28
                + sin(theta * 4.0 + uTime * 0.10) * 0.13
                + offY;

  // 形状约束：把粒子拉向潮汐面
  vec3 force = radial * (targetR - r) * 0.85;
  force.y += (targetY - pos.y) * 1.05;

  // 切向洋流：整体绕 Y 轴缓慢旋转
  force += tangent * (0.42 + uFlow * 1.6);

  // 湍流：无散度流场，粒子既不聚团也不散架
  vec3 curl = hcCurl3(pos * 0.62 + vec3(0.0, uTime * 0.05, uTime * 0.025));
  force += curl * (0.2 + uFlow * 0.4);

  // 一阶惯性：让运动有「重」的感觉，而不是直接吸附到力场
  float k = clamp(uDelta * 2.6, 0.0, 1.0);
  vel = mix(vel, force, k);

  gl_FragColor = vec4(vel, 0.0);
}
`;

/** 位置计算：按速度积分，并把粒子约束在潮汐环的柱状体积内。 */
const POSITION_COMPUTE = /* glsl */ `
precision highp float;

uniform float uDelta;
uniform float uMinR;
uniform float uMaxR;
uniform float uMinY;
uniform float uMaxY;

void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;

  vec4 posData = texture2D(texturePosition, uv);
  vec3 vel = texture2D(textureVelocity, uv).xyz;
  vec3 pos = posData.xyz + vel * uDelta;

  // 径向兜底（正常情况下力场已经把它们拉住，这里只是保险）
  float r = max(length(pos.xz), 0.0001);
  if (r > uMaxR) {
    pos.xz *= (uMaxR * 0.94 + uMinR * 0.06) / r;
  } else if (r < uMinR) {
    pos.xz *= uMinR / r;
  }

  // 垂直方向循环，永远不会飞出上下界
  pos.y = uMinY + mod(pos.y - uMinY, uMaxY - uMinY);

  gl_FragColor = vec4(pos, posData.w);
}
`;

/* ------------------------------------------------------------------ *
 * 渲染着色器
 * ------------------------------------------------------------------ */

/**
 * 粒子顶点着色器。
 *
 * GPU 路径（HC_TEXTURE_FIELD）：位置直接来自计算纹理（顶点纹理拾取）。
 * CPU 降级路径：位置来自粒子空间属性，并用一条解析波形把立方体粒子场
 * 重新塑形成同样的潮汐环面，保证降级后观感依然成立。
 */
const POINT_VERT = /* glsl */ `
precision highp float;

attribute vec2 aRef;
attribute float aPhase;
attribute float aSize;

uniform sampler2D uPositions;
uniform float uTime;
uniform float uLevel;
uniform float uTreble;
uniform float uPixelScale;
uniform float uCenterY;
uniform vec3 uColorInner;
uniform vec3 uColorOuter;
uniform vec3 uColorAccent;

varying vec3 vColor;
varying float vAlpha;

${PARTICLE_SPACE_GLSL}

void main() {
#ifdef HC_TEXTURE_FIELD
  vec4 pData = texture2D(uPositions, aRef);
  vec3 pos = pData.xyz;
#else
  // 把核心层给的立方体粒子场重新塑形成同样的潮汐环面
  vec3 raw = position;
  float rawR = max(length(raw.xz), 0.001);
  float rawTheta = atan(raw.z, raw.x);
  float ring = 2.55 + sin(rawTheta * 2.0 + uTime * 0.2) * 0.5;
  raw.xz *= mix(1.0, ring / rawR, 0.8);
  raw.y *= 0.15;
  vec3 pos = particleSpaceTransform(raw);
#endif

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = max(0.05, -mv.z);

  // 越靠近涡心越亮（这是「深度 / 亮度」的主要来源）
  float rr = length(pos.xz);
  float core = 1.0 - smoothstep(1.2, 4.6, rr);
  float twinkle = 0.76 + 0.24 * sin(uTime * (1.3 + uTreble * 6.0) + aPhase * 43.0);
  float bright = (0.34 + 0.66 * core) * (0.42 + 0.75 * uLevel);

  vec3 tint = mix(uColorOuter, uColorInner, clamp(core * (0.5 + 0.5 * aPhase), 0.0, 1.0));
  tint = mix(tint, uColorAccent, smoothstep(0.70, 1.0, aPhase) * 0.55);
  vColor = tint * bright * twinkle * 0.145;
  vAlpha = clamp(bright * 0.9, 0.0, 1.0);

  gl_PointSize = clamp(
    aSize * uPixelScale * (0.55 + 0.85 * core) * (0.85 + 0.4 * twinkle) / dist,
    1.0,
    42.0
  );
}
`;

const POINT_FRAG = /* glsl */ `
precision highp float;

varying vec3 vColor;
varying float vAlpha;

${GLSL_OUTPUT_FUNCS}

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot(c, c);
  if (d2 > 0.25) discard;

  float a = exp(-d2 * 8.0);
  gl_FragColor = vec4(vColor, a * vAlpha);
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * 场景搭建
 * ------------------------------------------------------------------ */

interface TideUniforms {
  uTime: { value: number };
  uLevel: { value: number };
  uTreble: { value: number };
  uPixelScale: { value: number };
  uCenterY: { value: number };
  uColorInner: { value: THREE.Color };
  uColorOuter: { value: THREE.Color };
  uColorAccent: { value: THREE.Color };
}

/** 可复现的伪随机数发生器。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** GPU 路径：建立两张计算纹理并驱动二十多万颗粒子。 */
interface GpuTideField {
  points: THREE.Points;
  gpuCompute: GPUComputationRenderer;
  velocityVariable: Variable;
  positionVariable: Variable;
  uniforms: TideUniforms;
  particleMatrix: { value: THREE.Matrix4 };
  dispose(): void;
}

function createGpuField(
  ctx: SceneContext,
  resolution: number,
  count: number,
  seed: number,
): GpuTideField {
  const renderer = ctx.renderer;
  const gpuCompute = new GPUComputationRenderer(resolution, resolution, renderer);
  const rng = mulberry32(seed);

  // ── 初始化纹理：createTexture() 返回的是全零纹理，必须自己填 ──
  const positionTexture = gpuCompute.createTexture();
  const velocityTexture = gpuCompute.createTexture();
  const positionData = positionTexture.image.data as Float32Array;
  const velocityData = velocityTexture.image.data as Float32Array;

  // 几何属性：aRef 指向计算纹理的 texel，aPhase 是每颗粒子的随机相位
  const refs = new Float32Array(count * 2);
  const phases = new Float32Array(count);
  const sizes = new Float32Array(count);
  const positions = new Float32Array(count * 3);

  for (let i = 0; i < count; i += 1) {
    const x = i % resolution;
    const y = Math.floor(i / resolution);

    const theta = rng() * Math.PI * 2;
    const seed = rng();
    // 与着色器里同一套偏移公式，保证第一帧就落在潮汐管里
    const offR = Math.sin(seed * 43.0) * TUBE_RADIUS;
    const offY = Math.sin(seed * 71.0 + 2.1) * TUBE_HEIGHT;
    // 初始就落在潮汐波形上，避免第一帧是一团随机云
    const wave = Math.sin(theta * 2.0) * 0.24 + Math.sin(theta * 3.0) * 0.13;
    const radius = BASE_RING_RADIUS + wave + offR + (rng() - 0.5) * 0.3;
    const height =
      CORE_Y +
      Math.sin(theta * 2.0) * 0.28 +
      Math.sin(theta * 4.0) * 0.13 +
      offY +
      (rng() - 0.5) * 0.3;

    positions[i * 3] = Math.cos(theta) * radius;
    positions[i * 3 + 1] = height;
    positions[i * 3 + 2] = Math.sin(theta) * radius;

    positionData[i * 4] = positions[i * 3];
    positionData[i * 4 + 1] = positions[i * 3 + 1];
    positionData[i * 4 + 2] = positions[i * 3 + 2];
    positionData[i * 4 + 3] = seed;

    velocityData[i * 4] = 0;
    velocityData[i * 4 + 1] = 0;
    velocityData[i * 4 + 2] = 0;
    velocityData[i * 4 + 3] = rng();

    refs[i * 2] = (x + 0.5) / resolution;
    refs[i * 2 + 1] = (y + 0.5) / resolution;
    phases[i] = seed;
    sizes[i] = 0.02 + rng() * 0.04;
  }
  positionTexture.needsUpdate = true;
  velocityTexture.needsUpdate = true;

  // ── 计算变量 ──
  const shared = {
    uTime: { value: 0 },
    uDelta: { value: 0 },
    uFlow: { value: 0 },
    uSwirl: { value: BASE_RING_RADIUS },
    uCenterY: { value: CORE_Y },
    uTubeR: { value: TUBE_RADIUS },
    uTubeY: { value: TUBE_HEIGHT },
  };

  const velocityVariable = gpuCompute.addVariable('textureVelocity', VELOCITY_COMPUTE, velocityTexture);
  const positionVariable = gpuCompute.addVariable('texturePosition', POSITION_COMPUTE, positionTexture);
  gpuCompute.setVariableDependencies(velocityVariable, [velocityVariable, positionVariable]);
  gpuCompute.setVariableDependencies(positionVariable, [velocityVariable, positionVariable]);

  Object.assign(velocityVariable.material.uniforms, shared);
  Object.assign(positionVariable.material.uniforms, {
    ...shared,
    uMinR: { value: MIN_RADIUS },
    uMaxR: { value: MAX_RADIUS },
    uMinY: { value: MIN_Y },
    uMaxY: { value: MAX_Y },
  });

  const error = gpuCompute.init();
  if (error !== null) {
    gpuCompute.dispose();
    throw new Error(`GPUComputationRenderer 初始化失败：${error}`);
  }

  // ── 渲染材质：位置直接从计算纹理里采样 ──
  const particleMatrix = { value: new THREE.Matrix4() };
  const uniforms: TideUniforms = {
    uTime: { value: 0 },
    uLevel: { value: 0.3 },
    uTreble: { value: 0 },
    uPixelScale: { value: 800 },
    uCenterY: { value: CORE_Y },
    uColorInner: { value: new THREE.Color(0x8fe6ff) },
    uColorOuter: { value: new THREE.Color(0x2b46d8) },
    uColorAccent: { value: new THREE.Color(0xff4fd8) },
  };

  const material = new THREE.ShaderMaterial({
    defines: { HC_TEXTURE_FIELD: '' },
    uniforms: {
      uPositions: { value: gpuCompute.getCurrentRenderTarget(positionVariable).texture },
      uTime: uniforms.uTime,
      uLevel: uniforms.uLevel,
      uTreble: uniforms.uTreble,
      uPixelScale: uniforms.uPixelScale,
      uCenterY: uniforms.uCenterY,
      uColorInner: uniforms.uColorInner,
      uColorOuter: uniforms.uColorOuter,
      uColorAccent: uniforms.uColorAccent,
      particleMatrix: particleMatrix,
    },
    vertexShader: POINT_VERT,
    fragmentShader: POINT_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aRef', new THREE.BufferAttribute(refs, 2));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));

  const points = new THREE.Points(geometry, material);
  points.name = 'gpu-tide-field';
  points.frustumCulled = false;

  return {
    points,
    gpuCompute,
    velocityVariable,
    positionVariable,
    uniforms,
    particleMatrix,
    dispose(): void {
      gpuCompute.dispose();
    },
  };
}

/** CPU 降级路径：用核心层现成的循环粒子场顶替 GPU 计算。 */
interface CpuTideField {
  points: THREE.Points;
  space: ParticleSpace;
  uniforms: TideUniforms;
  dispose(): void;
}

function createCpuField(count: number, seed: number): CpuTideField {
  const space = new ParticleSpace({
    radius: 4.2,
    spin: 0.03,
    tilt: 0.12,
    position: [0, CORE_Y, 0],
  });

  const points = createWrappedPointField(space, count, {
    size: 0.03,
    color: new THREE.Color(0x9fe4ff),
    opacity: 0.7,
    seed,
    vertexColors: false,
    additive: true,
  });

  const generated = points.material as THREE.PointsMaterial;
  const uniforms: TideUniforms = {
    uTime: { value: 0 },
    uLevel: { value: 0.3 },
    uTreble: { value: 0 },
    uPixelScale: { value: 800 },
    uCenterY: { value: CORE_Y },
    uColorInner: { value: new THREE.Color(0x8fe6ff) },
    uColorOuter: { value: new THREE.Color(0x2b46d8) },
    uColorAccent: { value: new THREE.Color(0xff4fd8) },
  };

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: uniforms.uTime,
      uLevel: uniforms.uLevel,
      uTreble: uniforms.uTreble,
      uPixelScale: uniforms.uPixelScale,
      uCenterY: uniforms.uCenterY,
      uColorInner: uniforms.uColorInner,
      uColorOuter: uniforms.uColorOuter,
      uColorAccent: uniforms.uColorAccent,
      particleMatrix: space.uniform,
    },
    vertexShader: POINT_VERT,
    fragmentShader: POINT_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  points.material = material;
  generated.dispose();

  return {
    points,
    space,
    uniforms,
    dispose(): void {
      // 粒子空间本身没有 GPU 资源
    },
  };
}

function createGpuTide(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'gpu-tide-scene';

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 400);
  camera.position.set(0, 3.4, 8.4);
  camera.lookAt(0, CORE_Y, 0);

  const quality = THREE.MathUtils.clamp(ctx.quality, 0.4, 2);
  const resolution = THREE.MathUtils.clamp(
    Math.round(BASE_RESOLUTION * Math.sqrt(quality)),
    MIN_RESOLUTION,
    MAX_RESOLUTION,
  );
  const count = resolution * resolution;

  // ── 建立粒子场（GPU 优先，失败则降级到 CPU） ──
  let gpuField: GpuTideField | null = null;
  let cpuField: CpuTideField | null = null;

  // GPU 计算需要：WebGL2、顶点纹理（取回位置）、浮点渲染目标（存位置/速度）
  const canUseGpu =
    ctx.renderer.capabilities.isWebGL2 &&
    ctx.renderer.capabilities.maxVertexTextures > 0 &&
    ctx.renderer.extensions.has('EXT_color_buffer_float');

  if (canUseGpu) {
    try {
      gpuField = createGpuField(ctx, resolution, count, 20241021);
    } catch (error) {
      console.error('[gpu-tide] GPU 计算不可用，降级到 CPU 粒子场', error);
      gpuField = null;
    }
  } else {
    console.warn('[gpu-tide] 当前设备不支持浮点渲染目标，改用 CPU 粒子场');
  }

  if (gpuField) {
    root.add(gpuField.points);
  } else {
    cpuField = createCpuField(Math.min(count, 60000), 20241021);
    root.add(cpuField.points);
  }

  // ── 背景穹顶 ──
  const backdrop = createGradientDome({
    zenith: 0x05070f,
    horizon: 0x0b1830,
    ground: 0x04060c,
    glow: 0x1b4a6e,
    radius: 90,
  });
  root.add(backdrop.mesh);

  // ── 灯光：只留一点点冷色底光，让材质不至于全黑 ──
  const lights = ctx.env.createStudioLights();
  lights.traverse((child) => {
    if (child instanceof THREE.Light) {
      child.intensity *= 0.12;
      child.castShadow = false;
    }
  });
  root.add(lights);

  // ── 音频驱动的运行期状态 ──
  const fieldUniforms = gpuField ? gpuField.uniforms : cpuField!.uniforms;
  let flowTime = 0;
  let pixelScale = 800;

  const halfFov = THREE.MathUtils.degToRad(FOV) * 0.5;

  return {
    root,
    camera,
    immersive: true,
    xrDistance: 3,
    framing: { distance: 8.4, height: 3.4, targetY: CORE_Y - 0.2, width: 9 },
    update(time: number, delta: number, context: SceneContext): void {
      const audio = context.audio;
      const pulse = audio.pulse;
      const bass = audio.bass;
      const level = audio.level;
      const treble = audio.treble;

      // 脉冲推进噪声场的时间：有音乐时随低频起音加快，无音乐时跟随呼吸
      flowTime += delta * (0.35 + 1.5 * pulse);
      fieldUniforms.uTime.value = time;
      fieldUniforms.uLevel.value = 0.28 + level * 0.9;
      fieldUniforms.uTreble.value = treble;

      pixelScale =
        (context.height * 0.5 * context.renderer.getPixelRatio()) / Math.tan(halfFov);
      fieldUniforms.uPixelScale.value = pixelScale;

      backdrop.uniforms.uLevel.value = level;

      if (gpuField) {
        const velocityUniforms = gpuField.velocityVariable.material.uniforms;
        velocityUniforms.uTime.value = flowTime;
        velocityUniforms.uDelta.value = delta;
        velocityUniforms.uFlow.value = pulse;
        velocityUniforms.uSwirl.value = BASE_RING_RADIUS + bass * 1.15;

        const positionUniforms = gpuField.positionVariable.material.uniforms;
        positionUniforms.uDelta.value = delta;

        gpuField.gpuCompute.compute();

        // 位置纹理直接喂给顶点着色器，全程不回读显存
        const material = gpuField.points.material as THREE.ShaderMaterial;
        material.uniforms.uPositions.value = gpuField.gpuCompute.getCurrentRenderTarget(
          gpuField.positionVariable,
        ).texture;
      } else if (cpuField) {
        cpuField.space.update(delta, time);
        wrapParticleField(cpuField.points, cpuField.space.radius, delta, 0.12);
      }
    },
    dispose(): void {
      gpuField?.dispose();
      cpuField?.dispose();
      disposeObject(root);
    },
  };
}

export const gpuTideScene: SceneDefinition = {
  id: 'gpu-tide',
  title: 'GPU 粒子潮汐',
  subtitle: 'GPU Particle Tide',
  description: '二十多万颗粒子在 GPU 上迭代位置与速度，被 curl noise 拧成缓慢翻涌的荧光潮汐。',
  tags: ['GPU 计算', '粒子', '流体'],
  accent: '#4fd6ff',
  gradient: ['#06283f', '#03060f'],
  category: 'procedural',
  breathing: { inhale: 5, hold: 2, exhale: 7, holdOut: 2 },
  create(ctx: SceneContext): SceneInstance {
    return createGpuTide(ctx);
  },
};

export default gpuTideScene;
