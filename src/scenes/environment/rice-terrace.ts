/**
 * 梯田晨光 / Rice Terraces
 * ---------------------------------------------------------------
 * 层层叠叠的梯田：一级一级的水田由田埂分开，每一级的水面都映着清晨的天空；
 * 薄雾在梯田之间流动，远处是一层山影，太阳刚刚从山后升起来。
 *
 * 梯田是一圈圈同心弧：以镜头所在的点为圆心向外铺开，
 * 每级水面抬高 0.55 米、往外推 4.4 米，于是从近到远一层层叠上去，
 * 形成「近景一级、中景几级、远景层峦、最后是山影与天光」的纵深。
 *
 * 音乐驱动：
 * - bass → 水田的波纹幅度（画面最主要的运动）；
 * - pulse → 天光的明灭与水面的碎光；mid → 雾在梯田间流动；
 * - treble → 水面细碎的高光；level → 雾的浓度与整体亮度。
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
  GLSL_SKY,
  attachWindSway,
  createGroundMistField,
  createMistTexture,
  createRidgeTexture,
  createScenicSky,
  createWindSwayUniforms,
  mergeSwayGeometries,
  setProgramKey,
  setSwayAttribute,
} from './scenic.js';

const BREATHING = { inhale: 6, hold: 2, exhale: 8 };
const FOV = 50;

/** 晨雾的颜色。 */
const HAZE = 0xc4cfcb;

/**
 * 梯田的几何：一圈圈同心弧，圆心在镜头前方。
 *
 * 镜头站在所有圆弧的外侧，于是每一级都朝着镜头凸出去，
 * 越远的一级越高 —— 正好是站在山坡上俯瞰梯田的样子。
 */
const FIELD_CENTER = new THREE.Vector3(-26, 0, -46);
/** 最近一级水田的半径。 */
const FIRST_RADIUS = 52;
/** 每向外一级，半径缩短这么多。 */
const RADIUS_STEP = 5.1;
/** 每级抬高的高度。 */
const LEVEL_STEP = 0.45;
/** 田埂的宽度（径向）。 */
const BUND_WIDTH = 0.9;
/** 每一级水田的径向宽度（不含田埂）。 */
const PADDY_WIDTH = 4.2;
/** 圆弧张开的角度（弧度）。 */
const ARC = 1.45;

/* ------------------------------------------------------------------ *
 * 水面
 * ------------------------------------------------------------------ */

const WATER_VERT = /* glsl */ `
#ifndef TERRACE_WATER_VERT_GUARD
#define TERRACE_WATER_VERT_GUARD
uniform float uTime;
uniform float uAmp;
uniform vec2 uCenter;

varying vec3 vWorld;
varying float vWave;

${GLSL_HASH}
${GLSL_NOISE2}

float terraceRipple( vec2 p, float t ) {
  // 以圆心为心的同心涟漪 + 一层细碎的噪声
  float r = length( p - uCenter );
  float rings = sin( r * 2.4 - t * 1.05 ) * 0.6 + sin( r * 3.9 + t * 0.63 ) * 0.4;
  float n = ( fbm2( p * 0.85 + vec2( t * 0.05, -t * 0.038 ), 3 ) - 0.5 ) * 2.0;
  return rings * uAmp + n * uAmp * 0.55;
}

void main() {
  vec3 p = position;
  float wave = terraceRipple( p.xz, uTime );
  p.y += wave;

  vec4 wp = modelMatrix * vec4( p, 1.0 );
  vWorld = wp.xyz;
  vWave = wave;

  gl_Position = projectionMatrix * viewMatrix * wp;
}
#endif
`;

