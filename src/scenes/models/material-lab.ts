/**
 * 材质实验室 —— 一排展台上的 PBR 材质对照实验。
 *
 * 每个展台是一件程序化几何体 + 一种专门强调 MeshPhysicalMaterial 某项特性的材质：
 * clearcoat（车漆）、iridescence（虹彩）、anisotropy（拉丝）、
 * transmission（玻璃）、sheen（绒面）、镜面金属、emissive（自发光）与珠光层。
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import {
  addGroundVignette,
  createLabelSprite,
  createRadialGlowTexture,
  createVerticalGradientTexture,
  disposeHierarchy,
  makeGroundMatte,
} from './shared.js';

/** 展台排布参数。 */
const SLOT_COUNT = 8;
const SLOT_SPACING = 1.42;
const BENCH_WIDTH = SLOT_COUNT * SLOT_SPACING + 0.9;
const BENCH_TOP = 0.24;
const PEDESTAL_HEIGHT = 0.76;
const PEDESTAL_TOP = BENCH_TOP + PEDESTAL_HEIGHT;
/** 相机参考距离，用于计算展品朝向。 */
const VIEW_DISTANCE = 8.4;

interface SampleSpec {
  /** 标签主标题。 */
  title: string;
  /** 标签副标题（参数名）。 */
  subtitle: string;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** 自转角速度（rad/s）。 */
  spin: number;
}

function buildSamples(): SampleSpec[] {
  return [
    {
      title: '车漆清漆',
      subtitle: 'CLEARCOAT 1.0',
      geometry: new THREE.SphereGeometry(0.32, 72, 48),
      material: new THREE.MeshPhysicalMaterial({
        color: 0x8a1226,
        metalness: 0.0,
        roughness: 0.38,
        clearcoat: 1.0,
        clearcoatRoughness: 0.035,
        envMapIntensity: 1.25,
      }),
      spin: 0.16,
    },
    {
      title: '虹彩薄膜',
      subtitle: 'IRIDESCENCE IOR 1.9',
      geometry: new THREE.TorusGeometry(0.28, 0.1, 48, 128),
      material: new THREE.MeshPhysicalMaterial({
        color: 0x8f96a2,
        metalness: 1.0,
        roughness: 0.14,
        iridescence: 1.0,
        iridescenceIOR: 1.9,
        iridescenceThicknessRange: [240, 1000],
        envMapIntensity: 1.5,
      }),
      spin: -0.24,
    },
    {
      title: '拉丝金属',
      subtitle: 'ANISOTROPY 1.0',
      geometry: new RoundedBoxGeometry(0.5, 0.5, 0.5, 8, 0.12),
      material: new THREE.MeshPhysicalMaterial({
        color: 0xc9d2de,
        metalness: 1.0,
        roughness: 0.24,
        anisotropy: 1.0,
        anisotropyRotation: Math.PI * 0.5,
        envMapIntensity: 1.25,
      }),
      spin: 0.2,
    },
    {
      title: '光学玻璃',
      subtitle: 'TRANSMISSION 1.0',
      geometry: new THREE.CapsuleGeometry(0.185, 0.36, 16, 40),
      material: new THREE.MeshPhysicalMaterial({
        color: 0xf4fbff,
        metalness: 0.0,
        roughness: 0.03,
        transmission: 1.0,
        ior: 1.55,
        thickness: 0.45,
        attenuationDistance: 9,
        attenuationColor: new THREE.Color(0xbfe6ff),
        specularIntensity: 1.0,
        envMapIntensity: 1.7,
      }),
      spin: 0.13,
    },
    {
      title: '绒面织物',
      subtitle: 'SHEEN 1.0',
      geometry: new THREE.ConeGeometry(0.3, 0.62, 64, 1),
      material: new THREE.MeshPhysicalMaterial({
        color: 0x5c2b4c,
        metalness: 0.0,
        roughness: 0.95,
        sheen: 1.0,
        sheenRoughness: 0.34,
        sheenColor: new THREE.Color(0xffa8cd),
        envMapIntensity: 0.85,
      }),
      spin: -0.18,
    },
    {
      title: '镜面金属',
      subtitle: 'METALNESS 1.0',
      geometry: new THREE.TorusKnotGeometry(0.235, 0.082, 220, 36),
      material: new THREE.MeshPhysicalMaterial({
        color: 0xf4f6fa,
        metalness: 1.0,
        roughness: 0.045,
        envMapIntensity: 1.7,
      }),
      spin: 0.3,
    },
    {
      title: '自发光体',
      subtitle: 'EMISSIVE 2.1',
      geometry: new THREE.IcosahedronGeometry(0.34, 1),
      material: new THREE.MeshPhysicalMaterial({
        color: 0x0d1218,
        metalness: 0.15,
        roughness: 0.3,
        emissive: new THREE.Color(0x2ad4ff),
        emissiveIntensity: 2.1,
        flatShading: true,
        envMapIntensity: 0.9,
      }),
      spin: 0.26,
    },
    {
      title: '珠光薄层',
      subtitle: 'CLEARCOAT + IRIDESCENCE',
      geometry: new THREE.CylinderGeometry(0.28, 0.28, 0.48, 72, 1),
      material: new THREE.MeshPhysicalMaterial({
        color: 0xf6ecff,
        metalness: 0.2,
        roughness: 0.16,
        clearcoat: 1.0,
        clearcoatRoughness: 0.08,
        iridescence: 0.85,
        iridescenceIOR: 1.5,
        iridescenceThicknessRange: [220, 900],
        transmission: 0.35,
        ior: 1.35,
        thickness: 0.45,
        envMapIntensity: 1.35,
      }),
      spin: -0.14,
    },
  ];
}

