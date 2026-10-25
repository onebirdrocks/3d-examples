/**
 * 「模型 / 材质展示」场景的共享辅助。
 *
 * 这里只放与业务无关的小工具：标签贴图、渐变 / 辉光贴图、
 * glTF 加载（带动画片段）、模型归一化与资源释放。
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/* ------------------------------------------------------------------ *
 * 贴图
 * ------------------------------------------------------------------ */

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 中文优先的字体栈，Canvas 与 DOM 均可渲染。 */
const SANS = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,-apple-system,sans-serif';
const MONO = 'ui-monospace,"SF Mono",Menlo,Consolas,monospace';

/**
 * 材质标签贴图：深色磨砂面板 + 中文标题 + 等宽英文参数。
 */
export function createLabelTexture(title: string, subtitle: string, anisotropy = 4): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 224;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const panel = ctx.createLinearGradient(0, 0, 0, canvas.height);
  panel.addColorStop(0, 'rgba(16,22,36,0.92)');
  panel.addColorStop(1, 'rgba(6,9,16,0.8)');
  roundRect(ctx, 6, 6, canvas.width - 12, canvas.height - 12, 28);
  ctx.fillStyle = panel;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(150,190,255,0.45)';
  ctx.stroke();

  ctx.fillStyle = 'rgba(122,162,255,0.95)';
  roundRect(ctx, 36, 58, 9, 108, 5);
  ctx.fill();

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#f2f7ff';
  ctx.font = `600 84px ${SANS}`;
  ctx.fillText(title, 70, 116);
  ctx.fillStyle = '#93abce';
  ctx.font = `500 46px ${MONO}`;
  ctx.fillText(subtitle, 70, 178);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  return texture;
}

/** 带文字标签的精灵（始终面向相机）。 */
export function createLabelSprite(title: string, subtitle: string, width = 1.6, anisotropy = 4): THREE.Sprite {
  const texture = createLabelTexture(title, subtitle, anisotropy);
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(width, width * 0.219, 1);
  sprite.renderOrder = 4;
  return sprite;
}

/** 纵向渐变贴图（stops = [位置, 颜色]）。 */
export function createVerticalGradientTexture(
  stops: readonly (readonly [number, string])[],
  height = 512,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');

  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  for (const [offset, color] of stops) gradient.addColorStop(offset, color);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** 径向辉光贴图（用于点光 / 假 bloom）。 */
export function createRadialGlowTexture(size = 128, core = 'rgba(255,255,255,1)'): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');

  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, core);
  gradient.addColorStop(0.28, 'rgba(255,255,255,0.45)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** 柔和的接触阴影贴图（径向衰减的黑色）。 */
export function createBlobShadowTexture(size = 256): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');

  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(0,0,0,0.78)');
  gradient.addColorStop(0.45, 'rgba(0,0,0,0.34)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

/**
 * 地面渐隐贴图：中心透明、边缘全黑。
 * 铺在大面积地面上可以压掉 IBL 带来的灰亮反光，并藏住地面边界。
 */
export function createVignetteTexture(size = 256): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');

  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(0,0,0,0)');
  gradient.addColorStop(0.06, 'rgba(0,0,0,0)');
  gradient.addColorStop(0.26, 'rgba(0,0,0,0.8)');
  gradient.addColorStop(0.46, 'rgba(0,0,0,1)');
  gradient.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

/**
 * 给一块大地面铺上渐隐遮罩：压暗边缘、藏住边界。
 * 返回的遮罩需要由调用方释放。
 */
export function addGroundVignette(
  root: THREE.Object3D,
  size: number,
  y = 0.004,
  opacity = 1,
): THREE.Mesh {
  const texture = createVignetteTexture(256);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity,
    depthWrite: false,
    color: 0x000000,
  });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(size, size), material);
  plane.rotation.x = -Math.PI / 2;
  plane.position.y = y;
  root.add(plane);
  return plane;
}