const WATER_FRAG = /* glsl */ `
#ifndef TERRACE_WATER_FRAG_GUARD
#define TERRACE_WATER_FRAG_GUARD
precision highp float;

uniform float uTime;
uniform float uAmp;
uniform vec2 uCenter;
uniform vec3 uMudColor;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform float uSparkle;
uniform vec3 uHazeColor;
uniform float uHazeNear;
uniform float uHazeFar;

varying vec3 vWorld;
varying float vWave;

${GLSL_HASH}
${GLSL_NOISE2}
${GLSL_SKY}
${GLSL_OUTPUT_FUNCS}

float terraceRipple( vec2 p, float t ) {
  float r = length( p - uCenter );
  float rings = sin( r * 2.4 - t * 1.05 ) * 0.6 + sin( r * 3.9 + t * 0.63 ) * 0.4;
  float n = ( fbm2( p * 0.85 + vec2( t * 0.05, -t * 0.038 ), 3 ) - 0.5 ) * 2.0;
  return rings * uAmp + n * uAmp * 0.55;
}

void main() {
  vec2 p = vWorld.xz;

  float e = 0.16;
  float h = terraceRipple( p, uTime );
  float hx = terraceRipple( p + vec2( e, 0.0 ), uTime );
  float hz = terraceRipple( p + vec2( 0.0, e ), uTime );
  vec3 N = normalize( vec3( ( h - hx ) / e, 1.0, ( h - hz ) / e ) );

  vec3 V = normalize( cameraPosition - vWorld );
  float fres = pow( 1.0 - clamp( dot( N, V ), 0.0, 1.0 ), 3.2 );
  fres = mix( 0.06, 1.0, fres );

  // 天空的倒影：与天穹共用同一组 uniform
  vec3 R = reflect( -V, N );
  vec3 sky = scenicSkyColor( vec3( R.x, abs( R.y ) * 0.9 + 0.02, R.z ) );

  // 水底的泥色透上来一点
  float mud = fbm2( p * 1.6, 3 );
  vec3 base = uMudColor * ( 0.75 + mud * 0.6 );
  vec3 col = mix( base, sky, fres * 0.95 );

  // 晨光的高光
  vec3 H = normalize( uSunDir + V );
  float spec = pow( max( dot( N, H ), 0.0 ), 90.0 );
  col += uSunColor * spec * 1.6;

  // 波峰上的细碎闪光
  float sparkle = pow( fbm2( p * 7.5 + vec2( uTime * 0.16, 0.0 ), 2 ), 9.0 );
  col += uSunColor * sparkle * uSparkle * 2.2;

  // 空气透视
  float dist = length( cameraPosition - vWorld );
  float hazeMix = smoothstep( uHazeNear, uHazeFar, dist );
  col = mix( col, uHazeColor, hazeMix );

  gl_FragColor = vec4( col, 1.0 );
  ${GLSL_OUTPUT}
}
#endif
`;

/* ------------------------------------------------------------------ *
 * 贴图与几何
 * ------------------------------------------------------------------ */

/** 田埂的湿泥：深浅不匀的土色。 */
function createSoilTexture(size = 256): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');

  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = (x / size) * 6;
      const v = (y / size) * 6;
      const grain = fbm2D(u * 2.1, v * 2.1, 4);
      const fine = fbm2D(u * 11.0 + 2.7, v * 11.0 + 5.9, 2);
      const moss = THREE.MathUtils.smoothstep(fbm2D(u * 0.8 + 13.1, v * 0.8 + 4.4, 3), 0.55, 0.82);
      const shade = 0.62 + grain * 0.5 + fine * 0.18;

      const r = THREE.MathUtils.lerp(96 * shade, 84 * shade, moss);
      const g = THREE.MathUtils.lerp(78 * shade, 96 * shade, moss);
      const b = THREE.MathUtils.lerp(58 * shade, 62 * shade, moss);

      const i = (y * size + x) * 4;
      image.data[i] = Math.round(r);
      image.data[i + 1] = Math.round(g);
      image.data[i + 2] = Math.round(b);
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'terrace-soil';
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

/**
 * 把一段圆弧揉皱。
 *
 * 真正的梯田边界不是正圆弧，而是不规则的曲线。
 * 这里按「世界方位角」给半径加一点噪声偏移，
 * 水面、田埂、土壁用的是同一个函数，所以三者的接缝依然严丝合缝。
 */
