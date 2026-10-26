import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { SceneEnvironment } from '../scenes/types.js';

/**
 * 创建一套标准环境资源：
 * - RoomEnvironment 烘焙出的 IBL 环境贴图（柔和的室内影棚光）
 * - 三点布光灯组
 * - 阴影接收地面
 */
export function createEnvironment(renderer: THREE.WebGLRenderer): SceneEnvironment {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();

  const room = new RoomEnvironment();
  const envRT = pmrem.fromScene(room, 0.04);
  room.dispose();
  pmrem.dispose();

  const envMap = envRT.texture;
  envMap.name = 'room-environment';

  return {
    envMap,
    dispose: () => envRT.dispose(),

    createStudioLights() {
      const group = new THREE.Group();
      group.name = 'studio-lights';

      const key = new THREE.DirectionalLight(0xffffff, 2.6);
      key.position.set(4, 7, 5);
      key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      key.shadow.camera.near = 0.5;
      key.shadow.camera.far = 30;
      key.shadow.camera.left = -8;
      key.shadow.camera.right = 8;
      key.shadow.camera.top = 8;
      key.shadow.camera.bottom = -8;
      key.shadow.bias = -0.0008;
      key.shadow.normalBias = 0.02;
      group.add(key);

      const fill = new THREE.DirectionalLight(0x9fc7ff, 0.9);
      fill.position.set(-5, 3, 2);
      group.add(fill);

      const rim = new THREE.DirectionalLight(0xffb27a, 1.1);
      rim.position.set(-2, 4, -6);
      group.add(rim);

      const ambient = new THREE.AmbientLight(0xffffff, 0.18);
      group.add(ambient);

      return group;
    },

    createGround(size = 24) {
      const geometry = new THREE.PlaneGeometry(size, size);
      const material = new THREE.MeshStandardMaterial({
        color: 0x12141a,
        roughness: 0.85,
        metalness: 0.0,
      });
      const ground = new THREE.Mesh(geometry, material);
      ground.name = 'ground';
      ground.rotation.x = -Math.PI / 2;
      ground.receiveShadow = true;
      return ground;
    },
  };
}