/**
 * 把核心层给出的地面换成全哑光材质。
 * 默认地面在三点光下会泛出一大片灰色高光，影棚场景里需要压掉。
 */
export function makeGroundMatte(ground: THREE.Object3D, color = 0x0a0c11): THREE.MeshPhysicalMaterial {
  const mesh = ground as THREE.Mesh;
  const previous = mesh.material;
  const material = new THREE.MeshPhysicalMaterial({
    color,
    roughness: 1,
    metalness: 0,
    specularIntensity: 0.06,
    envMapIntensity: 0.12,
  });
  mesh.material = material;
  if (Array.isArray(previous)) previous.forEach((entry) => entry.dispose());
  else previous.dispose();
  return material;
}

/* ------------------------------------------------------------------ *
 * glTF
 * ------------------------------------------------------------------ */

export interface LoadedModel {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
}

/**
 * 加载 glTF 并同时取回动画片段。
 * 核心层的 `loadGLTFInstance` 只返回模型树，会丢掉动画数据，
 * 因此需要播放内置动画的场景使用这个辅助。
 */
export function loadGLTFWithClips(url: string): Promise<LoadedModel> {
  return new Promise<LoadedModel>((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.load(
      url,
      (gltf) => {
        gltf.scene.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.castShadow = true;
            child.receiveShadow = true;
          }
        });
        resolve({ scene: gltf.scene, animations: gltf.animations });
      },
      undefined,
      (error) => reject(error),
    );
  });
}

/* ------------------------------------------------------------------ *
 * 模型归一化
 * ------------------------------------------------------------------ */

/**
 * 计算子树在世界空间的包围盒（对骨骼网格做蒙皮修正）。
 */
export function computeWorldBox(root: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3();
  root.updateMatrixWorld(true);
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    if (child instanceof THREE.SkinnedMesh) {
      child.computeBoundingBox();
      if (child.boundingBox) box.union(child.boundingBox.clone().applyMatrix4(child.matrixWorld));
      return;
    }
    const geometry = child.geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    if (geometry.boundingBox) box.union(geometry.boundingBox.clone().applyMatrix4(child.matrixWorld));
  });
  return box;
}

export interface ModelFit {
  /** 需要的缩放系数。 */
  scale: number;
  /** 需要施加的位置偏移（父空间）。 */
  offset: THREE.Vector3;
}

/**
 * 把模型缩放到目标高度，并把底部对齐到 y = 0、水平方向居中。
 */
export function fitModel(root: THREE.Object3D, targetHeight: number): ModelFit {
  const box = computeWorldBox(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const scale = size.y > 1e-5 ? targetHeight / size.y : 1;
  const offset = new THREE.Vector3(-center.x * scale, -box.min.y * scale, -center.z * scale);
  return { scale, offset };
}

/* ------------------------------------------------------------------ *
 * 释放
 * ------------------------------------------------------------------ */

const SKIP_TEXTURE_KEYS = new Set(['envMap']);

/** 释放材质及其贴图（跳过共享的 envMap）。 */
export function disposeMaterial(material: THREE.Material): void {
  const record = material as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (SKIP_TEXTURE_KEYS.has(key)) continue;
    const value = record[key];
    if (value && (value as THREE.Texture).isTexture) (value as THREE.Texture).dispose();
  }
  material.dispose();
}

/** 递归释放子树的几何体、材质与贴图。 */
export function disposeHierarchy(root: THREE.Object3D): void {
  root.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.Points || child instanceof THREE.Line) {
      child.geometry?.dispose();
      const material = child.material;
      if (Array.isArray(material)) material.forEach((entry) => disposeMaterial(entry));
      else if (material) disposeMaterial(material);
    }
    if (child instanceof THREE.Sprite) {
      const material = child.material;
      if (Array.isArray(material)) material.forEach((entry) => disposeMaterial(entry));
      else if (material) disposeMaterial(material);
    }
  });
}