function warpRingGeometry(geometry: THREE.BufferGeometry, amplitude: number, phase: number): void {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const z = position.getZ(i);
    const radius = Math.hypot(x, z);
    if (radius < 0.001) continue;
    const phi = Math.atan2(z, x);
    const wobble =
      (fbm2D(Math.cos(phi) * 2.1 + phase, Math.sin(phi) * 2.1 - phase, 4) - 0.5) * 2 * amplitude;
    const scale = (radius + wobble) / radius;
    position.setXYZ(i, x * scale, position.getY(i), z * scale);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
}

/**
 * 一丛稻苗：三片交叉的小面片。
 * 顶点色从根部的深绿渐变到梢头的浅黄绿。
 */
function createRiceTuftGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  for (let i = 0; i < 3; i += 1) {
    const blade = new THREE.PlaneGeometry(0.14, 0.5, 1, 3);
    blade.translate(0, 0.25, 0);

    // 叶片由宽变窄，梢头收成一点
    const position = blade.getAttribute('position') as THREE.BufferAttribute;
    for (let v = 0; v < position.count; v += 1) {
      const t = THREE.MathUtils.clamp(position.getY(v) / 0.5, 0, 1);
      const taper = 0.45 + 0.85 * Math.sin(Math.PI * Math.min(1, t * 1.05)) * (1 - t * 0.55);
      position.setX(v, position.getX(v) * taper);
    }
    position.needsUpdate = true;

    blade.rotateY((i / 3) * Math.PI);
    blade.rotateZ((i - 1) * 0.2);
    setSwayAttribute(blade, (y) => THREE.MathUtils.clamp(y / 0.5, 0, 1));

    const count = position.count;
    const colors = new Float32Array(count * 3);
    for (let v = 0; v < count; v += 1) {
      const t = THREE.MathUtils.clamp(position.getY(v) / 0.5, 0, 1);
      colors[v * 3] = 0.13 + t * 0.4;
      colors[v * 3 + 1] = 0.26 + t * 0.52;
      colors[v * 3 + 2] = 0.1 + t * 0.18;
    }
    blade.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    parts.push(blade);
  }

  return mergeSwayGeometries(parts);
}

const MIST_SHEET_VERT = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const MIST_SHEET_FRAG = /* glsl */ `
#ifndef TERRACE_MIST_FRAG_GUARD
#define TERRACE_MIST_FRAG_GUARD
precision highp float;

uniform sampler2D uMap;
uniform float uTime;
uniform float uOpacity;
uniform vec3 uColor;

varying vec2 vUv;

${GLSL_OUTPUT_FUNCS}

void main() {
  vec2 uv1 = vUv * 1.4 + vec2( uTime * 0.007, uTime * 0.003 );
  vec2 uv2 = vUv * 2.7 - vec2( uTime * 0.011, uTime * 0.005 );
  float a = texture2D( uMap, uv1 ).a * 0.72 + texture2D( uMap, uv2 ).a * 0.46;
  a = smoothstep( 0.16, 0.8, a );
  a *= smoothstep( 0.0, 0.32, vUv.y ) * smoothstep( 1.0, 0.6, vUv.y );
  a *= smoothstep( 0.0, 0.2, vUv.x ) * smoothstep( 1.0, 0.8, vUv.x );
  a *= uOpacity;
  if ( a < 0.004 ) discard;
  gl_FragColor = vec4( uColor, a );
  ${GLSL_OUTPUT}
}
#endif
`;

/* ------------------------------------------------------------------ *
 * 场景
 * ------------------------------------------------------------------ */