function createMaterialLab(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'material-lab';

  const anisotropy = Math.min(8, ctx.renderer.capabilities.getMaxAnisotropy());

  /* ---------------- 地面与背景 ---------------- */

  const ground = ctx.env.createGround(22);
  // 换成全哑光地面，避免大面积地板被三点光刷成大片灰亮反光。
  makeGroundMatte(ground, 0x0a0c11);
  root.add(ground);
  addGroundVignette(root, 22, 0.006, 0.95);

  // 影棚背景幕：竖向渐变，让展台从暗处浮出来。
  const backdropTexture = createVerticalGradientTexture([
    [0, '#39496e'],
    [0.38, '#1d2740'],
    [0.72, '#101725'],
    [1, '#06080e'],
  ]);
  const backdropMaterial = new THREE.MeshBasicMaterial({ map: backdropTexture, toneMapped: true });
  const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(62, 18), backdropMaterial);
  backdrop.position.set(0, 4.4, -14);
  root.add(backdrop);

  /* ---------------- 灯光 ---------------- */

  root.add(ctx.env.createStudioLights());

  // 冷色补光 + 暖色轮廓光，拉开材质边缘。
  const coolLight = new THREE.PointLight(0x86b6ff, 13, 16, 2);
  coolLight.position.set(-5.4, 2.8, 2.6);
  root.add(coolLight);

  const warmLight = new THREE.PointLight(0xffb27a, 9, 16, 2);
  warmLight.position.set(5.2, 2.4, 1.4);
  root.add(warmLight);

  const rimLight = new THREE.DirectionalLight(0xd6e6ff, 1.5);
  rimLight.position.set(0.5, 3.2, -6);
  root.add(rimLight);

  // 展台后方的柔光条：把展品轮廓从背景里勾出来。
  const backStrip = new THREE.Mesh(
    new THREE.BoxGeometry(BENCH_WIDTH * 0.92, 0.06, 0.02),
    new THREE.MeshBasicMaterial({ color: 0x3f6cc4, toneMapped: false }),
  );
  backStrip.position.set(0, 0.34, -1.45);
  root.add(backStrip);

  /* ---------------- 展台 ---------------- */

  const benchMaterial = new THREE.MeshStandardMaterial({
    color: 0x0d1016,
    roughness: 0.62,
    metalness: 0.22,
  });
  const bench = new THREE.Mesh(new RoundedBoxGeometry(BENCH_WIDTH, BENCH_TOP, 1.7, 4, 0.04), benchMaterial);
  bench.position.y = BENCH_TOP * 0.5;
  bench.castShadow = true;
  bench.receiveShadow = true;
  root.add(bench);

  const pedestalMaterial = new THREE.MeshStandardMaterial({
    color: 0x191d26,
    roughness: 0.88,
    metalness: 0.08,
  });
  const stripMaterial = new THREE.MeshBasicMaterial({ color: 0x6fa0ff, toneMapped: false });
  const samples = buildSamples();
  const spinners: Array<{ mesh: THREE.Mesh; spin: number; baseY: number; phase: number }> = [];

  for (let i = 0; i < SLOT_COUNT; i += 1) {
    const spec = samples[i];
    const offset = i - (SLOT_COUNT - 1) * 0.5;
    const x = offset * SLOT_SPACING;
    const z = -Math.abs(offset) * 0.13;

    const pedestal = new THREE.Mesh(
      new RoundedBoxGeometry(0.92, PEDESTAL_HEIGHT, 0.92, 4, 0.03),
      pedestalMaterial,
    );
    pedestal.position.set(x, BENCH_TOP + PEDESTAL_HEIGHT * 0.5, z);
    pedestal.castShadow = true;
    pedestal.receiveShadow = true;
    root.add(pedestal);

    // 展台前沿的轮廓光条。
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.018, 0.02), stripMaterial);
    strip.position.set(x, PEDESTAL_TOP - 0.07, z + 0.465);
    root.add(strip);

    // 展品：几何体按包围盒落在展台面上。
    spec.geometry.computeBoundingBox();
    const bounds = spec.geometry.boundingBox;
    const halfHeight = bounds ? bounds.max.y - bounds.min.y : 0;
    const baseY = PEDESTAL_TOP + halfHeight;

    const mesh = new THREE.Mesh(spec.geometry, spec.material);
    mesh.position.set(x, baseY, z);
    mesh.rotation.y = Math.atan2(-x, VIEW_DISTANCE - z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
    spinners.push({ mesh, spin: spec.spin, baseY, phase: i * 0.7 });

    // 展品标签（永远面向相机）。
    const label = createLabelSprite(spec.title, spec.subtitle, 1.32, anisotropy);
    label.position.set(x, BENCH_TOP + PEDESTAL_HEIGHT * 0.42, z + 0.7);
    root.add(label);

    // 透射样品的背光板：给玻璃一个可以折射的柔光源。
    if (i === 3) {
      const lightPanel = new THREE.Mesh(
        new THREE.PlaneGeometry(1.3, 2.0),
        new THREE.MeshBasicMaterial({
          map: createRadialGlowTexture(128, 'rgba(200,225,255,0.95)'),
          color: 0x9fc6ff,
          transparent: true,
          opacity: 0.85,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          toneMapped: false,
        }),
      );
      lightPanel.position.set(x, 1.25, -1.9);
      root.add(lightPanel);
    }
  }

  // 展台上方的柔光箱：把画面上半部分变成影棚结构，同时给展品补一层顶光感。
  const softbox = new THREE.Mesh(
    new RoundedBoxGeometry(BENCH_WIDTH * 0.86, 0.16, 0.46, 3, 0.05),
    new THREE.MeshStandardMaterial({ color: 0x1b2029, roughness: 0.55, metalness: 0.6 }),
  );
  softbox.position.set(0, 2.62, -0.2);
  root.add(softbox);

  const softboxStrip = new THREE.Mesh(
    new THREE.BoxGeometry(BENCH_WIDTH * 0.82, 0.03, 0.05),
    new THREE.MeshBasicMaterial({ color: 0xdce8ff, toneMapped: false }),
  );
  softboxStrip.position.set(0, 2.53, 0.03);
  root.add(softboxStrip);

  /* ---------------- 实例 ---------------- */

  const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 120);

  return {
    root,
    camera,
    immersive: false,
    ownsCamera: false,
    xrDistance: 3,
    framing: { distance: 8.4, height: 2.05, targetY: 1.22, width: BENCH_WIDTH + 1.2 },

    update(time, delta, sceneCtx) {
      // 扁平模式下核心层会把根节点后移，这里复位；XR 中保持在用户正前方。
      root.position.z = sceneCtx.isXR ? -3 : 0;

      for (const spinner of spinners) {
        spinner.mesh.rotation.y += spinner.spin * delta;
        // 展品整体轻微起伏，制造“展示中”的呼吸感。
        spinner.mesh.position.y = spinner.baseY + Math.sin(time * 0.7 + spinner.phase) * 0.012;
      }
    },

    dispose() {
      disposeHierarchy(root);
      root.clear();
    },
  };
}

export const materialLabScene: SceneDefinition = {
  id: 'material-lab',
  title: '材质实验室',
  subtitle: 'Material Lab',
  description: '八件程序化几何体共用同一套影棚光，各自演示一种 PBR 材质特性。',
  tags: ['材质', 'PBR', '展台'],
  accent: '#7aa2ff',
  gradient: ['#1c2742', '#080b12'],
  category: 'model',
  create: (ctx) => createMaterialLab(ctx),
};

export default materialLabScene;
