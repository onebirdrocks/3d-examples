import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

import type { SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { disposeObject } from '../../core/loader.js';
import { mulberry32 } from './lib/math.js';
import { createRadialTexture } from './lib/scene-kit.js';
import { GLSL_HASH, GLSL_NOISE } from './lib/noise.js';
import { GLSL_OUTPUT, GLSL_OUTPUT_FUNCS } from './lib/glsl-output.js';

/**
 * 霓虹雨夜 · 渲染管线 / Neon Pipeline
 *
 * 展示 three 的后处理栈：RenderPass → UnrealBloomPass → 自写调色 ShaderPass → OutputPass。
 *
 * 场景本体是一条程序化的霓虹雨夜街道：两侧楼体剪影 + 亮着窗的立面 + 霓虹招牌面片 +
 * 湿地面反光 + 雨丝。招牌与地面的倒影都用自发光材质（颜色可以大于 1），
 * 因此在网页模式下会被 UnrealBloomPass 抓成辉光。
 *
 * XR 说明：three 的 EffectComposer 在立体渲染下会先渲单目再复制到双眼，
 * 做不出正确的 XR 景深/色差，因此 XR 模式（ctx.isXR）完全不走 composer，
 * 改用材质层面的近似：招牌自发光强度拉高 + 场景内自绘的辉光面片。
 *
 * 音乐驱动：
 * - level  → 辉光强度、招牌亮度、雨丝亮度；
 * - bass  → 色差强度、低频震颤；
 * - treble→ 胶片颗粒密度；
 * - pulse → 雨势、雨丝速度、霓虹呼吸亮度。
 */

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

const FOV = 54;
const BREATHING = { inhale: 6, hold: 2, exhale: 8 };
const SIGN_COUNT = 8;
const HAZE_COLOR = 0x070c16;
/** 招牌所在的墙面位置（沿 X 轴）。 */
const SIGN_X = 8.2;
/** 楼体内侧墙面位置。 */
const WALL_X = 10.4;
/** 湿地面（含人行道）的半宽。 */
const ROAD_HALF = 10.4;
/** 路缘位置。 */
const CURB_X = 6.2;

/* ------------------------------------------------------------------ *
 * 贴图
 * ------------------------------------------------------------------ */

/** 一块霓虹灯管招牌：白色描边 + 内部笔画，画在透明画布上。 */
function createNeonSignTexture(seed: number, vertical: boolean): THREE.CanvasTexture {
  const width = vertical ? 192 : 768;
  const height = vertical ? 768 : 192;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');

  const random = mulberry32(seed);
  ctx.clearRect(0, 0, width, height);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#ffffff';
  ctx.shadowColor = 'rgba(255,255,255,0.95)';

  const tube = (path: () => void, blur: number, lineWidth: number): void => {
    ctx.shadowBlur = blur;
    ctx.lineWidth = lineWidth;
    path();
    ctx.stroke();
  };

  if (vertical) {
    // 竖招牌：外框 + 2~4 个抽象笔画
    const pad = width * 0.16;
    tube(() => {
      ctx.beginPath();
      ctx.roundRect(pad, pad, width - pad * 2, height - pad * 2, width * 0.1);
    }, 26, width * 0.055);

    const cells = 2 + Math.floor(random() * 3);
    const cell = (height - pad * 2.4) / cells;
    for (let i = 0; i < cells; i += 1) {
      const top = pad * 1.2 + i * cell;
      const strokes = 2 + Math.floor(random() * 3);
      for (let s = 0; s < strokes; s += 1) {
        const x = pad * 1.6 + random() * (width - pad * 3.2);
        const y0 = top + cell * 0.15;
        const y1 = top + cell * (0.45 + random() * 0.45);
        const w = width * 0.1;
        tube(() => {
          ctx.beginPath();
          ctx.moveTo(x, y0);
          ctx.lineTo(x + (random() - 0.5) * w, y1);
        }, 16, width * 0.05);
      }
    }
  } else {
    // 横招牌：一条主横线 + 竖笔画（像一行字）
    const midY = height * 0.5;
    tube(() => {
      ctx.beginPath();
      ctx.moveTo(width * 0.06, midY);
      ctx.lineTo(width * 0.94, midY);
    }, 24, height * 0.075);

    const strokes = 4 + Math.floor(random() * 4);
    for (let i = 0; i < strokes; i += 1) {
      const x = width * (0.14 + (i / strokes) * 0.72);
      const top = midY - height * (0.16 + random() * 0.16);
      const bottom = midY + height * (0.14 + random() * 0.18);
      tube(() => {
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x + (random() - 0.5) * height * 0.16, bottom);
      }, 14, height * 0.06);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'neon-sign';
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

/** 楼体立面：暗色墙面 + 亮着的窗（作为自发光贴图）。 */
function createFacadeTextures(seed: number): { map: THREE.CanvasTexture; emissive: THREE.CanvasTexture } {
  const size = 512;
  const random = mulberry32(seed);

  const base = document.createElement('canvas');
  base.width = size;
  base.height = size;
  const baseCtx = base.getContext('2d');
  if (!baseCtx) throw new Error('无法创建 2D 画布上下文');

  const glow = document.createElement('canvas');
  glow.width = size;
  glow.height = size;
  const glowCtx = glow.getContext('2d');
  if (!glowCtx) throw new Error('无法创建 2D 画布上下文');

  baseCtx.fillStyle = '#0a0d14';
  baseCtx.fillRect(0, 0, size, size);
  glowCtx.fillStyle = '#000000';
  glowCtx.fillRect(0, 0, size, size);

  // 墙面分格
  const cols = 6;
  const rows = 9;
  const cellW = size / cols;
  const cellH = size / rows;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const shade = 12 + Math.floor(random() * 10);
      baseCtx.fillStyle = `rgb(${shade},${shade + 2},${shade + 8})`;
      baseCtx.fillRect(c * cellW + 2, r * cellH + 2, cellW - 4, cellH - 4);

      // 窗
      const wx = c * cellW + cellW * 0.24;
      const wy = r * cellH + cellH * 0.22;
      const ww = cellW * 0.5;
      const wh = cellH * 0.5;
      baseCtx.fillStyle = '#05070c';
      baseCtx.fillRect(wx, wy, ww, wh);

      const roll = random();
      if (roll > 0.52) {
        const warm = random();
        const bright = 0.35 + random() * 0.65;
        const r0 = Math.round(255 * bright * (0.75 + warm * 0.25));
        const g0 = Math.round(255 * bright * (0.62 + warm * 0.2));
        const b0 = Math.round(255 * bright * (0.45 + warm * 0.1));
        glowCtx.fillStyle = `rgb(${r0},${g0},${b0})`;
        glowCtx.fillRect(wx, wy, ww, wh);
        // 窗框
        baseCtx.strokeStyle = 'rgba(4,5,9,0.95)';
        baseCtx.lineWidth = Math.max(1, size / 320);
        baseCtx.strokeRect(wx, wy, ww, wh);
      }
    }
  }

  const map = new THREE.CanvasTexture(base);
  map.name = 'facade';
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  map.needsUpdate = true;

  const emissive = new THREE.CanvasTexture(glow);
  emissive.name = 'facade-emissive';
  emissive.wrapS = THREE.RepeatWrapping;
  emissive.wrapT = THREE.RepeatWrapping;
  emissive.colorSpace = THREE.SRGBColorSpace;
  emissive.anisotropy = 4;
  emissive.needsUpdate = true;

  return { map, emissive };
}

/* ------------------------------------------------------------------ *
 * 着色器
 * ------------------------------------------------------------------ */

const WORLD_VERT = /* glsl */ `
varying vec3 vWorldPos;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

/** 湿地面：沥青 + 积水 + 霓虹倒影 + 涟漪 + 距离雾。 */
const ROAD_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uWet;
uniform float uCurbX;
uniform vec3 uFog;
uniform vec3 uSignColor[${SIGN_COUNT}];
uniform vec4 uSignSpot[${SIGN_COUNT}];  // xy = 位置, z = 半宽, w = 倒影长度
uniform float uSignPower[${SIGN_COUNT}];
uniform vec2 uRipples[4];

varying vec3 vWorldPos;

${GLSL_HASH}
${GLSL_NOISE}
${GLSL_OUTPUT_FUNCS}

void main() {
  vec2 p = vWorldPos.xz;

  // 积水遮罩
  float wet = smoothstep(0.28, 0.74, fbm2oct(p * 0.26, 3)) * uWet;

  // 沥青底色（人行道区域偏灰、偏干）
  float onWalk = smoothstep(uCurbX - 0.25, uCurbX + 0.25, abs(p.x));
  vec3 col = mix(vec3(0.010, 0.013, 0.021), vec3(0.021, 0.022, 0.026), onWalk);
  col *= 1.0 - wet * 0.55 * (1.0 - onWalk * 0.45);

  // 霓虹在湿地上的竖直倒影
  vec3 reflection = vec3(0.0);
  for (int i = 0; i < ${SIGN_COUNT}; i++) {
    vec2 d = p - uSignSpot[i].xy;
    float w = max(uSignSpot[i].z, 0.05);
    float lateral = exp(-(d.x * d.x) / (w * w * 1.7));
    float along = exp(-(d.y * d.y) / (uSignSpot[i].w * uSignSpot[i].w));
    float ripple = 0.45 + 0.95 * fbm2oct(p * 1.7 + vec2(0.0, uTime * 0.22), 2);
    reflection += uSignColor[i] * lateral * along * ripple * uSignPower[i];
  }
  col += reflection * (0.22 + wet * 0.85);

  // 雨滴打出的同心涟漪
  float rings = 0.0;
  for (int i = 0; i < 4; i++) {
    float phase = fract(uTime * 0.45 + float(i) * 0.31);
    float radius = phase * 1.9;
    float d = distance(p, uRipples[i]);
    rings += smoothstep(0.14, 0.0, abs(d - radius)) * (1.0 - phase);
  }
  col += vec3(0.30, 0.40, 0.52) * rings * wet * 0.16;

  // 远处雾霭
  float dist = length(vWorldPos - cameraPosition);
  col = mix(col, uFog, 1.0 - exp(-dist * 0.042));

  gl_FragColor = vec4(col, 1.0);
  ${GLSL_OUTPUT}
}
`;

/** 霓虹招牌面片（自发光，可大于 1）。 */
const SIGN_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorldPos;

void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SIGN_FRAG = /* glsl */ `
precision highp float;

uniform sampler2D uMap;
uniform vec3 uColor;
uniform float uIntensity;
uniform float uFade;

varying vec2 vUv;
varying vec3 vWorldPos;

${GLSL_OUTPUT_FUNCS}

void main() {
  vec4 tex = texture2D(uMap, vUv);
  float dist = length(vWorldPos - cameraPosition);
  float atten = 1.0 - smoothstep(16.0, 52.0, dist);
  float a = tex.a * mix(1.0, atten, uFade);
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor * uIntensity, a);
  ${GLSL_OUTPUT}
}
`;

/** 雨丝：顶点着色器里循环下落，片元只负责柔边。 */
const RAIN_VERT = /* glsl */ `
attribute float aSeed;
attribute float aEnd;
attribute vec3 aBase;

uniform float uTime;
uniform float uSpeed;
uniform float uLength;
uniform float uHeight;
uniform float uLevel;
uniform vec3 uLightPos[3];

varying float vAlpha;
varying float vLit;

void main() {
  float speed = uSpeed * (0.72 + aSeed * 0.56);
  float fall = mod(aBase.y - uTime * speed, uHeight);
  vec3 p = vec3(aBase.x, fall, aBase.z);
  // 风向：越高偏得越多
  p.x += (uHeight - fall) * 0.055;
  p.y += aEnd * uLength * (0.55 + aSeed * 0.9);

  // 灯光附近的雨丝更亮
  float lit = 0.0;
  for (int i = 0; i < 3; i++) {
    float d = distance(p, uLightPos[i]);
    lit += 1.0 / (1.0 + d * d * 0.32);
  }
  vLit = min(lit, 1.6);
  vAlpha = (1.0 - aEnd * 0.88) * uLevel;

  vec4 wp = modelMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const RAIN_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uColor;
uniform float uOpacity;

varying float vAlpha;
varying float vLit;

${GLSL_OUTPUT_FUNCS}

void main() {
  float a = vAlpha * uOpacity * (0.16 + vLit * 0.62);
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a);
  ${GLSL_OUTPUT}
}
`;

/** 远景天幕：城市光污染把低空染成暖色。 */
const SKY_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGlow;

varying vec3 vWorldPos;

${GLSL_HASH}
${GLSL_NOISE}
${GLSL_OUTPUT_FUNCS}

void main() {
  vec3 dir = normalize(vWorldPos - cameraPosition);
  float h = dir.y;
  vec3 col = mix(uHorizon, uZenith, smoothstep(-0.05, 0.62, h));

  // 低空的橙色光污染
  float band = exp(-max(h, 0.0) * 9.0) * smoothstep(-0.22, 0.02, h);
  col += uGlow * band * 0.55;

  // 云层
  float clouds = fbm2oct(vec2(atan(dir.z, dir.x) * 2.2, h * 3.4) + vec2(uTime * 0.004, 0.0), 3);
  col += vec3(0.030, 0.036, 0.055) * smoothstep(0.35, 0.9, clouds) * smoothstep(0.0, 0.5, h);

  gl_FragColor = vec4(col, 1.0);
  ${GLSL_OUTPUT}
}
`;

/** 后处理调色：色差 + 胶片颗粒 + 扫描线 + 暗角。 */
const GRADE_VERT = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const GRADE_FRAG = /* glsl */ `
precision highp float;

uniform sampler2D tDiffuse;
uniform float uTime;
uniform float uAberration;
uniform float uGrain;
uniform float uScanline;
uniform float uVignette;

varying vec2 vUv;

void main() {
  vec2 uv = vUv;
  vec2 c = uv - 0.5;
  float r2 = dot(c, c);

  // 色差：越靠边越明显
  float k = uAberration * (0.35 + r2 * 2.6);
  vec3 col;
  col.r = texture2D(tDiffuse, uv + c * k).r;
  col.g = texture2D(tDiffuse, uv).g;
  col.b = texture2D(tDiffuse, uv - c * k).b;

  // 胶片颗粒
  float n = fract(sin(dot(uv * vec2(1279.3, 719.7) + uTime * 37.0, vec2(12.9898, 78.233))) * 43758.5453);
  col += (n - 0.5) * uGrain;

  // 轻微扫描线
  float scan = 1.0 - uScanline * (0.5 + 0.5 * sin(uv.y * 860.0 + uTime * 3.0));
  col *= scan;

  // 暗角
  col *= 1.0 - uVignette * smoothstep(0.16, 0.82, r2);

  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

/* ------------------------------------------------------------------ *
 * 场景
 * ------------------------------------------------------------------ */

interface SignSpec {
  side: number;
  z: number;
  y: number;
  w: number;
  h: number;
  color: number;
  vertical: boolean;
}

const SIGN_SPECS: readonly SignSpec[] = [
  { side: -1, z: -5.5, y: 3.5, w: 0.55, h: 3.4, color: 0xff2f7a, vertical: true },
  { side: 1, z: -9.0, y: 2.9, w: 2.6, h: 0.5, color: 0x2ce8ff, vertical: false },
  { side: -1, z: -12.8, y: 4.9, w: 0.5, h: 2.4, color: 0xffb648, vertical: true },
  { side: 1, z: -16.8, y: 3.6, w: 2.0, h: 0.46, color: 0x9a6bff, vertical: false },
  { side: -1, z: -21.2, y: 2.7, w: 2.4, h: 0.46, color: 0x4dffa8, vertical: false },
  { side: 1, z: -25.8, y: 5.2, w: 0.5, h: 2.8, color: 0xff2f7a, vertical: true },
  { side: -1, z: -30.6, y: 3.8, w: 2.8, h: 0.5, color: 0x2ce8ff, vertical: false },
  { side: 1, z: -36.0, y: 3.2, w: 0.48, h: 2.6, color: 0xffe066, vertical: true },
];

interface NeonSign {
  material: THREE.ShaderMaterial;
  glow: THREE.Sprite;
  glowMaterial: THREE.SpriteMaterial;
  glowScale: number;
  light: THREE.PointLight | null;
}

function createNeonPipeline(ctx: SceneContext): SceneInstance {
  // root 用 Scene 而不是 Group：后处理链需要一个「顶层场景」，
  // 这样 RenderPass 渲染的就是它（而不是宿主场景），IBL 也由 root.environment 提供。
  const root = new THREE.Scene();
  root.name = 'neon-pipeline-scene';
  root.background = new THREE.Color(0x04060c);
  root.environment = ctx.env.envMap;

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 400);
  camera.position.set(0, 1.65, 5.2);

  const quality = THREE.MathUtils.clamp(ctx.quality, 0.4, 2);
  const random = mulberry32(20240917);

  const ownTextures: THREE.Texture[] = [];

  /* ---------------- 天幕 ---------------- */

  const skyUniforms = {
    uTime: { value: 0 },
    uZenith: { value: new THREE.Color(0x05070e) },
    uHorizon: { value: new THREE.Color(0x111a28) },
    uGlow: { value: new THREE.Color(0x3a2230) },
  };
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(220, 32, 20),
    new THREE.ShaderMaterial({
      uniforms: skyUniforms,
      vertexShader: WORLD_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    }),
  );
  sky.name = 'sky';
  sky.renderOrder = -1000;
  sky.frustumCulled = false;
  root.add(sky);

  /* ---------------- 街面 ---------------- */

  const signColors: THREE.Color[] = [];
  const signSpots: THREE.Vector4[] = [];
  const signPowers: number[] = [];
  for (const spec of SIGN_SPECS) {
    signColors.push(new THREE.Color(spec.color));
    signSpots.push(
      new THREE.Vector4(
        spec.side * SIGN_X,
        spec.z,
        spec.w * 0.5 + 1.1,
        spec.h * 0.45 + 2.6,
      ),
    );
    signPowers.push(0);
  }

  const roadUniforms = {
    uTime: { value: 0 },
    uWet: { value: 1 },
    uCurbX: { value: CURB_X },
    uFog: { value: new THREE.Color(HAZE_COLOR) },
    uSignColor: { value: signColors },
    uSignSpot: { value: signSpots },
    uSignPower: { value: signPowers },
    uRipples: {
      value: [
        new THREE.Vector2(-1.4, -2.6),
        new THREE.Vector2(1.9, -8.4),
        new THREE.Vector2(-2.3, -14.1),
        new THREE.Vector2(1.1, -20.6),
      ],
    },
  };
  const roadMaterial = new THREE.ShaderMaterial({
    uniforms: roadUniforms,
    vertexShader: WORLD_VERT,
    fragmentShader: ROAD_FRAG,
    fog: false,
  });
  const roadGeometry = new THREE.PlaneGeometry(ROAD_HALF * 2, 70, 1, 1);
  roadGeometry.rotateX(-Math.PI / 2);
  const road = new THREE.Mesh(roadGeometry, roadMaterial);
  road.name = 'wet-street';
  road.position.set(0, 0, -28);
  root.add(road);

  // 街面延伸到墙根（整条街都是湿沥青），路缘用着色器画出来，
  // 这样霓虹的倒影在招牌正下方也落得到地面上
  const curbMaterial = new THREE.MeshStandardMaterial({
    color: 0x0c1017,
    roughness: 0.86,
    metalness: 0.04,
  });
  curbMaterial.envMap = ctx.env.envMap;
  curbMaterial.envMapIntensity = 0.05;
  for (const side of [-1, 1]) {
    const curb = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.1, 70), curbMaterial);
    curb.name = 'curb';
    curb.position.set(side * CURB_X, 0.05, -28);
    root.add(curb);
  }

  /* ---------------- 楼体 ---------------- */

  const facadeSets = [createFacadeTextures(11), createFacadeTextures(29), createFacadeTextures(47)];
  const facadeMaterials = facadeSets.map((set) => {
    ownTextures.push(set.map, set.emissive);
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: set.map,
      emissiveMap: set.emissive,
      emissive: 0xffffff,
      emissiveIntensity: 0.8,
      roughness: 0.95,
      metalness: 0.0,
    });
    material.envMap = ctx.env.envMap;
    material.envMapIntensity = 0.05;
    return material;
  });

  for (const side of [-1, 1]) {
    for (let i = 0; i < 9; i += 1) {
      const length = 4.6 + random() * 2.6;
      const height = 7.5 + random() * 9.5;
      const depth = 5.5 + random() * 4;
      const z = 4.5 - i * 5.9 - random() * 1.2;

      const geometry = new THREE.BoxGeometry(depth, height, length);
      const uv = geometry.getAttribute('uv') as THREE.BufferAttribute;
      for (let v = 0; v < uv.count; v += 1) {
        uv.setXY(v, uv.getX(v) * (length / 5.5), uv.getY(v) * (height / 9));
      }
      uv.needsUpdate = true;

      const building = new THREE.Mesh(geometry, facadeMaterials[Math.floor(random() * facadeMaterials.length)]);
      building.name = 'facade';
      building.position.set(side * (WALL_X + depth / 2), height / 2, z);
      root.add(building);
    }
  }

  /* ---------------- 霓虹招牌 ---------------- */

  const glowTexture = createRadialTexture(128, 2.4);
  ownTextures.push(glowTexture);

  const signs: NeonSign[] = [];

  SIGN_SPECS.forEach((spec, index) => {
    const texture = createNeonSignTexture(101 + index * 37, spec.vertical);
    ownTextures.push(texture);

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: texture },
        uColor: { value: new THREE.Color(spec.color) },
        uIntensity: { value: 2.4 },
        uFade: { value: 1 },
      },
      vertexShader: SIGN_VERT,
      fragmentShader: SIGN_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });

    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(spec.w, spec.h), material);
    mesh.name = 'neon-sign';
    mesh.position.set(spec.side * SIGN_X, spec.y, spec.z);
    mesh.rotation.y = spec.side < 0 ? Math.PI / 2 : -Math.PI / 2;
    root.add(mesh);

    // 场景内自绘的辉光面片：XR 模式下没有 bloom，靠它撑起光晕
    const glowMaterial = new THREE.SpriteMaterial({
      map: glowTexture,
      color: new THREE.Color(spec.color),
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const glow = new THREE.Sprite(glowMaterial);
    glow.name = 'neon-glow';
    const glowScale = Math.max(spec.w, spec.h) * 1.9;
    glow.scale.setScalar(glowScale);
    glow.position.set(spec.side * (SIGN_X - 0.15), spec.y, spec.z);
    root.add(glow);

    const light = index < 3 ? new THREE.PointLight(spec.color, 12, 16, 2) : null;
    if (light) {
      light.position.set(spec.side * (SIGN_X - 0.7), spec.y, spec.z);
      root.add(light);
    }

    signs.push({
      material,
      glow,
      glowMaterial,
      glowScale,
      light,
    });
  });

  /* ---------------- 街灯 ---------------- */

  const lampPositions: THREE.Vector3[] = [
    new THREE.Vector3(6.6, 4.5, -1.6),
    new THREE.Vector3(-6.7, 4.2, -12.4),
    new THREE.Vector3(6.6, 4.4, -24.0),
  ];
  const lampLights: THREE.PointLight[] = [];

  const poleMaterial = new THREE.MeshStandardMaterial({
    color: 0x14181f,
    roughness: 0.7,
    metalness: 0.6,
  });
  poleMaterial.envMap = ctx.env.envMap;
  poleMaterial.envMapIntensity = 0.08;

  const lampHeadMaterial = new THREE.MeshBasicMaterial({ color: 0xffd9a8 });

  for (const position of lampPositions) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.11, position.y, 8), poleMaterial);
    pole.name = 'lamp-pole';
    pole.position.set(position.x, position.y / 2, position.z);
    root.add(pole);

    const head = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.16, 0.3), lampHeadMaterial);
    head.name = 'lamp-head';
    head.position.copy(position);
    root.add(head);

    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture,
        color: 0xffc98a,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
    );
    halo.name = 'lamp-halo';
    halo.scale.setScalar(3.2);
    halo.position.copy(position);
    root.add(halo);

    const light = new THREE.PointLight(0xffc27a, 22, 20, 2);
    light.position.copy(position);
    light.position.y -= 0.15;
    root.add(light);
    lampLights.push(light);
  }

  /* ---------------- 雨 ---------------- */

  const rainCount = Math.max(600, Math.round(2400 * quality));
  const rainPositions = new Float32Array(rainCount * 2 * 3);
  const rainBases = new Float32Array(rainCount * 2 * 3);
  const rainSeeds = new Float32Array(rainCount * 2);
  const rainEnds = new Float32Array(rainCount * 2);
  const RAIN_HEIGHT = 13;

  for (let i = 0; i < rainCount; i += 1) {
    const x = (random() - 0.5) * 19;
    const y = random() * RAIN_HEIGHT;
    const z = 7 - random() * 30;
    const seed = random();
    for (let v = 0; v < 2; v += 1) {
      const index = i * 2 + v;
      rainPositions[index * 3] = x;
      rainPositions[index * 3 + 1] = y;
      rainPositions[index * 3 + 2] = z;
      rainBases[index * 3] = x;
      rainBases[index * 3 + 1] = y;
      rainBases[index * 3 + 2] = z;
      rainSeeds[index] = seed;
      rainEnds[index] = v;
    }
  }

  const rainGeometry = new THREE.BufferGeometry();
  rainGeometry.setAttribute('position', new THREE.BufferAttribute(rainPositions, 3));
  rainGeometry.setAttribute('aBase', new THREE.BufferAttribute(rainBases, 3));
  rainGeometry.setAttribute('aSeed', new THREE.BufferAttribute(rainSeeds, 1));
  rainGeometry.setAttribute('aEnd', new THREE.BufferAttribute(rainEnds, 1));

  const rainUniforms = {
    uTime: { value: 0 },
    uSpeed: { value: 9 },
    uLength: { value: 0.42 },
    uHeight: { value: RAIN_HEIGHT },
    uLevel: { value: 1 },
    uColor: { value: new THREE.Color(0xbcd6ee) },
    uOpacity: { value: 0.5 },
    uLightPos: { value: lampPositions },
  };
  const rainMaterial = new THREE.ShaderMaterial({
    uniforms: rainUniforms,
    vertexShader: RAIN_VERT,
    fragmentShader: RAIN_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const rain = new THREE.LineSegments(rainGeometry, rainMaterial);
  rain.name = 'rain';
  rain.frustumCulled = false;
  root.add(rain);

  /* ---------------- 灯光 ---------------- */

  const lights = ctx.env.createStudioLights();
  lights.traverse((child) => {
    if (child instanceof THREE.Light) {
      child.intensity *= 0.12;
      child.castShadow = false;
      child.color.setHex(0x2a3a55);
    }
  });
  root.add(lights);

  const hemisphere = new THREE.HemisphereLight(0x1a2740, 0x04060a, 0.16);
  root.add(hemisphere);

  /* ---------------- 后处理栈 ---------------- */

  const composer = new EffectComposer(ctx.renderer);
  composer.setPixelRatio(ctx.renderer.getPixelRatio());
  composer.setSize(Math.max(1, ctx.width), Math.max(1, ctx.height));

  const renderPass = new RenderPass(root, camera);
  composer.addPass(renderPass);

  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(Math.max(1, ctx.width), Math.max(1, ctx.height)),
    0.85,
    0.62,
    0.28,
  );
  composer.addPass(bloomPass);

  const gradePass = new ShaderPass({
    name: 'NeonGradeShader',
    uniforms: {
      tDiffuse: { value: null },
      uTime: { value: 0 },
      uAberration: { value: 0.0014 },
      uGrain: { value: 0.05 },
      uScanline: { value: 0.03 },
      uVignette: { value: 0.62 },
    },
    vertexShader: GRADE_VERT,
    fragmentShader: GRADE_FRAG,
  });
  gradePass.material.depthTest = false;
  gradePass.material.depthWrite = false;
  composer.addPass(gradePass);

  const outputPass = new OutputPass();
  outputPass.material.depthTest = false;
  outputPass.material.depthWrite = false;
  composer.addPass(outputPass);

  /* ---------------- 运行时状态 ---------------- */

  let lastWidth = 0;
  let lastHeight = 0;
  let lastPixelRatio = ctx.renderer.getPixelRatio();
  // 宿主场景（Stage / ThumbnailBaker 的 hostScene）。
  // 走 composer 时必须让宿主随后的 render 既不清屏也不画东西，
  // 否则 composer 的结果会被覆盖掉。
  let hostSceneRef: THREE.Scene | null = null;
  let hostBackground: THREE.Color | THREE.Texture | THREE.CubeTexture | null = null;

  return {
    root,
    camera,
    immersive: false,
    xrDistance: 3,
    framing: { distance: 5.2, height: 1.65, targetY: 2.4, width: 9 },

    update(time: number, delta: number, sceneCtx: SceneContext): void {
      const audio = sceneCtx.audio;
      const pulse = audio.pulse;
      const level = audio.level;
      const bass = audio.bass;
      const treble = audio.treble;

      /* ---- 尺寸变化时才 setSize ---- */
      const pixelRatio = sceneCtx.renderer.getPixelRatio();
      if (sceneCtx.width !== lastWidth || sceneCtx.height !== lastHeight || pixelRatio !== lastPixelRatio) {
        lastWidth = sceneCtx.width;
        lastHeight = sceneCtx.height;
        lastPixelRatio = pixelRatio;
        // composer.setSize 会把尺寸乘上像素比，并转发给每个 pass（含 UnrealBloomPass）
        composer.setPixelRatio(pixelRatio);
        composer.setSize(lastWidth, lastHeight);
      }

      /* ---- 共用的音频驱动 ---- */
      skyUniforms.uTime.value = time;
      roadUniforms.uTime.value = time;

      // 雨势：脉冲越大，雨越大越急
      rainUniforms.uTime.value = time;
      rainUniforms.uSpeed.value = 8.5 + pulse * 5.5 + bass * 2.4;
      rainUniforms.uLength.value = 0.3 + pulse * 0.45 + level * 0.12;
      rainUniforms.uLevel.value = 0.55 + pulse * 0.6;
      rainUniforms.uOpacity.value = 0.28 + level * 0.32;

      // 街灯亮度跟着响度走
      for (let i = 0; i < lampLights.length; i += 1) {
        lampLights[i].intensity = 14 + level * 18 + pulse * 6;
      }

      // 霓虹：脉冲带来呼吸，响度带来整体亮度
      const breathe = 0.72 + level * 0.55 + pulse * 0.22;
      for (let i = 0; i < signs.length; i += 1) {
        const sign = signs[i];
        const flicker = 0.9 + 0.1 * Math.sin(time * 0.9 + i * 1.7);
        const shimmer = 0.94 + 0.06 * Math.sin(time * 9.3 + i * 2.9);
        const value = breathe * flicker * shimmer;

        sign.material.uniforms.uIntensity.value = value * 2.6;

        // XR 没有 bloom，辉光面片要自己撑起来
        const xrBoost = sceneCtx.isXR ? 1.9 : 1;
        sign.glowMaterial.opacity = (0.16 + value * 0.3) * xrBoost;
        sign.glow.scale.setScalar(sign.glowScale * xrBoost);
        if (sign.light) sign.light.intensity = 6 + value * 14;

        signPowers[i] = value * 0.85;
      }
      roadUniforms.uSignPower.value = signPowers;

      /* ---- 网页模式走后处理栈，XR 模式不走 ---- */
      if (sceneCtx.isXR) {
        // XR：还原自动清屏，交回宿主直接渲染
        sceneCtx.renderer.autoClear = true;
        root.visible = true;
        return;
      }

      sceneCtx.renderer.autoClear = false;
      root.visible = true;

      // 宿主场景若带背景色，three 会强制清屏（forceClear），
      // 这里把背景暂时摘掉，dispose 时再还回去。
      const host = root.parent;
      if (host instanceof THREE.Scene && host !== hostSceneRef) {
        hostSceneRef = host;
        hostBackground = host.background;
      }
      if (hostSceneRef) hostSceneRef.background = null;

      // 后处理参数跟随音乐
      bloomPass.strength = 0.55 + level * 0.95 + pulse * 0.35;
      gradePass.uniforms.uTime.value = time;
      gradePass.uniforms.uAberration.value = 0.0008 + bass * 0.0032;
      gradePass.uniforms.uGrain.value = 0.018 + treble * 0.07;
      gradePass.uniforms.uScanline.value = 0.018 + level * 0.022;
      gradePass.uniforms.uVignette.value = 0.5 + level * 0.22;

      composer.render(delta);

      // composer 已经把结果画到画布上，宿主随后的 render 不能再清屏或重画场景
      root.visible = false;
    },

    dispose(): void {
      // 还原渲染器状态，避免影响后续场景
      ctx.renderer.autoClear = true;
      root.visible = true;
      if (hostSceneRef) hostSceneRef.background = hostBackground;

      ownTextures.forEach((texture) => texture.dispose());
      composer.passes.forEach((pass) => pass.dispose());
      composer.dispose();
      disposeObject(root);
    },
  };
}

export const neonPipelineScene: SceneDefinition = {
  id: 'neon-pipeline',
  title: '霓虹雨夜 · 渲染管线',
  subtitle: 'Neon Pipeline',
  description: '霓虹雨夜街道走上完整的后处理栈：辉光、色差、胶片颗粒与暗角层层叠加。',
  tags: ['后处理', '霓虹', '雨夜', '泛光'],
  accent: '#ff4f9d',
  gradient: ['#2a1338', '#05070f'],
  category: 'procedural',
  audio: 'rain-window.mp3',
  breathing: BREATHING,
  create(ctx: SceneContext): SceneInstance {
    return createNeonPipeline(ctx);
  },
};

export default neonPipelineScene;