function createRiceTerrace(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'rice-terrace-scene';

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 600);
  camera.position.set(0, 5.2, 14);

  const quality = THREE.MathUtils.clamp(ctx.quality, 0.4, 2);
  const driver = new AudioDriver();
  const envMap = ctx.env.envMap;
  const textures: THREE.Texture[] = [];

  let state = 73013;
  const random = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };

  // ── 清晨的天 ─────────────────────────────────────────────────────────
  const sunDirection = new THREE.Vector3(-0.3, 0.17, -0.94).normalize();
  const sky = createScenicSky(
    {
      zenith: 0x6f9ec4,
      horizon: 0xe4e2cf,
      ground: 0x4a4c3e,
      band: 0xfbe6bc,
      bandStrength: 0.42,
      bandY: 0.03,
      bandWidth: 0.14,
      sunDir: sunDirection,
      sunColor: 0xffe9b8,
      sunStrength: 0.75,
    },
    460,
  );
  root.add(sky.mesh);

  // ── 梯田 ─────────────────────────────────────────────────────────────
  const levelCount = Math.round(8 * quality);
  const waterUniforms = {
    uTime: { value: 0 },
    uAmp: { value: 0.035 },
    uCenter: { value: new THREE.Vector2(FIELD_CENTER.x, FIELD_CENTER.z) },
    uMudColor: { value: new THREE.Color(0x3d4a3c) },
    uSunColor: { value: new THREE.Color(0xffe3ab) },
    uSunDir: { value: sunDirection.clone() },
    uSparkle: { value: 0.25 },
    uHazeColor: { value: new THREE.Color(HAZE) },
    uHazeNear: { value: 22 },
    uHazeFar: { value: 130 },
    ...sky.uniforms,
  };

  const waterMaterial = new THREE.ShaderMaterial({
    uniforms: waterUniforms,
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    side: THREE.FrontSide,
  });

  const soilTexture = createSoilTexture(256);
  textures.push(soilTexture);

  const bundMaterial = new THREE.MeshStandardMaterial({
    color: 0x9c8557,
    map: soilTexture,
    roughness: 0.97,
    metalness: 0,
    vertexColors: false,
  });
  bundMaterial.envMap = envMap;
  bundMaterial.envMapIntensity = 0.05;
  applyHaze(bundMaterial, { color: HAZE, near: 8, far: 90 });

  const riserMaterial = new THREE.MeshStandardMaterial({
    color: 0x7d6a48,
    map: soilTexture,
    roughness: 1,
    metalness: 0,
  });
  riserMaterial.envMap = envMap;
  riserMaterial.envMapIntensity = 0.04;
  applyHaze(riserMaterial, { color: HAZE, near: 8, far: 90 });

  const terraceGroup = new THREE.Group();
  terraceGroup.name = 'terraces';
  terraceGroup.position.copy(FIELD_CENTER);

  // 圆弧朝着镜头（世界坐标 +Z 方向）张开
  const thetaSegments = Math.round(96 * quality);
  const thetaStart = -Math.atan2(60, 26) - ARC;

  for (let i = 0; i < levelCount; i += 1) {
    // i = 0 是最近的一级，半径最大、位置最低；越往外半径越小、位置越高
    const radius = FIRST_RADIUS - i * RADIUS_STEP;
    const waterInner = radius - PADDY_WIDTH;
    const bundInner = waterInner - BUND_WIDTH;
    const level = i * LEVEL_STEP;

    // 水面：一块反射天空的田面
    const waterGeometry = new THREE.RingGeometry(waterInner, radius, thetaSegments, 1, thetaStart, ARC * 2);
    waterGeometry.rotateX(-Math.PI / 2);
    warpRingGeometry(waterGeometry, 1.15, i * 0.37);
    const paddy = new THREE.Mesh(waterGeometry, waterMaterial);
    paddy.name = 'paddy';
    paddy.position.y = level;
    terraceGroup.add(paddy);

    // 田埂：垫高的一圈土埂
    const bundGeometry = new THREE.RingGeometry(bundInner, waterInner, thetaSegments, 1, thetaStart, ARC * 2);
    bundGeometry.rotateX(-Math.PI / 2);
    warpRingGeometry(bundGeometry, 1.15, i * 0.37);
    const bund = new THREE.Mesh(bundGeometry, bundMaterial);
    bund.name = 'bund';
    bund.position.y = level + LEVEL_STEP;
    terraceGroup.add(bund);

    // 田埂挡住的土壁
    // 圆柱的参数化与圆环差 90°，这里换算一下让两者对齐
    const riserGeometry = new THREE.CylinderGeometry(
      bundInner,
      bundInner,
      LEVEL_STEP,
      thetaSegments,
      1,
      true,
      Math.PI / 2 + thetaStart,
      ARC * 2,
    );
    warpRingGeometry(riserGeometry, 1.15, i * 0.37);
    const riser = new THREE.Mesh(riserGeometry, riserMaterial);
    riser.name = 'riser';
    riser.position.y = level + LEVEL_STEP * 0.5;
    terraceGroup.add(riser);
  }
  root.add(terraceGroup);

  // ── 谷底 ─────────────────────────────────────────────────────────────
  const valleyMaterial = new THREE.MeshStandardMaterial({
    color: 0x93a06f,
    roughness: 0.98,
    metalness: 0,
  });
  valleyMaterial.envMap = envMap;
  valleyMaterial.envMapIntensity = 0.05;
  applyHaze(valleyMaterial, { color: HAZE, near: 8, far: 90 });

  const valleyGeometry = new THREE.PlaneGeometry(260, 260, 48, 48);
  valleyGeometry.rotateX(-Math.PI / 2);
  const valleyPosition = valleyGeometry.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < valleyPosition.count; i += 1) {
    const x = valleyPosition.getX(i);
    const z = valleyPosition.getZ(i);
    // 谷底也有起伏，不是一块平板
    const roll = (fbm2D(x * 0.03 + 4.1, z * 0.03 + 9.7, 3) - 0.5) * 2.4;
    const fine = (fbm2D(x * 0.11 + 1.3, z * 0.11 + 6.1, 2) - 0.5) * 0.5;
    valleyPosition.setY(i, roll + fine);
  }
  valleyPosition.needsUpdate = true;
  valleyGeometry.computeVertexNormals();

  const valley = new THREE.Mesh(valleyGeometry, valleyMaterial);
  valley.name = 'valley-floor';
  valley.position.set(0, -0.12, -10);
  root.add(valley);

  // ── 稻苗 ─────────────────────────────────────────────────────────────
  const swayUniforms = createWindSwayUniforms();
  const riceMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.92,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  riceMaterial.envMap = envMap;
  riceMaterial.envMapIntensity = 0.08;
  applyHaze(riceMaterial, { color: HAZE, near: 8, far: 70 });
  attachWindSway(riceMaterial, swayUniforms);
  setProgramKey(riceMaterial, 'rice-terrace/rice/sway');

  // 所有稻苗合成一个几何体：几百丛也只占一个 draw call，
  // 而风摆的相位由世界坐标决定，所以每一丛仍然各自摇摆。
  const tuftGeometry = createRiceTuftGeometry();
  const tuftParts: THREE.BufferGeometry[] = [];
  const tuftMatrix = new THREE.Matrix4();
  const tuftQuaternion = new THREE.Quaternion();
  const tuftScale = new THREE.Vector3();
  const tuftPosition = new THREE.Vector3();

  const pushTuft = (x: number, y: number, z: number, scale: number): void => {
    const clone = tuftGeometry.clone();
    tuftPosition.set(x, y, z);
    tuftQuaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), random() * Math.PI);
    tuftScale.setScalar(scale);
    tuftMatrix.compose(tuftPosition, tuftQuaternion, tuftScale);
    clone.applyMatrix4(tuftMatrix);
    tuftParts.push(clone);
  };

  const tuftCount = Math.round(300 * quality);
  for (let i = 0; i < tuftCount; i += 1) {
    const level = Math.floor(random() * levelCount);
    const outer = FIRST_RADIUS - level * RADIUS_STEP;
    const radius = outer - random() * PADDY_WIDTH;
    const angle = -Math.PI / 2 + (random() * 2 - 1) * ARC;
    pushTuft(
      FIELD_CENTER.x + Math.cos(angle) * radius,
      level * LEVEL_STEP + 0.01,
      FIELD_CENTER.z - Math.sin(angle) * radius,
      0.65 + random() * 0.7,
    );
  }

  // 谷底的一片秧田
  const valleyTuftCount = Math.round(340 * quality);
  for (let i = 0; i < valleyTuftCount; i += 1) {
    const x = (random() * 2 - 1) * 26;
    const z = 16 - random() * 44;
    pushTuft(x, -0.1, z, 0.55 + random() * 0.7);
  }

  const rice = new THREE.Mesh(mergeSwayGeometries(tuftParts), riceMaterial);
  rice.name = 'rice-field';
  root.add(rice);

  // ── 梯田间流动的雾 ───────────────────────────────────────────────────
  const mistSpace = new ParticleSpace({
    radius: 19,
    spin: 0.005,
    tilt: 0.02,
    position: [0, 1.0, -12],
  });

  const mistField = createGroundMistField(mistSpace, {
    count: Math.round(820 * quality),
    radius: 19,
    height: 3.2,
    size: 2.0,
    opacity: 0.13,
    color: 0xe6eee8,
    seed: 3312,
  });
  root.add(mistField.points);

  const mistTexture = createMistTexture(256, 7);
  textures.push(mistTexture);

  const mistMaterials: THREE.ShaderMaterial[] = [];
  const mistGroup = new THREE.Group();
  mistGroup.name = 'mist-banks';
  const sheetCount = Math.round(6 * quality);
  for (let i = 0; i < sheetCount; i += 1) {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: mistTexture },
        uTime: { value: 0 },
        uOpacity: { value: 0.14 },
        uColor: { value: new THREE.Color(0xe8efe8) },
      },
      vertexShader: MIST_SHEET_VERT,
      fragmentShader: MIST_SHEET_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    mistMaterials.push(material);

    const sheet = new THREE.Mesh(new THREE.PlaneGeometry(44, 7), material);
    sheet.name = 'mist-sheet';
    sheet.position.set((random() * 2 - 1) * 10, 1.5 + i * 0.62, -8 - i * 6.4);
    sheet.rotation.y = (random() * 2 - 1) * 0.16;
    mistGroup.add(sheet);
  }
  root.add(mistGroup);

  // ── 远处的山影 ───────────────────────────────────────────────────────
  const farTexture = createRidgeTexture({
    width: 1024,
    height: 256,
    color: '#8fa3ad',
    seed: 8823,
    amplitude: 0.62,
    layers: 6,
    base: 0.03,
  });
  textures.push(farTexture);

  const farMountainMaterial = new THREE.MeshBasicMaterial({
    map: farTexture,
    transparent: true,
    depthWrite: false,
    color: 0xffffff,
    fog: false,
  });
  applyHaze(farMountainMaterial, { color: HAZE, near: 70, far: 210 });

  const farMountain = new THREE.Mesh(new THREE.PlaneGeometry(620, 46), farMountainMaterial);
  farMountain.name = 'far-mountain';
  farMountain.position.set(0, 13, -132);
  farMountain.renderOrder = -10;
  root.add(farMountain);

  const midTexture = createRidgeTexture({
    width: 1024,
    height: 256,
    color: '#5d7078',
    seed: 3491,
    amplitude: 0.5,
    layers: 6,
    base: 0.03,
  });
  textures.push(midTexture);

  const midMountainMaterial = new THREE.MeshBasicMaterial({
    map: midTexture,
    transparent: true,
    depthWrite: false,
    color: 0xffffff,
    fog: false,
  });
  applyHaze(midMountainMaterial, { color: HAZE, near: 50, far: 170 });

  const midMountain = new THREE.Mesh(new THREE.PlaneGeometry(480, 34), midMountainMaterial);
  midMountain.name = 'mid-mountain';
  midMountain.position.set(0, 9, -88);
  midMountain.renderOrder = -9;
  root.add(midMountain);

  // ── 太阳 ─────────────────────────────────────────────────────────────
  const glowTexture = createGlowTexture(128, 2.0);
  textures.push(glowTexture);
  const sunGlow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture,
      color: 0xfff0c4,
      transparent: true,
      opacity: 0.36,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  sunGlow.name = 'sun-glow';
  sunGlow.scale.setScalar(24);
  sunGlow.position.copy(sunDirection).multiplyScalar(175);
  root.add(sunGlow);

  // ── 灯光 ─────────────────────────────────────────────────────────────
  const lights = ctx.env.createStudioLights();
  lights.traverse((child) => {
    if (child instanceof THREE.Light) {
      child.intensity *= 0.22;
      child.castShadow = false;
      child.color.setHex(0xd8e2ea);
    }
  });
  root.add(lights);

  const sun = new THREE.DirectionalLight(0xffe6b4, 1.5);
  sun.position.copy(sunDirection).multiplyScalar(90);
  root.add(sun);
  root.add(sun.target);

  const ambient = new THREE.HemisphereLight(0xc9dcea, 0x50543c, 1.5);
  root.add(ambient);

  return {
    root,
    camera,
    immersive: true,
    xrDistance: 3,
    framing: { distance: 14, height: 5.2, targetY: 2.1, width: 16 },
    update(time: number, delta: number, context: SceneContext): void {
      driver.update(context, delta);

      const pulse = driver.pulse;
      const level = driver.level;

      // 水田：低频决定波纹的幅度
      waterUniforms.uTime.value = time;
      waterUniforms.uAmp.value = 0.022 + driver.bass * 0.075 + pulse * 0.022;
      waterUniforms.uSparkle.value = 0.16 + driver.treble * 0.9 + pulse * 0.25;

      // 稻苗随风波动
      swayUniforms.uSwayTime.value = time;
      swayUniforms.uSwayStrength.value = 0.04 + pulse * 0.08 + level * 0.03;
      swayUniforms.uSwaySpeed.value = 1.2 + pulse * 1.1;

      // 雾：中频推动流动，响度决定浓度
      mistField.uniforms.uTime.value = time;
      mistField.uniforms.uWind.value = 0.1 + pulse * 0.4 + driver.mid * 0.25;
      mistField.uniforms.uOpacity.value = 0.08 + level * 0.1 + driver.bass * 0.04;
      mistSpace.breathe = 1 + pulse * 0.03;
      mistSpace.breathPhase = pulse;
      mistSpace.update(delta, time);

      for (const material of mistMaterials) {
        material.uniforms.uTime.value = time * (1 + driver.mid * 0.6);
        material.uniforms.uOpacity.value = 0.09 + level * 0.1 + pulse * 0.03;
      }
      mistGroup.position.x = Math.sin(time * 0.04) * 1.1 + driver.mid * 0.7;

      // 天光与晨光
      sky.uniforms.uSkyBandStrength.value = 0.36 + level * 0.2;
      sky.uniforms.uSkySunStrength.value = 0.62 + level * 0.4 + pulse * 0.12;
      sun.intensity = 1.25 + level * 0.55;
      ambient.intensity = 1.3 + level * 0.4;
      sunGlow.material.opacity = 0.28 + level * 0.22 + pulse * 0.08;

      bundMaterial.envMapIntensity = 0.04 + level * 0.04;
    },
    dispose(): void {
      for (const texture of textures) texture.dispose();
      disposeObject(root);
    },
  };
}

export const riceTerraceScene: SceneDefinition = {
  id: 'rice-terrace',
  title: '梯田晨光',
  subtitle: 'Rice Terraces',
  description: '层层水田映着清晨的天空，薄雾在田埂之间缓缓流动。',
  tags: ['梯田', '晨光', '水田'],
  accent: '#d8c48a',
  gradient: ['#8aa6b4', '#3b4a44'],
  category: 'environment',
  audio: 'terrace-mist.mp3',
  breathing: BREATHING,
  lighting: { autoExposure: true, autoExposureKey: 0.1 },
  create(ctx: SceneContext): SceneInstance {
    return createRiceTerrace(ctx);
  },
};

export default riceTerraceScene;
