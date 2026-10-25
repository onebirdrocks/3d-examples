import * as THREE from 'three';
import { MarchingCubes } from 'three/addons/objects/MarchingCubes.js';
import type { SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { disposeObject } from '../../core/loader.js';
import { GLSL_HARDCORE_NOISE } from './lib/hardcore-glsl.js';
import { GLSL_OUTPUT, GLSL_OUTPUT_FUNCS } from './lib/glsl-output.js';
import { createGradientDome } from './lib/backdrop.js';

/**
 * 熔核等值面
 *
 * 展示 three.js 的招牌能力之一：MarchingCubes —— 实时重建等值面。
 * 每帧往标量场里写入九个球体的场强，重建出一颗不断变形的液态金属核心；
 * 表面再用 onBeforeCompile 注入一层基于世界坐标的 fbm，
 * 让暖色脉络沿着等值面游走（注入点选在光照计算之前）。
 *
 * 音乐通过脉冲驱动球体强度（心跳般一涨一缩）、低频驱动整体尺度、
 * 响度驱动脉络亮度。
 */

/** 核心在世界中的高度。 */
const CORE_Y = 0.85;

/** 等值面分辨率（随画质缩放）。 */
const BASE_RESOLUTION = 48;
const MIN_RESOLUTION = 28;
const MAX_RESOLUTION = 72;

/** 场参数：等值面阈值与每个球体的衰减项。 */
const ISOLATION = 80;
const SUBTRACT = 12;
const BASE_STRENGTH = 1.9;

/** 核心的世界缩放（直径 = 2 × scale，始终控制在 1.5 米以内）。 */
const BASE_SCALE = 0.6;

/** 复用同一个 Color，避免 addBall 每帧新建对象。 */
const BALL_COLOR = new THREE.Color(0xffffff);

/** 参与融合的球体参数。 */
interface BlobSpec {
  /** 归一化轨道半径。 */
  orbit: number;
  /** 归一化高度摆幅。 */
  height: number;
  /** 角速度（rad/s）。 */
  speed: number;
  /** 初始相位。 */
  phase: number;
  /** 轨道倾角。 */
  tilt: number;
}

const BLOBS: BlobSpec[] = [];
for (let i = 0; i < 9; i += 1) {
  BLOBS.push({
    orbit: 0.1 + (i % 3) * 0.042 + (i / 9) * 0.055,
    height: 0.028 + ((i * 7) % 5) * 0.016,
    speed: 0.15 + ((i * 3) % 4) * 0.032,
    phase: (i / 9) * Math.PI * 2 + i * 0.63,
    tilt: ((i % 3) - 1) * 0.85,
  });
}

/* ------------------------------------------------------------------ *
 * 材质注入
 * ------------------------------------------------------------------ */

/**
 * 表面脉络：fbm 的零等值线天然形成细长的裂纹网络，
 * 在这里用来驱动暗色结壳、粗糙度与暖色自发光。
 */
const VEIN_BLOCK = /* glsl */ `
{
  vec3 hp = vCoreWorld * 2.4;
  float n1 = hcFbm3(hp + vec3(0.0, uTime * 0.05, uTime * 0.022));
  float n2 = hcFbm3(hp * 2.1 - vec3(uTime * 0.035, uTime * 0.012, uTime * 0.05));
  float field = n1 * 0.68 + n2 * 0.32;

  float crack = 1.0 - smoothstep(0.0, 0.028 + 0.022 * uVein, abs(field));

  // 暗色结壳 + 更粗糙的表面
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05, 0.024, 0.017), crack * 0.82);
  roughnessFactor = mix(roughnessFactor, 0.94, crack);

  // 暖色脉络
  totalEmissiveRadiance += uHot * crack * (0.5 + 2.8 * uVein);
  // 整体余温
  totalEmissiveRadiance += uHot * 0.055 * uVein * (0.5 + 0.5 * n1);
}
`;

/** 地面倒影：复用同一份几何体，镜像到 y = 0 以下并做距离衰减。 */
const REFLECTION_VERT = /* glsl */ `
varying vec3 vCoreWorld;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vCoreWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const REFLECTION_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uVein;
uniform vec3 uHot;

varying vec3 vCoreWorld;

${GLSL_HARDCORE_NOISE}
${GLSL_OUTPUT_FUNCS}

void main() {
  float depth = clamp(-vCoreWorld.y / 0.95, 0.0, 1.0);
  float fade = 1.0 - depth * depth;

  // 倒影里也保留裂纹结构：让它是「核心的映像」而不是一块红色剪影
  float veins = hcFbm3(vCoreWorld * 2.4 + vec3(0.0, uTime * 0.05, 0.0));
  float crack = 1.0 - smoothstep(0.0, 0.03, abs(veins));
  float haze = 0.5 + 0.5 * smoothstep(-0.15, 0.3, veins);

  vec3 col = uHot * (0.05 + 0.3 * crack + 0.08 * haze) * (0.28 + 0.8 * uVein);
  gl_FragColor = vec4(col, fade * 0.75);
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * 场景搭建
 * ------------------------------------------------------------------ */

interface CoreUniforms {
  uTime: { value: number };
  uVein: { value: number };
  uHot: { value: THREE.Color };
}

function createMetaball(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'metaball-scene';

  const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 200);
  camera.position.set(0, 1.25, 3.3);
  camera.lookAt(0, 0.32, 0);

  const quality = THREE.MathUtils.clamp(ctx.quality, 0.4, 2);
  const resolution = THREE.MathUtils.clamp(
    Math.round(BASE_RESOLUTION * Math.sqrt(quality)),
    MIN_RESOLUTION,
    MAX_RESOLUTION,
  );
  const maxPolyCount = Math.round(40000 * quality);

  const coreUniforms: CoreUniforms = {
    uTime: { value: 0 },
    uVein: { value: 0.3 },
    uHot: { value: new THREE.Color(0xff5a12) },
  };

  // ── 材质：低金属度 + 高 clearcoat + 一点虹彩 ──
  const material = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(0x1e0f0b),
    metalness: 0.42,
    roughness: 0.3,
    clearcoat: 1,
    clearcoatRoughness: 0.18,
    iridescence: 0.5,
    iridescenceIOR: 1.45,
    iridescenceThicknessRange: [140, 520],
    emissive: new THREE.Color(0x000000),
  });

  // 显式指定 envMap：宿主已经把 envMap 设为 scene.environment，
  // 这里再赋一次是为了能单独用 envMapIntensity 压低 IBL，避免 r186 下烧白。
  material.envMap = ctx.env.envMap;
  material.envMapIntensity = 0.4;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = coreUniforms.uTime;
    shader.uniforms.uVein = coreUniforms.uVein;
    shader.uniforms.uHot = coreUniforms.uHot;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCoreWorld;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n  vCoreWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;',
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vCoreWorld;
uniform float uTime;
uniform float uVein;
uniform vec3 uHot;
${GLSL_HARDCORE_NOISE}`,
      )
      // 注入点必须在光照累加之前，diffuseColor / totalEmissiveRadiance 才有效
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${VEIN_BLOCK}`);
  };

  // ── 等值面 ──
  const effect = new MarchingCubes(resolution, material, false, false, maxPolyCount);
  effect.name = 'metaball-core';
  effect.isolation = ISOLATION;
  effect.position.set(0, CORE_Y, 0);
  effect.scale.setScalar(BASE_SCALE);
  effect.frustumCulled = false;
  root.add(effect);

  // ── 地面倒影（与核心共享同一份几何体） ──
  const reflectionMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uTime: coreUniforms.uTime,
      uVein: coreUniforms.uVein,
      uHot: coreUniforms.uHot,
    },
    vertexShader: REFLECTION_VERT,
    fragmentShader: REFLECTION_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });

  const reflection = new THREE.Mesh(effect.geometry, reflectionMaterial);
  reflection.name = 'metaball-reflection';
  reflection.position.set(0, -CORE_Y, 0);
  reflection.scale.set(BASE_SCALE, -BASE_SCALE, BASE_SCALE);
  reflection.renderOrder = 2;
  reflection.frustumCulled = false;
  root.add(reflection);

  // ── 天幕：避免上半屏是纯黑 ──
  const dome = createGradientDome({
    zenith: 0x04060b,
    horizon: 0x0a1018,
    ground: 0x06070b,
    glow: 0x4a2410,
    radius: 70,
  });
  root.add(dome.mesh);

  // ── 地面 ──
  const ground = ctx.env.createGround(60) as THREE.Mesh;
  ground.name = 'metaball-ground';
  const groundMaterial = ground.material as THREE.MeshStandardMaterial;
  // 显式指定 envMap 并压低强度，否则宿主设置的 scene.environment 会把地面提亮成灰白
  groundMaterial.envMap = ctx.env.envMap;
  groundMaterial.envMapIntensity = 0.04;
  groundMaterial.color.setHex(0x06070b);
  groundMaterial.metalness = 0;
  groundMaterial.roughness = 0.96;
  root.add(ground);

  // ── 灯光：冷色三点光压暗，再补一盏跟随核心的暖色点光 ──
  const lights = ctx.env.createStudioLights();
  lights.traverse((child) => {
    if (child instanceof THREE.DirectionalLight) {
      child.intensity *= 0.26;
      child.castShadow = false;
    } else if (child instanceof THREE.AmbientLight) {
      child.intensity *= 0.45;
      child.color.setHex(0x24304a);
    }
  });
  root.add(lights);

  const coreLight = new THREE.PointLight(0xff6a1e, 12, 9, 2);
  coreLight.name = 'core-light';
  coreLight.position.set(0, CORE_Y, 0);
  root.add(coreLight);

  // 冷色轮廓光：勾出核心的边缘，让 clearcoat / 虹彩读得出来
  const rimLight = new THREE.DirectionalLight(0x9dc4ff, 0.85);
  rimLight.name = 'core-rim';
  rimLight.position.set(-3.2, 2.6, -4.4);
  root.add(rimLight);

  let scale = BASE_SCALE;

  return {
    root,
    camera,
    immersive: false,
    xrDistance: 2.4,
    framing: { distance: 3.3, height: 1.25, targetY: 0.32, width: 2.2 },
    update(time: number, _delta: number, context: SceneContext): void {
      const audio = context.audio;
      const pulse = audio.pulse;
      const bass = audio.bass;
      const level = audio.level;

      coreUniforms.uTime.value = time;
      coreUniforms.uVein.value = 0.22 + level * 1.05;

      // 低频驱动整体尺度（直径始终 < 1.5 米）
      scale = BASE_SCALE * (1 + bass * 0.14);
      effect.scale.setScalar(scale);
      reflection.scale.set(scale, -scale, scale);

      // 每帧重建场：先清空，再写入九个球体
      effect.reset();
      for (let i = 0; i < BLOBS.length; i += 1) {
        const blob = BLOBS[i];
        const angle = time * blob.speed + blob.phase;
        const cosA = Math.cos(angle);
        const sinA = Math.sin(angle);

        const x = 0.5 + cosA * blob.orbit;
        const z = 0.5 + sinA * blob.orbit * Math.cos(blob.tilt);
        const y =
          0.5 +
          sinA * blob.orbit * Math.sin(blob.tilt) * 1.6 +
          Math.sin(angle * 1.7 + blob.phase) * blob.height;

        // 脉冲让融合体一张一缩，像心跳
        const strength =
          BASE_STRENGTH *
          (1 + pulse * 0.85 + bass * 0.28) *
          (1 + 0.1 * Math.sin(angle * 2.3 + i));

        effect.addBall(x, y, z, strength, SUBTRACT, BALL_COLOR);
      }
      effect.update();

      // 核心自身的暖光随响度与脉冲跳动
      coreLight.intensity = 7 + level * 12 + pulse * 7;
    },
    dispose(): void {
      disposeObject(root);
    },
  };
}

export const metaballScene: SceneDefinition = {
  id: 'metaball',
  title: '熔核等值面',
  subtitle: 'Metaball Core',
  description: '九个场源实时融合成一颗液态金属核心，表面裂纹随节拍流动并映在地面上。',
  tags: ['等值面', 'Marching Cubes', '材质'],
  accent: '#ff7a2a',
  gradient: ['#3a1206', '#08060a'],
  category: 'procedural',
  breathing: { inhale: 4, hold: 1, exhale: 6, holdOut: 2 },
  create(ctx: SceneContext): SceneInstance {
    return createMetaball(ctx);
  },
};

export default metaballScene;
