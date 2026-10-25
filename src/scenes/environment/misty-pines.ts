/**
 * 雾松林 / Misty Pines
 * ---------------------------------------------------------------
 * 清晨的松林：高低错落的松树程序化生成（针叶是几层交错的锥体簇），
 * 浓雾贴着地面缓慢流动，树干上结着一层薄霜，偶尔有一束光穿过树冠落下来。
 *
 * 空间上分三层：近处的几棵松树夹住画面，中景是成排的树，远景在雾里只剩剪影；
 * 所有材质都按距离褪进雾色，做出真正的空气透视。
 *
 * 音乐驱动：
 * - pulse → 风力：树冠摆动的幅度、雾的流速、光柱的明灭；
 * - bass → 雾的浓度缓慢涨落；mid → 雾层飘动；treble → 霜与针叶的细碎闪烁；
 * - level → 整体亮度与能见度。
 */

import * as THREE from 'three';
import type { SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { disposeObject } from '../../core/loader.js';
import { ParticleSpace } from '../../core/particle-space.js';
import {
  AudioDriver,
  GLSL_HASH,
  GLSL_NOISE2,
  GLSL_OUTPUT,
  GLSL_OUTPUT_FUNCS,
  applyHaze,
  createGlowTexture,
  fbm2D,
} from './lib.js';
import {
  attachFrost,
  attachWindSway,
  createFrostUniforms,
  createGroundMistField,
  createMistTexture,
  createScenicSky,
  createWindSwayUniforms,
  mergeSwayGeometries,
  setProgramKey,
  setSwayAttribute,
} from './scenic.js';

const BREATHING = { inhale: 6, hold: 2, exhale: 8 };
const FOV = 52;

/** 雾色：所有远处的东西都褪进这个颜色。 */
const HAZE = 0xb3c3c0;

/* ------------------------------------------------------------------ *
 * 地形
 * ------------------------------------------------------------------ */

/** 林地的起伏：地面网格与树的位置共用这一个函数，树就正好长在地上。 */
function groundHeight(x: number, z: number): number {
  const dune = (fbm2D(x * 0.045 + 11.3, z * 0.045 + 4.7, 3) - 0.5) * 0.72;
  const ripple = (fbm2D(x * 0.17 + 2.1, z * 0.17 + 8.9, 2) - 0.5) * 0.16;
  return dune + ripple;
}

/** 林地的地表：落叶、松针与苔斑。 */
function createForestFloorTexture(size = 256): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');

  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = (x / size) * 7;
      const v = (y / size) * 7;
      const litter = fbm2D(u * 1.7, v * 1.7, 4);
      const needle = fbm2D(u * 9.5 + 3.3, v * 2.2 + 6.1, 2);
      const moss = THREE.MathUtils.smoothstep(fbm2D(u * 0.9 + 21.4, v * 0.9 + 12.8, 3), 0.52, 0.78);
      const speck = Math.pow(fbm2D(u * 26 + 4.1, v * 26 + 1.7, 2), 8);

      // 针叶是拉长的细纹，混在落叶与苔斑之间
      const straw = 0.88 + needle * 0.24;
      const r = THREE.MathUtils.lerp(104 + litter * 34, 112 + moss * 26, moss) * straw;
      const g = THREE.MathUtils.lerp(96 + litter * 30, 130 + moss * 30, moss) * straw;
      const b = THREE.MathUtils.lerp(78 + litter * 22, 92 + moss * 20, moss) * straw;

      const i = (y * size + x) * 4;
      image.data[i] = Math.round(r + speck * 58);
      image.data[i + 1] = Math.round(g + speck * 54);
      image.data[i + 2] = Math.round(b + speck * 40);
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'pine-needles-floor';
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

/* ------------------------------------------------------------------ *
 * 松树
 * ------------------------------------------------------------------ */

interface PineGeometry {
  trunk: THREE.BufferGeometry;
  foliage: THREE.BufferGeometry;
}

/**
 * 生成一棵松树的几何体。
 *
 * 树干是一根略带弯的锥形圆柱；针叶是 4 层交错的锥体簇，越往上越小，
 * 每层还带一点随机倾斜，所以树形不会千篇一律。
 */
function createPineGeometry(height: number, spread: number, seed: number): PineGeometry {
  let state = seed >>> 0;
  const random = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };

  const trunkHeight = height * 0.94;
  const trunk = new THREE.CylinderGeometry(height * 0.008, height * 0.028, trunkHeight, 7, 4, true);
  trunk.translate(0, trunkHeight / 2, 0);
  setSwayAttribute(trunk, (y) => Math.pow(THREE.MathUtils.clamp(y / trunkHeight, 0, 1), 2) * 0.22);

  const layers = 4;
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < layers; i += 1) {
    const t = i / (layers - 1);
    const radius = spread * (1 - t * 0.74) * (0.86 + random() * 0.26);
    const coneHeight = height * (0.36 - t * 0.07);
    const y = height * (0.26 + t * 0.6);

    const cone = new THREE.ConeGeometry(radius, coneHeight, 9, 1);
    cone.rotateY(random() * Math.PI * 2);
    cone.rotateZ((random() - 0.5) * 0.1);
    cone.translate((random() - 0.5) * spread * 0.12, y, (random() - 0.5) * spread * 0.12);
    setSwayAttribute(cone, (py) => Math.pow(THREE.MathUtils.clamp(py / height, 0, 1), 1.5));
    parts.push(cone);
  }

  return { trunk, foliage: mergeSwayGeometries(parts) };
}

