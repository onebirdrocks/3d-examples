import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import type { SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { disposeObject } from '../../core/loader.js';
import { ParticleSpace, wrapParticleField } from '../../core/particle-space.js';
import { createBreathSample, sampleBreath } from './lib/breath.js';
import {
  createBackdropDome,
  createGravelTexture,
  createRadialFadeTexture,
  createRadialGlowTexture,
  createSoftParticleField,
  createStoneTexture,
  dimStudioLights,
  disposeMeshMaterial,
  fbm3D,
  updateParticleScale,
} from './lib/gfx.js';

/**
 * 禅石
 *
 * 深色砂砾地面上叠放着四块平衡的石头：圆角的不规则外形由噪声顶点位移塑形，
 * 低角度的暖侧光投下柔和的长影，石面带一点苔痕与水渍，空气里只有极缓慢升腾的尘埃。
 * 呼吸让侧光与地上的光晕缓缓涨落。
 */

const BREATHING = { inhale: 5, hold: 5, exhale: 5, holdOut: 5 };

const FOV = 46;

/** 一块程序化的石头。 */
function createStone(options: {
  radius: number;
  flatten: number;
  seed: number;
  scale: [number, number, number];
  rotation: number;
  texture: THREE.Texture;
  envMap: THREE.Texture;
}): { mesh: THREE.Mesh; top: number } {
  const geometry = new THREE.IcosahedronGeometry(options.radius, 3);
  const merged = mergeVertices(geometry, 1e-4);
  geometry.dispose();

  const position = merged.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const n = fbm3D(x * 1.05 + options.seed, y * 1.05 + options.seed * 0.37, z * 1.05, 4);
    const k = 0.8 + n * 0.44;
    position.setXYZ(i, x * k, y * k * options.flatten, z * k);
  }
  position.needsUpdate = true;
  merged.computeVertexNormals();
  merged.computeBoundingBox();

  const box = merged.boundingBox;
  if (!box) throw new Error('石头几何体缺少包围盒');
  const height = box.max.y - box.min.y;

  const material = new THREE.MeshStandardMaterial({
    map: options.texture,
    color: 0xffffff,
    roughness: 0.9,
    metalness: 0.02,
    envMapIntensity: 0.16,
  });
  material.envMap = options.envMap;

  const mesh = new THREE.Mesh(merged, material);
  mesh.name = 'zen-stone';
  mesh.scale.set(options.scale[0], options.scale[1], options.scale[2]);
  mesh.rotation.set(0, options.rotation, 0);
  // 让石头坐在地面上
  mesh.position.y = -box.min.y * options.scale[1];
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  return { mesh, top: height * options.scale[1] };
}

