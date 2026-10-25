/**
 * 和风茶室 / Tea Room
 * ---------------------------------------------------------------
 * 一间极简的和风茶室，但整体尺度是「桌上尺度」：
 * 榻榻米只有 1.2 × 0.9 米，茶盘 0.52 米，茶壶直径 11 厘米 —— 全都是能真的
 * 摆上书桌的尺寸，所以这个场景放进 AR 里可以直接「放在你的桌上」。
 *
 * 构成：
 * - 榻榻米：程序化编织纹理（草茎横向排列 + 竖向绑线）；
 * - 木茶盘、陶土茶壶（LatheGeometry 旋成）、两只陶杯、一只风炉（kamadare）；
 * - 风炉里有一簇**真实燃烧的小火苗**：粒子空间里的加性粒子，随呼吸极缓地起伏；
 * - 壶嘴升起一缕热气：同样是粒子空间里的细小粒子，缓慢上升并消散；
 * - 纸障子门：半透光的纸面 + 木格栅，背后是明亮的「室外」。
 *
 * 交互：障子门可以**捏住推开**（onPinch）。
 * 抓住门板后记录抓取点与手的位置，移动时把手的位移换算成门板的平移与旋转，
 * 松手后门缓缓停在最近的状态。门开合时纸面的透光量、门后的灯、
 * 以及落在榻榻米上的格栅光影都会随之改变。
 *
 * 音乐驱动：
 * - pulse → 火苗的亮度与摇曳；level → 房间的整体暖度与热气浓度；
 * - bass → 门后灯光的缓慢起伏。
 */

