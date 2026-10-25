/**
 * 机械守卫 —— 加载 RobotExpressive.glb 并播放它自带的动画。
 *
 * 模型会被归一化到真实尺度（脚底贴地、居中），放在带反射的金属展台上；
 * 相机绕着它缓慢轨道，XR 中则改为转动展示台。
 */
import * as THREE from 'three';
import type { SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { assetUrl } from '../../core/loader.js';
import {
  addGroundVignette,
  createBlobShadowTexture,
  createRadialGlowTexture,
  createVerticalGradientTexture,
  disposeHierarchy,
  fitModel,
  loadGLTFWithClips,
  makeGroundMatte,
} from './shared.js';

/** 目标身高（米）。 */
const TARGET_HEIGHT = 1.85;
/** 相机轨道半径。 */
const ORBIT_RADIUS = 5.1;
/** 展台转速（rad/s）。 */
const TURNTABLE_SPEED = 0.22;
/** 金属展台顶面高度。 */
const STAGE_TOP = 0.1;

/** 加载失败时的程序化占位体。 */
function createFallbackRobot(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'fallback-robot';

  const material = new THREE.MeshStandardMaterial({
    color: 0x8d949e,
    roughness: 0.45,
    metalness: 0.6,
  });
  const accent = new THREE.MeshStandardMaterial({
    color: 0x1b2028,
    roughness: 0.6,
    metalness: 0.3,
  });

  const add = (geometry: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number): void => {
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  };

  add(new THREE.BoxGeometry(0.52, 0.72, 0.3), material, 0, 1.24, 0);
  add(new THREE.BoxGeometry(0.34, 0.3, 0.32), accent, 0, 1.74, 0);
  add(new THREE.BoxGeometry(0.16, 0.5, 0.18), material, -0.38, 1.28, 0);
  add(new THREE.BoxGeometry(0.16, 0.5, 0.18), material, 0.38, 1.28, 0);
  add(new THREE.BoxGeometry(0.2, 0.6, 0.22), accent, -0.16, 0.58, 0);
  add(new THREE.BoxGeometry(0.2, 0.6, 0.22), accent, 0.16, 0.58, 0);
  return group;
}

async function createRobot(ctx: SceneContext): Promise<SceneInstance> {
  const root = new THREE.Group();
  root.name = 'robot';

  /* ---------------- 模型 ---------------- */

  const turntable = new THREE.Group();
  turntable.name = 'turntable';
  root.add(turntable);

  const holder = new THREE.Group();
  holder.name = 'robot-holder';
  turntable.add(holder);

  let animations: THREE.AnimationClip[] = [];
  let model: THREE.Group;
  try {
    const loaded = await loadGLTFWithClips(assetUrl('models/RobotExpressive.glb'));
    model = loaded.scene;
    animations = loaded.animations;
  } catch (error) {
    console.warn('[robot] RobotExpressive.glb 加载失败，已切换到程序化占位体：', error);
    model = createFallbackRobot();
  }
  holder.add(model);

  // 归一化：缩放到真实身高，脚底贴地，水平居中。
  const fit = fitModel(holder, TARGET_HEIGHT);
  holder.scale.setScalar(fit.scale);
  holder.position.set(fit.offset.x, fit.offset.y + STAGE_TOP, fit.offset.z);

  /* ---------------- 动画 ---------------- */

  const mixer = new THREE.AnimationMixer(model);
  let activeClip = '（无）';
  if (animations.length > 0) {
    const preferred = ['Walking', 'Idle', 'Dance'];
    let clip = animations[0];
    for (const name of preferred) {
      const found = animations.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
      if (found) {
        clip = found;
        break;
      }
    }
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.play();
    activeClip = clip.name;
  } else {
    console.warn('[robot] 模型没有可用的动画片段，已退化为静态展示。');
  }
  console.info(`[robot] 模型已就位，播放动画片段：${activeClip}`);

  /* ---------------- 影棚 ---------------- */

  const ground = ctx.env.createGround(20);
  makeGroundMatte(ground, 0x0a0c11);
  root.add(ground);
  addGroundVignette(root, 20, 0.006, 0.95);

  const studioMaterial = new THREE.MeshStandardMaterial({
    color: 0x12161d,
    roughness: 0.46,
    metalness: 0.58,
    envMapIntensity: 0.4,
  });
  const stage = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.7, STAGE_TOP, 96), studioMaterial);
  stage.position.y = STAGE_TOP * 0.5;
  stage.receiveShadow = true;
  root.add(stage);

  const ringMaterial = new THREE.MeshBasicMaterial({ color: 0x6fa0ff, toneMapped: false });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(2.56, 0.012, 8, 128), ringMaterial);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = STAGE_TOP + 0.005;
  root.add(ring);

  // 展台光池：让机器人像站在一束光里，接触阴影才有对比。
  const poolMaterial = new THREE.MeshBasicMaterial({
    map: createRadialGlowTexture(256, 'rgba(150,185,235,0.9)'),
    color: 0x8fb4e8,
    transparent: true,
    opacity: 0.14,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const lightPool = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 4.4), poolMaterial);
  lightPool.rotation.x = -Math.PI / 2;
  lightPool.position.y = STAGE_TOP + 0.004;
  lightPool.renderOrder = 1;
  root.add(lightPool);

  // 接触阴影：柔和的暗斑压在光池上。
  const shadowMaterial = new THREE.MeshBasicMaterial({
    map: createBlobShadowTexture(256),
    transparent: true,
    depthWrite: false,
    opacity: 0.9,
    color: 0x000000,
  });
  const contactShadow = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 1.7), shadowMaterial);
  contactShadow.rotation.x = -Math.PI / 2;
  contactShadow.position.y = STAGE_TOP + 0.008;
  contactShadow.renderOrder = 2;
  root.add(contactShadow);

  root.add(ctx.env.createStudioLights());

  const keyLight = new THREE.SpotLight(0xfff2e2, 90, 12, Math.PI * 0.22, 0.55, 1.6);
  keyLight.position.set(2.6, 4.4, 3.2);
  keyLight.target.position.set(0, 1.1, 0);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  keyLight.shadow.bias = -0.0009;
  keyLight.shadow.normalBias = 0.02;
  root.add(keyLight);
  root.add(keyLight.target);

  const rimLight = new THREE.SpotLight(0x86b6ff, 70, 12, Math.PI * 0.26, 0.6, 1.6);
  rimLight.position.set(-3.4, 3.2, -3.6);
  rimLight.target.position.set(0, 1.2, 0);
  root.add(rimLight);
  root.add(rimLight.target);

  const fillLight = new THREE.PointLight(0xffb27a, 12, 10, 2);
  fillLight.position.set(-1.8, 0.9, 2.6);
  root.add(fillLight);

  // 背景幕，给机器人一个柔和的轮廓衬底。
  const backdropTexture = createVerticalGradientTexture([
    [0, '#46598a'],
    [0.4, '#222c42'],
    [0.75, '#111823'],
    [1, '#05070c'],
  ]);
  const backdrop = new THREE.Mesh(
    new THREE.CylinderGeometry(12, 12, 8, 48, 1, true),
    new THREE.MeshBasicMaterial({ map: backdropTexture, side: THREE.BackSide, fog: false }),
  );
  backdrop.position.y = 1.6;
  root.add(backdrop);

  /* ---------------- 相机 ---------------- */

  const camera = new THREE.PerspectiveCamera(36, 1, 0.05, 80);
  const lookTarget = new THREE.Vector3(0, 1.0, 0);

  return {
    root,
    camera,
    immersive: false,
    ownsCamera: true,
    xrDistance: 3,
    framing: { distance: ORBIT_RADIUS, height: 1.75, targetY: 1.0 },

    update(time, delta, sceneCtx) {
      root.position.z = sceneCtx.isXR ? -3 : 0;

      mixer.update(delta);
      turntable.rotation.y += delta * TURNTABLE_SPEED;

      if (sceneCtx.isXR) {
        // XR 中相机由 three 接管，展示台的旋转负责制造运动感。
        return;
      }

      const angle = time * 0.16;
      const radius = ORBIT_RADIUS + Math.sin(time * 0.21) * 0.4;
      camera.position.set(Math.sin(angle) * radius, 1.75 + Math.sin(time * 0.33) * 0.2, Math.cos(angle) * radius);
      camera.lookAt(lookTarget);
    },

    dispose() {
      mixer.stopAllAction();
      mixer.uncacheRoot(model);
      disposeHierarchy(root);
      root.clear();
    },
  };
}

export const robotScene: SceneDefinition = {
  id: 'robot',
  title: '机械守卫',
  subtitle: 'Mechanical Sentinel',
  description: '带骨骼动画的机器人在金属展台上缓慢转动，镜头绕行一周。',
  tags: ['模型', '动画', '影棚'],
  accent: '#ff9d5c',
  gradient: ['#3a2417', '#0b0906'],
  category: 'model',
  create: (ctx) => createRobot(ctx),
};

export default robotScene;
