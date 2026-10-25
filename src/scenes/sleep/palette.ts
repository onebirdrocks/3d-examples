/**
 * 助眠场景共用的小工具。
 *
 * 这里的颜色一律偏暗、偏冷：助眠场景要「看得清主体」，但绝不能刺眼。
 */
import * as THREE from 'three';
import type { SceneCategory } from '../types.js';

/**
 * 「助眠」分类。
 *
 * `SceneDefinition.category` 的类型是 `SceneCategory`（定义在 `src/scenes/types.ts`，
 * 那个文件由宿主维护）。本目录不改动它，而是用一次显式转换把 `'sleep'` 送进去：
 * 这样无论宿主何时把 `'sleep'` 登记进联合类型，这里都能正常编译，两边互不覆盖。
 */
export const SLEEP_CATEGORY = 'sleep' satisfies SceneCategory;

/**
 * 把核心给的三点布光调暗并去掉阴影：助眠场景只需要一点极弱的底光。
 */
export function dimLights(lights: THREE.Object3D, factor: number, tint?: number): void {
  lights.traverse((child) => {
    if (child instanceof THREE.Light) {
      child.intensity *= factor;
      child.castShadow = false;
      if (tint !== undefined) child.color.setHex(tint);
    }
  });
}

/**
 * 给标准材质显式挂上环境贴图。
 *
 * three r186 的坑：`material.envMapIntensity` 只有在显式设置 `material.envMap` 时才生效；
 * 只依赖 `scene.environment` 的话 IBL 是满强度，画面会被刷白。
 */
export function configureStandard(
  material: THREE.MeshStandardMaterial,
  envMap: THREE.Texture,
  envMapIntensity: number,
): void {
  material.envMap = envMap;
  material.envMapIntensity = envMapIntensity;
  material.needsUpdate = true;
}
