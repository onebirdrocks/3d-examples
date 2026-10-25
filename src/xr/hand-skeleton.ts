import * as THREE from 'three';

/** WebXR 手部关节名（three 写在 `renderer.xr.getHand(i).joints` 里）。 */
const JOINTS = [
  'wrist',
  'thumb-metacarpal',
  'thumb-phalanx-proximal',
  'thumb-phalanx-distal',
  'thumb-tip',
  'index-finger-metacarpal',
  'index-finger-phalanx-proximal',
  'index-finger-phalanx-intermediate',
  'index-finger-phalanx-distal',
  'index-finger-tip',
  'middle-finger-metacarpal',
  'middle-finger-phalanx-proximal',
  'middle-finger-phalanx-intermediate',
  'middle-finger-phalanx-distal',
  'middle-finger-tip',
  'ring-finger-metacarpal',
  'ring-finger-phalanx-proximal',
  'ring-finger-phalanx-intermediate',
  'ring-finger-phalanx-distal',
  'ring-finger-tip',
  'pinky-finger-metacarpal',
  'pinky-finger-phalanx-proximal',
  'pinky-finger-phalanx-intermediate',
  'pinky-finger-phalanx-distal',
  'pinky-finger-tip',
] as const;

/** 手指骨骼：父关节 → 子关节。 */
const BONES: [string, string][] = [
  ['wrist', 'thumb-metacarpal'],
  ['thumb-metacarpal', 'thumb-phalanx-proximal'],
  ['thumb-phalanx-proximal', 'thumb-phalanx-distal'],
  ['thumb-phalanx-distal', 'thumb-tip'],
  ['wrist', 'index-finger-metacarpal'],
  ['index-finger-metacarpal', 'index-finger-phalanx-proximal'],
  ['index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate'],
  ['index-finger-phalanx-intermediate', 'index-finger-phalanx-distal'],
  ['index-finger-phalanx-distal', 'index-finger-tip'],
  ['wrist', 'middle-finger-metacarpal'],
  ['middle-finger-metacarpal', 'middle-finger-phalanx-proximal'],
  ['middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate'],
  ['middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal'],
  ['middle-finger-phalanx-distal', 'middle-finger-tip'],
  ['wrist', 'ring-finger-metacarpal'],
  ['ring-finger-metacarpal', 'ring-finger-phalanx-proximal'],
  ['ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate'],
  ['ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal'],
  ['ring-finger-phalanx-distal', 'ring-finger-tip'],
  ['wrist', 'pinky-finger-metacarpal'],
  ['pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal'],
  ['pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate'],
  ['pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal'],
  ['pinky-finger-phalanx-distal', 'pinky-finger-tip'],
];

const BONE_RADIUS = 0.0075;

/**
 * 程序化的**手部骨架**：关节画成小球，骨骼画成细杆。
 *
 * three 自带的 `XRHandModelFactory` 只有 'spheres'（一堆关节球）与 'mesh'
 * （需要外部 glTF 手模型）两种 profile。这里用基础几何自己搭一副骨架：
 * 无需外部资产、任何设备都能跑，而且看起来像一副有意为之的"光之手"。
 */
export class HandSkeleton {
  readonly group = new THREE.Group();

  private readonly joints = new Map<string, THREE.Mesh>();
  private readonly bones: { mesh: THREE.Mesh; from: string; to: string }[] = [];
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly tmpMid = new THREE.Vector3();
  private readonly tmpDir = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(color = 0x9fc6ff) {
    this.group.name = 'hand-skeleton';

    const jointMaterial = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.85,
      toneMapped: false,
      depthWrite: false,
    });
    const boneMaterial = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.4,
      toneMapped: false,
      depthWrite: false,
    });

    const jointGeometry = new THREE.SphereGeometry(0.009, 10, 8);
    for (const name of JOINTS) {
      const mesh = new THREE.Mesh(jointGeometry, jointMaterial);
      mesh.name = `joint-${name}`;
      mesh.renderOrder = 900;
      this.group.add(mesh);
      this.joints.set(name, mesh);
    }

    const boneGeometry = new THREE.CylinderGeometry(BONE_RADIUS, BONE_RADIUS, 1, 6, 1, true);
    for (const [from, to] of BONES) {
      const mesh = new THREE.Mesh(boneGeometry, boneMaterial);
      mesh.name = `bone-${from}-${to}`;
      mesh.renderOrder = 899;
      this.group.add(mesh);
      this.bones.push({ mesh, from, to });
    }
  }

  /**
   * 用 WebXR 的关节数据更新骨架。
   * @param hand `renderer.xr.getHand(i)` 返回的手部空间对象
   */
  update(hand: THREE.Object3D): void {
    const joints = (hand as unknown as { joints?: Record<string, { position?: THREE.Vector3; visible?: boolean }> })
      .joints;
    if (!joints) return;

    for (const [name, mesh] of this.joints) {
      const joint = joints[name];
      if (!joint?.position) {
        mesh.visible = false;
        continue;
      }
      mesh.visible = joint.visible !== false;
      mesh.position.copy(joint.position);
    }

    for (const bone of this.bones) {
      const a = joints[bone.from]?.position;
      const b = joints[bone.to]?.position;
      if (!a || !b) {
        bone.mesh.visible = false;
        continue;
      }
      bone.mesh.visible = true;
      this.tmpA.copy(a);
      this.tmpB.copy(b);
      this.tmpMid.copy(this.tmpA).add(this.tmpB).multiplyScalar(0.5);
      this.tmpDir.copy(this.tmpB).sub(this.tmpA);
      const length = this.tmpDir.length();
      if (length < 1e-5) {
        bone.mesh.visible = false;
        continue;
      }
      this.tmpDir.divideScalar(length);
      bone.mesh.position.copy(this.tmpMid);
      this.tmpQuat.setFromUnitVectors(this.up, this.tmpDir);
      bone.mesh.quaternion.copy(this.tmpQuat);
      bone.mesh.scale.set(1, length, 1);
    }
  }

  dispose(): void {
    this.group.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    });
    this.group.clear();
  }
}
