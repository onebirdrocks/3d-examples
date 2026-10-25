import * as THREE from 'three';
import type { SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { ParticleSpace } from '../../core/particle-space.js';
import { createMoteField, updateMoteScale } from '../procedural/lib/mote-field.js';
import { createGlazeTextures } from '../procedural/lib/scene-kit.js';
import {
  createVerticalGradientTexture,
  disposeHierarchy,
  makeGroundMatte,
} from './shared.js';

/**
 * 青瓷茶器
 *
 * 一套程序化拼装的中式茶器：壶身用旋成体成型，壶嘴是收细的弯管，
 * 壶把是一段圆弧，品茗杯与茶盘同属青釉。
 * 釉面是低粗糙度 + 清漆层的物理材质，贴图里带着开片与釉色不匀。
 * 影棚布光：柔和侧光为主，背景幕压暗，热气从壶口极慢地升起。
 */

const FOV = 34;

/** 茶盘尺寸（米）。 */
const TRAY_W = 0.4;
const TRAY_D = 0.3;

/* ------------------------------------------------------------------ *
 * 几何
 * ------------------------------------------------------------------ */

/** 圆角矩形轮廓（逆时针点列）。 */
function roundedRectPoints(
  width: number,
  height: number,
  radius: number,
  segments = 6,
): [number, number][] {
  const w = width / 2;
  const h = height / 2;
  const r = Math.min(radius, w, h);
  const pts: [number, number][] = [];
  const corners: [number, number, number][] = [
    [w - r, -h + r, -Math.PI / 2],
    [w - r, h - r, 0],
    [-w + r, h - r, Math.PI / 2],
    [-w + r, -h + r, Math.PI],
  ];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= segments; i += 1) {
      const a = a0 + (i / segments) * (Math.PI / 2);
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  }
  return pts;
}

