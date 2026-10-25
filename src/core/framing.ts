import * as THREE from 'three';
import type { PerspectiveCamera } from 'three';
import type { SceneFraming } from '../scenes/types.js';

/**
 * 根据画幅比例计算相机到内容中心的实际距离。
 *
 * 场景声明的 `distance` 是理想距离；一旦声明了 `width`（需要横向覆盖的宽度），
 * 则按当前画幅反推所需距离，取两者较大值，保证窄画幅下内容也不会被裁切。
 * 画廊缩略图（固定 16:10）与网页查看器（跟随窗口）共用这套逻辑，构图保持一致。
 */
export function computeFramingDistance(camera: PerspectiveCamera, framing: SceneFraming): number {
  const halfVertical = THREE.MathUtils.degToRad(camera.fov) / 2;
  const aspect = camera.aspect > 0 ? camera.aspect : 1;
  const halfHorizontal = Math.atan(Math.tan(halfVertical) * aspect);

  let distance = framing.distance;
  if (framing.width) {
    const required = framing.width / 2 / Math.tan(halfHorizontal);
    distance = Math.max(distance, required);
  }
  return distance;
}

/** 把场景相机摆到取景建议的位置。 */
export function applyFraming(camera: PerspectiveCamera, framing: SceneFraming): void {
  const distance = computeFramingDistance(camera, framing);
  camera.position.set(0, framing.height, distance);
  camera.lookAt(0, framing.targetY, 0);
  camera.updateProjectionMatrix();
}
