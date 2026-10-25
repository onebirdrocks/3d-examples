import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';

/** 拼接 Vite base 与 public 资源路径，得到可直接用于 fetch 的 URL。 */
export function assetUrl(path: string): string {
  const base = import.meta.env.BASE_URL || '/';
  return `${base.endsWith('/') ? base : `${base}/`}${path.replace(/^\//, '')}`;
}

const templates = new Map<string, Promise<THREE.Group>>();

/**
 * 加载 glTF 模板（同一 URL 只下载一次）。
 * 模板本身不会被直接放进场景，调用方应使用 loadGLTFInstance 拿到可独立驱动的副本。
 */
export function loadGLTF(url: string): Promise<THREE.Group> {
  const cached = templates.get(url);
  if (cached) return cached;

  const promise = new Promise<THREE.Group>((resolve, reject) => {
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
        resolve(gltf.scene);
      },
      undefined,
      (error) => reject(error),
    );
  });

  templates.set(url, promise);
  return promise;
}

/**
 * 获取一个独立的 glTF 副本（保留骨骼与动画）。
 * 适合「缩略图烘焙后销毁、再重新实例化」的场景。
 */
export async function loadGLTFInstance(url: string): Promise<THREE.Group> {
  const template = await loadGLTF(url);
  const instance = cloneSkeleton(template) as THREE.Group;
  instance.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
  return instance;
}

/** 递归释放一棵子树的几何体与材质（共享材质会被释放多次，three 内部有幂等保护）。 */
export function disposeObject(root: THREE.Object3D): void {
  root.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.Points || child instanceof THREE.Line) {
      child.geometry?.dispose();
      const material = child.material;
      if (Array.isArray(material)) {
        material.forEach((m) => m.dispose());
      } else {
        material?.dispose();
      }
    }
  });
}
