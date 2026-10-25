import * as THREE from 'three';
import type { SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { disposeHierarchy, makeGroundMatte, createVerticalGradientTexture } from './shared.js';
import { fbm2, valueNoise2 } from '../procedural/lib/scene-kit.js';

/**
 * 苔藓生态瓶
 *
 * 玻璃罩里是一小片苔藓生态：湿润的深色土、浅浅的积水、几块石头、
 * 一株小蕨类。苔藓用上万个低面数实例堆出绒面感，数量随画质缩放。
 * 玻璃罩用带厚度的物理材质做真实折射，光从窗口斜进来。
 */

const FOV = 38;

/** 底座高度。 */
const BASE_HEIGHT = 0.026;

/** 苔藓丘尺寸。 */
const MOSS_RADIUS = 0.092;
const MOSS_HEIGHT = 0.052;

/** 土层顶面（相对罩底）。 */
const SOIL_TOP = 0.036;

/* ------------------------------------------------------------------ *
 * 苔藓
 * ------------------------------------------------------------------ */

/** 苔藓丘的高度场：穹顶 + 细碎起伏。 */
function mossHeight(x: number, z: number): number {
  const r = Math.hypot(x, z) / MOSS_RADIUS;
  if (r > 1) return 0;
  const dome = MOSS_HEIGHT * Math.pow(1 - r * r, 0.85);
  const bump = (fbm2(x * 70 + 11.3, z * 70 + 4.7, 3) - 0.5) * 0.009;
  return dome + bump * (1 - r * 0.5);
}

function createMossMoundGeometry(rings: number, segments: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let r = 0; r <= rings; r += 1) {
    const radius = (r / rings) * MOSS_RADIUS;
    for (let s = 0; s <= segments; s += 1) {
      const angle = (s / segments) * Math.PI * 2;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      positions.push(x, mossHeight(x, z), z);
      uvs.push(0.5 + x / (MOSS_RADIUS * 2), 0.5 + z / (MOSS_RADIUS * 2));
    }
  }

  for (let r = 0; r < rings; r += 1) {
    for (let s = 0; s < segments; s += 1) {
      const a = r * (segments + 1) + s;
      const b = a + segments + 1;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/* ------------------------------------------------------------------ *
 * 石头
 * ------------------------------------------------------------------ */

function stoneNoise(x: number, y: number, z: number): number {
  return (
    valueNoise2(x * 6 + z * 2.3, y * 6 + z * 3.1) * 0.6 +
    valueNoise2(y * 9 - x * 3.7, z * 9 + x * 1.3) * 0.4
  );
}

function createStone(radius: number, seed: number): THREE.BufferGeometry {
  const geometry = new THREE.IcosahedronGeometry(radius, 2);
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const n = stoneNoise(x * 9 + seed, y * 9 + seed, z * 9 + seed);
    const k = 0.74 + n * 0.52;
    position.setXYZ(i, x * k, y * k * 0.72, z * k);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

/* ------------------------------------------------------------------ *
 * 蕨类
 * ------------------------------------------------------------------ */

function createFrondCurve(length: number, lean: number): THREE.CatmullRomCurve3 {
  const points: THREE.Vector3[] = [];
  const steps = 5;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    points.push(
      new THREE.Vector3(Math.pow(t, 1.9) * length * lean, t * length * 0.78, 0),
    );
  }
  return new THREE.CatmullRomCurve3(points);
}

function createLeafletGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.quadraticCurveTo(0.005, 0.013, 0, 0.027);
  shape.quadraticCurveTo(-0.005, 0.013, 0, 0);
  return new THREE.ShapeGeometry(shape, 5);
}

/* ------------------------------------------------------------------ *
 * 场景
 * ------------------------------------------------------------------ */

function createTerrarium(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'terrarium-scene';

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.02, 20);
  camera.position.set(0.6, 0.3, 0.62);
  camera.lookAt(0, 0.14, 0);

  const quality = THREE.MathUtils.clamp(ctx.quality, 0.4, 2);
  let state = 0x7a13c9d5;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };

  /* ---------------- 桌面与背景 ---------------- */

  const ground = ctx.env.createGround(30);
  makeGroundMatte(ground, 0x0b0d0c);
  root.add(ground);

  // 背景幕：给玻璃罩一点可折射的内容，避免罩内是纯黑
  const backdropTexture = createVerticalGradientTexture([
    [0, '#3a5047'],
    [0.42, '#2a3d36'],
    [0.78, '#141d19'],
    [1, '#0a0d0c'],
  ]);
  const backdrop = new THREE.Mesh(
    new THREE.CylinderGeometry(0.85, 0.85, 0.9, 48, 1, true),
    new THREE.MeshBasicMaterial({ map: backdropTexture, side: THREE.BackSide, fog: false }),
  );
  backdrop.name = 'backdrop';
  backdrop.position.y = 0.36;
  root.add(backdrop);

  /* ---------------- 木质底座 ---------------- */

  const woodMaterial = new THREE.MeshStandardMaterial({
    color: 0x3a2a1d,
    roughness: 0.58,
    metalness: 0.04,
  });
  woodMaterial.envMap = ctx.env.envMap;
  woodMaterial.envMapIntensity = 0.5;

  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.158, 0.164, BASE_HEIGHT, 72),
    woodMaterial,
  );
  base.name = 'terrarium-base';
  base.position.y = BASE_HEIGHT / 2;
  base.castShadow = true;
  base.receiveShadow = true;
  root.add(base);

  /* ---------------- 玻璃罩 ---------------- */

  const jarProfile = [
    [0.148, 0.0],
    [0.15, 0.008],
    [0.15, 0.13],
    [0.145, 0.18],
    [0.13, 0.225],
    [0.1, 0.265],
    [0.06, 0.292],
    [0.03, 0.3],
    [0.022, 0.302],
    [0.019, 0.297],
    [0.027, 0.295],
    [0.053, 0.285],
    [0.091, 0.255],
    [0.119, 0.217],
    [0.134, 0.175],
    [0.14, 0.13],
    [0.14, 0.01],
    [0.0, 0.006],
  ].map(([x, y]) => new THREE.Vector2(x, y));

  const glassMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.05,
    metalness: 0,
    transmission: 1,
    thickness: 0.014,
    ior: 1.5,
    attenuationColor: new THREE.Color(0xc9e9dc),
    attenuationDistance: 0.9,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    envMap: ctx.env.envMap,
    envMapIntensity: 0.45,
  });

  const jar = new THREE.Mesh(new THREE.LatheGeometry(jarProfile, 80), glassMaterial);
  jar.name = 'glass-jar';
  jar.position.y = BASE_HEIGHT;
  jar.castShadow = false;
  jar.receiveShadow = false;
  root.add(jar);

  /* ---------------- 罩内生态 ---------------- */

  const contents = new THREE.Group();
  contents.name = 'terrarium-contents';
  contents.position.y = BASE_HEIGHT;
  root.add(contents);

  // 湿润的深色土壤
  const soilMaterial = new THREE.MeshStandardMaterial({
    color: 0x241a12,
    roughness: 0.93,
    metalness: 0,
  });
  soilMaterial.envMap = ctx.env.envMap;
  soilMaterial.envMapIntensity = 0.3;

  const soil = new THREE.Mesh(
    new THREE.CylinderGeometry(0.138, 0.132, SOIL_TOP, 56),
    soilMaterial,
  );
  soil.name = 'soil';
  soil.position.y = SOIL_TOP / 2;
  soil.receiveShadow = true;
  contents.add(soil);

  // 浅浅的积水
  const waterGeometry = new THREE.CircleGeometry(0.042, 40);
  const waterPosition = waterGeometry.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < waterPosition.count; i += 1) {
    const x = waterPosition.getX(i);
    const y = waterPosition.getY(i);
    const r = Math.hypot(x, y);
    if (r > 0.0001) {
      const wobble = 1 + (fbm2(x * 40 + 3.1, y * 40 + 8.7, 3) - 0.5) * 0.35;
      waterPosition.setXY(i, x * wobble, y * wobble);
    }
  }
  waterPosition.needsUpdate = true;
  waterGeometry.computeVertexNormals();
  waterGeometry.rotateX(-Math.PI / 2);

  const waterMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x14241f,
    roughness: 0.02,
    metalness: 0,
    transparent: true,
    opacity: 0.82,
    clearcoat: 1,
    clearcoatRoughness: 0.02,
    ior: 1.33,
    envMap: ctx.env.envMap,
    envMapIntensity: 1.8,
  });
  const water = new THREE.Mesh(waterGeometry, waterMaterial);
  water.name = 'water';
  water.position.set(0.055, SOIL_TOP + 0.0015, 0.04);
  contents.add(water);

  // 苔藓丘
  const moundMaterial = new THREE.MeshStandardMaterial({
    color: 0x2b4522,
    roughness: 0.96,
    metalness: 0,
  });
  moundMaterial.envMap = ctx.env.envMap;
  moundMaterial.envMapIntensity = 0.25;

  const mound = new THREE.Mesh(createMossMoundGeometry(14, 56), moundMaterial);
  mound.name = 'moss-mound';
  mound.position.set(-0.012, SOIL_TOP, 0.004);
  mound.receiveShadow = true;
  contents.add(mound);

  // 苔藓绒毛：密集的低面数实例
  const mossCount = Math.round(
    THREE.MathUtils.clamp(9000 * quality, 2500, 20000),
  );
  const mossMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.92,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  mossMaterial.envMap = ctx.env.envMap;
  mossMaterial.envMapIntensity = 0.22;

  const moss = new THREE.InstancedMesh(
    new THREE.ConeGeometry(0.0013, 0.0062, 3, 1, true),
    mossMaterial,
    mossCount,
  );
  const mossMatrix = new THREE.Matrix4();
  const mossPosition = new THREE.Vector3();
  const mossQuaternion = new THREE.Quaternion();
  const mossScale = new THREE.Vector3();
  const mossEuler = new THREE.Euler();
  const mossColor = new THREE.Color();
  const moundOffset = new THREE.Vector3(-0.012, SOIL_TOP, 0.004);

  for (let i = 0; i < mossCount; i += 1) {
    // 大部分长在苔藓丘上，少量散落在土面
    const onMound = i < mossCount * 0.82;
    let x: number;
    let z: number;
    let y: number;
    if (onMound) {
      const angle = random() * Math.PI * 2;
      const radius = Math.sqrt(random()) * MOSS_RADIUS * 0.98;
      x = moundOffset.x + Math.cos(angle) * radius;
      z = moundOffset.z + Math.sin(angle) * radius;
      y = moundOffset.y + mossHeight(x - moundOffset.x, z - moundOffset.z);
    } else {
      const angle = random() * Math.PI * 2;
      const radius = MOSS_RADIUS * (1 + random() * 0.5);
      x = Math.cos(angle) * radius;
      z = Math.sin(angle) * radius;
      y = SOIL_TOP;
    }

    mossPosition.set(x, y + 0.006, z);
    mossEuler.set(
      (random() - 0.5) * 0.7,
      random() * Math.PI * 2,
      (random() - 0.5) * 0.7,
    );
    mossQuaternion.setFromEuler(mossEuler);
    const size = 0.55 + random() * 0.95;
    mossScale.set(size, size * (0.7 + random() * 0.8), size);
    mossMatrix.compose(mossPosition, mossQuaternion, mossScale);
    moss.setMatrixAt(i, mossMatrix);

    mossColor.setHSL(0.25 + random() * 0.07, 0.34 + random() * 0.22, 0.07 + random() * 0.11);
    moss.setColorAt(i, mossColor);
  }
  moss.instanceMatrix.needsUpdate = true;
  if (moss.instanceColor) moss.instanceColor.needsUpdate = true;
  moss.name = 'moss-fuzz';
  moss.computeBoundingSphere();
  contents.add(moss);

  // 石头
  const stoneMaterial = new THREE.MeshStandardMaterial({
    color: 0x6a6a60,
    roughness: 0.82,
    metalness: 0.05,
    flatShading: true,
  });
  stoneMaterial.envMap = ctx.env.envMap;
  stoneMaterial.envMapIntensity = 0.45;

  const stoneSpecs: { pos: [number, number, number]; radius: number; seed: number }[] = [
    { pos: [0.082, SOIL_TOP + 0.012, -0.062], radius: 0.021, seed: 3.1 },
    { pos: [-0.088, SOIL_TOP + 0.01, 0.058], radius: 0.017, seed: 7.7 },
    { pos: [0.012, SOIL_TOP + 0.008, -0.096], radius: 0.013, seed: 11.3 },
    { pos: [0.108, SOIL_TOP + 0.007, 0.012], radius: 0.011, seed: 17.9 },
  ];
  for (const spec of stoneSpecs) {
    const stone = new THREE.Mesh(createStone(spec.radius, spec.seed), stoneMaterial);
    stone.name = 'stone';
    stone.position.set(spec.pos[0], spec.pos[1], spec.pos[2]);
    stone.rotation.set(random() * 0.6, random() * Math.PI * 2, random() * 0.6);
    stone.castShadow = true;
    stone.receiveShadow = true;
    contents.add(stone);
  }

  // 蕨类
  const fernMaterial = new THREE.MeshStandardMaterial({
    color: 0x27532e,
    roughness: 0.78,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  fernMaterial.envMap = ctx.env.envMap;
  fernMaterial.envMapIntensity = 0.35;

  const fern = new THREE.Group();
  fern.name = 'fern';
  fern.position.set(-0.012, SOIL_TOP + MOSS_HEIGHT * 0.62, 0.004);
  contents.add(fern);

  const frondCount = 6;
  const leafletsPerFrond = 30;
  const leafletTotal = frondCount * leafletsPerFrond;
  const leaflets = new THREE.InstancedMesh(createLeafletGeometry(), fernMaterial, leafletTotal);

  const leafletMatrix = new THREE.Matrix4();
  const leafletPosition = new THREE.Vector3();
  const leafletScale = new THREE.Vector3();
  const leafletBasis = new THREE.Matrix4();
  const tangent = new THREE.Vector3();
  const side = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const zAxis = new THREE.Vector3();
  const xAxis = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  let leafletIndex = 0;

  for (let f = 0; f < frondCount; f += 1) {
    const azimuth = (f / frondCount) * Math.PI * 2 + random() * 0.4;
    const length = 0.075 + random() * 0.035;
    const curve = createFrondCurve(length, 0.55 + random() * 0.35);

    const stem = new THREE.Mesh(new THREE.TubeGeometry(curve, 12, 0.0011, 5, false), fernMaterial);
    stem.name = 'fern-stem';
    stem.castShadow = true;
    fern.add(stem);

    for (let l = 0; l < leafletsPerFrond; l += 1) {
      const t = 0.16 + (l / leafletsPerFrond) * 0.8;
      const point = curve.getPointAt(t);
      curve.getTangentAt(t, tangent);
      side.crossVectors(tangent, up).normalize();
      const sign = l % 2 === 0 ? 1 : -1;
      dir.copy(side).multiplyScalar(sign).addScaledVector(tangent, 0.75).normalize();

      // 叶片的局部坐标：Y 沿叶长，X 沿叶宽，Z 为叶面法线
      xAxis.copy(side).multiplyScalar(sign);
      zAxis.crossVectors(xAxis, dir).normalize();
      xAxis.crossVectors(dir, zAxis).normalize();
      leafletBasis.makeBasis(xAxis, dir, zAxis);

      const cos = Math.cos(azimuth);
      const sin = Math.sin(azimuth);
      leafletPosition.set(
        point.x * cos + point.z * sin,
        point.y,
        -point.x * sin + point.z * cos,
      );

      const size = (0.75 + random() * 0.5) * (1.15 - t * 0.4);
      leafletScale.set(size, size, size);
      leafletMatrix.compose(leafletPosition, new THREE.Quaternion().setFromRotationMatrix(leafletBasis), leafletScale);
      leaflets.setMatrixAt(leafletIndex, leafletMatrix);
      leafletIndex += 1;
    }
  }
  leaflets.instanceMatrix.needsUpdate = true;
  leaflets.name = 'fern-leaflets';
  leaflets.castShadow = false;
  fern.add(leaflets);

  /* ---------------- 灯光 ---------------- */

  const lights = ctx.env.createStudioLights();
  lights.traverse((child) => {
    if (child instanceof THREE.Light) {
      child.intensity *= 0.28;
      child.castShadow = false;
    }
  });
  root.add(lights);

  // 窗口透进来的柔光
  const windowLight = new THREE.SpotLight(0xfff3e0, 6.5, 3, Math.PI * 0.28, 0.85, 1.4);
  windowLight.name = 'window-light';
  windowLight.position.set(-0.52, 0.82, 0.42);
  windowLight.target.position.set(0, 0.06, 0);
  windowLight.castShadow = true;
  windowLight.shadow.mapSize.set(1024, 1024);
  windowLight.shadow.camera.near = 0.05;
  windowLight.shadow.camera.far = 2.4;
  windowLight.shadow.bias = -0.0012;
  windowLight.shadow.normalBias = 0.008;
  root.add(windowLight);
  root.add(windowLight.target);

  const rim = new THREE.SpotLight(0x8fc4ff, 2.4, 3, Math.PI * 0.3, 0.85, 1.5);
  rim.name = 'rim-light';
  rim.position.set(0.7, 0.5, -0.62);
  rim.target.position.set(0, 0.1, 0);
  root.add(rim);
  root.add(rim.target);

  // 罩内的一点补光
  const inner = new THREE.PointLight(0xbfe8cf, 0.22, 0.42, 2);
  inner.name = 'inner-light';
  inner.position.set(0.01, SOIL_TOP + 0.07, 0.01);
  contents.add(inner);

  const lookTarget = new THREE.Vector3(0, 0.14, 0);

  return {
    root,
    camera,
    immersive: false,
    ownsCamera: true,
    xrDistance: 1.6,
    framing: { distance: 0.85, height: 0.3, targetY: 0.14 },

    update(time: number, _delta: number, sceneCtx: SceneContext): void {
      // 罩内的一点呼吸感：光强极缓慢地起伏
      inner.intensity = 0.2 + Math.sin(time * 0.23) * 0.04;

      if (sceneCtx.isXR) {
        root.position.z = -1.6;
        return;
      }

      const angle = time * 0.14 + 0.6;
      const radius = 0.82 + Math.sin(time * 0.21) * 0.03;
      camera.position.set(Math.sin(angle) * radius, 0.3 + Math.sin(time * 0.27) * 0.014, Math.cos(angle) * radius);
      camera.lookAt(lookTarget);
    },

    dispose(): void {
      backdropTexture.dispose();
      disposeHierarchy(root);
    },
  };
}

export const terrariumScene: SceneDefinition = {
  id: 'terrarium',
  title: '苔藓生态瓶',
  subtitle: 'Moss Terrarium',
  description: '玻璃罩里长着一小片苔藓与蕨类，湿润的土壤上积着浅浅的水。',
  tags: ['苔藓', '玻璃', '微景观'],
  accent: '#9fe08a',
  gradient: ['#1b3324', '#070c09'],
  category: 'model',
  lighting: {
    autoExposure: true,
    autoExposureKey: 0.12,
    realTimeReflection: true,
    lightProbe: true,
  },
  create(ctx: SceneContext): SceneInstance {
    return createTerrarium(ctx);
  },
};

export default terrariumScene;
