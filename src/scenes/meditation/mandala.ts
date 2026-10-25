import * as THREE from 'three';
import type { SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { disposeObject } from '../../core/loader.js';
import { ParticleSpace, wrapParticleField } from '../../core/particle-space.js';
import { createBreathSample, sampleBreath } from './lib/breath.js';
import {
  createBackdropDome,
  createRadialGlowTexture,
  createSoftParticleField,
  dimStudioLights,
  disposeMeshMaterial,
  updateParticleScale,
} from './lib/gfx.js';

/**
 * 万象
 *
 * 一个铺在水面上的曼陀罗投影：多层细线环、花瓣曲线、辐条与点阵全部由程序化几何生成，
 * 中心一团柔和的光晕，边缘渐渐溶进深色背景。整幅图案极慢地旋转，并随呼吸缩放。
 */

const BREATHING = { inhale: 4, hold: 4, exhale: 8 };

const FOV = 46;

/** 曼陀罗落在地面上的高度。 */
const PLANE_Y = 0.03;

function createRingGeometry(radius: number, segments = 240): THREE.BufferGeometry {
  const positions = new Float32Array(segments * 3);
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    positions[i * 3] = Math.cos(t) * radius;
    positions[i * 3 + 1] = 0;
    positions[i * 3 + 2] = Math.sin(t) * radius;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}

/** 花瓣曲线：r = R · (1 + a·cos(kθ))。 */
function createPetalGeometry(radius: number, petals: number, amplitude: number, segments = 480): THREE.BufferGeometry {
  const positions = new Float32Array(segments * 3);
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    const r = radius * (1 + amplitude * Math.cos(petals * t));
    positions[i * 3] = Math.cos(t) * r;
    positions[i * 3 + 1] = 0;
    positions[i * 3 + 2] = Math.sin(t) * r;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}

function createSpokeGeometry(inner: number, outer: number, count: number, offset = 0): THREE.BufferGeometry {
  const positions = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    const t = ((i + offset) / count) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    positions[i * 6] = c * inner;
    positions[i * 6 + 1] = 0;
    positions[i * 6 + 2] = s * inner;
    positions[i * 6 + 3] = c * outer;
    positions[i * 6 + 4] = 0;
    positions[i * 6 + 5] = s * outer;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}

function createDotRingGeometry(radius: number, count: number): THREE.BufferGeometry {
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const t = (i / count) * Math.PI * 2;
    positions[i * 3] = Math.cos(t) * radius;
    positions[i * 3 + 1] = 0;
    positions[i * 3 + 2] = Math.sin(t) * radius;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}

function createLineMaterial(color: number, opacity: number): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

function createMandala(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'mandala-scene';

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 260);
  camera.position.set(0, 3.5, 5.0);
  camera.lookAt(0, 0.6, 0);

  // ── 背景与水面 ────────────────────────────────────────────────────────
  const backdrop = createBackdropDome({
    zenith: 0x05070d,
    horizon: 0x0d1420,
    ground: 0x04060a,
    radius: 60,
  });
  root.add(backdrop.mesh);

  const ground = ctx.env.createGround(44) as THREE.Mesh;
  const groundMaterial = new THREE.MeshStandardMaterial({
    color: 0x060a10,
    roughness: 0.46,
    metalness: 0.24,
    envMapIntensity: 0.1,
  });
  groundMaterial.envMap = ctx.env.envMap;
  disposeMeshMaterial(ground);
  ground.material = groundMaterial;
  root.add(ground);

  const glowTexture = createRadialGlowTexture(128, 2.4);

  // 水面上的一层薄雾光晕
  const auraMaterial = new THREE.MeshBasicMaterial({
    map: glowTexture,
    color: 0x2e5f63,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const aura = new THREE.Mesh(new THREE.PlaneGeometry(9, 9), auraMaterial);
  aura.name = 'aura';
  aura.rotation.x = -Math.PI / 2;
  aura.position.y = 0.008;
  root.add(aura);

  // ── 曼陀罗 ────────────────────────────────────────────────────────────
  const mandala = new THREE.Group();
  mandala.name = 'mandala';
  mandala.position.y = PLANE_Y;
  root.add(mandala);

  const ringGroup = new THREE.Group();
  const petalGroup = new THREE.Group();
  const spokeGroup = new THREE.Group();
  const dotGroup = new THREE.Group();
  mandala.add(ringGroup, petalGroup, spokeGroup, dotGroup);

  const ringMaterials: THREE.LineBasicMaterial[] = [];
  const ringRadii = [2.78, 2.52, 2.24, 1.94, 1.6, 1.24, 0.88, 0.52];
  for (let i = 0; i < ringRadii.length; i++) {
    const color = i % 3 === 0 ? 0xe8e4dc : i % 3 === 1 ? 0x7d8f7a : 0x9fb0b8;
    const material = createLineMaterial(color, 0.2);
    ringMaterials.push(material);
    const ring = new THREE.LineLoop(createRingGeometry(ringRadii[i]), material);
    ring.name = 'ring';
    ringGroup.add(ring);
  }

  const petalMaterials: THREE.LineBasicMaterial[] = [];
  const petalSpecs = [
    { radius: 2.38, petals: 8, amplitude: 0.13, color: 0xd9a066 },
    { radius: 1.78, petals: 12, amplitude: 0.16, color: 0xe8e4dc },
    { radius: 1.06, petals: 16, amplitude: 0.2, color: 0xd9a066 },
    { radius: 0.62, petals: 6, amplitude: 0.28, color: 0x9fb0b8 },
  ];
  for (const spec of petalSpecs) {
    const material = createLineMaterial(spec.color, 0.26);
    petalMaterials.push(material);
    const petal = new THREE.LineLoop(
      createPetalGeometry(spec.radius, spec.petals, spec.amplitude),
      material,
    );
    petal.name = 'petal';
    petalGroup.add(petal);
  }

  const spokeMaterials: THREE.LineBasicMaterial[] = [];
  const spokeSpecs = [
    { inner: 0.56, outer: 1.2, count: 24, offset: 0 },
    { inner: 1.28, outer: 1.9, count: 36, offset: 0.5 },
    { inner: 1.98, outer: 2.48, count: 48, offset: 0 },
    { inner: 0, outer: 0.5, count: 12, offset: 0.25 },
  ];
  for (const spec of spokeSpecs) {
    const material = createLineMaterial(0x8fa3ad, 0.17);
    spokeMaterials.push(material);
    const spokes = new THREE.LineSegments(
      createSpokeGeometry(spec.inner, spec.outer, spec.count, spec.offset),
      material,
    );
    spokes.name = 'spokes';
    spokeGroup.add(spokes);
  }

  // 点阵
  const dotTexture = createRadialGlowTexture(64, 2.0);
  const dotMaterials: THREE.PointsMaterial[] = [];
  const dotSpecs = [
    { radius: 2.64, count: 72, color: 0xe8e4dc, size: 0.05 },
    { radius: 2.08, count: 54, color: 0x9fb0b8, size: 0.04 },
    { radius: 1.44, count: 36, color: 0xd9a066, size: 0.045 },
    { radius: 0.74, count: 24, color: 0xe8e4dc, size: 0.035 },
  ];
  for (const spec of dotSpecs) {
    const material = new THREE.PointsMaterial({
      map: dotTexture,
      color: spec.color,
      size: spec.size,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    dotMaterials.push(material);
    const dots = new THREE.Points(createDotRingGeometry(spec.radius, spec.count), material);
    dots.name = 'dots';
    dotGroup.add(dots);
  }

  // 中心光晕
  const coreMaterial = new THREE.MeshBasicMaterial({
    map: glowTexture,
    color: 0xe8c48f,
    transparent: true,
    opacity: 0.2,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const core = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 1.7), coreMaterial);
  core.name = 'core-glow';
  core.rotation.x = -Math.PI / 2;
  core.position.y = 0.004;
  mandala.add(core);

  // ── 曼陀罗外围缓缓浮动的尘埃 ──────────────────────────────────────────
  const space = new ParticleSpace({
    radius: 3.4,
    spin: 0.009,
    tilt: 0.14,
    position: [0, 0.8, 0],
  });
  const dust = createSoftParticleField(space, Math.floor(280 * ctx.quality), {
    size: 0.026,
    color: new THREE.Color(0xcfd8e4),
    opacity: 0.3,
    seed: 7331,
    wander: 0.09,
  });
  root.add(dust.points);

  // ── 灯光 ──────────────────────────────────────────────────────────────
  const lights = ctx.env.createStudioLights();
  dimStudioLights(lights, 0.05, 0x33405a);
  root.add(lights);

  const breath = createBreathSample();

  return {
    root,
    camera,
    immersive: true,
    framing: { distance: 5.0, height: 3.5, targetY: 0.6, width: 6 },
    update(time: number, delta: number, context: SceneContext): void {
      sampleBreath(BREATHING, time, breath);
      const level = breath.level;

      space.breathe = 1 + level * 0.12;
      space.breathPhase = level;
      space.update(delta, time);
      wrapParticleField(dust.points, space.radius, delta, 0.009);

      dust.uniforms.uTime.value = time;
      dust.uniforms.uBreath.value = level;
      updateParticleScale(dust.uniforms, context, FOV);

      // 整体极慢地旋转，各层反向微旋
      mandala.rotation.y = time * 0.016;
      ringGroup.rotation.y = time * 0.006;
      petalGroup.rotation.y = -time * 0.009;
      spokeGroup.rotation.y = time * 0.012;
      dotGroup.rotation.y = -time * 0.007;

      // 呼吸：整幅图案缓缓缩放、明暗随之起伏
      mandala.scale.setScalar(1 + level * 0.045);
      const fade = 0.72 + level * 0.28;
      for (const material of ringMaterials) material.opacity = 0.2 * fade;
      for (const material of petalMaterials) material.opacity = 0.26 * fade;
      for (const material of spokeMaterials) material.opacity = 0.17 * fade;
      for (const material of dotMaterials) material.opacity = 0.55 * fade;

      coreMaterial.opacity = 0.12 + level * 0.16;
      core.scale.setScalar(0.94 + level * 0.14);
      auraMaterial.opacity = 0.1 + level * 0.1;

      backdrop.uniforms.uTime.value = time;
      backdrop.uniforms.uBreath.value = level;
    },
    dispose(): void {
      glowTexture.dispose();
      dotTexture.dispose();
      disposeObject(root);
    },
  };
}

export const mandalaScene: SceneDefinition = {
  id: 'mandala',
  title: '万象',
  subtitle: 'Slow Mandala',
  description: '一幅曼陀罗投影浮在水面上，极慢地旋转着，随呼吸轻轻涨落。',
  tags: ['几何', '曼陀罗', '水影'],
  accent: '#7d8f7a',
  gradient: ['#16203c', '#05070c'],
  category: 'meditation',
  audio: 'slow-mandala.mp3',
  breathing: BREATHING,
  create(ctx: SceneContext): SceneInstance {
    return createMandala(ctx);
  },
};

export default mandalaScene;
