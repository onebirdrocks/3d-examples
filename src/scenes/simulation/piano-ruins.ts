/**
 * 废墟里的钢琴 · Piano in Ruins
 * ---------------------------------------------------------------
 * 一间半塌的石屋里立着一架老式立式钢琴。斜射的黄昏光柱穿过残墙上的窗口，
 * 尘埃在光里缓慢下坠，脚下是积灰开裂的旧木地板。
 *
 * 这个场景把三件事合在一起：
 * 1. **刚体物理**：88 个琴键都是 Rapier 刚体，用 revolute 关节挂在琴体上
 *    （支点就在琴键的平衡点上，所以琴键天然平躺、不会塌下去）。
 *    琴键有真实质量、真实惯量，按下时给前端施加冲量 + 持续按压力，
 *    于是琴键真的沉下去、被弹簧顶回来，落石也会在开局从高处掉下并稳住。
 * 2. **真实发声**：每个键对应一个 MIDI 音，用 Web Audio 合成
 *    （基频 + 两个泛音 + 槌击噪声 + 随时间关闭的低通 + 指数包络）。
 *    发声由**物理状态**驱动：琴键沉到多深，音就持续多久；琴键弹回原位，
 *    阻尼器落下，音也跟着断掉。
 * 3. **手直接操控**：黄铜拨杆标记了 `userData.pinchable`，捏住就能掀开琴盖；
 *    琴键同样可捏（XR）与可点（网页），按下即响。
 *
 * 音乐驱动：
 * - `ctx.audio.pulse` → 被按下的琴键周围泛起一圈共鸣微光；
 * - `ctx.audio.level` → 光柱与尘埃的亮度；
 * - `ctx.audio.bass`  → 废墟的低频震动（落石被轻轻推一下、灰尘抖落）。
 *
 * 没有音乐时（实验室页面）画面回落到场景声明的呼吸节奏，永远不会死掉。
 */