import * as THREE from 'three';
import type { PinchInfo, SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { disposeObject } from '../../core/loader.js';
import { ParticleSpace } from '../../core/particle-space.js';
import { createBreathSample, sampleBreath } from '../../core/breath.js';
import {
  AudioDriver,
  GLSL_OUTPUT,
  GLSL_OUTPUT_FUNCS,
  PARTICLE_SPACE_GLSL,
  fbm2D,
} from './lib.js';

const BREATHING = { inhale: 4, hold: 4, exhale: 6 };
const FOV = 42;

/* 尺度（米） */
const MAT_W = 1.2;
const MAT_D = 0.9;
const TRAY_W = 0.52;
const TRAY_D = 0.34;
const TRAY_H = 0.016;

/* 障子门 */
const SCREEN_Z = -0.4;
const DOOR_W = 0.46;
const DOOR_H = 0.56;
const DOOR_SLIDE_MAX = 0.46;
const DOOR_SWING_MAX = 0.52;

/* ------------------------------------------------------------------ *
 * 程序化贴图
 * ------------------------------------------------------------------ */

/** 榻榻米：横向排列的草茎 + 竖向绑线 + 做旧斑驳。 */
function createTatamiTexture(size = 512): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');

  const ROWS = 96;
  const COLS = 26;
  const image = ctx.createImageData(size, size);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;

      const row = Math.floor(v * ROWS);
      const rowT = v * ROWS - row;
      const colT = u * COLS - Math.floor(u * COLS);

      // 每根草茎的圆润截面 + 茎与茎之间的暗缝
      const shade = 0.78 + 0.22 * Math.sin(rowT * Math.PI);
      const seam = Math.pow(Math.abs(rowT * 2 - 1), 6);
      // 每一行的色差（草的批次不同）
      const rowTint = 0.93 + 0.07 * Math.abs((Math.sin(row * 12.9898) * 43758.5453) % 1);
      // 竖向绑线：每列边界上的一道很淡的深色细线
      const threadDist = Math.min(colT, 1 - colT) * (size / COLS);
      const thread = Math.exp(-((threadDist / 1.6) ** 2));

      const grain = fbm2D(u * 7 + row * 0.17, v * 7, 3);
      const stain = fbm2D(u * 2.2 + 5.7, v * 2.2 + 1.3, 3);

      let l = shade * rowTint * (0.86 + grain * 0.26) * (0.93 + stain * 0.14);
      l *= 1 - seam * 0.22;
      l *= 1 - thread * 0.16;

      const i = (y * size + x) * 4;
      image.data[i] = Math.round(202 * l);
      image.data[i + 1] = Math.round(180 * l);
      image.data[i + 2] = Math.round(126 * l);
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'tatami-weave';
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

/** 木纹：沿着一个方向的深浅条纹。 */
function createWoodTexture(size = 256): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');

  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      const grain = fbm2D(u * 2.4, v * 34, 4);
      const streak = fbm2D(u * 1.1 + 3.3, v * 9, 3);
      const l = 0.62 + grain * 0.5 + streak * 0.18;
      const i = (y * size + x) * 4;
      image.data[i] = Math.round(112 * l);
      image.data[i + 1] = Math.round(74 * l);
      image.data[i + 2] = Math.round(46 * l);
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'wood-grain';
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

/** 和纸：暖白底 + 细长的纤维。 */
function createPaperTexture(size = 256): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');

  ctx.fillStyle = '#f2e9d4';
  ctx.fillRect(0, 0, size, size);

  const image = ctx.getImageData(0, 0, size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const n = fbm2D((x / size) * 9, (y / size) * 9, 3);
      const t = 236 + n * 16;
      image.data[i] = Math.round(t);
      image.data[i + 1] = Math.round(t - 4);
      image.data[i + 2] = Math.round(t - 18);
    }
  }
  ctx.putImageData(image, 0, 0);

  // 纸浆里的长纤维
  let seed = 20240915;
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  ctx.strokeStyle = 'rgba(206, 190, 158, 0.55)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 260; i += 1) {
    const x = random() * size;
    const y = random() * size;
    const len = 6 + random() * 26;
    const angle = random() * Math.PI;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(angle) * len, y + Math.sin(angle) * len);
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'washi-paper';
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** 门后漏在榻榻米上的柔光（上下渐隐、左右柔化）。 */
function createLightPatchTexture(size = 128): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');

  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = (x / size) * 2 - 1;
      const v = y / size;
      const horizontal = Math.pow(Math.max(0, 1 - u * u), 1.4);
      const vertical = Math.pow(Math.sin(v * Math.PI), 1.2);
      const n = fbm2D((x / size) * 5, (y / size) * 5, 3);
      const a = horizontal * vertical * (0.72 + n * 0.5);
      const i = (y * size + x) * 4;
      image.data[i] = 255;
      image.data[i + 1] = 244;
      image.data[i + 2] = 214;
      image.data[i + 3] = Math.round(Math.min(1, a) * 255);
    }
  }
  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'door-patch';
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** 门后的「室外」：一片过曝的暖白天光，底下带一点庭园的剪影。 */
function createOutsideTexture(size = 128): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');

  const gradient = ctx.createLinearGradient(0, size, 0, 0);
  gradient.addColorStop(0, '#f6e2b8');
  gradient.addColorStop(0.45, '#fdf4e2');
  gradient.addColorStop(1, '#dfe7f2');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  // 远处的庭园剪影：一排柔软的深绿树冠
  let seed = 70519;
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  ctx.fillStyle = 'rgba(74, 92, 66, 0.55)';
  for (let i = 0; i < 26; i += 1) {
    const x = random() * size;
    const y = size * (0.62 + random() * 0.16);
    const r = size * (0.06 + random() * 0.09);
    ctx.beginPath();
    ctx.ellipse(x, y, r * 1.5, r, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(92, 84, 58, 0.5)';
  ctx.fillRect(0, size * 0.84, size, size * 0.16);

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'outside';
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/* ------------------------------------------------------------------ *
 * 粒子着色器（火苗 / 热气）
 * ------------------------------------------------------------------ */

const FLAME_VERT = /* glsl */ `
#ifndef TEA_ROOM_FLAME_VERT_GUARD
#define TEA_ROOM_FLAME_VERT_GUARD
attribute float aSize;
attribute float aPhase;
attribute float aSeed;

uniform float uTime;
uniform float uScale;
uniform float uHeight;
uniform float uSway;
uniform float uSpeed;

varying float vLife;
varying float vSeed;

${PARTICLE_SPACE_GLSL}

void main() {
  // 生命期循环：火苗永远不会烧尽，只是不断换一批新的粒子
  float life = fract( aSeed + uTime * uSpeed * ( 0.72 + 0.56 * fract( aPhase ) ) );
  float shrink = 1.0 - life * 0.52;
  vec3 p = vec3( position.x * shrink, life * uHeight, position.z * shrink );

  // 摇曳幅度只有几毫米，跟着呼吸节奏极缓地摆
  p.x += sin( uTime * 0.9 + aSeed * 6.2831853 + life * 2.4 ) * uSway * life;
  p.z += cos( uTime * 0.7 + aSeed * 5.1 ) * uSway * 0.6 * life;

  vec3 world = particleSpaceTransform( p );
  vec4 mv = modelViewMatrix * vec4( world, 1.0 );
  gl_Position = projectionMatrix * mv;

  vLife = life;
  vSeed = aSeed;
  gl_PointSize = aSize * uScale / max( 0.12, -mv.z );
}
#endif
`;

const FLAME_FRAG = /* glsl */ `
#ifndef TEA_ROOM_FLAME_FRAG_GUARD
#define TEA_ROOM_FLAME_FRAG_GUARD
precision highp float;

uniform vec3 uColorCore;
uniform vec3 uColorTip;
uniform float uIntensity;

varying float vLife;
varying float vSeed;

${GLSL_OUTPUT_FUNCS}

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot( c, c );
  if ( d2 > 0.25 ) discard;
  float falloff = exp( -d2 * 7.0 );

  // 根部白热，火苗尖渐渐转成深橙并淡出
  vec3 col = mix( uColorCore, uColorTip, smoothstep( 0.0, 0.8, vLife ) );
  col *= 0.85 + 0.3 * fract( vSeed * 7.3 );

  float a = falloff * ( 1.0 - smoothstep( 0.5, 1.0, vLife ) ) * uIntensity;
  if ( a < 0.004 ) discard;

  gl_FragColor = vec4( col, a );
  ${GLSL_OUTPUT}
}
#endif
`;

const STEAM_VERT = /* glsl */ `
#ifndef TEA_ROOM_STEAM_VERT_GUARD
#define TEA_ROOM_STEAM_VERT_GUARD
attribute float aSize;
attribute float aPhase;
attribute float aSeed;

uniform float uTime;
uniform float uScale;
uniform float uHeight;
uniform float uSpeed;

varying float vLife;

${PARTICLE_SPACE_GLSL}

void main() {
  float life = fract( aSeed + uTime * uSpeed * ( 0.8 + 0.4 * fract( aPhase ) ) );

  // 越升越散、越升越淡
  float spread = 0.45 + life * 2.6;
  vec3 p = vec3(
    position.x * spread + sin( uTime * 0.23 + aSeed * 6.2831853 ) * 0.022 * life + life * 0.012,
    life * uHeight,
    position.z * spread + cos( uTime * 0.19 + aSeed * 4.7 ) * 0.018 * life
  );

  vec3 world = particleSpaceTransform( p );
  vec4 mv = modelViewMatrix * vec4( world, 1.0 );
  gl_Position = projectionMatrix * mv;

  vLife = life;
  gl_PointSize = aSize * uScale * ( 0.7 + life * 1.4 ) / max( 0.12, -mv.z );
}
#endif
`;

const STEAM_FRAG = /* glsl */ `
#ifndef TEA_ROOM_STEAM_FRAG_GUARD
#define TEA_ROOM_STEAM_FRAG_GUARD
precision highp float;

uniform vec3 uColor;
uniform float uOpacity;

varying float vLife;

${GLSL_OUTPUT_FUNCS}

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot( c, c );
  if ( d2 > 0.25 ) discard;
  float falloff = exp( -d2 * 5.0 );

  float a = falloff * pow( sin( vLife * 3.14159265 ), 0.8 ) * uOpacity;
  if ( a < 0.003 ) discard;

  gl_FragColor = vec4( uColor, a );
  ${GLSL_OUTPUT}
}
#endif
`;

/* ------------------------------------------------------------------ *
 * 几何
 * ------------------------------------------------------------------ */

/** 陶壶的旋转轮廓（半径, 高度）。 */
function createTeapotProfile(): THREE.Vector2[] {
  return [
    new THREE.Vector2(0.0, 0.0),
    new THREE.Vector2(0.03, 0.0),
    new THREE.Vector2(0.045, 0.011),
    new THREE.Vector2(0.054, 0.032),
    new THREE.Vector2(0.056, 0.056),
    new THREE.Vector2(0.05, 0.079),
    new THREE.Vector2(0.036, 0.094),
    new THREE.Vector2(0.03, 0.1),
    new THREE.Vector2(0.031, 0.104),
  ];
}

/** 陶杯的旋转轮廓（含内壁）。 */
function createCupProfile(): THREE.Vector2[] {
  return [
    new THREE.Vector2(0.0, 0.0),
    new THREE.Vector2(0.016, 0.0),
    new THREE.Vector2(0.026, 0.012),
    new THREE.Vector2(0.032, 0.03),
    new THREE.Vector2(0.034, 0.044),
    new THREE.Vector2(0.031, 0.045),
    new THREE.Vector2(0.029, 0.034),
    new THREE.Vector2(0.023, 0.014),
    new THREE.Vector2(0.012, 0.004),
    new THREE.Vector2(0.0, 0.004),
  ];
}

/** 风炉的旋转轮廓。 */
function createKamadareProfile(): THREE.Vector2[] {
  return [
    new THREE.Vector2(0.0, 0.0),
    new THREE.Vector2(0.048, 0.0),
    new THREE.Vector2(0.056, 0.01),
    new THREE.Vector2(0.061, 0.04),
    new THREE.Vector2(0.059, 0.056),
    new THREE.Vector2(0.052, 0.06),
    new THREE.Vector2(0.049, 0.052),
    new THREE.Vector2(0.05, 0.022),
    new THREE.Vector2(0.0, 0.018),
  ];
}

/* ------------------------------------------------------------------ *
 * 场景
 * ------------------------------------------------------------------ */

function createTeaRoom(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'tea-room-scene';

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.02, 60);
  camera.position.set(0, 0.42, 0.95);

  const quality = THREE.MathUtils.clamp(ctx.quality, 0.4, 2);
  const driver = new AudioDriver();
  const breath = createBreathSample();

  const textures: THREE.Texture[] = [];
  const envMap = ctx.env.envMap;

  /** 统一给标准材质挂上环境贴图并压低强度（r186 下只设 scene.environment 会满强度）。 */
  const std = (
    params: THREE.MeshStandardMaterialParameters,
    envIntensity = 0.12,
  ): THREE.MeshStandardMaterial => {
    const material = new THREE.MeshStandardMaterial(params);
    material.envMap = envMap;
    material.envMapIntensity = envIntensity;
    return material;
  };

  // ── 榻榻米 ─────────────────────────────────────────────────────────────
  const tatamiTexture = createTatamiTexture(512);
  textures.push(tatamiTexture);

  const tatamiMaterial = std({ map: tatamiTexture, roughness: 0.95, metalness: 0 }, 0.08);
  const tatami = new THREE.Mesh(new THREE.PlaneGeometry(MAT_W, MAT_D), tatamiMaterial);
  tatami.name = 'tatami';
  tatami.rotation.x = -Math.PI / 2;
  tatami.receiveShadow = true;
  root.add(tatami);

  // 榻榻米的布缘（缘布）
  const heriMaterial = std({ color: 0x2c3550, roughness: 0.9, metalness: 0 }, 0.05);
  const heriW = 0.045;
  const heriSpecs: [number, number, number, number][] = [
    [MAT_W, heriW, 0, -MAT_D / 2 + heriW / 2],
    [MAT_W, heriW, 0, MAT_D / 2 - heriW / 2],
    [heriW, MAT_D - heriW * 2, -MAT_W / 2 + heriW / 2, 0],
    [heriW, MAT_D - heriW * 2, MAT_W / 2 - heriW / 2, 0],
  ];
  for (const [w, d, x, z] of heriSpecs) {
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(w, d), heriMaterial);
    strip.name = 'tatami-heri';
    strip.rotation.x = -Math.PI / 2;
    strip.position.set(x, 0.0022, z);
    strip.receiveShadow = true;
    root.add(strip);
  }

  // ── 障子门（屏风） ─────────────────────────────────────────────────────
  const woodTexture = createWoodTexture(256);
  const paperTexture = createPaperTexture(256);
  const outsideTexture = createOutsideTexture(128);
  const patchTexture = createLightPatchTexture(128);
  textures.push(woodTexture, paperTexture, outsideTexture, patchTexture);

  const woodMaterial = std({ map: woodTexture, color: 0xc8a888, roughness: 0.66, metalness: 0.02 }, 0.16);
  const darkWoodMaterial = std({ map: woodTexture, color: 0x7a6048, roughness: 0.72, metalness: 0.02 }, 0.12);

  const paperMaterial = std(
    {
      map: paperTexture,
      emissiveMap: paperTexture,
      emissive: new THREE.Color(0xffe3b0),
      emissiveIntensity: 0.55,
      transparent: true,
      opacity: 0.93,
      roughness: 0.96,
      metalness: 0,
      side: THREE.DoubleSide,
    },
    0.1,
  );

  /** 造一扇障子：木框 + 竖向格栅 + 半透光的纸面。 */
  const buildShoji = (width: number, height: number, withLattice: boolean): THREE.Group => {
    const group = new THREE.Group();
    group.name = 'shoji';

    const barW = 0.018;
    const depth = 0.016;

    // 上下横框
    const bottom = new THREE.Mesh(new THREE.BoxGeometry(width, barW, depth), darkWoodMaterial);
    bottom.position.y = barW / 2;
    bottom.castShadow = true;
    group.add(bottom);

    const top = new THREE.Mesh(new THREE.BoxGeometry(width, barW, depth), darkWoodMaterial);
    top.position.y = height - barW / 2;
    top.castShadow = true;
    group.add(top);

    // 左右立框
    const postGeo = new THREE.BoxGeometry(barW, height, depth);
    const left = new THREE.Mesh(postGeo, darkWoodMaterial);
    left.position.x = -width / 2 + barW / 2;
    left.position.y = height / 2;
    left.castShadow = true;
    group.add(left);

    const right = new THREE.Mesh(postGeo, darkWoodMaterial);
    right.position.x = width / 2 - barW / 2;
    right.position.y = height / 2;
    right.castShadow = true;
    group.add(right);

    if (withLattice) {
      const latticeGeo = new THREE.BoxGeometry(0.008, height - barW * 2, 0.01);
      const count = Math.max(2, Math.round(width / 0.085));
      for (let i = 1; i < count; i += 1) {
        const bar = new THREE.Mesh(latticeGeo, woodMaterial);
        bar.position.x = -width / 2 + (width / count) * i;
        bar.position.y = height / 2;
        bar.castShadow = true;
        group.add(bar);
      }
      // 中间一道横档
      const mid = new THREE.Mesh(new THREE.BoxGeometry(width - barW * 2, 0.01, 0.01), woodMaterial);
      mid.position.y = height * 0.42;
      mid.castShadow = true;
      group.add(mid);
    }

    const paper = new THREE.Mesh(new THREE.PlaneGeometry(width - barW * 1.6, height - barW * 1.6), paperMaterial);
    paper.name = 'shoji-paper';
    paper.position.y = height / 2;
    paper.position.z = -0.004;
    group.add(paper);

    return group;
  };

  // 屏风：左半是可推拉的门板，右半是固定的一扇
  const screen = new THREE.Group();
  screen.name = 'shoji-screen';
  screen.position.z = SCREEN_Z;
  root.add(screen);

  const fixedPanel = buildShoji(DOOR_W, DOOR_H, true);
  fixedPanel.position.set(DOOR_W / 2, 0, 0.004);
  screen.add(fixedPanel);

  // 可推拉的门板：铰链在屏风最左边的立柱上，关着时正好盖住左半边的门洞
  const doorSwing = new THREE.Group();
  doorSwing.name = 'shoji-door-swing';
  doorSwing.position.set(-DOOR_W, 0, 0);
  screen.add(doorSwing);

  const doorPanel = buildShoji(DOOR_W, DOOR_H, true);
  doorPanel.name = 'shoji-door';
  doorPanel.position.set(DOOR_W / 2, 0, 0);
  doorPanel.userData.pinchable = true;
  doorSwing.add(doorPanel);

  // 门后的「室外」——纸面透光、门推开后直接看见。
  // 尺寸正好等于门洞，并紧贴在门后，这样从侧面看不到它的边缘。
  const outsideMaterial = new THREE.MeshBasicMaterial({ map: outsideTexture, toneMapped: true });
  const outside = new THREE.Mesh(new THREE.PlaneGeometry(DOOR_W, DOOR_H), outsideMaterial);
  outside.name = 'outside';
  outside.position.set(-DOOR_W / 2, DOOR_H / 2, SCREEN_Z - 0.1);
  root.add(outside);

  // 门缝里漏在榻榻米上的柔光
  const patchMaterial = new THREE.MeshBasicMaterial({
    map: patchTexture,
    transparent: true,
    opacity: 0.18,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: true,
  });
  const patch = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.78), patchMaterial);
  patch.name = 'door-patch';
  patch.rotation.x = -Math.PI / 2;
  patch.position.set(-DOOR_W / 2, 0.004, SCREEN_Z + 0.4);
  root.add(patch);

  // ── 茶盘 ───────────────────────────────────────────────────────────────
  const trayMaterial = std({ map: woodTexture, color: 0x8e7a5e, roughness: 0.76, metalness: 0 }, 0.14);
  const tray = new THREE.Group();
  tray.name = 'tea-tray';

  const trayBase = new THREE.Mesh(new THREE.BoxGeometry(TRAY_W, TRAY_H, TRAY_D), trayMaterial);
  trayBase.position.y = TRAY_H / 2;
  trayBase.castShadow = true;
  trayBase.receiveShadow = true;
  tray.add(trayBase);

  const rimH = 0.02;
  const rimT = 0.012;
  const longRim = new THREE.BoxGeometry(TRAY_W, rimH, rimT);
  const shortRim = new THREE.BoxGeometry(rimT, rimH, TRAY_D - rimT * 2);
  for (const sign of [-1, 1]) {
    const front = new THREE.Mesh(longRim, trayMaterial);
    front.position.set(0, TRAY_H + rimH / 2, (sign * (TRAY_D - rimT)) / 2);
    front.castShadow = true;
    front.receiveShadow = true;
    tray.add(front);

    const side = new THREE.Mesh(shortRim, trayMaterial);
    side.position.set((sign * (TRAY_W - rimT)) / 2, TRAY_H + rimH / 2, 0);
    side.castShadow = true;
    side.receiveShadow = true;
    tray.add(side);
  }
  root.add(tray);

  // ── 茶具 ───────────────────────────────────────────────────────────────
  const clayMaterial = std({ color: 0x9c6f52, roughness: 0.78, metalness: 0.02 }, 0.14);
  const glazeMaterial = std({ color: 0xdadbd0, roughness: 0.3, metalness: 0.04 }, 0.3);
  const brassMaterial = std({ color: 0x8a6a3a, roughness: 0.36, metalness: 0.85 }, 0.4);

  const teaSet = new THREE.Group();
  teaSet.name = 'tea-set';
  teaSet.position.set(0, TRAY_H, 0.02);
  teaSet.rotation.y = -0.14;
  root.add(teaSet);

  // 茶壶
  const teapot = new THREE.Group();
  teapot.name = 'teapot';
  teapot.position.set(-0.09, 0, 0.0);

  const potBody = new THREE.Mesh(new THREE.LatheGeometry(createTeapotProfile(), 28), clayMaterial);
  potBody.castShadow = true;
  potBody.receiveShadow = true;
  teapot.add(potBody);

  const lidProfile = [
    new THREE.Vector2(0.0, 0.0),
    new THREE.Vector2(0.032, 0.0),
    new THREE.Vector2(0.033, 0.005),
    new THREE.Vector2(0.026, 0.011),
    new THREE.Vector2(0.014, 0.015),
    new THREE.Vector2(0.009, 0.021),
    new THREE.Vector2(0.0, 0.022),
  ];
  const lid = new THREE.Mesh(new THREE.LatheGeometry(lidProfile, 20), clayMaterial);
  lid.position.y = 0.1;
  lid.castShadow = true;
  teapot.add(lid);

  // 壶嘴
  const spoutCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.03, 0.035, 0),
    new THREE.Vector3(0.062, 0.05, 0),
    new THREE.Vector3(0.082, 0.072, 0),
    new THREE.Vector3(0.088, 0.086, 0),
  ]);
  const spout = new THREE.Mesh(new THREE.TubeGeometry(spoutCurve, 18, 0.0072, 10, false), clayMaterial);
  spout.castShadow = true;
  teapot.add(spout);

  // 壶把
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.026, 0.0055, 8, 20, Math.PI * 1.25), clayMaterial);
  handle.position.set(-0.045, 0.05, 0);
  handle.rotation.set(Math.PI / 2, 0, Math.PI * 0.62);
  handle.castShadow = true;
  teapot.add(handle);

  teaSet.add(teapot);

  // 两只茶杯
  const cupGeometry = new THREE.LatheGeometry(createCupProfile(), 24);
  const teaMaterial = std({ color: 0x6b4a24, roughness: 0.18, metalness: 0.05 }, 0.35);
  for (let i = 0; i < 2; i += 1) {
    const cup = new THREE.Mesh(cupGeometry, glazeMaterial);
    cup.position.set(0.085 + i * 0.085, 0, 0.055 - i * 0.085);
    cup.castShadow = true;
    cup.receiveShadow = true;
    teaSet.add(cup);

    const surface = new THREE.Mesh(new THREE.CircleGeometry(0.026, 20), teaMaterial);
    surface.rotation.x = -Math.PI / 2;
    surface.position.set(cup.position.x, 0.03, cup.position.z);
    teaSet.add(surface);
  }

  // ── 风炉（kamadare）与火苗 ─────────────────────────────────────────────
  const kamadare = new THREE.Group();
  kamadare.name = 'kamadare';
  kamadare.position.set(0.115, 0, -0.075);
  teaSet.add(kamadare);

  const stove = new THREE.Mesh(new THREE.LatheGeometry(createKamadareProfile(), 24), clayMaterial);
  stove.castShadow = true;
  stove.receiveShadow = true;
  kamadare.add(stove);

  const stoveRim = new THREE.Mesh(new THREE.TorusGeometry(0.056, 0.0035, 8, 28), brassMaterial);
  stoveRim.rotation.x = Math.PI / 2;
  stoveRim.position.y = 0.058;
  stoveRim.castShadow = true;
  kamadare.add(stoveRim);

  // 炉里的炭
  const charcoalMaterial = std({
    color: 0x241a14,
    emissive: new THREE.Color(0xff5a1e),
    emissiveIntensity: 0.55,
    roughness: 0.95,
    metalness: 0,
  }, 0.05);
  const charcoalGeometry = new THREE.IcosahedronGeometry(0.011, 1);
  for (let i = 0; i < 4; i += 1) {
    const char = new THREE.Mesh(charcoalGeometry, charcoalMaterial);
    const angle = (i / 4) * Math.PI * 2 + 0.6;
    char.position.set(Math.cos(angle) * 0.019, 0.036, Math.sin(angle) * 0.019);
    char.scale.set(1, 0.72, 1);
    kamadare.add(char);
  }

  // 火苗：粒子空间（锚在风炉的炉口）
  const flameSpace = new ParticleSpace({
    radius: 0.016,
    spin: 0.05,
    tilt: 0.2,
    position: [0.124, 0.058, -0.038],
  });

  const flameCount = Math.round(150 * quality);
  const flamePositions = new Float32Array(flameCount * 3);
  const flameSizes = new Float32Array(flameCount);
  const flamePhases = new Float32Array(flameCount);
  const flameSeeds = new Float32Array(flameCount);
  {
    let state = 99117;
    const random = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    for (let i = 0; i < flameCount; i += 1) {
      const r = Math.sqrt(random()) * 0.014;
      const a = random() * Math.PI * 2;
      flamePositions[i * 3] = Math.cos(a) * r;
      flamePositions[i * 3 + 1] = 0;
      flamePositions[i * 3 + 2] = Math.sin(a) * r;
      flameSizes[i] = 0.006 + random() * 0.009;
      flamePhases[i] = random();
      flameSeeds[i] = random();
    }
  }

  const flameGeometry = new THREE.BufferGeometry();
  flameGeometry.setAttribute('position', new THREE.BufferAttribute(flamePositions, 3));
  flameGeometry.setAttribute('aSize', new THREE.BufferAttribute(flameSizes, 1));
  flameGeometry.setAttribute('aPhase', new THREE.BufferAttribute(flamePhases, 1));
  flameGeometry.setAttribute('aSeed', new THREE.BufferAttribute(flameSeeds, 1));

  const flameUniforms = {
    uTime: { value: 0 },
    uScale: { value: 600 },
    uHeight: { value: 0.052 },
    uSway: { value: 0.0018 },
    uSpeed: { value: 0.3 },
    uIntensity: { value: 0.85 },
    uColorCore: { value: new THREE.Color(0xfff0c0) },
    uColorTip: { value: new THREE.Color(0xff6a1e) },
    particleMatrix: flameSpace.uniform,
  };

  const flameMaterial = new THREE.ShaderMaterial({
    uniforms: flameUniforms,
    vertexShader: FLAME_VERT,
    fragmentShader: FLAME_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const flame = new THREE.Points(flameGeometry, flameMaterial);
  flame.name = 'flame';
  flame.frustumCulled = false;
  flame.renderOrder = 4;
  root.add(flame);

  // ── 热气：粒子空间 ─────────────────────────────────────────────────────
  const steamSpace = new ParticleSpace({
    radius: 0.03,
    spin: 0.02,
    tilt: 0.1,
    position: [-0.002, 0.104, 0.02],
  });

  const steamCount = Math.round(90 * quality);
  const steamPositions = new Float32Array(steamCount * 3);
  const steamSizes = new Float32Array(steamCount);
  const steamPhases = new Float32Array(steamCount);
  const steamSeeds = new Float32Array(steamCount);
  {
    let state = 4423;
    const random = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    for (let i = 0; i < steamCount; i += 1) {
      const r = Math.sqrt(random()) * 0.008;
      const a = random() * Math.PI * 2;
      steamPositions[i * 3] = Math.cos(a) * r;
      steamPositions[i * 3 + 1] = 0;
      steamPositions[i * 3 + 2] = Math.sin(a) * r;
      steamSizes[i] = 0.009 + random() * 0.014;
      steamPhases[i] = random();
      steamSeeds[i] = random();
    }
  }

  const steamGeometry = new THREE.BufferGeometry();
  steamGeometry.setAttribute('position', new THREE.BufferAttribute(steamPositions, 3));
  steamGeometry.setAttribute('aSize', new THREE.BufferAttribute(steamSizes, 1));
  steamGeometry.setAttribute('aPhase', new THREE.BufferAttribute(steamPhases, 1));
  steamGeometry.setAttribute('aSeed', new THREE.BufferAttribute(steamSeeds, 1));

  const steamUniforms = {
    uTime: { value: 0 },
    uScale: { value: 600 },
    uHeight: { value: 0.24 },
    uSpeed: { value: 0.085 },
    uOpacity: { value: 0.24 },
    uColor: { value: new THREE.Color(0xf2ece0) },
    particleMatrix: steamSpace.uniform,
  };

  const steamMaterial = new THREE.ShaderMaterial({
    uniforms: steamUniforms,
    vertexShader: STEAM_VERT,
    fragmentShader: STEAM_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
  });

  const steam = new THREE.Points(steamGeometry, steamMaterial);
  steam.name = 'steam';
  steam.frustumCulled = false;
  steam.renderOrder = 3;
  root.add(steam);

  // ── 灯光 ───────────────────────────────────────────────────────────────
  // 火苗的暖光
  const flameLight = new THREE.PointLight(0xff9440, 0.5, 1.8, 2);
  flameLight.position.set(0.124, 0.082, -0.038);
  root.add(flameLight);

  // 主光：一盏小聚光，阴影相机收紧到茶具尺度
  const keyLight = new THREE.SpotLight(0xfff1da, 3.2, 4.2, 0.78, 0.65, 1.3);
  keyLight.position.set(0.42, 1.05, 0.72);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  keyLight.shadow.camera.near = 0.2;
  keyLight.shadow.camera.far = 4;
  keyLight.shadow.bias = -0.0006;
  keyLight.shadow.normalBias = 0.008;
  keyLight.shadow.radius = 4;
  keyLight.target.position.set(-0.02, 0.02, -0.04);
  root.add(keyLight);
  root.add(keyLight.target);

  // 门后的天光：门开得越大，透进来的光越强，格栅的影子也随之流动
  const doorLight = new THREE.SpotLight(0xffeccb, 1.4, 3.4, 0.72, 0.7, 1.1);
  doorLight.position.set(-DOOR_W / 2, 0.62, SCREEN_Z - 0.55);
  doorLight.castShadow = true;
  doorLight.shadow.mapSize.set(1024, 1024);
  doorLight.shadow.camera.near = 0.1;
  doorLight.shadow.camera.far = 3.2;
  doorLight.shadow.bias = -0.0008;
  doorLight.shadow.normalBias = 0.006;
  doorLight.shadow.radius = 3;
  doorLight.target.position.set(-DOOR_W / 2, 0, 0.16);
  root.add(doorLight);
  root.add(doorLight.target);

  const fill = new THREE.HemisphereLight(0xffeacd, 0x2b2418, 0.42);
  root.add(fill);

  const lights = ctx.env.createStudioLights();
  lights.traverse((child) => {
    if (child instanceof THREE.Light) {
      child.intensity *= 0.16;
      child.castShadow = false;
      child.color.setHex(0xffeede);
    }
  });
  root.add(lights);

  // ── 门的开合状态 ───────────────────────────────────────────────────────
  let slide = 0;
  let swing = 0;
  let grabbing = false;
  let settledOpen = false;
  const grabHandStart = new THREE.Vector3();
  let grabSlideStart = 0;
  let grabSwingStart = 0;

  const applyDoor = (): void => {
    doorPanel.position.x = DOOR_W / 2 + slide;
    doorSwing.rotation.y = -swing;
  };
  applyDoor();

  const openRatio = (): number =>
    THREE.MathUtils.clamp(Math.max(slide / DOOR_SLIDE_MAX, swing / DOOR_SWING_MAX), 0, 1);

  return {
    root,
    camera,
    immersive: false,
    xrDistance: 1.2,
    framing: { distance: 0.95, height: 0.42, targetY: 0.14, width: 1.24 },

    update(time: number, delta: number, context: SceneContext): void {
      driver.update(context, delta);
      sampleBreath(BREATHING, time, breath);

      const breathLevel = breath.level;
      const pulse = driver.pulse;
      const level = driver.level;
      const bass = driver.bass;

      // ── 火苗 ───────────────────────────────────────────────────────────
      flameSpace.breathe = 1 + breathLevel * 0.07;
      flameSpace.breathPhase = breathLevel;
      flameSpace.update(delta, time);

      flameUniforms.uTime.value = time;
      flameUniforms.uIntensity.value = 0.72 + breathLevel * 0.34 + pulse * 0.14;
      flameUniforms.uSway.value = 0.0014 + breathLevel * 0.0016;
      flameUniforms.uScale.value =
        (context.height * 0.5 * context.renderer.getPixelRatio()) / Math.tan(THREE.MathUtils.degToRad(FOV) / 2);

      flameLight.intensity = 0.4 + breathLevel * 0.22 + pulse * 0.1 + bass * 0.05;
      charcoalMaterial.emissiveIntensity = 0.42 + breathLevel * 0.28;

      // ── 热气 ───────────────────────────────────────────────────────────
      steamSpace.breathe = 1 + breathLevel * 0.05;
      steamSpace.breathPhase = breathLevel;
      steamSpace.update(delta, time);

      steamUniforms.uTime.value = time;
      steamUniforms.uOpacity.value = 0.11 + level * 0.1 + breathLevel * 0.04;
      steamUniforms.uScale.value = flameUniforms.uScale.value;

      // ── 门的开合 ───────────────────────────────────────────────────────
      if (!grabbing) {
        // 松手后缓缓停到最近的状态
        const targetSlide = settledOpen ? DOOR_SLIDE_MAX : 0;
        const targetSwing = settledOpen ? DOOR_SWING_MAX * 0.5 : 0;
        slide = THREE.MathUtils.damp(slide, targetSlide, 1.5, delta);
        swing = THREE.MathUtils.damp(swing, targetSwing, 1.5, delta);
        applyDoor();
      }

      const open = openRatio();

      // 纸面的透光量：门关上时纸被背后的光透亮，开门后光从门缝直接进来
      paperMaterial.emissiveIntensity = 0.16 + (1 - open) * 0.34;
      paperMaterial.opacity = 0.86 + (1 - open) * 0.1;

      // 门后的灯与落在榻榻米上的光斑
      doorLight.intensity = 0.5 + open * 2.6 + level * 0.25;
      patchMaterial.opacity = 0.08 + open * 0.3;
      patch.position.x = -DOOR_W / 2 + Math.sin(time * 0.23) * 0.02;
      patch.scale.set(0.72 + open * 0.5, 0.86 + open * 0.3, 1);

      // 门外的天光随门缝一起变亮
      outsideMaterial.color.setScalar(0.55 + open * 0.3);

      keyLight.intensity = 3.0 + level * 0.5;
      fill.intensity = 0.4 + level * 0.18;
    },

    onPinch(info: PinchInfo): void {
      if (info.phase === 'start') {
        if (!info.hit) return;
        grabbing = true;
        grabHandStart.copy(info.hand);
        grabSlideStart = slide;
        grabSwingStart = swing;
        return;
      }

      if (info.phase === 'move') {
        if (!grabbing) return;
        // 用手的位移驱动：手往右推 → 门板平移；手往身前拉 → 门板转开
        const dx = info.hand.x - grabHandStart.x;
        const dz = info.hand.z - grabHandStart.z;
        slide = THREE.MathUtils.clamp(grabSlideStart + dx * 1.15, 0, DOOR_SLIDE_MAX);
        swing = THREE.MathUtils.clamp(grabSwingStart + dz * 1.6, 0, DOOR_SWING_MAX);
        applyDoor();
        return;
      }

      if (info.phase === 'end') {
        if (!grabbing) return;
        grabbing = false;
        // 松手后停到最近的一侧
        settledOpen = openRatio() > 0.45;
      }
    },

    dispose(): void {
      for (const texture of textures) texture.dispose();
      disposeObject(root);
    },
  };
}

export const teaRoomScene: SceneDefinition = {
  id: 'tea-room',
  title: '和风茶室',
  subtitle: 'Tea Room',
  description: '一张桌上尺度的榻榻米、一炉小火与一缕热气，障子门可以被轻轻推开。',
  tags: ['茶室', '和风', 'AR', '极简'],
  accent: '#d8b98c',
  gradient: ['#d9c39a', '#6c5940'],
  category: 'environment',
  audio: 'zen-stones.mp3',
  breathing: BREATHING,
  lighting: {
    autoExposure: true,
    autoExposureKey: 0.14,
    softShadows: 0.6,
  },
  create(ctx: SceneContext): SceneInstance {
    return createTeaRoom(ctx);
  },
};

export default teaRoomScene;
