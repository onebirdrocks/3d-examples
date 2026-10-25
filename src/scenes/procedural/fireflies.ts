import * as THREE from 'three';
import type { SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { disposeObject } from '../../core/loader.js';
import { ParticleSpace, wrapParticleField } from '../../core/particle-space.js';
import { createMoteField, createMoteMirror, updateMoteScale } from './lib/mote-field.js';
import { createRadialTexture } from './lib/scene-kit.js';

/**
 * 萤火微光
 *
 * 夜色里的竹林：细杆与叶丛被压到近乎剪影，只有几十只萤火以各自的节奏明灭。
 * 萤火用粒子空间承载（顶点着色器里各自漂移 + 各自明灭），
 * 地面半透明，萤火的倒影从地面下透上来。
 */

const FOV = 58;

/* ------------------------------------------------------------------ *
 * 天空与月
 * ------------------------------------------------------------------ */

function createSkyTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');

  const gradient = ctx.createLinearGradient(0, 0, 0, 256);
  gradient.addColorStop(0, '#050a14');
  gradient.addColorStop(0.42, '#0d1f2c');
  gradient.addColorStop(0.68, '#1d3d47');
  gradient.addColorStop(0.86, '#132a31');
  gradient.addColorStop(1, '#060b0d');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 4, 256);

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'night-sky';
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/* ------------------------------------------------------------------ *
 * 竹子
 * ------------------------------------------------------------------ */

interface CulmSpec {
  x: number;
  z: number;
  height: number;
  bend: number;
  radius: number;
  yaw: number;
}

function createCulmCurve(spec: CulmSpec): THREE.CatmullRomCurve3 {
  const points: THREE.Vector3[] = [];
  const segments = 6;
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    points.push(
      new THREE.Vector3(
        Math.sin(t * Math.PI * 0.5) * spec.bend,
        t * spec.height,
        Math.sin(t * Math.PI * 0.75) * spec.bend * 0.45,
      ),
    );
  }
  return new THREE.CatmullRomCurve3(points);
}

function createLeafGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.quadraticCurveTo(0.017, 0.035, 0, 0.092);
  shape.quadraticCurveTo(-0.017, 0.035, 0, 0);
  return new THREE.ShapeGeometry(shape, 6);
}

/* ------------------------------------------------------------------ *
 * 场景
 * ------------------------------------------------------------------ */