/** 壶身：带内壁的旋成体。 */
function createPotBody(): THREE.BufferGeometry {
  const profile = [
    [0.0, 0.0],
    [0.038, 0.0],
    [0.044, 0.006],
    [0.052, 0.018],
    [0.068, 0.04],
    [0.082, 0.068],
    [0.086, 0.092],
    [0.08, 0.115],
    [0.066, 0.138],
    [0.052, 0.152],
    [0.049, 0.158],
    [0.044, 0.158],
    [0.043, 0.147],
    [0.056, 0.135],
    [0.072, 0.1],
    [0.07, 0.05],
    [0.05, 0.02],
    [0.0, 0.014],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  return new THREE.LatheGeometry(profile, 72);
}

/** 壶盖：浅拱顶 + 内凹的底面。 */
function createPotLid(): THREE.BufferGeometry {
  const profile = [
    [0.0, 0.03],
    [0.016, 0.028],
    [0.034, 0.021],
    [0.046, 0.01],
    [0.051, 0.002],
    [0.051, -0.004],
    [0.044, -0.006],
    [0.026, 0.002],
    [0.0, 0.006],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  return new THREE.LatheGeometry(profile, 64);
}

/** 壶嘴：沿曲线生成的管子，再把末端收细。 */
function createPotSpout(): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.05, 0.04, 0),
    new THREE.Vector3(0.092, 0.05, 0),
    new THREE.Vector3(0.126, 0.074, 0),
    new THREE.Vector3(0.15, 0.106, 0),
  ]);
  const tubular = 20;
  const radial = 10;
  const geometry = new THREE.TubeGeometry(curve, tubular, 0.014, radial, false);
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const center = new THREE.Vector3();
  for (let i = 0; i <= tubular; i += 1) {
    const t = i / tubular;
    curve.getPointAt(t, center);
    const taper = 1.3 - t * 0.78;
    for (let j = 0; j <= radial; j += 1) {
      const index = i * (radial + 1) + j;
      position.setXYZ(
        index,
        center.x + (position.getX(index) - center.x) * taper,
        center.y + (position.getY(index) - center.y) * taper,
        center.z + (position.getZ(index) - center.z) * taper,
      );
    }
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

/** 壶把：一段圆弧（耳形）。 */
function createPotHandle(): THREE.BufferGeometry {
  const geometry = new THREE.TorusGeometry(0.048, 0.0085, 12, 36, Math.PI * 1.11);
  geometry.rotateZ(1.2217);
  geometry.translate(-0.072, 0.098, 0);
  return geometry;
}

/** 品茗杯：圈足 + 收腰 + 微撇的口沿，带内壁。 */
function createCup(): THREE.BufferGeometry {
  const profile = [
    [0.0, 0.0],
    [0.014, 0.0],
    [0.017, 0.005],
    [0.016, 0.011],
    [0.021, 0.021],
    [0.026, 0.033],
    [0.028, 0.041],
    [0.0265, 0.0425],
    [0.0245, 0.039],
    [0.021, 0.025],
    [0.015, 0.011],
    [0.0, 0.007],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  return new THREE.LatheGeometry(profile, 56);
}

/* ------------------------------------------------------------------ *
 * 场景
 * ------------------------------------------------------------------ */

function createCeladon(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'celadon-scene';

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.02, 30);
  camera.position.set(0, 0.26, 0.62);
  camera.lookAt(0, 0.1, 0);

  const quality = THREE.MathUtils.clamp(ctx.quality, 0.4, 2);

  /* ---------------- 影棚环境 ---------------- */

  const ground = ctx.env.createGround(8);
  makeGroundMatte(ground, 0x0a0c11);
  root.add(ground);

  const backdropTexture = createVerticalGradientTexture([
    [0, '#20323a'],
    [0.38, '#1a2a31'],
    [0.62, '#0e171c'],
    [1, '#070b0e'],
  ]);
  const backdrop = new THREE.Mesh(
    new THREE.CylinderGeometry(1.15, 1.15, 2.4, 48, 1, true),
    new THREE.MeshBasicMaterial({ map: backdropTexture, side: THREE.BackSide, fog: false }),
  );
  backdrop.name = 'backdrop';
  backdrop.position.y = 1.0;
  root.add(backdrop);

  /* ---------------- 青釉材质 ---------------- */

  const { colorMap, roughnessMap } = createGlazeTextures(512, 20240912);
  colorMap.repeat.set(5, 3.5);
  roughnessMap.repeat.set(5, 3.5);

  const glazeMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x4f8d78,
    map: colorMap,
    roughnessMap,
    roughness: 0.52,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.06,
    ior: 1.52,
    specularIntensity: 1,
    side: THREE.DoubleSide,
    envMap: ctx.env.envMap,
    envMapIntensity: 0.5,
  });

  const trayMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x4c7a70,
    map: colorMap,
    roughnessMap,
    roughness: 0.72,
    metalness: 0,
    clearcoat: 0.7,
    clearcoatRoughness: 0.18,
    envMap: ctx.env.envMap,
    envMapIntensity: 0.6,
  });

  /* ---------------- 转台上的茶器 ---------------- */

  const turntable = new THREE.Group();
  turntable.name = 'turntable';
  root.add(turntable);

  const teaSet = new THREE.Group();
  teaSet.name = 'tea-set';
  teaSet.position.y = 0.008;
  turntable.add(teaSet);

  // 茶盘：外圈 + 内孔，挤出成带边框的托盘
  const trayOuter = roundedRectPoints(TRAY_W, TRAY_D, 0.038);
  const trayInner = roundedRectPoints(TRAY_W - 0.05, TRAY_D - 0.05, 0.028);
  const trayShape = new THREE.Shape(trayOuter.map(([x, y]) => new THREE.Vector2(x, y)));
  trayShape.holes.push(
    new THREE.Path(trayInner.slice().reverse().map(([x, y]) => new THREE.Vector2(x, y))),
  );
  const trayGeometry = new THREE.ExtrudeGeometry(trayShape, {
    depth: 0.016,
    bevelEnabled: true,
    bevelSize: 0.0025,
    bevelThickness: 0.0025,
    bevelSegments: 2,
    curveSegments: 1,
  });
  trayGeometry.rotateX(-Math.PI / 2);
  const tray = new THREE.Mesh(trayGeometry, trayMaterial);
  tray.name = 'tea-tray';
  tray.castShadow = true;
  tray.receiveShadow = true;
  teaSet.add(tray);

  // 盘底
  const wellShape = new THREE.Shape(trayInner.map(([x, y]) => new THREE.Vector2(x, y)));
  const wellGeometry = new THREE.ExtrudeGeometry(wellShape, {
    depth: 0.008,
    bevelEnabled: false,
    curveSegments: 1,
  });
  wellGeometry.rotateX(-Math.PI / 2);
  const well = new THREE.Mesh(wellGeometry, trayMaterial);
  well.name = 'tea-tray-well';
  well.receiveShadow = true;
  teaSet.add(well);

  // 茶壶
  const pot = new THREE.Group();
  pot.name = 'teapot';
  pot.position.set(0, 0, -0.03);
  pot.rotation.y = -2.36;
  teaSet.add(pot);

  const body = new THREE.Mesh(createPotBody(), glazeMaterial);
  body.name = 'pot-body';
  body.castShadow = true;
  body.receiveShadow = true;
  pot.add(body);

  const spout = new THREE.Mesh(createPotSpout(), glazeMaterial);
  spout.name = 'pot-spout';
  spout.castShadow = true;
  pot.add(spout);

  const handle = new THREE.Mesh(createPotHandle(), glazeMaterial);
  handle.name = 'pot-handle';
  handle.castShadow = true;
  pot.add(handle);

  const lid = new THREE.Mesh(createPotLid(), glazeMaterial);
  lid.name = 'pot-lid';
  lid.position.y = 0.156;
  lid.castShadow = true;
  pot.add(lid);

  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.0085, 24, 16), glazeMaterial);
  knob.name = 'pot-knob';
  knob.position.y = 0.194;
  knob.scale.set(1, 0.86, 1);
  knob.castShadow = true;
  pot.add(knob);

  const knobStem = new THREE.Mesh(new THREE.CylinderGeometry(0.0032, 0.004, 0.014, 16), glazeMaterial);
  knobStem.name = 'pot-knob-stem';
  knobStem.position.y = 0.183;
  pot.add(knobStem);

  // 品茗杯
  const cupGeometry = createCup();
  const cupA = new THREE.Mesh(cupGeometry, glazeMaterial);
  cupA.name = 'tea-cup-a';
  cupA.position.set(-0.115, 0, 0.062);
  cupA.castShadow = true;
  cupA.receiveShadow = true;
  teaSet.add(cupA);

  const cupB = new THREE.Mesh(cupGeometry, glazeMaterial);
  cupB.name = 'tea-cup-b';
  cupB.position.set(0.112, 0, 0.05);
  cupB.rotation.y = 0.8;
  cupB.castShadow = true;
  cupB.receiveShadow = true;
  teaSet.add(cupB);

  /* ---------------- 热气 ---------------- */

  const steamSpace = new ParticleSpace({
    radius: 0.07,
    spin: 0,
    tilt: 0,
    position: [0, 0.205, 0],
  });
  const steam = createMoteField(steamSpace, Math.floor(170 * quality), {
    size: 0.017,
    color: new THREE.Color(0xcfe0dc),
    core: new THREE.Color(0xffffff),
    opacity: 0.11,
    seed: 5150,
    mode: 'steam',
    riseSpeed: 0.045,
    riseHeight: 0.28,
  });
  teaSet.add(steam.points);

  /* ---------------- 灯光 ---------------- */

  const lights = ctx.env.createStudioLights();
  lights.traverse((child) => {
    if (child instanceof THREE.Light) {
      child.intensity *= 0.4;
      child.castShadow = false;
    }
  });
  root.add(lights);

  const key = new THREE.SpotLight(0xfff1dd, 5, 4, Math.PI * 0.32, 0.75, 1.6);
  key.name = 'key-light';
  key.position.set(-0.78, 0.82, 0.62);
  key.target.position.set(0, 0.08, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 0.1;
  key.shadow.camera.far = 4;
  key.shadow.bias = -0.0009;
  key.shadow.normalBias = 0.012;
  root.add(key);
  root.add(key.target);

  const rim = new THREE.SpotLight(0x9fd4ff, 3.2, 4, Math.PI * 0.34, 0.8, 1.6);
  rim.name = 'rim-light';
  rim.position.set(0.95, 0.66, -0.78);
  rim.target.position.set(0, 0.08, 0);
  root.add(rim);
  root.add(rim.target);

  const bounce = new THREE.PointLight(0xffd9b0, 0.5, 1.4, 2);
  bounce.name = 'bounce-light';
  bounce.position.set(0.25, 0.08, 0.34);
  root.add(bounce);

  const lookTarget = new THREE.Vector3(0, 0.1, 0);

  return {
    root,
    camera,
    immersive: false,
    ownsCamera: true,
    xrDistance: 2.2,
    framing: { distance: 0.62, height: 0.26, targetY: 0.1 },

    update(time: number, delta: number, sceneCtx: SceneContext): void {
      // 转台：XR 里相机被接管，靠转台制造运动感
      turntable.rotation.y += delta * 0.07;

      steamSpace.update(delta, time);
      steam.uniforms.uTime.value = time;
      updateMoteScale(steam.uniforms, sceneCtx, FOV);

      if (sceneCtx.isXR) {
        root.position.z = -2.2;
        return;
      }

      const angle = time * 0.12 + 0.45;
      const radius = 0.68 + Math.sin(time * 0.23) * 0.035;
      camera.position.set(Math.sin(angle) * radius, 0.25 + Math.sin(time * 0.31) * 0.02, Math.cos(angle) * radius);
      camera.lookAt(lookTarget);
    },

    dispose(): void {
      colorMap.dispose();
      roughnessMap.dispose();
      backdropTexture.dispose();
      disposeHierarchy(root);
    },
  };
}

export const celadonScene: SceneDefinition = {
  id: 'celadon',
  title: '青瓷茶器',
  subtitle: 'Celadon Tea Set',
  description: '青釉的茶壶与品茗杯在柔和侧光下泛着温润的釉光，热气从壶口极慢地升起。',
  tags: ['青瓷', '茶器', '釉面'],
  accent: '#8fd8c0',
  gradient: ['#16302c', '#080b0e'],
  category: 'model',
  lighting: {
    autoExposure: true,
    autoExposureKey: 0.13,
    realTimeReflection: true,
    lightProbe: true,
  },
  create(ctx: SceneContext): SceneInstance {
    return createCeladon(ctx);
  },
};

export default celadonScene;