function createZenStones(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'zenstones-scene';

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 220);
  camera.position.set(0, 0.82, 2.4);
  camera.lookAt(0, 0.66, 0);

  // ── 背景与砂砾地面 ────────────────────────────────────────────────────
  const backdrop = createBackdropDome({
    zenith: 0x07080c,
    horizon: 0x121319,
    ground: 0x08090c,
    radius: 46,
  });
  root.add(backdrop.mesh);

  const gravelTexture = createGravelTexture(512);
  gravelTexture.repeat.set(9, 9);

  const ground = ctx.env.createGround(30) as THREE.Mesh;
  const groundMaterial = new THREE.MeshStandardMaterial({
    map: gravelTexture,
    roughness: 1,
    metalness: 0,
    envMapIntensity: 0.09,
  });
  groundMaterial.envMap = ctx.env.envMap;
  disposeMeshMaterial(ground);
  ground.material = groundMaterial;
  root.add(ground);

  // 地面边缘渐隐，藏住大片砂砾的边界
  const fadeTexture = createRadialFadeTexture(256);
  const fade = new THREE.Mesh(
    new THREE.PlaneGeometry(30, 30),
    new THREE.MeshBasicMaterial({
      map: fadeTexture,
      color: 0x000000,
      transparent: true,
      depthWrite: false,
      opacity: 0.92,
    }),
  );
  fade.name = 'ground-fade';
  fade.rotation.x = -Math.PI / 2;
  fade.position.y = 0.006;
  fade.renderOrder = 0;
  root.add(fade);

  // ── 石头 ──────────────────────────────────────────────────────────────
  const stoneTexture = createStoneTexture(256, {
    base: [88, 90, 95],
    moss: [116, 130, 108],
  });
  stoneTexture.repeat.set(2, 2);

  const stack = new THREE.Group();
  stack.name = 'stone-stack';
  root.add(stack);

  const specs = [
    { radius: 0.42, flatten: 0.5, seed: 3.1, scale: [1.3, 1, 1.05], rotation: 0.42, offset: 0 },
    { radius: 0.3, flatten: 0.58, seed: 11.7, scale: [1.2, 1, 1.05], rotation: 1.15, offset: 0.035 },
    { radius: 0.22, flatten: 0.62, seed: 23.4, scale: [1.25, 1, 1.0], rotation: 2.31, offset: -0.03 },
    { radius: 0.13, flatten: 0.72, seed: 37.9, scale: [1.15, 1, 1.1], rotation: 0.83, offset: 0.018 },
  ];

  let baseY = 0;
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const stone = createStone({
      radius: spec.radius,
      flatten: spec.flatten,
      seed: spec.seed,
      scale: [spec.scale[0], spec.scale[1], spec.scale[2]],
      rotation: spec.rotation,
      texture: stoneTexture,
      envMap: ctx.env.envMap,
    });
    stone.mesh.position.x = spec.offset;
    stone.mesh.position.z = i % 2 === 0 ? 0.01 : -0.02;
    stone.mesh.position.y += baseY - (i === 0 ? 0 : 0.035);
    baseY = stone.mesh.position.y + stone.top;
    stack.add(stone.mesh);
  }

  // ── 侧光 ──────────────────────────────────────────────────────────────
  const key = new THREE.DirectionalLight(0xffc891, 2.6);
  key.position.set(-7, 1.75, 3.2);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 30;
  key.shadow.camera.left = -5;
  key.shadow.camera.right = 5;
  key.shadow.camera.top = 5;
  key.shadow.camera.bottom = -5;
  key.shadow.bias = -0.0008;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 4;
  root.add(key);
  root.add(key.target);

  const fill = new THREE.DirectionalLight(0x7392c4, 0.3);
  fill.position.set(4.5, 2.6, -4);
  root.add(fill);

  const lights = ctx.env.createStudioLights();
  dimStudioLights(lights, 0.05, 0x3b4258);
  root.add(lights);

  // ── 石头周围极缓慢升腾的尘埃 ──────────────────────────────────────────
  const space = new ParticleSpace({
    radius: 1.5,
    spin: 0.007,
    tilt: 0.22,
    position: [0, 0.85, 0],
  });
  const dust = createSoftParticleField(space, Math.floor(190 * ctx.quality), {
    size: 0.02,
    color: new THREE.Color(0xcfd8d0),
    opacity: 0.3,
    seed: 2287,
    wander: 0.05,
  });
  root.add(dust.points);

  // ── 石头底下的一点暖光 ────────────────────────────────────────────────
  const glowTexture = createRadialGlowTexture(128, 2.8);
  const auraMaterial = new THREE.MeshBasicMaterial({
    map: glowTexture,
    color: 0xc59a6a,
    transparent: true,
    opacity: 0.12,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const aura = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.6), auraMaterial);
  aura.name = 'aura';
  aura.rotation.x = -Math.PI / 2;
  aura.position.y = 0.014;
  aura.renderOrder = 1;
  root.add(aura);

  const breath = createBreathSample();

  return {
    root,
    camera,
    immersive: false,
    xrDistance: 2.2,
    framing: { distance: 2.4, height: 0.82, targetY: 0.66, width: 2.3 },
    update(time: number, delta: number, context: SceneContext): void {
      sampleBreath(BREATHING, time, breath);
      const level = breath.level;

      space.breathe = 1 + level * 0.09;
      space.breathPhase = level;
      space.update(delta, time);
      wrapParticleField(dust.points, space.radius, delta, 0.01);

      dust.uniforms.uTime.value = time;
      dust.uniforms.uBreath.value = level;
      updateParticleScale(dust.uniforms, context, FOV);

      // 侧光随呼吸极轻地明灭
      key.intensity = 2.2 + level * 0.85;
      fill.intensity = 0.26 + level * 0.08;

      auraMaterial.opacity = 0.07 + level * 0.1;
      aura.scale.setScalar(0.94 + level * 0.12);

      backdrop.uniforms.uTime.value = time;
      backdrop.uniforms.uBreath.value = level;
    },
    dispose(): void {
      gravelTexture.dispose();
      stoneTexture.dispose();
      fadeTexture.dispose();
      glowTexture.dispose();
      disposeObject(root);
    },
  };
}

export const zenstonesScene: SceneDefinition = {
  id: 'zenstones',
  title: '禅石',
  subtitle: 'Zen Stones',
  description: '四块石头在砂砾上安静地平衡着，低低的暖光把影子拉得很长。',
  tags: ['石头', '留白', '侧光'],
  accent: '#d9a066',
  gradient: ['#1d1f26', '#0a0b0f'],
  category: 'meditation',
  audio: 'zen-stones.mp3',
  breathing: BREATHING,
  create(ctx: SceneContext): SceneInstance {
    return createZenStones(ctx);
  },
};

export default zenstonesScene;
