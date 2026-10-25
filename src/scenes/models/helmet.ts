/**
 * 头盔工坊 —— DamagedHelmet 的影棚展示与扫描分析。
 *
 * 头盔以 IBL 为主光塑形，放在缓慢自转的金属转台上，
 * 周围有刻度环与扫描线强化“工坊 / 扫描”的气质，相机缓慢绕行。
 */
import * as THREE from 'three';
import type { SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { assetUrl, disposeObject, loadGLTFInstance } from '../../core/loader.js';
import {
  addGroundVignette,
  createRadialGlowTexture,
  createVerticalGradientTexture,
  makeGroundMatte,
} from './shared.js';

/** 头盔目标高度（米）。 */
const TARGET_HEIGHT = 0.26;
/** 转台高度。 */
const PLINTH_HEIGHT = 0.05;

async function createHelmet(ctx: SceneContext): Promise<SceneInstance> {
  const root = new THREE.Group();
  root.name = 'helmet';

  /** 需要单独释放的自建贴图。 */
  const ownTextures: THREE.Texture[] = [];

  /* ---------------- 模型 ---------------- */

  const turntable = new THREE.Group();
  turntable.name = 'turntable';
  root.add(turntable);

  const holder = new THREE.Group();
  holder.name = 'helmet-holder';
  turntable.add(holder);

  let model: THREE.Group;
  try {
    model = await loadGLTFInstance(assetUrl('models/DamagedHelmet/DamagedHelmet.gltf'));
  } catch (error) {
    console.warn('[helmet] DamagedHelmet.gltf 加载失败，已切换到程序化占位体：', error);
    const placeholderMaterial = new THREE.MeshStandardMaterial({
      color: 0x8a8f98,
      roughness: 0.42,
      metalness: 0.85,
    });
    model = new THREE.Group();
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.15, 48, 32, 0, Math.PI * 2, 0, Math.PI * 0.62), placeholderMaterial);
    dome.castShadow = true;
    dome.receiveShadow = true;
    model.add(dome);
  }
  holder.add(model);

  // 统一 IBL 强度，让贴图在环境光下更有质感。
  model.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = true;
      child.receiveShadow = true;
      const material = child.material;
      if (Array.isArray(material)) material.forEach((entry) => (entry.envMapIntensity = 1.35));
      else material.envMapIntensity = 1.35;
    }
  });

  // 归一化：统一到真实尺寸，底部对齐转台，水平居中。
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const fitScale = size.y > 1e-5 ? TARGET_HEIGHT / size.y : 1;
  holder.scale.setScalar(fitScale);
  // 原始模型正面朝 -Z，转 180° 让面罩朝向镜头。
  model.rotation.y = Math.PI;
  holder.position.set(-center.x * fitScale, -box.min.y * fitScale + PLINTH_HEIGHT, -center.z * fitScale);

  /* ---------------- 工坊环境 ---------------- */

  const ground = ctx.env.createGround(14);
  makeGroundMatte(ground, 0x0a0c11);
  root.add(ground);
  addGroundVignette(root, 14, 0.004, 0.92);

  const backdropTexture = createVerticalGradientTexture([
    [0, '#41547e'],
    [0.34, '#3d5078'],
    [0.52, '#1b2435'],
    [0.74, '#2f3d5c'],
    [1, '#41547e'],
  ]);
  ownTextures.push(backdropTexture);
  const backdrop = new THREE.Mesh(
    new THREE.CylinderGeometry(3.4, 3.4, 3.2, 48, 1, true),
    new THREE.MeshBasicMaterial({ map: backdropTexture, side: THREE.BackSide, fog: false }),
  );
  backdrop.position.y = 1.2;
  root.add(backdrop);

  const plinthMaterial = new THREE.MeshStandardMaterial({
    color: 0x1b1f27,
    roughness: 0.24,
    metalness: 0.9,
    envMapIntensity: 0.95,
  });
  const plinth = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.3, PLINTH_HEIGHT, 72), plinthMaterial);
  plinth.position.y = PLINTH_HEIGHT * 0.5;
  plinth.castShadow = true;
  plinth.receiveShadow = true;
  turntable.add(plinth);

  const plinthRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.275, 0.004, 8, 96),
    new THREE.MeshBasicMaterial({ color: 0x4f7fd8, toneMapped: false }),
  );
  plinthRing.rotation.x = Math.PI / 2;
  plinthRing.position.y = PLINTH_HEIGHT - 0.006;
  turntable.add(plinthRing);

  /* ---------------- 灯光 ---------------- */

  root.add(ctx.env.createStudioLights());

  const keyLight = new THREE.SpotLight(0xfff4e6, 14, 8, Math.PI * 0.3, 0.6, 1.5);
  keyLight.position.set(1.1, 2.0, 1.4);
  keyLight.target.position.set(0, 0.2, 0);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  keyLight.shadow.bias = -0.0008;
  keyLight.shadow.normalBias = 0.015;
  root.add(keyLight);
  root.add(keyLight.target);

  const rimLight = new THREE.SpotLight(0x7fb0ff, 11, 8, Math.PI * 0.32, 0.7, 1.5);
  rimLight.position.set(-1.6, 1.3, -1.5);
  rimLight.target.position.set(0, 0.22, 0);
  root.add(rimLight);
  root.add(rimLight.target);

  const kicker = new THREE.PointLight(0xffa060, 1.3, 4, 2);
  kicker.position.set(-0.6, 0.35, 1.1);
  root.add(kicker);

  /* ---------------- 刻度环与扫描线 ---------------- */

  const tickMaterial = new THREE.MeshBasicMaterial({ color: 0x1b2f52, toneMapped: false });
  const tickGeometry = new THREE.BoxGeometry(0.0035, 0.018, 0.009);
  const tickCount = 48;
  const ticks = new THREE.InstancedMesh(tickGeometry, tickMaterial, tickCount);
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const tickScale = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const euler = new THREE.Euler();
  for (let i = 0; i < tickCount; i += 1) {
    const angle = (i / tickCount) * Math.PI * 2;
    const major = i % 4 === 0;
    position.set(Math.cos(angle) * 0.34, PLINTH_HEIGHT + 0.014, Math.sin(angle) * 0.34);
    euler.set(0, -angle, 0);
    quaternion.setFromEuler(euler);
    tickScale.set(1, major ? 1.9 : 1, major ? 1.5 : 1);
    matrix.compose(position, quaternion, tickScale);
    ticks.setMatrixAt(i, matrix);
  }
  ticks.instanceMatrix.needsUpdate = true;
  root.add(ticks);

  const majorTickMaterial = new THREE.MeshBasicMaterial({ color: 0x3a5c92, toneMapped: false });
  const majorTicks = new THREE.InstancedMesh(new THREE.BoxGeometry(0.0045, 0.032, 0.011), majorTickMaterial, 12);
  for (let i = 0; i < 12; i += 1) {
    const angle = (i / 12) * Math.PI * 2;
    position.set(Math.cos(angle) * 0.42, PLINTH_HEIGHT + 0.022, Math.sin(angle) * 0.42);
    euler.set(0, -angle, 0);
    quaternion.setFromEuler(euler);
    tickScale.set(1, 1, 1);
    matrix.compose(position, quaternion, tickScale);
    majorTicks.setMatrixAt(i, matrix);
  }
  majorTicks.instanceMatrix.needsUpdate = true;
  root.add(majorTicks);

  // 缓慢倾斜旋转的扫描环。
  const scanRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.23, 0.0022, 6, 128),
    new THREE.MeshBasicMaterial({ color: 0x4f9fd0, toneMapped: false }),
  );
  scanRing.position.y = 0.17;
  root.add(scanRing);

  // 竖直扫描光片。
  const scanSheetTexture = createRadialGlowTexture(128, 'rgba(150,220,255,0.9)');
  ownTextures.push(scanSheetTexture);
  const scanSheetMaterial = new THREE.MeshBasicMaterial({
    map: scanSheetTexture,
    color: 0x6fd0ff,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const scanSheet = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5), scanSheetMaterial);
  scanSheet.rotation.x = -Math.PI / 2;
  root.add(scanSheet);

  /* ---------------- 相机 ---------------- */

  const camera = new THREE.PerspectiveCamera(34, 1, 0.02, 40);
  const lookTarget = new THREE.Vector3(0, 0.155, 0);

  return {
    root,
    camera,
    immersive: false,
    ownsCamera: true,
    xrDistance: 2.5,
    framing: { distance: 1.15, height: 0.28, targetY: 0.155 },

    update(time, delta, sceneCtx) {
      root.position.z = sceneCtx.isXR ? -2.5 : 0;

      turntable.rotation.y += delta * 0.35;
      ticks.rotation.y -= delta * 0.12;
      majorTicks.rotation.y -= delta * 0.06;

      // 扫描环：倾斜 + 上下浮动。
      const sweep = (time * 0.18) % (Math.PI * 2);
      scanRing.rotation.set(Math.PI / 2 + Math.sin(sweep) * 0.7, sweep * 0.6, Math.cos(sweep) * 0.35);
      scanRing.position.y = 0.15 + Math.sin(time * 0.55) * 0.06;

      // 扫描光片：自下而上循环扫过头盔。
      const scanPhase = (time * 0.22) % 1;
      scanSheet.position.y = 0.02 + scanPhase * 0.3;
      scanSheetMaterial.opacity = 0.06 + 0.22 * Math.sin(scanPhase * Math.PI);

      if (sceneCtx.isXR) return;

      const angle = time * 0.22;
      const radius = 1.12 + Math.sin(time * 0.27) * 0.07;
      camera.position.set(Math.sin(angle) * radius, 0.27 + Math.sin(time * 0.35) * 0.04, Math.cos(angle) * radius);
      camera.lookAt(lookTarget);
    },

    dispose() {
      disposeObject(root);
      ownTextures.forEach((texture) => texture.dispose());
      root.clear();
    },
  };
}

export const helmetScene: SceneDefinition = {
  id: 'helmet',
  title: '头盔工坊',
  subtitle: 'Helmet Workshop',
  description: '经典 PBR 头盔在影棚灯下缓慢转动，刻度环与扫描线勾勒出工坊的质感。',
  tags: ['模型', 'PBR', '扫描'],
  accent: '#8fd8ff',
  gradient: ['#16304a', '#05070c'],
  category: 'model',
  create: (ctx) => createHelmet(ctx),
};

export default helmetScene;