import * as THREE from 'three';
import type { RigidBody, Rotation } from '@dimforge/rapier3d-compat';
import type { PinchInfo, SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { disposeObject } from '../../core/loader.js';
import { createBreathSample, sampleBreath } from '../../core/breath.js';
import { GLSL_OUTPUT, GLSL_OUTPUT_FUNCS } from '../procedural/lib/glsl-output.js';
import { createBackdropDome } from '../meditation/lib/gfx.js';
import { PianoSynth } from './piano-audio.js';

/* ------------------------------------------------------------------ *
 * 尺度与常量（1 单位 = 1 米，地面 y = 0）
 * ------------------------------------------------------------------ */

/** 琴体在世界里的位置（琴键中心）。 */
const PIANO_X = -0.16;
const PIANO_Z = -0.62;
/** 琴体高度。 */
const PIANO_HEIGHT = 1.25;

/** 白键：宽 23mm 左右的真实立式钢琴白键。 */
const WHITE_PITCH = 0.0235;
const WHITE_W = 0.0215;
const WHITE_H = 0.02;
const WHITE_L = 0.145;
/** 黑键：更窄更高，插在白键之间。 */
const BLACK_W = 0.011;
const BLACK_H = 0.013;
const BLACK_L = 0.085;

/** 琴键支点（平衡点）位置。 */
const PIVOT_Y = 0.7275;
const WHITE_PIVOT_Z = 0.17;
const BLACK_PIVOT_Z = 0.175;
/** 黑键底面 = 白键顶面。 */
const WHITE_TOP_Y = PIVOT_Y + WHITE_H;

/** 88 键的音高范围：A0 ~ C8。 */
const FIRST_MIDI = 21;
const LAST_MIDI = 108;

/** 物理固定步长。 */
const FIXED_STEP = 1 / 60;
/** 单帧最多推进的物理步数，避免卡顿后的「死亡螺旋」。 */
const MAX_SUBSTEPS = 4;

/** 琴键弹簧（以参考白键的转动惯量为基准，按各键惯量等比缩放）。 */
const SPRING_K = 0.1;
const SPRING_C = 0.009;
/** 按下瞬间的一次冲量。 */
const PRESS_IMPULSE = 0.002;
/** 按住时每步施加的等效冲量（把琴键压到约 6.5mm 的下沉量）。 */
const HOLD_IMPULSE = 0.00063;
/** 判定「琴键已经回到原位」的阈值。 */
const ANGLE_EPS = 0.0006;
const OMEGA_EPS = 0.004;

/** 碰撞分组：琴键之间互相碰撞，但不与琴体 / 地面纠缠。 */
const GROUP_WHITE = (0x0001 << 16) | 0x0001;
const GROUP_BLACK = (0x0002 << 16) | 0x0002;
const GROUP_SCENERY = (0x0004 << 16) | 0x0004;

/** 窗口与光柱。 */
const WINDOW_X = 2.35;
const WINDOW_Y = 1.8;
const WINDOW_Z = 0.0;
/** 光柱落在地面上的位置。 */
const POOL_X = -0.55;
const POOL_Z = 0.95;
/** 光柱在窗口 / 地面两端的半径。 */
const BEAM_R_TOP = 0.5;
const BEAM_R_BOTTOM = 1.05;

/** 琴盖的最大开启角（弧度）。 */
const LID_MAX_ANGLE = 0.62;

/** 场景声明的呼吸节奏（没有音乐时画面跟随它）。 */
const BREATHING = { inhale: 6, hold: 2, exhale: 8 };

/* ------------------------------------------------------------------ *
 * 键盘排布
 * ------------------------------------------------------------------ */

/** 白键的音级（C D E F G A B）。 */
const WHITE_CLASSES = [0, 2, 4, 5, 7, 9, 11];
/** 音级 → 字母。 */
const LETTER_BY_CLASS: Record<number, string> = { 0: 'C', 2: 'D', 4: 'E', 5: 'F', 7: 'G', 9: 'A', 11: 'B' };

interface KeyLayout {
  /** MIDI 音高。 */
  readonly midi: number;
  /** 是否黑键。 */
  readonly black: boolean;
  /** 支点在琴体局部空间里的 x。 */
  readonly x: number;
}

/** 生成 88 键的排布（52 白 + 36 黑）。 */
function buildKeyboard(): KeyLayout[] {
  const whites: number[] = [];
  for (let midi = FIRST_MIDI; midi <= LAST_MIDI; midi += 1) {
    if (WHITE_CLASSES.includes(midi % 12)) whites.push(midi);
  }

  const layout: KeyLayout[] = [];
  const half = (whites.length - 1) / 2;
  for (let i = 0; i < whites.length; i += 1) {
    layout.push({ midi: whites[i], black: false, x: (i - half) * WHITE_PITCH });
  }
  for (let i = 0; i < whites.length - 1; i += 1) {
    const midi = whites[i];
    const letter = LETTER_BY_CLASS[midi % 12];
    // B/C 之间、E/F 之间没有黑键
    if (letter === 'B' || letter === 'E') continue;
    const blackMidi = midi + 1;
    if (blackMidi > LAST_MIDI) continue;
    layout.push({ midi: blackMidi, black: true, x: (i - half) * WHITE_PITCH + WHITE_PITCH / 2 });
  }
  return layout;
}

/* ------------------------------------------------------------------ *
 * 程序化贴图
 * ------------------------------------------------------------------ */

/** 确定性随机数（贴图用，避免每次刷新都在变）。 */
function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 建一张画布贴图。 */
function makeCanvasTexture(
  size: number,
  name: string,
  draw: (ctx: CanvasRenderingContext2D, size: number, random: () => number) => void,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');
  draw(ctx, size, makeRandom(20241025));
  const texture = new THREE.CanvasTexture(canvas);
  texture.name = name;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

/** 积灰的深色木地板：木纹 + 灰 + 裂缝。 */
function createFloorTexture(): THREE.CanvasTexture {
  const texture = makeCanvasTexture(1024, 'piano-floor', (ctx, size, random) => {
    ctx.fillStyle = '#241c15';
    ctx.fillRect(0, 0, size, size);

    // 木板
    const planks = 6;
    const h = size / planks;
    for (let i = 0; i < planks; i += 1) {
      const v = 0.78 + random() * 0.45;
      ctx.fillStyle = `rgb(${Math.round(56 * v)},${Math.round(43 * v)},${Math.round(32 * v)})`;
      ctx.fillRect(0, i * h, size, h - 1);

      // 木纹
      ctx.strokeStyle = 'rgba(24,18,13,0.28)';
      ctx.lineWidth = 1;
      for (let g = 0; g < 26; g += 1) {
        const y = i * h + random() * (h - 2);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.bezierCurveTo(size * 0.3, y + (random() - 0.5) * 5, size * 0.7, y + (random() - 0.5) * 5, size, y);
        ctx.stroke();
      }
      // 板缝
      ctx.fillStyle = 'rgba(10,8,6,0.9)';
      ctx.fillRect(0, i * h + h - 2, size, 2);
      // 竖向接缝（错开）
      const seam = Math.floor(random() * size);
      ctx.fillRect(seam, i * h, 2, h);
    }

    // 积灰
    for (let i = 0; i < 2600; i += 1) {
      const x = random() * size;
      const y = random() * size;
      const r = 3 + random() * 26;
      ctx.fillStyle = `rgba(196,186,168,${0.012 + random() * 0.03})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // 裂缝
    ctx.strokeStyle = 'rgba(8,6,5,0.75)';
    for (let c = 0; c < 7; c += 1) {
      let x = random() * size;
      let y = random() * size;
      ctx.lineWidth = 1 + random() * 2.4;
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let s = 0; s < 14; s += 1) {
        x += (random() - 0.5) * 60;
        y += (random() - 0.35) * 46;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  });
  texture.repeat.set(8, 8);
  return texture;
}

/** 粗糙的旧石墙。 */
function createStoneTexture(): THREE.CanvasTexture {
  const texture = makeCanvasTexture(512, 'piano-stone', (ctx, size, random) => {
    ctx.fillStyle = '#6d6a63';
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 1400; i += 1) {
      const x = random() * size;
      const y = random() * size;
      const r = 4 + random() * 40;
      const shade = 90 + random() * 70;
      ctx.fillStyle = `rgba(${shade},${shade - 4},${shade - 12},${0.05 + random() * 0.12})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // 石缝（不规则，不要规则网格）
    ctx.strokeStyle = 'rgba(48,45,40,0.3)';
    for (let r = 0; r < 16; r += 1) {
      let x = random() * size;
      let y = random() * size;
      ctx.lineWidth = 0.8 + random() * 1.6;
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let s = 0; s < 7; s += 1) {
        x += (random() - 0.5) * 90;
        y += (random() - 0.5) * 70;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // 整体的脏污与水渍
    for (let i = 0; i < 26; i += 1) {
      const x = random() * size;
      const y = random() * size;
      const r = 30 + random() * 90;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(70,64,54,${0.05 + random() * 0.1})`);
      g.addColorStop(1, 'rgba(70,64,54,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
  });
  texture.repeat.set(3, 2);
  return texture;
}

/** 黄昏天空（窗口外面）。 */
function createSkyTexture(): THREE.CanvasTexture {
  const texture = makeCanvasTexture(512, 'piano-sky', (ctx, size) => {
    const gradient = ctx.createLinearGradient(0, 0, 0, size);
    gradient.addColorStop(0, '#1b2740');
    gradient.addColorStop(0.45, '#4d4a63');
    gradient.addColorStop(0.72, '#c2744a');
    gradient.addColorStop(0.88, '#e8a765');
    gradient.addColorStop(1, '#f0c98d');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    // 远处的地平线剪影
    ctx.fillStyle = 'rgba(38,28,26,0.85)';
    ctx.beginPath();
    ctx.moveTo(0, size);
    ctx.lineTo(0, size * 0.9);
    for (let x = 0; x <= size; x += 32) {
      ctx.lineTo(x, size * (0.88 + Math.sin(x * 0.05) * 0.012 + Math.cos(x * 0.017) * 0.01));
    }
    ctx.lineTo(size, size);
    ctx.closePath();
    ctx.fill();
  });
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

/** 柔和的径向光斑（地面光池、琴键辉光、窗口的太阳）。 */
function createGlowTexture(): THREE.CanvasTexture {
  const texture = makeCanvasTexture(128, 'piano-glow', (ctx, size) => {
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.35, 'rgba(255,255,255,0.55)');
    gradient.addColorStop(0.72, 'rgba(255,255,255,0.12)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  });
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

/* ------------------------------------------------------------------ *
 * GLSL
 * ------------------------------------------------------------------ */

/** 光柱（圆锥筒）的顶点着色器。 */
const BEAM_VERT = /* glsl */ `
varying vec3 vNormalW;
varying vec3 vViewW;
varying float vT;

void main() {
  vec4 world = modelMatrix * vec4( position, 1.0 );
  vNormalW = normalize( mat3( modelMatrix ) * normal );
  vViewW = normalize( cameraPosition - world.xyz );
  vT = uv.y;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

/** 光柱的片元着色器：正对视线的地方最亮（体积感），向地面逐渐变淡。 */
const BEAM_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uColor;
uniform float uTime;
uniform float uIntensity;

varying vec3 vNormalW;
varying vec3 vViewW;
varying float vT;

${GLSL_OUTPUT_FUNCS}

void main() {
  float facing = abs( dot( normalize( vNormalW ), normalize( vViewW ) ) );
  float body = pow( facing, 2.0 );
  float vertical = mix( 0.08, 1.0, smoothstep( 0.0, 0.95, vT ) );
  float flicker = 0.92 + 0.08 * sin( uTime * 0.7 + vT * 4.0 );
  float a = body * vertical * uIntensity * flicker;
  if ( a < 0.002 ) discard;
  gl_FragColor = vec4( uColor * a, 1.0 );
  ${GLSL_OUTPUT}
}
`;

/** 尘埃的顶点着色器：在光柱局部空间里缓慢下坠并回绕。 */
const DUST_VERT = /* glsl */ `
attribute float aPhase;
attribute float aSize;
attribute float aSpeed;

uniform float uTime;
uniform float uScale;
uniform float uLength;
uniform float uRTop;
uniform float uRBottom;
uniform float uOpacity;
uniform float uLevel;

varying float vAlpha;
varying float vWarm;

void main() {
  vec3 p = position;
  float fall = fract( uTime * aSpeed + aPhase );
  p.y = -fall * uLength;
  p.x += sin( uTime * 0.33 + aPhase * 6.2831 ) * 0.07;
  p.z += cos( uTime * 0.27 + aPhase * 5.117 ) * 0.07;

  float maxR = mix( uRTop, uRBottom, fall );
  float radial = 1.0 - smoothstep( maxR * 0.45, maxR, length( p.xz ) );

  vec4 mv = modelViewMatrix * vec4( p, 1.0 );
  gl_Position = projectionMatrix * mv;

  float shimmer = 0.55 + 0.45 * sin( uTime * 1.3 + aPhase * 9.0 );
  vAlpha = uOpacity * uLevel * radial * shimmer;
  vWarm = 1.0 - fall * 0.45;
  gl_PointSize = aSize * uScale / max( 1.0, -mv.z );
}
`;

/** 尘埃的片元着色器。 */
const DUST_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uColor;

varying float vAlpha;
varying float vWarm;

${GLSL_OUTPUT_FUNCS}

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot( c, c );
  if ( d2 > 0.25 ) discard;
  float falloff = exp( -d2 * 16.0 );
  float a = falloff * vAlpha;
  if ( a < 0.002 ) discard;
  gl_FragColor = vec4( mix( uColor, vec3( 1.0, 0.93, 0.82 ), vWarm * 0.35 ) * a, 1.0 );
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * 运行期状态
 * ------------------------------------------------------------------ */

/** 一个琴键的完整状态。 */
interface KeyState {
  readonly layout: KeyLayout;
  readonly mesh: THREE.Mesh;
  readonly body: RigidBody;
  /** 支点在琴体局部空间的 y / z。 */
  readonly pivotY: number;
  readonly pivotZ: number;
  /** 键体的中心 z（琴体局部）。 */
  readonly centerZ: number;
  /** 键面的高度（琴体局部）。 */
  readonly topY: number;
  /** 半宽。 */
  readonly halfW: number;
  /** 半长。 */
  readonly halfL: number;
  /** 惯量比例（相对参考白键），用于缩放弹簧与冲量。 */
  readonly scale: number;
  /** 是否正被按住。 */
  held: boolean;
  /** 是否还在运动（运动中的键才需要算弹簧，避免每帧新建对象）。 */
  active: boolean;
  /** 共鸣辉光（首次按下时创建）。 */
  glow: THREE.Mesh | null;
  glowMaterial: THREE.MeshBasicMaterial | null;
  /** 辉光生命 0~1。 */
  glowLife: number;
}

/** 一块落石。 */
interface RubblePiece {
  readonly mesh: THREE.Mesh;
  readonly body: RigidBody;
  readonly mass: number;
}

/* ------------------------------------------------------------------ *
 * 场景
 * ------------------------------------------------------------------ */

async function createPianoRuins(ctx: SceneContext): Promise<SceneInstance> {
  // Rapier 内联了 WASM（约 2MB），这里按需动态加载，避免把主包撑大
  const rapierModule = await import('@dimforge/rapier3d-compat');
  const RAPIER = rapierModule.default;
  await RAPIER.init();

  const root = new THREE.Group();
  root.name = 'piano-ruins-scene';

  const camera = new THREE.PerspectiveCamera(52, 1, 0.05, 120);
  camera.position.set(0, 1.45, 4.2);
  camera.lookAt(0, 0.85, 0);

  // 画质系数：控制尘埃、落石数量。
  const quality = THREE.MathUtils.clamp(ctx.quality, 0.5, 2);
  const dustCount = Math.round(520 * quality);
  const rubbleCount = Math.round(11 * quality);

  /* ---------------- 物理世界 ---------------- */

  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = FIXED_STEP;

  const floorBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
  world.createCollider(RAPIER.ColliderDesc.cuboid(16, 0.5, 16).setFriction(0.9).setCollisionGroups(GROUP_SCENERY), floorBody);

  /* ---------------- 材质 ---------------- */

  const envMap = ctx.env.envMap;

  const floorTexture = createFloorTexture();
  const stoneTexture = createStoneTexture();
  const skyTexture = createSkyTexture();
  const glowTexture = createGlowTexture();

  const floorMaterial = new THREE.MeshStandardMaterial({
    color: 0x6a5c4c,
    map: floorTexture,
    roughness: 0.93,
    metalness: 0.0,
    envMap,
    envMapIntensity: 0.35,
  });

  const stoneMaterial = new THREE.MeshStandardMaterial({
    color: 0x8a867c,
    map: stoneTexture,
    roughness: 0.94,
    metalness: 0.0,
    envMap,
    envMapIntensity: 0.45,
  });

  const woodMaterial = new THREE.MeshStandardMaterial({
    color: 0x2e1c12,
    roughness: 0.48,
    metalness: 0.08,
    envMap,
    envMapIntensity: 0.5,
  });

  const woodDarkMaterial = new THREE.MeshStandardMaterial({
    color: 0x1b1009,
    roughness: 0.4,
    metalness: 0.06,
    envMap,
    envMapIntensity: 0.45,
  });

  const ivoryMaterial = new THREE.MeshStandardMaterial({
    color: 0xe6dcc0,
    roughness: 0.34,
    metalness: 0.0,
    envMap,
    envMapIntensity: 0.6,
  });

  const ebonyMaterial = new THREE.MeshStandardMaterial({
    color: 0x120e0c,
    roughness: 0.26,
    metalness: 0.04,
    envMap,
    envMapIntensity: 0.8,
  });

  const brassMaterial = new THREE.MeshStandardMaterial({
    color: 0xb4883f,
    metalness: 1.0,
    roughness: 0.32,
    envMap,
    envMapIntensity: 1.05,
  });

  // 旧铭牌：磨得发暗的铜
  const brassDullMaterial = new THREE.MeshStandardMaterial({
    color: 0x6f5527,
    metalness: 0.85,
    roughness: 0.62,
    envMap,
    envMapIntensity: 0.45,
  });

  const brassLeverMaterial = new THREE.MeshStandardMaterial({
    color: 0xd6a75a,
    metalness: 1.0,
    roughness: 0.22,
    emissive: new THREE.Color(0x2a1a06),
    emissiveIntensity: 0.8,
    envMap,
    envMapIntensity: 1.2,
  });

  /* ---------------- 地面 ---------------- */

  // 背景穹顶：塌了顶的屋子外面是黄昏，别让画面出现大片纯黑
  const backdrop = createBackdropDome({
    zenith: 0x141c2e,
    horizon: 0x6b4a3c,
    ground: 0x0d0a09,
    radius: 70,
  });
  backdrop.mesh.name = 'ruin-backdrop';
  root.add(backdrop.mesh);

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(32, 32), floorMaterial);
  floor.name = 'ruin-floor';
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  root.add(floor);

  /* ---------------- 石墙 ---------------- */

  const walls = new THREE.Group();
  walls.name = 'ruin-walls';
  root.add(walls);

  /** 造一块墙（带一点随机起伏，看起来像垒起来的石头）。 */
  const addWall = (
    width: number,
    height: number,
    depth: number,
    x: number,
    y: number,
    z: number,
    broken = false,
  ): void => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), stoneMaterial);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    walls.add(mesh);

    // 墙顶的碎块
    if (broken) {
      const pieces = Math.max(2, Math.round(width * 1.6));
      for (let i = 0; i < pieces; i += 1) {
        const w = 0.18 + Math.random() * 0.42;
        const h = 0.12 + Math.random() * 0.5;
        const d = depth * (0.7 + Math.random() * 0.5);
        const chunk = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), stoneMaterial);
        chunk.position.set(
          x - width / 2 + (i + 0.5) * (width / pieces) + (Math.random() - 0.5) * 0.2,
          y + height / 2 + h / 2 - 0.03,
          z + (Math.random() - 0.5) * 0.06,
        );
        chunk.rotation.set((Math.random() - 0.5) * 0.2, (Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.2);
        chunk.castShadow = true;
        chunk.receiveShadow = true;
        walls.add(chunk);
      }
    }
  };

  // 后墙（中间高，两侧低，中间还有一段缺口）
  addWall(3.4, 3.1, 0.32, -0.7, 1.55, -2.85, true);
  addWall(2.2, 1.85, 0.32, 1.85, 0.92, -2.85, true);
  addWall(1.1, 0.7, 0.32, -2.85, 0.35, -2.85, true);
  // 左墙（塌了一半）
  addWall(0.32, 2.4, 4.6, -2.95, 1.2, -0.6, true);
  // 右墙：留出一个窗口
  addWall(0.28, 1.25, 4.9, 2.5, 0.625, -0.55);
  addWall(0.28, 0.85, 4.9, 2.5, 2.775, -0.55);
  addWall(0.28, 1.1, 1.35, 2.5, 1.8, 1.225, true);
  addWall(0.28, 1.1, 2.45, 2.5, 1.8, -1.775, true);

  // 窗框与窗台
  const sillMaterial = new THREE.MeshStandardMaterial({
    color: 0x77726a,
    roughness: 0.9,
    metalness: 0.0,
    envMap,
    envMapIntensity: 0.4,
  });
  const sill = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.12, 1.34), sillMaterial);
  sill.position.set(2.42, 1.19, 0);
  sill.castShadow = true;
  sill.receiveShadow = true;
  walls.add(sill);

  // 墙的碰撞体（把落石留在屋里）
  const wallBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, 0));
  world.createCollider(RAPIER.ColliderDesc.cuboid(0.16, 2.0, 2.5).setTranslation(-2.95, 2.0, -0.6).setCollisionGroups(GROUP_SCENERY), wallBody);
  world.createCollider(RAPIER.ColliderDesc.cuboid(2.8, 2.0, 0.16).setTranslation(-0.7, 2.0, -2.85).setCollisionGroups(GROUP_SCENERY), wallBody);
  world.createCollider(RAPIER.ColliderDesc.cuboid(0.14, 2.0, 2.45).setTranslation(2.5, 2.0, -0.55).setCollisionGroups(GROUP_SCENERY), wallBody);

  /* ---------------- 窗外的黄昏 ---------------- */

  const skyMaterial = new THREE.MeshBasicMaterial({ map: skyTexture, fog: false, depthWrite: false });
  const sky = new THREE.Mesh(new THREE.PlaneGeometry(9, 5.4), skyMaterial);
  sky.name = 'dusk-sky';
  sky.position.set(3.85, 1.7, -0.1);
  sky.rotation.y = -Math.PI / 2;
  sky.renderOrder = -900;
  root.add(sky);

  const sunGlowMaterial = new THREE.MeshBasicMaterial({
    map: glowTexture,
    color: 0xffc98a,
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  const sunGlow = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 1.8), sunGlowMaterial);
  sunGlow.name = 'window-sun';
  sunGlow.position.set(2.3, 1.95, 0.12);
  sunGlow.rotation.y = -Math.PI / 2;
  sunGlow.renderOrder = -880;
  root.add(sunGlow);

  /* ---------------- 光柱与尘埃 ---------------- */

  const beamStart = new THREE.Vector3(WINDOW_X, WINDOW_Y, WINDOW_Z);
  const beamEnd = new THREE.Vector3(POOL_X, 0.02, POOL_Z);
  const beamDirection = new THREE.Vector3().subVectors(beamEnd, beamStart);
  const beamLength = beamDirection.length();
  beamDirection.normalize();

  const beamGroup = new THREE.Group();
  beamGroup.name = 'light-shaft';
  beamGroup.position.copy(beamStart);
  // 局部 +Y 指回窗口，局部 -Y 顺着光柱往下
  beamGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), beamDirection.clone().negate());
  root.add(beamGroup);

  const beamUniforms = {
    uColor: { value: new THREE.Color(0xffb877) },
    uTime: { value: 0 },
    uIntensity: { value: 0.5 },
  };
  const beamMaterial = new THREE.ShaderMaterial({
    uniforms: beamUniforms,
    vertexShader: BEAM_VERT,
    fragmentShader: BEAM_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendEquation: THREE.AddEquation,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(BEAM_R_TOP, BEAM_R_BOTTOM, beamLength, 28, 1, true),
    beamMaterial,
  );
  beam.name = 'light-beam';
  beam.position.y = -beamLength / 2;
  beam.renderOrder = 10;
  beamGroup.add(beam);

  // 尘埃
  const dustGeometry = new THREE.BufferGeometry();
  const dustPositions = new Float32Array(dustCount * 3);
  const dustPhases = new Float32Array(dustCount);
  const dustSizes = new Float32Array(dustCount);
  const dustSpeeds = new Float32Array(dustCount);
  const dustRandom = makeRandom(90210);
  for (let i = 0; i < dustCount; i += 1) {
    const fall = dustRandom();
    const maxR = THREE.MathUtils.lerp(BEAM_R_TOP, BEAM_R_BOTTOM, fall) * 0.92;
    const radius = Math.sqrt(dustRandom()) * maxR;
    const angle = dustRandom() * Math.PI * 2;
    dustPositions[i * 3] = Math.cos(angle) * radius;
    dustPositions[i * 3 + 1] = 0;
    dustPositions[i * 3 + 2] = Math.sin(angle) * radius;
    dustPhases[i] = dustRandom();
    dustSizes[i] = 0.004 + dustRandom() * 0.011;
    dustSpeeds[i] = 0.012 + dustRandom() * 0.035;
  }
  dustGeometry.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3));
  dustGeometry.setAttribute('aPhase', new THREE.BufferAttribute(dustPhases, 1));
  dustGeometry.setAttribute('aSize', new THREE.BufferAttribute(dustSizes, 1));
  dustGeometry.setAttribute('aSpeed', new THREE.BufferAttribute(dustSpeeds, 1));

  const dustUniforms = {
    uTime: { value: 0 },
    uScale: { value: 600 },
    uLength: { value: beamLength },
    uRTop: { value: BEAM_R_TOP },
    uRBottom: { value: BEAM_R_BOTTOM },
    uOpacity: { value: 0.9 },
    uLevel: { value: 0.4 },
    uColor: { value: new THREE.Color(0xffd6a5) },
  };
  const dustMaterial = new THREE.ShaderMaterial({
    uniforms: dustUniforms,
    vertexShader: DUST_VERT,
    fragmentShader: DUST_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendEquation: THREE.AddEquation,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  const dust = new THREE.Points(dustGeometry, dustMaterial);
  dust.name = 'shaft-dust';
  dust.frustumCulled = false;
  dust.renderOrder = 12;
  beamGroup.add(dust);

  // 地面上的光池
  const poolMaterial = new THREE.MeshBasicMaterial({
    map: glowTexture,
    color: 0xffb877,
    transparent: true,
    opacity: 0.4,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  const lightPool = new THREE.Mesh(new THREE.CircleGeometry(1.5, 48), poolMaterial);
  lightPool.name = 'light-pool';
  lightPool.rotation.x = -Math.PI / 2;
  lightPool.position.set(POOL_X, 0.012, POOL_Z);
  lightPool.renderOrder = 5;
  root.add(lightPool);

  /* ---------------- 钢琴 ---------------- */

  const piano = new THREE.Group();
  piano.name = 'upright-piano';
  piano.position.set(PIANO_X, 0, PIANO_Z);
  root.add(piano);

  const addBox = (
    parent: THREE.Object3D,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    material: THREE.Material,
    name: string,
  ): THREE.Mesh => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = name;
    parent.add(mesh);
    return mesh;
  };

  // 侧板、背板、底板
  addBox(piano, 0.05, PIANO_HEIGHT, 0.47, -0.735, PIANO_HEIGHT / 2, -0.075, woodMaterial, 'piano-side-l');
  addBox(piano, 0.05, PIANO_HEIGHT, 0.47, 0.735, PIANO_HEIGHT / 2, -0.075, woodMaterial, 'piano-side-r');
  addBox(piano, 1.47, PIANO_HEIGHT, 0.04, 0, PIANO_HEIGHT / 2, -0.29, woodDarkMaterial, 'piano-back');
  addBox(piano, 1.47, 0.05, 0.47, 0, 0.025, -0.075, woodDarkMaterial, 'piano-bottom');
  // 上下前板
  addBox(piano, 1.42, 0.66, 0.035, 0, 0.36, 0.142, woodMaterial, 'piano-front-lower');
  addBox(piano, 1.42, 0.46, 0.035, 0, 0.985, 0.142, woodMaterial, 'piano-front-upper');
  // 键盘托板与前挡条
  addBox(piano, 1.44, 0.02, 0.18, 0, 0.7075, 0.235, woodDarkMaterial, 'piano-keybed');
  addBox(piano, 1.44, 0.028, 0.05, 0, 0.6955, 0.332, woodDarkMaterial, 'piano-key-slip');
  // 谱架
  const musicDesk = addBox(piano, 0.62, 0.2, 0.014, 0, 0.875, 0.178, woodMaterial, 'piano-music-desk');
  musicDesk.rotation.x = 0.3;
  // 黄铜铭牌
  const plate = addBox(piano, 0.16, 0.03, 0.005, 0, 0.5, 0.163, brassDullMaterial, 'piano-plate');
  plate.rotation.x = -0.06;
  // 琴盖（可开合）：支点在后沿
  const lidPivot = new THREE.Group();
  lidPivot.name = 'piano-lid-pivot';
  lidPivot.position.set(0, PIANO_HEIGHT, -0.32);
  piano.add(lidPivot);
  addBox(lidPivot, 1.54, 0.035, 0.49, 0, 0.0175, 0.245, woodMaterial, 'piano-lid');

  // 黄铜拨杆（可抓取）
  const lever = new THREE.Group();
  lever.name = 'brass-lever';
  lever.position.set(0.44, 0.03, 0.42);
  lever.userData.pinchable = true;
  lidPivot.add(lever);
  const leverStem = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.013, 0.085, 12), brassLeverMaterial);
  leverStem.position.y = 0.042;
  leverStem.rotation.x = -0.22;
  leverStem.castShadow = true;
  lever.add(leverStem);
  const leverKnob = new THREE.Mesh(new THREE.SphereGeometry(0.021, 16, 12), brassLeverMaterial);
  leverKnob.position.set(0, 0.086, 0.018);
  leverKnob.castShadow = true;
  lever.add(leverKnob);
  // 拨杆底座
  const leverBase = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.032, 0.014, 16), brassMaterial);
  leverBase.position.y = 0.004;
  lever.add(leverBase);

  // 琴盖的刚体（运动学位置驱动）
  const lidBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(PIANO_X, PIANO_HEIGHT, PIANO_Z - 0.32),
  );
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(0.77, 0.018, 0.245)
      .setTranslation(0, 0.0175, 0.245)
      .setCollisionGroups(GROUP_SCENERY),
    lidBody,
  );

  // 琴体（固定刚体，琴键的关节挂在这里）
  const cabinetBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(PIANO_X, PIANO_HEIGHT / 2, PIANO_Z - 0.075),
  );
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(0.74, PIANO_HEIGHT / 2, 0.235).setCollisionGroups(GROUP_SCENERY),
    cabinetBody,
  );

  /* ---------------- 琴键 ---------------- */

  const layout = buildKeyboard();
  const whiteGeometry = new THREE.BoxGeometry(WHITE_W, WHITE_H, WHITE_L);
  whiteGeometry.translate(0, WHITE_H / 2, WHITE_L / 2);
  const blackGeometry = new THREE.BoxGeometry(BLACK_W, BLACK_H, BLACK_L);
  blackGeometry.translate(0, BLACK_H / 2, BLACK_L / 2);

  const keys: KeyState[] = [];
  const interactive: THREE.Object3D[] = [];

  // 参考白键的转动惯量（绕 X 轴）。
  const referenceMass = 1600 * WHITE_W * WHITE_H * WHITE_L;
  const referenceInertia = (referenceMass * (WHITE_H * WHITE_H + WHITE_L * WHITE_L)) / 12;

  for (const item of layout) {
    const pivotY = item.black ? WHITE_TOP_Y : PIVOT_Y;
    const pivotZ = item.black ? BLACK_PIVOT_Z : WHITE_PIVOT_Z;
    const width = item.black ? BLACK_W : WHITE_W;
    const height = item.black ? BLACK_H : WHITE_H;
    const length = item.black ? BLACK_L : WHITE_L;

    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(PIANO_X + item.x, pivotY, PIANO_Z + pivotZ)
        .setLinearDamping(0.6)
        .setAngularDamping(1.2),
    );
    // 碰撞盒以支点为中心：重心正好落在平衡点上，琴键自然平躺。
    const mass = 1600 * width * height * length;
    const inertia = (mass * (height * height + length * length)) / 12;
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(width / 2, height / 2, length / 2)
        .setDensity(1600)
        .setFriction(0.6)
        .setRestitution(0.02)
        .setCollisionGroups(item.black ? GROUP_BLACK : GROUP_WHITE),
      body,
    );
    world.createImpulseJoint(
      RAPIER.JointData.revolute(
        { x: item.x, y: pivotY - PIANO_HEIGHT / 2, z: pivotZ + 0.075 },
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 0, z: 0 },
      ),
      cabinetBody,
      body,
      true,
    );

    const mesh = new THREE.Mesh(item.black ? blackGeometry : whiteGeometry, item.black ? ebonyMaterial : ivoryMaterial);
    mesh.name = item.black ? 'piano-key-black' : 'piano-key-white';
    mesh.position.set(item.x, pivotY, pivotZ);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.pinchable = true;
    mesh.userData.keyIndex = keys.length;
    piano.add(mesh);
    interactive.push(mesh);

    keys.push({
      layout: item,
      mesh,
      body,
      pivotY,
      pivotZ,
      centerZ: pivotZ + length / 2,
      topY: pivotY + height,
      halfW: width / 2,
      halfL: length / 2,
      scale: inertia / referenceInertia,
      held: false,
      active: false,
      glow: null,
      glowMaterial: null,
      glowLife: 0,
    });
  }
  interactive.push(lever);

  /* ---------------- 落石 ---------------- */

  const rubble: RubblePiece[] = [];
  const rubbleGroup = new THREE.Group();
  rubbleGroup.name = 'rubble';
  root.add(rubbleGroup);

  const rubbleRandom = makeRandom(31415);
  for (let i = 0; i < rubbleCount; i += 1) {
    const radius = 0.07 + rubbleRandom() * 0.16;
    const geometry = new THREE.IcosahedronGeometry(radius, 0);
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    const vertices = new Float32Array(position.array.length);
    for (let v = 0; v < position.count; v += 1) {
      const k = 0.72 + rubbleRandom() * 0.55;
      const x = position.getX(v) * k;
      const y = position.getY(v) * k;
      const z = position.getZ(v) * k;
      position.setXYZ(v, x, y, z);
      vertices[v * 3] = x;
      vertices[v * 3 + 1] = y;
      vertices[v * 3 + 2] = z;
    }
    geometry.computeVertexNormals();

    const side = rubbleRandom();
    let x: number;
    let z: number;
    if (side < 0.45) {
      x = -2.4 + rubbleRandom() * 1.1;
      z = -2.5 + rubbleRandom() * 1.2;
    } else if (side < 0.8) {
      x = 1.6 + rubbleRandom() * 0.7;
      z = -2.4 + rubbleRandom() * 1.0;
    } else {
      x = -2.5 + rubbleRandom() * 0.9;
      z = 0.6 + rubbleRandom() * 1.0;
    }
    const dropY = 0.55 + rubbleRandom() * 1.1;

    const mesh = new THREE.Mesh(geometry, stoneMaterial);
    mesh.name = 'rubble-stone';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    rubbleGroup.add(mesh);

    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, dropY, z)
        .setRotation(quaternionFromEuler(rubbleRandom() * 3, rubbleRandom() * 3, rubbleRandom() * 3))
        .setLinearDamping(0.35)
        .setAngularDamping(0.55),
    );
    const hull = RAPIER.ColliderDesc.convexHull(vertices);
    const colliderDesc = hull ?? RAPIER.ColliderDesc.ball(radius * 0.86);
    world.createCollider(colliderDesc.setFriction(0.85).setRestitution(0.12).setCollisionGroups(GROUP_SCENERY), body);

    rubble.push({ mesh, body, mass: body.mass() });
  }

  /* ---------------- 灯光 ---------------- */

  const sun = new THREE.DirectionalLight(0xffb271, 3.1);
  sun.name = 'dusk-sun';
  sun.position.copy(beamEnd).addScaledVector(beamDirection, -11);
  sun.target.position.copy(beamEnd);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 24;
  sun.shadow.camera.left = -4.5;
  sun.shadow.camera.right = 4.5;
  sun.shadow.camera.top = 4.5;
  sun.shadow.camera.bottom = -4.5;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.022;
  root.add(sun, sun.target);

  const fill = new THREE.HemisphereLight(0x7d93c4, 0x3a2b1e, 0.85);
  fill.name = 'ruin-fill';
  root.add(fill);

  // 地面光池反射回来的暖光，让钢琴正面不至于全黑
  const bounce = new THREE.DirectionalLight(0xffc089, 0.55);
  bounce.name = 'ruin-bounce';
  bounce.position.set(2.4, 0.9, 3.4);
  bounce.target.position.set(PIANO_X, 0.7, PIANO_Z);
  root.add(bounce, bounce.target);

  const studio = ctx.env.createStudioLights();
  studio.traverse((child) => {
    const light = child as THREE.DirectionalLight;
    if (light.isLight) {
      light.intensity *= 0.22;
      light.castShadow = false;
    }
  });
  root.add(studio);

  // 琴键共鸣的暖光
  const resonanceLight = new THREE.PointLight(0xffc27a, 0, 1.4, 2);
  resonanceLight.name = 'resonance-light';
  resonanceLight.position.set(PIANO_X, 0.8, PIANO_Z + 0.24);
  root.add(resonanceLight);

  /* ---------------- 声音 ---------------- */

  const synth = new PianoSynth(ctx.listener.context, { volume: 0.42 });
  const breath = createBreathSample();

  /* ---------------- 交互 ---------------- */

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const tmpVector = new THREE.Vector3();
  const tmpVectorB = new THREE.Vector3();
  const heldByPointer = new Set<number>();

  /** 打开 / 合上琴盖。 */
  let lidOpen = false;
  let lidAngle = 0;

  /** 找到离给定点最近的琴键（点为琴体局部坐标）。 */
  const findKey = (localX: number, localY: number, localZ: number): KeyState | null => {
    let best: KeyState | null = null;
    let bestScore = Infinity;
    for (const key of keys) {
      // 命中点必须落在键的高度范围内（白键顶 = 黑键底，靠 x/z 区分）
      if (localY < key.pivotY - 0.003 || localY > key.topY + 0.006) continue;
      const dx = Math.abs(localX - key.layout.x) / key.halfW;
      const dz = Math.abs(localZ - key.centerZ) / key.halfL;
      if (dx > 1.6 || dz > 0.95) continue;
      const score = dx * dx + dz * dz;
      if (score < bestScore) {
        bestScore = score;
        best = key;
      }
    }
    return best;
  };

  /** 按下琴键：给前端施加冲量，并持续按压。 */
  const pressKey = (key: KeyState): void => {
    if (key.held) return;
    key.held = true;
    key.active = true;
    const impulse = PRESS_IMPULSE * key.scale;
    key.body.applyImpulseAtPoint(
      { x: 0, y: -impulse, z: 0 },
      { x: PIANO_X + key.layout.x, y: key.topY, z: PIANO_Z + key.pivotZ + key.halfL * 1.64 },
      true,
    );
    synth.press(key.layout.midi, 0.75 + key.scale * 0.25);

    // 首次按下时创建共鸣辉光
    if (!key.glow) {
      const material = new THREE.MeshBasicMaterial({
        map: glowTexture,
        color: 0xffc98a,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      });
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
      glow.rotation.x = -Math.PI / 2;
      glow.position.set(key.layout.x, key.topY + 0.002, key.centerZ);
      glow.scale.set(key.halfW * 4.4, key.halfL * 2.6, 1);
      glow.renderOrder = 8;
      piano.add(glow);
      key.glow = glow;
      key.glowMaterial = material;
    }
    key.glowLife = 1;
  };

  /** 松开琴键：弹簧把它顶回原位，声音也随之收住。 */
  const releaseKey = (key: KeyState): void => {
    if (!key.held) return;
    key.held = false;
    synth.release(key.layout.midi);
  };

  const releaseAll = (): void => {
    for (const key of keys) releaseKey(key);
    heldByPointer.clear();
  };

  /* ---------------- 网页端的点击 / 拖拽 ---------------- */

  const canvas = ctx.renderer.domElement;

  const handlePointerDown = (event: PointerEvent): void => {
    if (ctx.isXR) return;
    const rect = canvas.getBoundingClientRect();
    ndc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(interactive, true);
    if (!hits.length) return;

    const object = hits[0].object as THREE.Object3D;
    if (object === lever || object.parent === lever) {
      lidOpen = !lidOpen;
      return;
    }
    const index = object.userData.keyIndex as number | undefined;
    if (index === undefined) return;
    const key = keys[index];
    heldByPointer.add(index);
    pressKey(key);
  };

  const handlePointerUp = (): void => {
    for (const index of heldByPointer) {
      const key = keys[index];
      if (key) releaseKey(key);
    }
    heldByPointer.clear();
  };

  canvas.addEventListener('pointerdown', handlePointerDown);
  window.addEventListener('pointerup', handlePointerUp);

  /* ---------------- 音频提示 ---------------- */

  let audioHint: HTMLElement | null = null;

  const ensureAudioHint = (): void => {
    if (audioHint || synth.ready) return;
    const element = document.createElement('div');
    element.textContent = '点击画面开启声音';
    element.style.cssText =
      'position:fixed;left:50%;bottom:34px;transform:translateX(-50%);z-index:40;' +
      'padding:8px 16px;border-radius:999px;background:rgba(12,10,14,.74);color:#e9d6b4;' +
      'border:1px solid rgba(233,214,180,.26);font:500 13px/1.5 ui-sans-serif,-apple-system,"PingFang SC",sans-serif;' +
      'backdrop-filter:blur(10px);pointer-events:none;transition:opacity .6s ease;';
    document.body.appendChild(element);
    audioHint = element;
  };

  const removeAudioHint = (): void => {
    if (!audioHint) return;
    audioHint.remove();
    audioHint = null;
  };

  /* ---------------- 每帧更新用的临时量 ---------------- */

  let accumulator = 0;
  let smoothedLevel = 0;
  let smoothedBass = 0;
  let heldCount = 0;

  // 物理调用用的临时量：全部预分配，update 里不再新建对象。
  const tmpImpulse = { x: 0, y: 0, z: 0 };
  const tmpPoint = { x: 0, y: 0, z: 0 };
  const tmpTorque = { x: 0, y: 0, z: 0 };
  const tmpRotation = { x: 0, y: 0, z: 0, w: 1 };

  return {
    root,
    camera,
    framing: { distance: 3.0, height: 1.32, targetY: 0.78, width: 2.35 },

    update(time: number, delta: number, context: SceneContext): void {
      const audio = context.audio;

      // 有音乐时跟随音乐，没有音乐时跟随场景声明的呼吸节奏。
      sampleBreath(BREATHING, time, breath);
      const pulse = audio.active ? audio.pulse : breath.level;
      const level = audio.active ? audio.level : 0.22 + breath.level * 0.34;
      const bass = audio.active ? audio.bass : 0.12 + breath.level * 0.2;

      smoothedLevel += (level - smoothedLevel) * Math.min(1, delta * 6);
      smoothedBass += (bass - smoothedBass) * Math.min(1, delta * 5);

      /* ── 固定步长推进物理 ─────────────────────────────────────────── */
      // 复位弹簧：每帧算一次（力矩会一直保留到下一次重置），
      // 只处理还在运动的键，这样绝大多数帧不会新建任何对象。
      for (const key of keys) {
        if (!key.active) continue;
        const body = key.body;
        const rotation = body.rotation();
        const angle = 2 * Math.atan2(rotation.x, rotation.w);
        const velocity = body.angvel();
        if (!key.held && Math.abs(angle) <= ANGLE_EPS && Math.abs(velocity.x) <= OMEGA_EPS) {
          key.active = false;
          continue;
        }
        body.resetTorques(true);
        tmpTorque.x = -SPRING_K * key.scale * angle - SPRING_C * key.scale * velocity.x;
        tmpTorque.y = 0;
        tmpTorque.z = 0;
        body.addTorque(tmpTorque, true);
      }

      accumulator += Math.min(delta, 0.05);
      let steps = 0;
      while (accumulator >= FIXED_STEP && steps < MAX_SUBSTEPS) {
        accumulator -= FIXED_STEP;
        steps += 1;

        // 琴盖（运动学刚体）
        const lidTarget = lidOpen ? LID_MAX_ANGLE : 0;
        lidAngle += (lidTarget - lidAngle) * Math.min(1, FIXED_STEP * 4.2);
        const half = -lidAngle / 2;
        tmpRotation.x = Math.sin(half);
        tmpRotation.y = 0;
        tmpRotation.z = 0;
        tmpRotation.w = Math.cos(half);
        lidBody.setNextKinematicRotation(tmpRotation);

        // 琴键：按住时每步补一次等效冲量，模拟手指一直压着
        for (const key of keys) {
          if (!key.held) continue;
          tmpImpulse.x = 0;
          tmpImpulse.y = -HOLD_IMPULSE * key.scale;
          tmpImpulse.z = 0;
          tmpPoint.x = PIANO_X + key.layout.x;
          tmpPoint.y = key.topY;
          tmpPoint.z = PIANO_Z + key.pivotZ + key.halfL * 1.64;
          key.body.applyImpulseAtPoint(tmpImpulse, tmpPoint, true);
        }

        world.step();
      }

      /* ── 刚体 → 网格 ─────────────────────────────────────────────── */
      // 只有还在运动的键需要同步，静止的键保持原位即可。
      for (const key of keys) {
        if (!key.active) continue;
        const translation = key.body.translation();
        const rotation = key.body.rotation();
        key.mesh.position.set(translation.x - PIANO_X, translation.y, translation.z - PIANO_Z);
        key.mesh.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
      }

      for (const piece of rubble) {
        if (piece.body.isSleeping()) continue;
        const translation = piece.body.translation();
        const rotation = piece.body.rotation();
        piece.mesh.position.set(translation.x, translation.y, translation.z);
        piece.mesh.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
      }

      /* ── 音乐 → 废墟的低频震动 ───────────────────────────────────── */
      if (smoothedBass > 0.16) {
        for (const piece of rubble) {
          tmpImpulse.x = (Math.random() - 0.5) * smoothedBass * 0.0004 * piece.mass;
          tmpImpulse.y = smoothedBass * 0.0006 * piece.mass;
          tmpImpulse.z = 0;
          piece.body.applyImpulse(tmpImpulse, true);
        }
        rubbleGroup.position.y = Math.sin(time * 31) * smoothedBass * 0.0035;
        walls.position.y = Math.sin(time * 27 + 1.3) * smoothedBass * 0.0022;
      } else {
        rubbleGroup.position.y = 0;
        walls.position.y = 0;
      }

      /* ── 音乐 → 光柱、尘埃、辉光 ─────────────────────────────────── */
      const shimmer = 0.75 + pulse * 0.55;
      backdrop.uniforms.uTime.value = time;
      backdrop.uniforms.uBreath.value = breath.level;
      beamUniforms.uTime.value = time;
      beamUniforms.uIntensity.value = (0.17 + smoothedLevel * 0.26) * shimmer;

      dustUniforms.uTime.value = time;
      dustUniforms.uLevel.value = 0.22 + smoothedLevel * 0.55;
      const dustScale = (context.height * 0.5 * context.renderer.getPixelRatio()) / Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
      dustUniforms.uScale.value = dustScale;

      poolMaterial.opacity = 0.28 + smoothedLevel * 0.34;
      sunGlowMaterial.opacity = 0.42 + smoothedLevel * 0.26;

      /* ── 琴键共鸣微光 ─────────────────────────────────────────────── */
      heldCount = 0;
      for (const key of keys) {
        if (key.held) heldCount += 1;
        if (!key.glow || !key.glowMaterial) continue;
        const target = key.held ? 1 : 0;
        key.glowLife += (target - key.glowLife) * Math.min(1, delta * (key.held ? 14 : 3.2));
        const life = key.glowLife;
        key.glowMaterial.opacity = life * (0.28 + pulse * 0.72);
        const spread = 1 + (1 - life) * 1.35;
        key.glow.scale.set(key.halfW * 4.4 * spread, key.halfL * 2.6 * spread, 1);
      }

      // 最近被按下的琴键上的一盏暖光
      if (heldCount > 0) {
        let latest: KeyState | null = null;
        for (const key of keys) {
          if (key.held) latest = key;
        }
        if (latest) {
          resonanceLight.position.set(PIANO_X + latest.layout.x, latest.topY + 0.05, PIANO_Z + latest.centerZ);
          resonanceLight.intensity = 0.18 + pulse * 0.9;
        }
      } else {
        resonanceLight.intensity *= 0.9;
      }

      /* ── 琴盖 ─────────────────────────────────────────────────────── */
      lidPivot.rotation.x = -lidAngle;
      brassLeverMaterial.emissiveIntensity = 0.55 + (lidOpen ? 0.9 : 0.25) + pulse * 0.4;

      /* ── 音频 housekeeping ────────────────────────────────────────── */
      synth.update();
      if (synth.ready) removeAudioHint();
      else if (heldCount > 0) ensureAudioHint();
    },

    onPinch(info: PinchInfo): void {
      if (info.phase === 'start') {
        if (!info.hit) return;
        root.updateWorldMatrix(true, true);

        // 拨杆：掀开 / 合上琴盖
        lever.getWorldPosition(tmpVector);
        tmpVectorB.copy(info.point);
        root.localToWorld(tmpVectorB);
        if (tmpVector.distanceTo(tmpVectorB) < 0.22) {
          lidOpen = !lidOpen;
          return;
        }

        // 琴键：找离命中点最近的一个
        const localX = info.point.x - PIANO_X;
        const localY = info.point.y;
        const localZ = info.point.z - PIANO_Z;
        const key = findKey(localX, localY, localZ);
        if (key) pressKey(key);
        return;
      }

      if (info.phase === 'end') {
        releaseAll();
      }
    },

    dispose(): void {
      canvas.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('pointerup', handlePointerUp);
      removeAudioHint();
      synth.dispose();
      disposeObject(root);
      floorTexture.dispose();
      stoneTexture.dispose();
      skyTexture.dispose();
      glowTexture.dispose();
      world.free();
    },
  };
}

/** 由三个欧拉角生成四元数（落石用）。 */
function quaternionFromEuler(x: number, y: number, z: number): Rotation {
  const halfX = x / 2;
  const halfY = y / 2;
  const halfZ = z / 2;
  const sx = Math.sin(halfX);
  const cx = Math.cos(halfX);
  const sy = Math.sin(halfY);
  const cy = Math.cos(halfY);
  const sz = Math.sin(halfZ);
  const cz = Math.cos(halfZ);
  return {
    x: sx * cy * cz - cx * sy * sz,
    y: cx * sy * cz + sx * cy * sz,
    z: cx * cy * sz - sx * sy * cz,
    w: cx * cy * cz + sx * sy * sz,
  };
}

export const pianoRuinsScene: SceneDefinition = {
  id: 'piano-ruins',
  title: '废墟里的钢琴',
  subtitle: 'Piano in Ruins',
  description: '半塌的石屋里立着一架老立式钢琴，琴键是真正的刚体，弹下去会响，黄昏的光柱里全是灰。',
  tags: ['物理', '可交互', '声音'],
  accent: '#e8b06a',
  gradient: ['#4a2f1c', '#120c0a'],
  category: 'simulation',
  audio: 'enigma-monastery.mp3',
  breathing: { inhale: 6, hold: 2, exhale: 8 },
  lighting: {
    autoExposure: true,
    autoExposureKey: 0.12,
    softShadows: 0.5,
  },
  create(ctx: SceneContext): Promise<SceneInstance> {
    return createPianoRuins(ctx);
  },
};

export default pianoRuinsScene;
