/**
 * 城市微缩 —— 程序化生成的昼夜城市模型。
 *
 * 建筑用 InstancedMesh 批量生成（网格分布 + 随机高度/占地），
 * 窗户是包在建筑外的自发光灯带，街道是发光条，街上跑着发光的车辆。
 * 昼夜以 44 秒为周期平滑过渡。
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { createRadialGlowTexture, createVerticalGradientTexture, disposeHierarchy } from './shared.js';

/** 昼夜周期（秒）。 */
const DAY_CYCLE = 44;
/** XR 中内容与用户的距离。 */
const XR_DISTANCE = 4;

interface BuildingSpec {
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
  /** 建筑基色（HSL 亮度 + 色相）。 */
  hue: number;
  saturation: number;
  lightness: number;
  /** 塔楼天线高度（0 表示没有）。 */
  spire: number;
}

interface WindowBand {
  x: number;
  z: number;
  y: number;
  width: number;
  depth: number;
  height: number;
  color: THREE.Color;
}

interface CarSpec {
  /** 0 = 沿 X 行驶，1 = 沿 Z 行驶。 */
  axis: 0 | 1;
  /** 行驶的街道编号。 */
  line: number;
  /** 车道方向（相对街道中心线的偏移符号）。 */
  lane: number;
  /** 行驶方向。 */
  dir: 1 | -1;
  speed: number;
  /** 沿街道方向的当前坐标。 */
  offset: number;
}