function createFireflies(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'fireflies-scene';

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 120);
  camera.position.set(0, 1.5, 4.4);
  camera.lookAt(0, 1.35, 0);

  const quality = THREE.MathUtils.clamp(ctx.quality, 0.4, 2);
  let state = 0x2f6b1c93;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };

  const ownTextures: THREE.Texture[] = [];

  /* ---------------- 夜空 ---------------- */

  const skyTexture = createSkyTexture();
  ownTextures.push(skyTexture);
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(60, 32, 20),
    new THREE.MeshBasicMaterial({ map: skyTexture, side: THREE.BackSide, depthWrite: false, fog: false }),
  );
  sky.name = 'sky';
  sky.renderOrder = -1000;
  sky.frustumCulled = false;
  root.add(sky);

  // 月亮：远处的一点冷光
  const moonTexture = createRadialTexture(128, 2.6);
  ownTextures.push(moonTexture);
  const moon = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: moonTexture,
      color: 0xbdd2f0,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    }),
  );
  moon.name = 'moon';
  moon.position.set(-11, 11, -26);
  moon.scale.set(7.5, 7.5, 1);
  root.add(moon);

  const moonDisc = new THREE.Mesh(
    new THREE.CircleGeometry(0.55, 32),
    new THREE.MeshBasicMaterial({ color: 0xe8f0ff, toneMapped: false, fog: false }),
  );
  moonDisc.name = 'moon-disc';
  moonDisc.position.copy(moon.position);
  moonDisc.lookAt(camera.position);
  root.add(moonDisc);

  /* ---------------- 地面 ---------------- */

  const ground = ctx.env.createGround(140) as THREE.Mesh;
  const groundMaterial = new THREE.MeshStandardMaterial({
    color: 0x050806,
    roughness: 0.72,
    metalness: 0.02,
    transparent: true,
    opacity: 0.82,
    // 不写深度：地面下方的萤火倒影才能透上来
    depthWrite: false,
  });
  groundMaterial.envMap = ctx.env.envMap;
  groundMaterial.envMapIntensity = 0.06;
  const previousGroundMaterial = ground.material;
  ground.material = groundMaterial;
  if (Array.isArray(previousGroundMaterial)) previousGroundMaterial.forEach((m) => m.dispose());
  else previousGroundMaterial.dispose();
  root.add(ground);

  /* ---------------- 竹林 ---------------- */

  const bambooMaterial = new THREE.MeshStandardMaterial({
    color: 0x16261c,
    roughness: 0.82,
    metalness: 0.02,
  });
  bambooMaterial.envMap = ctx.env.envMap;
  bambooMaterial.envMapIntensity = 0.14;

  const culmSpecs: CulmSpec[] = [];
  for (let i = 0; i < 22; i += 1) {
    const angle = random() * Math.PI * 2;
    const radius = 1.7 + random() * 7.2;
    culmSpecs.push({
      x: Math.cos(angle) * radius,
      z: Math.sin(angle) * radius - 1.6,
      height: 3.4 + random() * 3.4,
      bend: (random() - 0.5) * 0.9,
      radius: 0.016 + random() * 0.012,
      yaw: random() * Math.PI * 2,
    });
  }

  const nodeMatrices: THREE.Matrix4[] = [];
  const culmCurves: THREE.CatmullRomCurve3[] = [];

  /** 把竹竿局部坐标换算到世界坐标（竹竿整体带一个 yaw）。 */
  const toWorld = (spec: CulmSpec, point: THREE.Vector3, target: THREE.Vector3): THREE.Vector3 => {
    const cos = Math.cos(spec.yaw);
    const sin = Math.sin(spec.yaw);
    return target.set(
      spec.x + point.x * cos + point.z * sin,
      point.y,
      spec.z - point.x * sin + point.z * cos,
    );
  };

  const nodePosition = new THREE.Vector3();
  const nodeQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0));
  const nodeScale = new THREE.Vector3();

  for (const spec of culmSpecs) {
    const curve = createCulmCurve(spec);
    culmCurves.push(curve);

    const culm = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 16, spec.radius, 6, false),
      bambooMaterial,
    );
    culm.name = 'bamboo-culm';
    culm.position.set(spec.x, 0, spec.z);
    culm.rotation.y = spec.yaw;
    culm.castShadow = true;
    culm.receiveShadow = true;
    root.add(culm);

    // 竹节
    const nodeCount = 4 + Math.floor(random() * 3);
    for (let n = 1; n <= nodeCount; n += 1) {
      const t = n / (nodeCount + 1);
      const point = curve.getPointAt(t);
      toWorld(spec, point, nodePosition);
      const scale = spec.radius * 1.3;
      nodeScale.set(scale, scale, scale);
      const matrix = new THREE.Matrix4();
      matrix.compose(nodePosition, nodeQuaternion, nodeScale);
      nodeMatrices.push(matrix);
    }
  }

  const nodeGeometry = new THREE.TorusGeometry(1, 0.16, 6, 12);
  const nodes = new THREE.InstancedMesh(nodeGeometry, bambooMaterial, nodeMatrices.length);
  for (let i = 0; i < nodeMatrices.length; i += 1) {
    nodes.setMatrixAt(i, nodeMatrices[i]);
  }
  nodes.instanceMatrix.needsUpdate = true;
  nodes.name = 'bamboo-nodes';
  nodes.castShadow = false;
  root.add(nodes);

  /* ---------------- 叶丛 ---------------- */

  const leafMaterial = new THREE.MeshStandardMaterial({
    color: 0x162d1f,
    roughness: 0.88,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  leafMaterial.envMap = ctx.env.envMap;
  leafMaterial.envMapIntensity = 0.12;

  const leafCount = Math.floor(420 * quality);
  const leaves = new THREE.InstancedMesh(createLeafGeometry(), leafMaterial, leafCount);
  const leafMatrix = new THREE.Matrix4();
  const leafPosition = new THREE.Vector3();
  const leafAnchor = new THREE.Vector3();
  const leafQuaternion = new THREE.Quaternion();
  const leafScale = new THREE.Vector3();
  const leafEuler = new THREE.Euler();
  const leafColor = new THREE.Color();
  for (let i = 0; i < leafCount; i += 1) {
    const specIndex = Math.floor(random() * culmSpecs.length);
    const spec = culmSpecs[specIndex];
    const curve = culmCurves[specIndex];
    const t = 0.32 + random() * 0.56;
    const point = curve.getPointAt(t);
    const angle = random() * Math.PI * 2;
    const spread = 0.06 + random() * 0.34;

    toWorld(spec, point, leafAnchor);
    leafPosition.set(
      leafAnchor.x + Math.cos(angle) * spread,
      leafAnchor.y + (random() - 0.5) * 0.25,
      leafAnchor.z + Math.sin(angle) * spread,
    );
    leafEuler.set(
      -0.4 - random() * 1.1,
      random() * Math.PI * 2,
      (random() - 0.5) * 0.8,
    );
    leafQuaternion.setFromEuler(leafEuler);
    const size = 1.4 + random() * 1.3;
    leafScale.set(size, size, size);
    leafMatrix.compose(leafPosition, leafQuaternion, leafScale);
    leaves.setMatrixAt(i, leafMatrix);

    leafColor.setHSL(0.33 + random() * 0.06, 0.42 + random() * 0.2, 0.08 + random() * 0.06);
    leaves.setColorAt(i, leafColor);
  }
  leaves.instanceMatrix.needsUpdate = true;
  if (leaves.instanceColor) leaves.instanceColor.needsUpdate = true;
  leaves.name = 'bamboo-leaves';
  leaves.castShadow = false;
  root.add(leaves);

  /* ---------------- 草丛 ---------------- */

  const grassCount = Math.floor(360 * quality);
  const grassMaterial = new THREE.MeshStandardMaterial({
    color: 0x101c14,
    roughness: 0.92,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  grassMaterial.envMap = ctx.env.envMap;
  grassMaterial.envMapIntensity = 0.1;

  const grass = new THREE.InstancedMesh(
    new THREE.ConeGeometry(0.012, 0.24, 3, 1, true),
    grassMaterial,
    grassCount,
  );
  const grassMatrix = new THREE.Matrix4();
  const grassPosition = new THREE.Vector3();
  const grassQuaternion = new THREE.Quaternion();
  const grassScale = new THREE.Vector3();
  for (let i = 0; i < grassCount; i += 1) {
    const angle = random() * Math.PI * 2;
    const radius = 0.8 + random() * 6.5;
    grassPosition.set(Math.cos(angle) * radius, 0.11, Math.sin(angle) * radius - 1.2);
    grassQuaternion.setFromEuler(
      new THREE.Euler((random() - 0.5) * 0.5, random() * Math.PI * 2, (random() - 0.5) * 0.5),
    );
    const size = 0.6 + random() * 0.9;
    grassScale.set(size, size, size);
    grassMatrix.compose(grassPosition, grassQuaternion, grassScale);
    grass.setMatrixAt(i, grassMatrix);
  }
  grass.instanceMatrix.needsUpdate = true;
  grass.name = 'undergrowth';
  grass.castShadow = false;
  root.add(grass);

  /* ---------------- 萤火 ---------------- */

  const space = new ParticleSpace({
    radius: 6,
    spin: 0.01,
    tilt: 0,
    position: [0, 1.45, -1],
  });

  const fireflyCount = Math.max(34, Math.floor(90 * quality));
  const fireflies = createMoteField(space, fireflyCount, {
    size: 0.065,
    color: new THREE.Color(0x8ef55a),
    core: new THREE.Color(0xfff4bc),
    opacity: 1,
    seed: 90210,
    mode: 'firefly',
    wander: 0.42,
    blinkRate: 0.5,
    floor: 0.14,
  });
  root.add(fireflies.points);

  // 倒影：同一批粒子在世界空间沿地面对称
  const reflection = createMoteMirror(fireflies);
  reflection.material.uniforms.uOpacity.value = 5;
  root.add(reflection.points);

  /* ---------------- 雾气 ---------------- */

  const mistTexture = createRadialTexture(128, 1.6);
  ownTextures.push(mistTexture);
  const mistLayers: THREE.Mesh[] = [];
  for (let i = 0; i < 5; i += 1) {
    const mistMaterial = new THREE.MeshBasicMaterial({
      map: mistTexture,
      color: new THREE.Color().setHSL(0.52, 0.3, 0.13),
      transparent: true,
      opacity: 0.05 + i * 0.008 + (i === 0 ? 0.035 : 0),
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const mist = new THREE.Mesh(new THREE.PlaneGeometry(16, 16), mistMaterial);
    mist.name = 'mist';
    mist.rotation.x = -Math.PI / 2;
    mist.position.set(0, 0.12 + i * 0.22, -1.5);
    mist.renderOrder = 3;
    mistLayers.push(mist);
    root.add(mist);
  }

  /* ---------------- 灯光 ---------------- */

  const lights = ctx.env.createStudioLights();
  lights.traverse((child) => {
    if (child instanceof THREE.Light) {
      child.intensity *= 0.05;
      child.castShadow = false;
      child.color.setHex(0x33475c);
    }
  });
  root.add(lights);

  const moonlight = new THREE.DirectionalLight(0xa8c2e6, 0.26);
  moonlight.name = 'moonlight';
  moonlight.position.set(-9, 11, -14);
  moonlight.castShadow = true;
  moonlight.shadow.mapSize.set(1024, 1024);
  moonlight.shadow.camera.near = 4;
  moonlight.shadow.camera.far = 40;
  moonlight.shadow.camera.left = -10;
  moonlight.shadow.camera.right = 10;
  moonlight.shadow.camera.top = 12;
  moonlight.shadow.camera.bottom = -4;
  moonlight.shadow.bias = -0.001;
  moonlight.shadow.normalBias = 0.03;
  root.add(moonlight);

  const hemisphere = new THREE.HemisphereLight(0x1b2c3c, 0x05070a, 0.14);
  root.add(hemisphere);

  return {
    root,
    camera,
    immersive: true,
    xrDistance: 3,
    framing: { distance: 4.4, height: 1.5, targetY: 1.35, width: 7 },

    update(time: number, delta: number, sceneCtx: SceneContext): void {
      space.breathe = 1 + Math.sin(time * 0.1) * 0.06;
      space.update(delta, time);
      wrapParticleField(fireflies.points, space.radius, delta, 0.02);
      fireflies.uniforms.uTime.value = time;
      updateMoteScale(fireflies.uniforms, sceneCtx, FOV);

      // 雾气缓慢漂移与旋转
      for (let i = 0; i < mistLayers.length; i += 1) {
        const mist = mistLayers[i];
        mist.rotation.z = time * (0.008 + i * 0.003) * (i % 2 === 0 ? 1 : -1);
        mist.position.x = Math.sin(time * 0.06 + i) * 0.7;
        mist.position.z = -1.5 + Math.cos(time * 0.05 + i * 1.7) * 0.7;
      }
    },

    dispose(): void {
      ownTextures.forEach((texture) => texture.dispose());
      disposeObject(root);
    },
  };
}

export const firefliesScene: SceneDefinition = {
  id: 'fireflies',
  title: '萤火微光',
  subtitle: 'Fireflies',
  description: '夜色竹林里，几十只萤火以各自的节奏明灭，雾气贴着湿地面缓缓流动。',
  tags: ['夜色', '萤火', '竹林'],
  accent: '#a8ff6a',
  gradient: ['#0d2416', '#04070a'],
  category: 'procedural',
  create(ctx: SceneContext): SceneInstance {
    return createFireflies(ctx);
  },
};

export default firefliesScene;
