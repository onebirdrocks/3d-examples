/**
 * 港湾黄昏 / Harbor at Dusk
 * ---------------------------------------------------------------
 * 黄昏的港湾：水面有缓慢的涌浪，映着暖色的天空；几艘小船只剩剪影，
 * 桅杆一动不动；岸边的灯刚开始亮起，水面上拖出一条暖色的倒影；
 * 远处的水面那头有一座钟楼，偶尔传来一声很远的钟。
 *
 * 空间层次：近处是码头与灯，中景是船与水面，远景是对岸的山影与钟楼，
 * 三层都被黄昏的雾气拉开距离。
 *
 * 音乐驱动：
 * - bass → 潮水涨落与涌浪的幅度（画面最主要的变化）；
 * - pulse → 灯的明灭、水面的碎光；mid → 天空与雾的流动；
 * - treble → 水面细碎的高光；level → 整体亮度与余晖的浓淡。
 */

import * as THREE from 'three';
import type { SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { disposeObject } from '../../core/loader.js';
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
import { DistantBell, GLSL_SKY, createRidgeTexture, createScenicSky } from './scenic.js';

const BREATHING = { inhale: 5, hold: 3, exhale: 7 };
const FOV = 54;

/** 黄昏的雾色：远处的一切都褪进这个颜色。 */
const HAZE = 0x6f6a6d;

/** 岸边那盏灯的位置。 */
const LAMP_X = -3.4;
const LAMP_Z = 5.6;

/* ------------------------------------------------------------------ *
 * 水面
 * ------------------------------------------------------------------ */

const WATER_VERT = /* glsl */ `
#ifndef HARBOR_WATER_VERT_GUARD
#define HARBOR_WATER_VERT_GUARD
uniform float uTime;
uniform float uAmp;
uniform float uSwell;
uniform float uTide;

varying vec3 vWorld;
varying float vWave;

${GLSL_HASH}
${GLSL_NOISE2}

float harborWave( vec2 p, float t ) {
  // 缓慢的涌浪：两组长波，互相错开
  float swell = sin( p.x * 0.085 + t * 0.42 ) * 0.55 + sin( p.y * 0.062 - t * 0.33 ) * 0.45;
  // 细碎的涟漪
  float ripple = ( fbm2( p * 0.42 + vec2( t * 0.05, -t * 0.033 ), 3 ) - 0.5 ) * 2.0;
  return swell * uSwell + ripple * uAmp;
}

void main() {
  vec3 p = position;
  float wave = harborWave( p.xz, uTime );
  p.y += wave + uTide;

  vec4 wp = modelMatrix * vec4( p, 1.0 );
  vWorld = wp.xyz;
  vWave = wave;

  gl_Position = projectionMatrix * viewMatrix * wp;
}
#endif
`;

const WATER_FRAG = /* glsl */ `
#ifndef HARBOR_WATER_FRAG_GUARD
#define HARBOR_WATER_FRAG_GUARD
precision highp float;

uniform float uTime;
uniform float uAmp;
uniform float uSwell;
uniform vec3 uDeepColor;
uniform vec3 uShallowColor;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform vec3 uLampPos;
uniform vec3 uLampColor;
uniform float uLampStrength;
uniform float uGlitter;
uniform vec3 uHazeColor;
uniform float uHazeNear;
uniform float uHazeFar;

varying vec3 vWorld;
varying float vWave;

${GLSL_HASH}
${GLSL_NOISE2}
${GLSL_SKY}
${GLSL_OUTPUT_FUNCS}

float harborWave( vec2 p, float t ) {
  float swell = sin( p.x * 0.085 + t * 0.42 ) * 0.55 + sin( p.y * 0.062 - t * 0.33 ) * 0.45;
  float ripple = ( fbm2( p * 0.42 + vec2( t * 0.05, -t * 0.033 ), 3 ) - 0.5 ) * 2.0;
  return swell * uSwell + ripple * uAmp;
}

void main() {
  vec2 p = vWorld.xz;

  // 有限差分求水面法线
  float e = 0.42;
  float h = harborWave( p, uTime );
  float hx = harborWave( p + vec2( e, 0.0 ), uTime );
  float hz = harborWave( p + vec2( 0.0, e ), uTime );
  vec3 N = normalize( vec3( ( h - hx ) / e, 1.0, ( h - hz ) / e ) );

  vec3 V = normalize( cameraPosition - vWorld );
  float fres = pow( 1.0 - clamp( dot( N, V ), 0.0, 1.0 ), 4.0 );
  fres = mix( 0.04, 1.0, fres );

  // 天空的倒影：与天穹共用同一组 uniform，颜色永远对得上
  vec3 R = reflect( -V, N );
  vec3 sky = scenicSkyColor( vec3( R.x, abs( R.y ) * 0.85 + 0.02, R.z ) );

  // 水本身：越深越暗，靠近岸边略浅
  float shore = smoothstep( 26.0, 2.0, abs( vWorld.z - 2.0 ) );
  vec3 base = mix( uDeepColor, uShallowColor, shore * 0.55 );
  vec3 col = mix( base, sky, fres * 0.94 );

  // 落日的高光
  vec3 H = normalize( uSunDir + V );
  float spec = pow( max( dot( N, H ), 0.0 ), 110.0 );
  col += uSunColor * spec * 2.2;

  // 落日在水面上拉出的碎光带
  float glint = pow( fbm2( p * 2.6 + vec2( uTime * 0.1, 0.0 ), 3 ), 7.0 );
  vec2 viewXZ = normalize( p - cameraPosition.xz + vec2( 0.0001 ) );
  float toSun = dot( viewXZ, normalize( uSunDir.xz ) );
  float path = smoothstep( 0.86, 0.997, toSun );
  col += uSunColor * glint * uGlitter * ( 0.25 + path * 1.3 );

  // 岸边灯的倒影：一条竖直的暖色光柱
  vec2 toLamp = p - uLampPos.xz;
  float lateral = abs( toLamp.x );
  float along = max( 0.0, -toLamp.y );
  float streak = exp( -lateral * lateral / ( 0.5 + 0.03 * along ) ) * exp( -along * 0.055 );
  float lampFacing = max( 0.0, dot( N, normalize( vec3( toLamp.x, 1.4, toLamp.y ) ) ) );
  col += uLampColor * streak * lampFacing * uLampStrength;

  // 空气透视：远处的水融进黄昏的雾里
  float dist = length( cameraPosition - vWorld );
  float hazeMix = smoothstep( uHazeNear, uHazeFar, dist );
  col = mix( col, uHazeColor, hazeMix );

  gl_FragColor = vec4( col, 1.0 );
  ${GLSL_OUTPUT}
}
#endif
`;

/* ------------------------------------------------------------------ *
 * 几何
 * ------------------------------------------------------------------ */

/**
 * 船体：由若干横截面拼出来的封闭外壳。
 * 船头船尾收窄、中部最宽，看得出是一条船而不是一个盒子。
 */
function createBoatHull(length: number, beam: number, depth: number): THREE.BufferGeometry {
  const sections = 9;
  const positions: number[] = [];

  const halfBeam = (t: number): number => beam * 0.5 * Math.pow(Math.sin(Math.PI * t), 0.55);
  const deckY = (t: number): number => depth * (0.16 + 0.84 * Math.pow(Math.sin(Math.PI * t), 0.5));
  const keelY = (t: number): number => -depth * (0.34 + 0.66 * Math.pow(Math.sin(Math.PI * t), 0.85));

  const ring = (t: number): number[][] => {
    const hb = halfBeam(t);
    const dy = deckY(t);
    const ky = keelY(t);
    const z = (t - 0.5) * length;
    return [
      [hb, dy, z],
      [hb * 0.86, ky + (dy - ky) * 0.34, z],
      [-hb * 0.86, ky + (dy - ky) * 0.34, z],
      [-hb, dy, z],
    ];
  };

  const quad = (a: number[], b: number[], c: number[], d: number[]): void => {
    positions.push(...a, ...b, ...c, ...a, ...c, ...d);
  };

  for (let i = 0; i < sections - 1; i += 1) {
    const t0 = i / (sections - 1);
    const t1 = (i + 1) / (sections - 1);
    const r0 = ring(t0);
    const r1 = ring(t1);
    for (let k = 0; k < 3; k += 1) {
      quad(r0[k], r0[k + 1], r1[k + 1], r1[k]);
    }
  }

  // 首尾封口
  const bow = ring(0);
  const stern = ring(1);
  for (let k = 1; k < 3; k += 1) {
    positions.push(...bow[0], ...bow[k + 1], ...bow[k]);
    positions.push(...stern[0], ...stern[k], ...stern[k + 1]);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/** 码头的石墙。 */
function createQuayTexture(size = 256): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');

  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = (x / size) * 5;
      const v = (y / size) * 5;
      const grain = fbm2D(u * 2.2, v * 2.2, 4);
      const fine = fbm2D(u * 9.0 + 3.3, v * 9.0 + 7.1, 2);
      const seam = Math.pow(Math.abs(((v * 5) % 1) * 2 - 1), 8);
      const shade = 0.68 + grain * 0.44 + fine * 0.16;
      const i = (y * size + x) * 4;
      image.data[i] = Math.round(150 * shade * (1 - seam * 0.35));
      image.data[i + 1] = Math.round(138 * shade * (1 - seam * 0.35));
      image.data[i + 2] = Math.round(126 * shade * (1 - seam * 0.35));
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'quay-stone';
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

/* ------------------------------------------------------------------ *
 * 场景
 * ------------------------------------------------------------------ */

function createHarborDusk(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'harbor-dusk-scene';

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 500);
  camera.position.set(0, 2.4, 10);

  const quality = THREE.MathUtils.clamp(ctx.quality, 0.4, 2);
  const driver = new AudioDriver();
  const envMap = ctx.env.envMap;
  const textures: THREE.Texture[] = [];

  let state = 62401;
  const random = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };

  // ── 黄昏的天空 ───────────────────────────────────────────────────────
  const sunDirection = new THREE.Vector3(-0.24, 0.07, -0.97).normalize();
  const sky = createScenicSky(
    {
      zenith: 0x2b4076,
      horizon: 0xbe7c46,
      ground: 0x241c22,
      band: 0xdd9457,
      bandStrength: 0.45,
      bandY: 0.01,
      bandWidth: 0.13,
      sunDir: sunDirection,
      sunColor: 0xffc27a,
      sunStrength: 0.78,
    },
    420,
  );
  root.add(sky.mesh);

  // ── 水面 ─────────────────────────────────────────────────────────────
  const waterUniforms = {
    uTime: { value: 0 },
    uAmp: { value: 0.06 },
    uSwell: { value: 0.22 },
    uTide: { value: 0 },
    uDeepColor: { value: new THREE.Color(0x1d2733) },
    uShallowColor: { value: new THREE.Color(0x3a3a3c) },
    uSunColor: { value: new THREE.Color(0xffb877) },
    uSunDir: { value: sunDirection.clone() },
    uLampPos: { value: new THREE.Vector3(LAMP_X + 0.62, 4.2, LAMP_Z) },
    uLampColor: { value: new THREE.Color(0xffb257) },
    uLampStrength: { value: 0.5 },
    uGlitter: { value: 0.35 },
    uHazeColor: { value: new THREE.Color(HAZE) },
    uHazeNear: { value: 26 },
    uHazeFar: { value: 150 },
    ...sky.uniforms,
  };

  const waterMaterial = new THREE.ShaderMaterial({
    uniforms: waterUniforms,
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    side: THREE.FrontSide,
  });

  const waterSegments = Math.round(90 * quality);
  const waterGeometry = new THREE.PlaneGeometry(300, 130, waterSegments, waterSegments);
  waterGeometry.rotateX(-Math.PI / 2);
  const water = new THREE.Mesh(waterGeometry, waterMaterial);
  water.name = 'harbor-water';
  water.position.set(0, 0, -60.9);
  root.add(water);

  // ── 码头 ─────────────────────────────────────────────────────────────
  const quayTexture = createQuayTexture(256);
  textures.push(quayTexture);
  const quayMaterial = new THREE.MeshStandardMaterial({
    color: 0xa89d8c,
    map: quayTexture,
    roughness: 0.95,
    metalness: 0,
  });
  quayMaterial.envMap = envMap;
  quayMaterial.envMapIntensity = 0.05;
  applyHaze(quayMaterial, { color: HAZE, near: 8, far: 60 });

  const quay = new THREE.Mesh(new THREE.BoxGeometry(46, 2.6, 9), quayMaterial);
  quay.name = 'quay';
  quay.position.set(0, -0.4, 8.6);
  quay.receiveShadow = true;
  root.add(quay);

  // 码头边缘的石墩
  const bollardGeometry = new THREE.CylinderGeometry(0.17, 0.22, 0.62, 10);
  for (let i = 0; i < 7; i += 1) {
    const bollard = new THREE.Mesh(bollardGeometry, quayMaterial);
    bollard.name = 'bollard';
    bollard.position.set(-12 + i * 4.1, 1.18, 5.1);
    root.add(bollard);
  }

  // ── 岸边的灯 ─────────────────────────────────────────────────────────
  const lampMetal = new THREE.MeshStandardMaterial({
    color: 0x24252a,
    roughness: 0.62,
    metalness: 0.55,
  });
  lampMetal.envMap = envMap;
  lampMetal.envMapIntensity = 0.18;

  const lampPost = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.11, 3.6, 10), lampMetal);
  lampPost.name = 'lamp-post';
  lampPost.position.set(LAMP_X, 2.7, LAMP_Z);
  root.add(lampPost);

  const lampArm = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.7, 8), lampMetal);
  lampArm.name = 'lamp-arm';
  lampArm.rotation.z = Math.PI / 2;
  lampArm.position.set(LAMP_X + 0.32, 4.45, LAMP_Z);
  root.add(lampArm);

  const lampGlassMaterial = new THREE.MeshStandardMaterial({
    color: 0x3a3128,
    emissive: new THREE.Color(0xffb257),
    emissiveIntensity: 1.4,
    roughness: 0.3,
    metalness: 0,
  });
  const lampGlass = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 10), lampGlassMaterial);
  lampGlass.name = 'lamp-glass';
  lampGlass.position.set(LAMP_X + 0.62, 4.33, LAMP_Z);
  root.add(lampGlass);

  const lampLight = new THREE.PointLight(0xffb257, 7.5, 22, 1.7);
  lampLight.name = 'lamp-light';
  lampLight.position.set(LAMP_X + 0.62, 4.25, LAMP_Z);
  root.add(lampLight);

  const glowTexture = createGlowTexture(128, 2.2);
  textures.push(glowTexture);
  const lampGlow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture,
      color: 0xffc178,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  lampGlow.name = 'lamp-glow';
  lampGlow.scale.setScalar(2.0);
  lampGlow.position.copy(lampLight.position);
  root.add(lampGlow);

  // ── 船 ───────────────────────────────────────────────────────────────
  const boatMaterial = new THREE.MeshStandardMaterial({
    color: 0x1b1d24,
    roughness: 0.88,
    metalness: 0.04,
  });
  boatMaterial.envMap = envMap;
  boatMaterial.envMapIntensity = 0.1;
  applyHaze(boatMaterial, { color: HAZE, near: 16, far: 120 });

  const mastMaterial = new THREE.MeshStandardMaterial({
    color: 0x24262c,
    roughness: 0.9,
    metalness: 0,
  });
  mastMaterial.envMap = envMap;
  mastMaterial.envMapIntensity = 0.08;
  applyHaze(mastMaterial, { color: HAZE, near: 16, far: 120 });

  const rigMaterial = new THREE.LineBasicMaterial({ color: 0x1e2026, transparent: true, opacity: 0.75 });

  const boats: { group: THREE.Group; phase: number; baseY: number }[] = [];
  const hullGeometry = createBoatHull(4.6, 1.5, 0.95);
  const mastGeometry = new THREE.CylinderGeometry(0.045, 0.06, 6.4, 6);
  const boomGeometry = new THREE.CylinderGeometry(0.035, 0.04, 2.2, 5);

  const boatCount = Math.round(5 * quality) + 2;
  for (let i = 0; i < boatCount; i += 1) {
    const group = new THREE.Group();
    group.name = 'boat';

    const scale = 0.75 + random() * 0.75;
    const hull = new THREE.Mesh(hullGeometry, boatMaterial);
    hull.name = 'hull';
    group.add(hull);

    const mast = new THREE.Mesh(mastGeometry, mastMaterial);
    mast.name = 'mast';
    mast.position.set(0, 3.2, 0.2);
    group.add(mast);

    const boom = new THREE.Mesh(boomGeometry, mastMaterial);
    boom.name = 'boom';
    boom.rotation.x = Math.PI / 2;
    boom.position.set(0, 1.15, -0.9);
    group.add(boom);

    // 两根缆绳：船头与桅顶、船尾与桅顶
    const rigging = new THREE.BufferGeometry();
    const top = 6.3;
    rigging.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, top, 0.2, 0, 0.55, -2.2, 0, top, 0.2, 0, 0.55, 2.1], 3),
    );
    const lines = new THREE.LineSegments(rigging, rigMaterial);
    lines.name = 'rigging';
    group.add(lines);

    const distance = -13 - random() * 26;
    const x = (random() * 2 - 1) * 26;
    group.position.set(x, 0, distance);
    group.rotation.y = (random() * 2 - 1) * 0.5 + Math.PI * 0.5;
    group.scale.setScalar(scale);
    root.add(group);

    boats.push({ group, phase: random() * Math.PI * 2, baseY: 0 });
  }

  // ── 对岸的剪影与钟楼 ─────────────────────────────────────────────────
  const ridgeTexture = createRidgeTexture({
    width: 1024,
    height: 256,
    color: '#2a2430',
    seed: 4471,
    amplitude: 0.5,
    base: 0.02,
  });
  textures.push(ridgeTexture);

  const farShoreMaterial = new THREE.MeshBasicMaterial({
    map: ridgeTexture,
    transparent: true,
    depthWrite: false,
    color: 0xffffff,
    fog: false,
  });
  applyHaze(farShoreMaterial, { color: HAZE, near: 60, far: 190 });

  const farShore = new THREE.Mesh(new THREE.PlaneGeometry(420, 34), farShoreMaterial);
  farShore.name = 'far-shore';
  farShore.position.set(0, 7, -144);
  farShore.renderOrder = -10;
  root.add(farShore);

  const nearShoreTexture = createRidgeTexture({
    width: 1024,
    height: 256,
    color: '#231e28',
    seed: 9931,
    amplitude: 0.34,
    base: 0.02,
  });
  textures.push(nearShoreTexture);

  const nearShoreMaterial = new THREE.MeshBasicMaterial({
    map: nearShoreTexture,
    transparent: true,
    depthWrite: false,
    color: 0xffffff,
    fog: false,
  });
  applyHaze(nearShoreMaterial, { color: HAZE, near: 60, far: 190 });

  const nearShore = new THREE.Mesh(new THREE.PlaneGeometry(420, 26), nearShoreMaterial);
  nearShore.name = 'near-shore';
  nearShore.position.set(0, 4.5, -130);
  nearShore.renderOrder = -9;
  root.add(nearShore);

  // 远处的钟楼：塔身 + 尖顶 + 塔顶的一点微光
  const towerMaterial = new THREE.MeshStandardMaterial({
    color: 0x1c1a22,
    roughness: 0.92,
    metalness: 0,
  });
  towerMaterial.envMap = envMap;
  towerMaterial.envMapIntensity = 0.06;
  applyHaze(towerMaterial, { color: HAZE, near: 60, far: 190 });

  const tower = new THREE.Group();
  tower.name = 'bell-tower';
  const shaft = new THREE.Mesh(new THREE.BoxGeometry(2.2, 11, 2.2), towerMaterial);
  shaft.position.y = 5.5;
  tower.add(shaft);
  const roof = new THREE.Mesh(new THREE.ConeGeometry(1.9, 3.4, 4), towerMaterial);
  roof.position.y = 12.6;
  roof.rotation.y = Math.PI / 4;
  tower.add(roof);
  const bellGlow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture,
      color: 0xffc98a,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  bellGlow.name = 'bell-glow';
  bellGlow.scale.setScalar(3.4);
  bellGlow.position.set(0, 10.4, 0);
  tower.add(bellGlow);
  tower.position.set(23, 0, -136);
  tower.scale.setScalar(1.5);
  root.add(tower);

  // ── 灯光 ─────────────────────────────────────────────────────────────
  const lights = ctx.env.createStudioLights();
  lights.traverse((child) => {
    if (child instanceof THREE.Light) {
      child.intensity *= 0.16;
      child.castShadow = false;
      child.color.setHex(0x8f93b8);
    }
  });
  root.add(lights);

  const dusk = new THREE.DirectionalLight(0xffb877, 1.1);
  dusk.position.copy(sunDirection).multiplyScalar(120);
  root.add(dusk);
  root.add(dusk.target);

  const ambient = new THREE.HemisphereLight(0x8791b8, 0x453a38, 2.1);
  root.add(ambient);

  // ── 远处的钟声 ───────────────────────────────────────────────────────
  const bell = new DistantBell({ interval: [19, 31], volume: 0.14, cutoff: 820, reverb: ctx.reverb });

  return {
    root,
    camera,
    immersive: true,
    xrDistance: 3,
    framing: { distance: 10, height: 2.4, targetY: 1.7, width: 30 },
    update(time: number, delta: number, context: SceneContext): void {
      driver.update(context, delta);
      bell.update(context);

      const pulse = driver.pulse;
      const level = driver.level;

      // 水：低频带来潮水的涨落与涌浪的幅度
      waterUniforms.uTime.value = time;
      waterUniforms.uTide.value = driver.bass * 0.22 + pulse * 0.05;
      waterUniforms.uSwell.value = 0.17 + driver.bass * 0.5 + pulse * 0.12;
      waterUniforms.uAmp.value = 0.045 + driver.mid * 0.12 + driver.treble * 0.05;
      waterUniforms.uGlitter.value = 0.25 + driver.treble * 1.1 + pulse * 0.35;

      // 船随潮水轻轻起伏
      for (const boat of boats) {
        const bob = Math.sin(time * 0.55 + boat.phase) * 0.06 + Math.sin(time * 0.31 + boat.phase * 1.7) * 0.04;
        boat.group.position.y = boat.baseY + waterUniforms.uTide.value + bob * (0.6 + driver.bass * 0.8);
        boat.group.rotation.z = Math.sin(time * 0.42 + boat.phase) * 0.035 * (0.5 + driver.bass);
        boat.group.rotation.x = Math.cos(time * 0.36 + boat.phase * 1.3) * 0.022 * (0.5 + driver.bass);
      }

      // 灯：正在亮起来，脉冲让它轻轻晃一下
      const lampBase = 1.1 + level * 1.6;
      const flicker = 1 + Math.sin(time * 7.3) * 0.03 + pulse * 0.18;
      lampGlassMaterial.emissiveIntensity = lampBase * flicker;
      lampLight.intensity = 5.5 + level * 6.5 * flicker;
      lampGlow.material.opacity = 0.3 + level * 0.28 + pulse * 0.1;
      waterUniforms.uLampStrength.value = 0.35 + level * 0.5 + pulse * 0.22;

      // 天空与余晖
      sky.uniforms.uSkyBandStrength.value = 0.6 + level * 0.22;
      sky.uniforms.uSkySunStrength.value = 0.68 + level * 0.45 + pulse * 0.16;
      dusk.intensity = 0.9 + level * 0.5;
      ambient.intensity = 1.85 + level * 0.55;

      // 钟楼的微光随着远处的钟声一闪
      bellGlow.material.opacity = 0.22 + level * 0.16 + Math.max(0, Math.sin(time * 0.6)) * 0.08;

    },
    dispose(): void {
      bell.dispose();
      for (const texture of textures) texture.dispose();
      disposeObject(root);
    },
  };
}

export const harborDuskScene: SceneDefinition = {
  id: 'harbor-dusk',
  title: '港湾黄昏',
  subtitle: 'Harbor at Dusk',
  description: '潮水在黄昏里缓缓起伏，小船停在雾中，岸边的灯刚亮起来。',
  tags: ['港湾', '黄昏', '水面'],
  accent: '#e0a068',
  gradient: ['#4a3a4e', '#1b1620'],
  category: 'environment',
  audio: 'harbor-bell.mp3',
  breathing: BREATHING,
  lighting: { autoExposure: true, autoExposureKey: 0.11 },
  create(ctx: SceneContext): SceneInstance {
    return createHarborDusk(ctx);
  },
};

export default harborDuskScene;