function createCity(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'city';

  const quality = ctx.quality;
  const cells = Math.max(8, Math.min(16, Math.round(12 * Math.sqrt(quality))));
  const pitch = 2.35;
  const roadWidth = 0.8;
  const citySize = cells * pitch;
  const half = citySize * 0.5;
  const baseSize = citySize + 12;

  /* ---------------- 地面与底座 ---------------- */

  const baseMaterial = new THREE.MeshStandardMaterial({
    color: 0x06080c,
    roughness: 0.62,
    metalness: 0.22,
    envMapIntensity: 0.4,
  });
  const base = new THREE.Mesh(new RoundedBoxGeometry(baseSize, 0.6, baseSize, 4, 0.16), baseMaterial);
  base.position.y = -0.32;
  base.receiveShadow = true;
  root.add(base);

  const floorMaterial = new THREE.MeshStandardMaterial({
    color: 0x0d1017,
    roughness: 0.88,
    metalness: 0.08,
    envMapIntensity: 0.35,
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(citySize + 2.4, citySize + 2.4), floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  root.add(floor);

  /* ---------------- 街区生成 ---------------- */

  const buildings: BuildingSpec[] = [];
  const bands: WindowBand[] = [];
  const beaconPoints: number[] = [];
  const spires: BuildingSpec[] = [];

  const warm = new THREE.Color(0xffc98a);
  const cool = new THREE.Color(0x9fd8ff);
  const dim = new THREE.Color(0x0c1018);

  const usable = pitch - roadWidth;
  for (let i = 0; i < cells; i += 1) {
    for (let j = 0; j < cells; j += 1) {
      const blockX = -half + (i + 0.5) * pitch;
      const blockZ = -half + (j + 0.5) * pitch;

      // 每个街区切成 1~3 个地块。
      const lotCount = 1 + Math.floor(Math.random() * 3);
      const splitAxis = Math.random() < 0.5;
      for (let k = 0; k < lotCount; k += 1) {
        const offset = ((k + 0.5) / lotCount - 0.5) * usable;
        const sizeAlong = usable / lotCount - 0.14;
        const sizeAcross = usable - 0.1;
        const width = splitAxis ? sizeAlong : sizeAcross;
        const depth = splitAxis ? sizeAcross : sizeAlong;
        const x = blockX + (splitAxis ? offset : (Math.random() - 0.5) * 0.12);
        const z = blockZ + (splitAxis ? (Math.random() - 0.5) * 0.12 : offset);

        const roll = Math.random();
        let height: number;
        if (roll < 0.6) height = 0.8 + Math.random() * 1.9;
        else if (roll < 0.9) height = 2.8 + Math.random() * 3.2;
        else height = 6.2 + Math.random() * 5.4;

        const building: BuildingSpec = {
          x,
          z,
          width: width * (0.86 + Math.random() * 0.14),
          depth: depth * (0.86 + Math.random() * 0.14),
          height,
          hue: 0.55 + Math.random() * 0.12,
          saturation: 0.04 + Math.random() * 0.16,
          lightness: 0.22 + Math.random() * 0.28,
          spire: height > 6.5 ? 0.8 + Math.random() * 1.8 : 0,
        };
        buildings.push(building);
        if (building.spire > 0) spires.push(building);
      }
    }
  }

  // 窗格灯带：每栋楼按高度分层。
  for (const building of buildings) {
    const layers = Math.max(1, Math.min(5, Math.floor(building.height / 1.25)));
    for (let k = 0; k < layers; k += 1) {
      const y = 0.5 + (k + 0.35) * ((building.height - 0.8) / layers);
      const roll = Math.random();
      const color = roll < 0.16 ? dim : roll < 0.72 ? warm : cool;
      bands.push({
        x: building.x,
        z: building.z,
        y,
        width: building.width + 0.06,
        depth: building.depth + 0.06,
        height: Math.min(0.2, building.height * 0.12),
        color: color.clone().multiplyScalar(0.72 + Math.random() * 0.55),
      });
    }
    if (building.spire > 0) {
      beaconPoints.push(building.x, building.height + building.spire + 0.3, building.z);
    }
  }

  /* ---------------- 建筑实例 ---------------- */

  const buildingMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.58,
    metalness: 0.16,
    envMapIntensity: 0.5,
  });
  const buildingMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), buildingMaterial, buildings.length);
  buildingMesh.castShadow = true;
  buildingMesh.receiveShadow = true;
  buildingMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const instanceColor = new THREE.Color();

  buildings.forEach((building, index) => {
    position.set(building.x, building.height * 0.5, building.z);
    scale.set(building.width, building.height, building.depth);
    matrix.compose(position, quaternion, scale);
    buildingMesh.setMatrixAt(index, matrix);
    instanceColor.setHSL(building.hue, building.saturation, building.lightness);
    buildingMesh.setColorAt(index, instanceColor);
  });
  buildingMesh.instanceMatrix.needsUpdate = true;
  if (buildingMesh.instanceColor) buildingMesh.instanceColor.needsUpdate = true;
  root.add(buildingMesh);

  /* ---------------- 窗格灯带 ---------------- */

  const bandMaterial = new THREE.MeshBasicMaterial({ color: 0x10131a, toneMapped: true });
  const bandMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), bandMaterial, bands.length);
  bandMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  bands.forEach((band, index) => {
    position.set(band.x, band.y, band.z);
    scale.set(band.width, band.height, band.depth);
    matrix.compose(position, quaternion, scale);
    bandMesh.setMatrixAt(index, matrix);
    bandMesh.setColorAt(index, band.color);
  });
  bandMesh.instanceMatrix.needsUpdate = true;
  if (bandMesh.instanceColor) bandMesh.instanceColor.needsUpdate = true;
  root.add(bandMesh);

  /* ---------------- 天线与航障灯 ---------------- */

  if (spires.length > 0) {
    const spireMaterial = new THREE.MeshStandardMaterial({ color: 0x2a3040, roughness: 0.5, metalness: 0.7 });
    const spireMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.035, 0.055, 1, 6), spireMaterial, spires.length);
    spires.forEach((building, index) => {
      position.set(building.x, building.height + building.spire * 0.5, building.z);
      scale.set(1, building.spire, 1);
      matrix.compose(position, quaternion, scale);
      spireMesh.setMatrixAt(index, matrix);
    });
    spireMesh.instanceMatrix.needsUpdate = true;
    root.add(spireMesh);
  }

  let beaconMaterial: THREE.PointsMaterial | null = null;
  if (beaconPoints.length > 0) {
    const beaconGeometry = new THREE.BufferGeometry();
    beaconGeometry.setAttribute('position', new THREE.Float32BufferAttribute(beaconPoints, 3));
    beaconMaterial = new THREE.PointsMaterial({
      map: createRadialGlowTexture(128, 'rgba(255,140,110,1)'),
      color: 0xff6a52,
      size: 1.2,
      sizeAttenuation: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0.25,
    });
    const beacons = new THREE.Points(beaconGeometry, beaconMaterial);
    root.add(beacons);
  }

  /* ---------------- 街道 ---------------- */

  const lineCount = cells + 1;
  const roadMaterial = new THREE.MeshStandardMaterial({
    color: 0x14181f,
    roughness: 0.9,
    metalness: 0.05,
  });
  const roadMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), roadMaterial, lineCount * 2);
  const streetMaterial = new THREE.MeshBasicMaterial({ color: 0x1a1d24, toneMapped: true });
  const streetMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), streetMaterial, lineCount * 2);

  let roadIndex = 0;
  for (let i = 0; i < lineCount; i += 1) {
    const coord = -half + i * pitch;

    position.set(coord, 0.012, 0);
    scale.set(roadWidth, 0.024, citySize);
    matrix.compose(position, quaternion, scale);
    roadMesh.setMatrixAt(roadIndex, matrix);

    position.set(coord, 0.03, 0);
    scale.set(0.1, 0.012, citySize);
    matrix.compose(position, quaternion, scale);
    streetMesh.setMatrixAt(roadIndex, matrix);
    roadIndex += 1;

    position.set(0, 0.012, coord);
    scale.set(citySize, 0.024, roadWidth);
    matrix.compose(position, quaternion, scale);
    roadMesh.setMatrixAt(roadIndex, matrix);

    position.set(0, 0.03, coord);
    scale.set(citySize, 0.012, 0.1);
    matrix.compose(position, quaternion, scale);
    streetMesh.setMatrixAt(roadIndex, matrix);
    roadIndex += 1;
  }
  roadMesh.instanceMatrix.needsUpdate = true;
  streetMesh.instanceMatrix.needsUpdate = true;
  root.add(roadMesh);
  root.add(streetMesh);

  /* ---------------- 路灯 ---------------- */

  const lampPositions: number[] = [];
  for (let i = 0; i < lineCount; i += 1) {
    const coord = -half + i * pitch;
    const steps = Math.max(4, Math.floor(citySize / 6));
    for (let s = 0; s < steps; s += 1) {
      const along = -half + ((s + 0.5) / steps) * citySize;
      lampPositions.push(coord + roadWidth * 0.44, 0.45, along);
      lampPositions.push(along, 0.45, coord + roadWidth * 0.44);
    }
  }
  const lampGeometry = new THREE.BufferGeometry();
  lampGeometry.setAttribute('position', new THREE.Float32BufferAttribute(lampPositions, 3));
  const lampMaterial = new THREE.PointsMaterial({
    map: createRadialGlowTexture(128, 'rgba(255,214,150,1)'),
    color: 0xffc98a,
    size: 0.8,
    sizeAttenuation: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    opacity: 0.18,
  });
  const lamps = new THREE.Points(lampGeometry, lampMaterial);
  root.add(lamps);

  /* ---------------- 车流 ---------------- */

  const carCount = Math.max(10, Math.min(140, Math.round(48 * quality)));
  const cars: CarSpec[] = [];
  for (let i = 0; i < carCount; i += 1) {
    const axis: 0 | 1 = Math.random() < 0.5 ? 0 : 1;
    const line = Math.floor(Math.random() * lineCount);
    cars.push({
      axis,
      line,
      lane: Math.random() < 0.5 ? -1 : 1,
      dir: Math.random() < 0.5 ? 1 : -1,
      speed: 3.4 + Math.random() * 4.6,
      offset: (Math.random() - 0.5) * citySize,
    });
  }

  const headMaterial = new THREE.MeshBasicMaterial({ color: 0xfff0cf, toneMapped: true });
  const tailMaterial = new THREE.MeshBasicMaterial({ color: 0xff4633, toneMapped: true });
  const headMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.46, 0.2, 0.24), headMaterial, carCount);
  const tailMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.46, 0.16, 0.24), tailMaterial, carCount);
  headMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  tailMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  root.add(headMesh);
  root.add(tailMesh);

  /* ---------------- 底座辉光与天空 ---------------- */

  const haloMaterial = new THREE.MeshBasicMaterial({
    map: createRadialGlowTexture(256, 'rgba(120,180,255,0.95)'),
    color: 0x4f8bff,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    opacity: 0.3,
  });
  const halo = new THREE.Mesh(new THREE.PlaneGeometry(baseSize * 1.5, baseSize * 1.5), haloMaterial);
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = -0.63;
  root.add(halo);

  const skyTexture = createVerticalGradientTexture([
    [0, '#0a1430'],
    [0.45, '#16294f'],
    [0.78, '#2c4a74'],
    [1, '#050810'],
  ]);
  const skyMaterial = new THREE.MeshBasicMaterial({ map: skyTexture, side: THREE.BackSide, fog: false });
  const sky = new THREE.Mesh(new THREE.CylinderGeometry(130, 130, 110, 48, 1, true), skyMaterial);
  sky.position.y = 18;
  root.add(sky);

  /* ---------------- 灯光 ---------------- */

  const sun = new THREE.DirectionalLight(0xfff0dc, 2.6);
  sun.position.set(26, 38, 18);
  sun.castShadow = true;
  const shadowSize = quality > 1 ? 2048 : 1024;
  sun.shadow.mapSize.set(shadowSize, shadowSize);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 160;
  sun.shadow.camera.left = -half - 4;
  sun.shadow.camera.right = half + 4;
  sun.shadow.camera.top = half + 4;
  sun.shadow.camera.bottom = -half - 4;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.03;
  root.add(sun);

  const moon = new THREE.DirectionalLight(0x93b7ff, 0.0);
  moon.position.set(-22, 26, -16);
  root.add(moon);

  const ambient = new THREE.AmbientLight(0xffffff, 0.22);
  root.add(ambient);

  const hemi = new THREE.HemisphereLight(0x9fc0ff, 0x0a0d14, 0.35);
  root.add(hemi);

  /* ---------------- 昼夜配色 ---------------- */

  const dayBuilding = new THREE.Color(0xffffff);
  const nightBuilding = new THREE.Color(0x2b3652);
  const dayBand = new THREE.Color(0x8a93a4);
  const nightBand = new THREE.Color(0xffffff);
  const dayStreet = new THREE.Color(0x1b1f27);
  const nightStreet = new THREE.Color(0xffb066);
  const daySky = new THREE.Color(0xffffff);
  const nightSky = new THREE.Color(0x5f7bb5);
  const dayFog = new THREE.Color(0x8fa8c8);
  const nightFog = new THREE.Color(0x070b16);
  const duskTint = new THREE.Color(0xff9d5c);
  const coolAmbient = new THREE.Color(0x4a5f8c);
  const coolHemi = new THREE.Color(0x2b3f6e);
  const workingColor = new THREE.Color();

  const fog = new THREE.Fog(dayFog.clone(), 26, 120);
  let hostScene: THREE.Scene | null = null;
  let previousFog: THREE.Fog | THREE.FogExp2 | null = null;

  /* ---------------- 相机 ---------------- */

  const camera = new THREE.PerspectiveCamera(38, 1, 0.5, 400);
  const lookTarget = new THREE.Vector3(0, 2.4, 0);

  return {
    root,
    camera,
    immersive: false,
    ownsCamera: true,
    xrDistance: XR_DISTANCE,
    framing: { distance: 34, height: 23, targetY: 2.4 },

    update(time, delta, sceneCtx) {
      root.position.z = sceneCtx.isXR ? -XR_DISTANCE : 0;

      /* --- 昼夜 --- */
      const phase = (time % DAY_CYCLE) / DAY_CYCLE;
      const dayAmount = 0.5 + 0.5 * Math.cos(phase * Math.PI * 2);
      const nightAmount = 1 - dayAmount;
      const dusk = Math.pow(1 - Math.abs(dayAmount * 2 - 1), 2.2);

      sun.intensity = 0.08 + 1.45 * Math.pow(dayAmount, 1.4);
      sun.color.copy(workingColor.setHex(0xfff0dc)).lerp(duskTint, dusk * 0.85);
      moon.intensity = 0.42 * nightAmount;
      ambient.intensity = 0.14 + 0.2 * dayAmount;
      ambient.color.copy(workingColor.setHex(0xffffff)).lerp(coolAmbient, nightAmount);
      hemi.intensity = 0.1 + 0.3 * dayAmount;
      hemi.color.copy(workingColor.setHex(0x9fc0ff)).lerp(coolHemi, nightAmount);

      buildingMaterial.color.copy(dayBuilding).lerp(nightBuilding, nightAmount);
      bandMaterial.color.copy(dayBand).lerp(nightBand, Math.pow(nightAmount, 1.6)).multiplyScalar(1 + nightAmount * 0.9);
      streetMaterial.color.copy(dayStreet).lerp(nightStreet, Math.pow(nightAmount, 1.4));
      lampMaterial.opacity = 0.12 + 0.85 * nightAmount;
      if (beaconMaterial) beaconMaterial.opacity = 0.2 + 0.8 * nightAmount;
      haloMaterial.opacity = 0.1 + 0.35 * nightAmount;
      skyMaterial.color.copy(daySky).lerp(nightSky, nightAmount);

      // 雾：宿主场景没有自带雾时才接管，卸载时还原。
      if (!hostScene) {
        hostScene = (root.parent as THREE.Scene | null) ?? null;
        previousFog = hostScene?.fog ?? null;
      }
      if (hostScene && !previousFog) {
        fog.color.copy(dayFog).lerp(nightFog, nightAmount);
        fog.near = 26 - 10 * nightAmount;
        fog.far = 120 - 40 * nightAmount;
        hostScene.fog = fog;
      }

      /* --- 车流 --- */
      for (let i = 0; i < cars.length; i += 1) {
        const car = cars[i];
        car.offset += car.speed * car.dir * delta;
        let along = car.offset;
        along = ((along + half) % citySize + citySize) % citySize - half;

        const lineCoord = -half + car.line * pitch;
        const laneOffset = car.lane * roadWidth * 0.26;
        const headX = car.axis === 0 ? along : lineCoord + laneOffset;
        const headZ = car.axis === 0 ? lineCoord + laneOffset : along;
        const backX = car.axis === 0 ? along - car.dir * 0.32 : lineCoord + laneOffset;
        const backZ = car.axis === 0 ? lineCoord + laneOffset : along - car.dir * 0.32;

        position.set(headX, 0.16, headZ);
        if (car.axis === 1) scale.set(0.24, 0.2, 0.46);
        else scale.set(0.46, 0.2, 0.24);
        matrix.compose(position, quaternion, scale);
        headMesh.setMatrixAt(i, matrix);

        position.set(backX, 0.14, backZ);
        if (car.axis === 1) scale.set(0.24, 0.16, 0.4);
        else scale.set(0.4, 0.16, 0.24);
        matrix.compose(position, quaternion, scale);
        tailMesh.setMatrixAt(i, matrix);
      }
      headMesh.instanceMatrix.needsUpdate = true;
      tailMesh.instanceMatrix.needsUpdate = true;

      /* --- 相机 --- */
      if (sceneCtx.isXR) {
        // XR 中相机由 three 接管，靠转动模型制造运动感。
        root.rotation.y += delta * 0.07;
      } else {
        const angle = time * 0.052;
        const radius = 34 + Math.sin(time * 0.09) * 2.2;
        camera.position.set(Math.sin(angle) * radius, 23 + Math.sin(time * 0.13) * 2.4, Math.cos(angle) * radius);
        camera.lookAt(lookTarget);
      }
    },

    dispose() {
      if (hostScene && hostScene.fog === fog) hostScene.fog = previousFog;
      hostScene = null;
      previousFog = null;
      disposeHierarchy(root);
      root.clear();
    },
  };
}

export const cityScene: SceneDefinition = {
  id: 'city',
  title: '城市微缩',
  subtitle: 'Miniature City',
  description: '程序化生成的微缩都市，昼夜循环中窗户次第亮起，车流沿街道穿行。',
  tags: ['城市', '昼夜', '实例化'],
  accent: '#5fd0ff',
  gradient: ['#0f2a4a', '#05080f'],
  category: 'model',
  create: (ctx) => createCity(ctx),
};

export default cityScene;