/* ------------------------------------------------------------------ *
 * 雾面与光柱
 * ------------------------------------------------------------------ */

const MIST_SHEET_VERT = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const MIST_SHEET_FRAG = /* glsl */ `
#ifndef MISTY_PINES_MIST_FRAG_GUARD
#define MISTY_PINES_MIST_FRAG_GUARD
precision highp float;

uniform sampler2D uMap;
uniform float uTime;
uniform float uOpacity;
uniform vec3 uColor;

varying vec2 vUv;

${GLSL_OUTPUT_FUNCS}

void main() {
  // 两层不同速度的 fbm 贴图叠在一起，雾看起来一直在缓慢地流
  vec2 uv1 = vUv * 1.5 + vec2( uTime * 0.0055, uTime * 0.0022 );
  vec2 uv2 = vUv * 2.9 - vec2( uTime * 0.0092, uTime * 0.0041 );
  float a = texture2D( uMap, uv1 ).a * 0.72 + texture2D( uMap, uv2 ).a * 0.46;
  a = smoothstep( 0.16, 0.8, a );
  a *= smoothstep( 0.0, 0.34, vUv.y ) * smoothstep( 1.0, 0.58, vUv.y );
  a *= smoothstep( 0.0, 0.22, vUv.x ) * smoothstep( 1.0, 0.78, vUv.x );
  a *= uOpacity;
  if ( a < 0.004 ) discard;
  gl_FragColor = vec4( uColor, a );
  ${GLSL_OUTPUT}
}
#endif
`;

const SHAFT_VERT = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const SHAFT_FRAG = /* glsl */ `
#ifndef MISTY_PINES_SHAFT_FRAG_GUARD
#define MISTY_PINES_SHAFT_FRAG_GUARD
precision highp float;

uniform vec3 uColor;
uniform float uTime;
uniform float uIntensity;

varying vec2 vUv;

${GLSL_HASH}
${GLSL_NOISE2}
${GLSL_OUTPUT_FUNCS}

void main() {
  // 顶端（树冠的缝隙）亮，往下渐渐散开
  float along = smoothstep( 0.0, 0.34, vUv.y ) * smoothstep( 1.0, 0.5, vUv.y );
  float n = fbm2( vec2( vUv.x * 2.6, vUv.y * 1.1 - uTime * 0.035 ), 3 );
  float a = along * ( 0.28 + 0.95 * n ) * uIntensity;
  if ( a < 0.004 ) discard;
  gl_FragColor = vec4( uColor * a, 1.0 );
  ${GLSL_OUTPUT}
}
#endif
`;

/* ------------------------------------------------------------------ *
 * 场景
 * ------------------------------------------------------------------ */

function createMistyPines(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'misty-pines-scene';

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 400);
  camera.position.set(0, 1.75, 7.2);

  const quality = THREE.MathUtils.clamp(ctx.quality, 0.4, 2);
  const driver = new AudioDriver();

  const envMap = ctx.env.envMap;
  const textures: THREE.Texture[] = [];

  // ── 天光 ─────────────────────────────────────────────────────────────
  const sunDirection = new THREE.Vector3(-0.42, 0.78, 0.46).normalize();
  const sky = createScenicSky(
    {
      zenith: 0x7e96a6,
      horizon: 0xc9d6d4,
      ground: 0x4a5347,
      band: 0xe4e6d9,
      bandStrength: 0.3,
      bandY: 0.06,
      bandWidth: 0.16,
      sunDir: sunDirection,
      sunColor: 0xfff0cf,
      sunStrength: 0.55,
    },
    320,
  );
  root.add(sky.mesh);

  // ── 地面 ─────────────────────────────────────────────────────────────
  const floorTexture = createForestFloorTexture(256);
  textures.push(floorTexture);

  const floorMaterial = new THREE.MeshStandardMaterial({
    color: 0xc2c4ab,
    map: floorTexture,
    roughness: 0.97,
    metalness: 0,
  });
  floorMaterial.envMap = envMap;
  floorMaterial.envMapIntensity = 0.05;
  applyHaze(floorMaterial, { color: HAZE, near: 4, far: 40 });

  const floorSegments = Math.round(96 * quality);
  const floorGeometry = new THREE.PlaneGeometry(150, 150, floorSegments, floorSegments);
  floorGeometry.rotateX(-Math.PI / 2);
  const floorPosition = floorGeometry.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < floorPosition.count; i += 1) {
    const x = floorPosition.getX(i);
    const z = floorPosition.getZ(i);
    floorPosition.setY(i, groundHeight(x, z));
  }
  floorPosition.needsUpdate = true;
  floorGeometry.computeVertexNormals();

  const floor = new THREE.Mesh(floorGeometry, floorMaterial);
  floor.name = 'forest-floor';
  floor.position.set(0, 0, -34);
  floor.receiveShadow = true;
  root.add(floor);

  // ── 材质：树皮 / 针叶 ───────────────────────────────────────────────
  const swayUniforms = createWindSwayUniforms();
  const barkFrost = createFrostUniforms({ amount: 0.34, scale: 2.4, color: 0xd9e7ea });
  const needleFrost = createFrostUniforms({ amount: 0.22, scale: 3.1, color: 0xd6e4e4 });

  const barkMaterial = new THREE.MeshStandardMaterial({
    color: 0x6a5a49,
    roughness: 0.96,
    metalness: 0,
  });
  barkMaterial.envMap = envMap;
  barkMaterial.envMapIntensity = 0.05;
  applyHaze(barkMaterial, { color: HAZE, near: 4, far: 34 });
  attachFrost(barkMaterial, barkFrost);
  setProgramKey(barkMaterial, 'misty-pines/bark/frost');

  const needleMaterial = new THREE.MeshStandardMaterial({
    color: 0x4d6846,
    roughness: 0.93,
    metalness: 0,
    flatShading: true,
  });
  needleMaterial.envMap = envMap;
  needleMaterial.envMapIntensity = 0.05;
  applyHaze(needleMaterial, { color: HAZE, near: 4, far: 32 });
  attachWindSway(needleMaterial, swayUniforms);
  attachFrost(needleMaterial, needleFrost);
  setProgramKey(needleMaterial, 'misty-pines/needles/sway/frost');

  // ── 松树 ─────────────────────────────────────────────────────────────
  let state = 30517;
  const random = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };

  const variants = [
    createPineGeometry(13.5, 2.9, 7717),
    createPineGeometry(10.2, 2.4, 9131),
    createPineGeometry(16.4, 3.3, 5507),
  ];

  const placeTree = (x: number, z: number, variant: number, scale: number): void => {
    const geo = variants[variant];
    const base = groundHeight(x, z) - 0.12;

    const trunk = new THREE.Mesh(geo.trunk, barkMaterial);
    trunk.name = 'pine-trunk';
    trunk.position.set(x, base, z);
    trunk.rotation.y = random() * Math.PI * 2;
    trunk.scale.setScalar(scale);
    root.add(trunk);

    const foliage = new THREE.Mesh(geo.foliage, needleMaterial);
    foliage.name = 'pine-foliage';
    foliage.position.set(x, base, z);
    foliage.rotation.y = random() * Math.PI * 2;
    foliage.scale.setScalar(scale);
    root.add(foliage);
  };

  // 近景：夹住画面两侧的松树
  const nearCount = Math.round(8 * quality);
  for (let i = 0; i < nearCount; i += 1) {
    const side = i % 2 === 0 ? 1 : -1;
    const x = side * (4.6 + random() * 4.2);
    const z = 2.5 - random() * 10;
    placeTree(x, z, i % 3, 0.82 + random() * 0.36);
  }

  // 中景：成排的树
  const midCount = Math.round(14 * quality);
  for (let i = 0; i < midCount; i += 1) {
    const side = random() > 0.5 ? 1 : -1;
    const x = side * (5.5 + random() * 10.5);
    const z = -11 - random() * 18;
    placeTree(x, z, (i + 1) % 3, 0.8 + random() * 0.45);
  }

  // 远景：在雾里只剩剪影
  const farCount = Math.round(18 * quality);
  for (let i = 0; i < farCount; i += 1) {
    const x = (random() * 2 - 1) * 34;
    const z = -30 - random() * 46;
    placeTree(x, z, (i + 2) % 3, 0.85 + random() * 0.5);
  }

  // ── 贴地的浓雾（粒子空间） ───────────────────────────────────────────
  const mistSpace = new ParticleSpace({
    radius: 24,
    spin: 0.006,
    tilt: 0.03,
    position: [0, 0.03, -8],
  });

  const mistField = createGroundMistField(mistSpace, {
    count: Math.round(1250 * quality),
    radius: 24,
    height: 1.5,
    size: 1.9,
    opacity: 0.19,
    color: 0xe4ecea,
    seed: 4816,
  });
  root.add(mistField.points);

  // ── 远处的雾面 ───────────────────────────────────────────────────────
  const mistTexture = createMistTexture(256, 3);
  textures.push(mistTexture);

  const mistMaterials: THREE.ShaderMaterial[] = [];
  const mistGroup = new THREE.Group();
  mistGroup.name = 'mist-banks';
  const sheetCount = Math.round(7 * quality);
  for (let i = 0; i < sheetCount; i += 1) {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: mistTexture },
        uTime: { value: 0 },
        uOpacity: { value: 0.16 },
        uColor: { value: new THREE.Color(0xe2ebe8) },
      },
      vertexShader: MIST_SHEET_VERT,
      fragmentShader: MIST_SHEET_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    mistMaterials.push(material);

    const depth = 11 + i * (7 + random() * 4);
    const sheet = new THREE.Mesh(new THREE.PlaneGeometry(30 + depth * 1.2, 5 + depth * 0.16), material);
    sheet.name = 'mist-sheet';
    sheet.position.set((random() * 2 - 1) * 6, 1.5 + random() * 1.4, -depth);
    sheet.rotation.y = (random() * 2 - 1) * 0.22;
    mistGroup.add(sheet);
  }
  root.add(mistGroup);

  // ── 穿过树冠的一束光 ─────────────────────────────────────────────────
  const shaftMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0xfff0cd) },
      uTime: { value: 0 },
      uIntensity: { value: 0.14 },
    },
    vertexShader: SHAFT_VERT,
    fragmentShader: SHAFT_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });

  const shaftHeight = 17;
  const shaftBase = new THREE.Vector3(-2.8, 0, -21);
  const shaft = new THREE.Mesh(new THREE.ConeGeometry(2.4, shaftHeight, 14, 1, true), shaftMaterial);
  shaft.name = 'light-shaft';
  shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), sunDirection);
  shaft.position.copy(shaftBase).addScaledVector(sunDirection, shaftHeight * 0.5);
  root.add(shaft);

  const glowTexture = createGlowTexture(128, 2.0);
  textures.push(glowTexture);
  const sunGlow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture,
      color: 0xfff2d4,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  sunGlow.name = 'sun-glow';
  sunGlow.scale.setScalar(10);
  sunGlow.position.copy(shaftBase).addScaledVector(sunDirection, shaftHeight * 1.02);
  root.add(sunGlow);

  // ── 灯光 ─────────────────────────────────────────────────────────────
  const lights = ctx.env.createStudioLights();
  lights.traverse((child) => {
    if (child instanceof THREE.Light) {
      child.intensity *= 0.28;
      child.castShadow = false;
      child.color.setHex(0xc6dae6);
    }
  });
  root.add(lights);

  const sun = new THREE.DirectionalLight(0xffeed0, 1.35);
  sun.position.copy(sunDirection).multiplyScalar(46);
  root.add(sun);
  root.add(sun.target);

  const ambient = new THREE.HemisphereLight(0xc6d9e2, 0x4a5340, 1.25);
  root.add(ambient);

  const updateScale = (context: SceneContext): void => {
    const halfFov = THREE.MathUtils.degToRad(FOV) * 0.5;
    mistField.uniforms.uScale.value =
      (context.height * 0.5 * context.renderer.getPixelRatio()) / Math.tan(halfFov);
  };
  updateScale(ctx);

  return {
    root,
    camera,
    immersive: true,
    xrDistance: 3,
    framing: { distance: 7.2, height: 1.75, targetY: 1.55, width: 16 },
    update(time: number, delta: number, context: SceneContext): void {
      driver.update(context, delta);

      const pulse = driver.pulse;
      const level = driver.level;

      // 风：脉冲决定摆动幅度与速度
      swayUniforms.uSwayTime.value = time;
      swayUniforms.uSwayStrength.value = 0.028 + pulse * 0.085 + level * 0.02;
      swayUniforms.uSwaySpeed.value = 0.85 + pulse * 1.5 + driver.mid * 0.4;

      // 雾：中频推动流动，低频让浓度缓慢涨落
      mistField.uniforms.uTime.value = time;
      mistField.uniforms.uWind.value = 0.12 + pulse * 0.55 + driver.mid * 0.22;
      mistField.uniforms.uOpacity.value = 0.07 + level * 0.08 + driver.bass * 0.05 + pulse * 0.03;
      mistSpace.breathe = 1 + pulse * 0.035;
      mistSpace.breathPhase = pulse;
      mistSpace.update(delta, time);

      for (const material of mistMaterials) {
        material.uniforms.uTime.value = time * (1 + driver.mid * 0.6);
        material.uniforms.uOpacity.value = 0.1 + level * 0.1 + driver.bass * 0.04;
      }
      mistGroup.position.x = Math.sin(time * 0.045) * 0.9 + driver.mid * 0.6;

      // 光柱：随呼吸与响度明灭，偶尔一阵一阵地亮起来
      const shaftPulse = 0.6 + 0.4 * Math.sin(time * 0.21);
      shaftMaterial.uniforms.uTime.value = time;
      shaftMaterial.uniforms.uIntensity.value =
        (0.07 + level * 0.07 + pulse * 0.06) * shaftPulse;
      sunGlow.material.opacity = 0.2 + level * 0.22 + pulse * 0.1;

      // 霜：高频让霜面有一点细碎的反光
      barkFrost.uFrostAmount.value = 0.22 + level * 0.2 + driver.treble * 0.12;
      needleFrost.uFrostAmount.value = 0.16 + level * 0.14 + driver.treble * 0.14;

      // 天光与整体亮度
      sky.uniforms.uSkyBandStrength.value = 0.26 + level * 0.16;
      sky.uniforms.uSkySunStrength.value = 0.45 + level * 0.35;
      sun.intensity = 1.15 + level * 0.5;
      ambient.intensity = 1.05 + level * 0.35;

      updateScale(context);
    },
    dispose(): void {
      for (const texture of textures) texture.dispose();
      disposeObject(root);
    },
  };
}

export const mistyPinesScene: SceneDefinition = {
  id: 'misty-pines',
  title: '雾松林',
  subtitle: 'Misty Pines',
  description: '清晨的松林里浓雾贴着地面流动，风穿过针叶，偶尔有一束光落下。',
  tags: ['松林', '晨雾', '风声'],
  accent: '#a9c8c1',
  gradient: ['#7f9c96', '#202d29'],
  category: 'environment',
  audio: 'misty-pines.mp3',
  breathing: BREATHING,
  lighting: { autoExposure: true, autoExposureKey: 0.1 },
  create(ctx: SceneContext): SceneInstance {
    return createMistyPines(ctx);
  },
};

export default mistyPinesScene;
