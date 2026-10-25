import * as THREE from 'three';
import type { SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { disposeObject } from '../../core/loader.js';
import { ParticleSpace, createRandom, wrapParticleField } from '../../core/particle-space.js';
import { createBreathSample, sampleBreath } from './lib/breath.js';
import {
  GLSL_HASH,
  GLSL_NOISE2,
  GLSL_DITHER,
  GLSL_OUTPUT,
  GLSL_OUTPUT_FUNCS,
  createBackdropDome,
  createSoftParticleField,
  dimStudioLights,
  updateParticleScale,
} from './lib/gfx.js';

/**
 * 雨夜窗
 *
 * 隔着一层布满雨滴的玻璃看窗外：窗外是失焦的城市灯光（烘焙成一张
 * 可平铺的散景贴图，缓慢漂移），玻璃上的雨滴沿窗面极缓慢地下滑并留下水痕，
 * 水珠把背后的灯光折射开，玻璃整体覆着一层薄雾。呼吸让整片窗景极轻地明灭。
 */

const BREATHING = { inhale: 4, hold: 4, exhale: 6, holdOut: 2 };

const FOV = 50;

/** 玻璃窗的位置：贴在用户正前方偏下一点。 */
const PANE_Z = -0.9;
const PANE_Y = 1.7;
const PANE_W = 12;
const PANE_H = 7.5;

function rgba(hex: number, alpha: number): string {
  const r = (hex >> 16) & 255;
  const g = (hex >> 8) & 255;
  const b = hex & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * 烘焙一张「失焦城市」贴图：上下渐变的夜空 + 一片柔和的大颗散景光斑。
 * 光斑在水平方向平铺无缝，垂直方向保持一条自然的城市灯带。
 */
function createCityTexture(size = 1024, seed = 9173): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');

  const sky = ctx.createLinearGradient(0, 0, 0, size);
  sky.addColorStop(0, '#05080f');
  sky.addColorStop(0.34, '#0a1120');
  sky.addColorStop(0.56, '#101b2b');
  sky.addColorStop(0.74, '#0a121d');
  sky.addColorStop(1, '#04070d');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, size, size);

  const random = createRandom(seed);
  const palette = [0xd9a066, 0xe8c48f, 0x8fb6c9, 0xf0e2c6, 0x6f8f9f, 0xc98f6a, 0xa9c0d6];

  // 城市底部的一片暖色辉光，让窗外不至于完全漆黑
  const glow = ctx.createLinearGradient(0, size * 0.4, 0, size * 0.86);
  glow.addColorStop(0, rgba(0x6f5a44, 0));
  glow.addColorStop(0.55, rgba(0x8a6a48, 0.24));
  glow.addColorStop(1, rgba(0x2a2233, 0.12));
  ctx.fillStyle = glow;
  ctx.fillRect(0, size * 0.4, size, size * 0.46);

  for (let i = 0; i < 220; i += 1) {
    const x = random() * size;
    // 灯带集中在中上部，越往上越稀
    const y = size * (0.24 + Math.pow(random(), 1.7) * 0.54);
    const radius = size * (0.014 + Math.pow(random(), 1.9) * 0.062);
    const color = palette[Math.floor(random() * palette.length)];
    const alpha = 0.26 + random() * 0.5;

    // 水平平铺：把跨越边界的光斑在对侧再画一遍
    for (let ox = -1; ox <= 1; ox++) {
      const cx = x + ox * size;
      const gradient = ctx.createRadialGradient(cx, y, 0, cx, y, radius);
      gradient.addColorStop(0, rgba(color, alpha));
      gradient.addColorStop(0.42, rgba(color, alpha * 0.42));
      gradient.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(cx, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'city-bokeh';
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

const PANE_VERT = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const PANE_FRAG = /* glsl */ `
precision highp float;

uniform sampler2D uCity;
uniform vec2 uCityScale;
uniform vec2 uCityOffset;
uniform float uDropColumns;
uniform float uRefract;
uniform float uTime;
uniform float uBreath;
uniform vec3 uMistColor;

varying vec2 vUv;

${GLSL_HASH}
${GLSL_NOISE2}
${GLSL_DITHER}
${GLSL_OUTPUT_FUNCS}

/**
 * 一根水柱上的雨滴场。
 * 返回 x/y = 折射梯度，z = 水珠边缘与水痕，w = 水珠本体。
 */
vec4 dropField(vec2 uv, float columns) {
  float col = floor(uv.x * columns);
  float fx = fract(uv.x * columns);
  float h1 = hash12(vec2(col, 1.7));
  float h2 = hash12(vec2(col, 5.3));
  float h3 = hash12(vec2(col, 9.1));

  // 每列 3~5 颗水珠，沿窗面极缓慢下滑（跨越整块玻璃需要 100 秒以上）
  float n = 3.0 + floor(h1 * 3.0);
  float spacing = 1.0 / n;
  float speed = 0.005 + h2 * 0.007;
  float t = uTime * speed + h3;

  float j = floor(n * (uv.y + t) + 0.5);
  float dropY = mod((j + 0.5) * spacing - t, 1.0);

  float dx = 0.5 + (h2 - 0.5) * 0.5;
  float rx = 0.024 + h3 * 0.018;
  float ry = rx * (1.3 + h1 * 0.6);

  vec2 q = vec2((fx - dx) / rx, (uv.y - dropY) / ry);
  float drop = exp(-dot(q, q) * 2.2);
  float edge = length(q);
  float rim = smoothstep(0.5, 0.9, edge) * (1.0 - smoothstep(0.9, 1.5, edge));

  // 水痕：水珠上方那一道渐淡的湿痕
  float above = uv.y - dropY;
  float lateral = 1.0 - smoothstep(0.0, rx * 1.6, abs(fx - dx));
  float trail = smoothstep(0.0, 0.006, above) * exp(-above * 55.0) * lateral;

  vec2 grad = vec2(-4.4 * q.x * drop / rx, -4.4 * q.y * drop / ry);
  return vec4(grad, rim + trail * 0.32, drop);
}

void main() {
  vec4 field = dropField(vUv, uDropColumns);
  vec2 grad = field.xy;
  float rim = field.z;
  float drop = field.w;

  // 折射：水珠把背后的城市灯光拉开
  vec2 refr = grad * uRefract * uCityScale;
  vec2 cityUV = vUv * uCityScale + uCityOffset + refr;
  vec3 city = texture2D(uCity, cityUV).rgb;

  // 水珠边缘捕捉到的光
  float bright = dot(city, vec3(0.34));
  city += rim * bright * 0.95;
  city += rim * 0.012;

  // 玻璃上的薄雾
  float mist = fbm2(vUv * vec2(5.0, 2.6) + vec2(uTime * 0.0035, 0.0));
  float fog = clamp(0.09 + mist * 0.09 + uBreath * 0.03, 0.0, 0.26);
  city = mix(city, uMistColor, fog);

  // 凝结的细小水珠
  float cond = pow(vnoise2(vUv * 150.0), 14.0);
  city += cond * 0.04;

  // 边缘压暗，把玻璃边界藏进暗处
  vec2 c = vUv - 0.5;
  float vig = 1.0 - smoothstep(0.3, 0.76, length(c * vec2(1.0, 1.42)));
  city *= 0.66 + 0.34 * vig;

  // 呼吸：整片窗景极轻地明灭
  city *= 0.94 + 0.11 * uBreath;
  city += (dither(gl_FragCoord.xy) - 0.5) * 0.007;

  gl_FragColor = vec4(city, 1.0);
  ${GLSL_OUTPUT}
}
`;

function createRainWindow(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'raindow-scene';

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 220);
  camera.position.set(0, 1.62, 2.6);
  camera.lookAt(0, 1.72, 0);

  // 窗外之外的暗色底，填满 XR 里的周边视野
  const backdrop = createBackdropDome({
    zenith: 0x04060c,
    horizon: 0x0a111d,
    ground: 0x03050a,
    radius: 60,
  });
  root.add(backdrop.mesh);

  // ── 玻璃 ──────────────────────────────────────────────────────────────
  const cityTexture = createCityTexture(1024);
  const cityScale = new THREE.Vector2(3, 1);
  const cityOffset = new THREE.Vector2(0, 0);

  const paneUniforms = {
    uCity: { value: cityTexture },
    uCityScale: { value: cityScale },
    uCityOffset: { value: cityOffset },
    uDropColumns: { value: 40 },
    uRefract: { value: 0.00028 },
    uTime: { value: 0 },
    uBreath: { value: 0 },
    uMistColor: { value: new THREE.Color(0x2e3a48) },
  };

  const paneMaterial = new THREE.ShaderMaterial({
    uniforms: paneUniforms,
    vertexShader: PANE_VERT,
    fragmentShader: PANE_FRAG,
    side: THREE.FrontSide,
  });

  const pane = new THREE.Mesh(new THREE.PlaneGeometry(PANE_W, PANE_H), paneMaterial);
  pane.name = 'glass';
  pane.position.set(0, PANE_Y, PANE_Z);
  root.add(pane);

  // ── 窗框 ──────────────────────────────────────────────────────────────
  const frameMaterial = new THREE.MeshStandardMaterial({
    color: 0x0b0d12,
    roughness: 0.92,
    metalness: 0,
    envMapIntensity: 0.08,
  });
  frameMaterial.envMap = ctx.env.envMap;

  const mullion = new THREE.Mesh(new THREE.BoxGeometry(0.1, PANE_H, 0.16), frameMaterial);
  mullion.name = 'mullion';
  mullion.position.set(-1.95, PANE_Y, PANE_Z + 0.06);
  root.add(mullion);

  const sill = new THREE.Mesh(new THREE.BoxGeometry(PANE_W + 0.4, 0.34, 0.4), frameMaterial);
  sill.name = 'sill';
  sill.position.set(0, PANE_Y - PANE_H * 0.5 - 0.1, PANE_Z + 0.12);
  root.add(sill);

  // ── 玻璃前缓缓浮动的水汽微粒 ──────────────────────────────────────────
  const space = new ParticleSpace({
    radius: 2.8,
    spin: 0.006,
    tilt: 0.1,
    position: [0, 1.7, -0.45],
  });
  const motes = createSoftParticleField(space, Math.floor(260 * ctx.quality), {
    size: 0.02,
    color: new THREE.Color(0xbcd0dc),
    opacity: 0.3,
    seed: 8821,
    wander: 0.08,
  });
  root.add(motes.points);

  // ── 灯光 ──────────────────────────────────────────────────────────────
  const lights = ctx.env.createStudioLights();
  dimStudioLights(lights, 0.06, 0x2c3a4a);
  root.add(lights);

  const breath = createBreathSample();

  return {
    root,
    camera,
    immersive: true,
    framing: { distance: 2.6, height: 1.62, targetY: 1.72, width: 5.2 },
    update(time: number, delta: number, context: SceneContext): void {
      sampleBreath(BREATHING, time, breath);
      const level = breath.level;

      space.breathe = 1 + level * 0.1;
      space.breathPhase = level;
      space.update(delta, time);
      wrapParticleField(motes.points, space.radius, delta, 0.008);

      motes.uniforms.uTime.value = time;
      motes.uniforms.uBreath.value = level;
      updateParticleScale(motes.uniforms, context, FOV);

      // 城市灯带极缓慢地漂移
      cityOffset.x = (time * 0.0035) % 1;
      cityOffset.y = Math.sin(time * 0.021) * 0.006;

      paneUniforms.uTime.value = time;
      paneUniforms.uBreath.value = level;
      backdrop.uniforms.uTime.value = time;
      backdrop.uniforms.uBreath.value = level;
    },
    dispose(): void {
      cityTexture.dispose();
      disposeObject(root);
    },
  };
}

export const rainwindowScene: SceneDefinition = {
  id: 'raindow',
  title: '雨夜窗',
  subtitle: 'Rain on Glass',
  description: '雨滴沿着窗玻璃缓慢滑落，身后城市的灯光被折射成一片温柔的光斑。',
  tags: ['雨', '窗', '夜'],
  accent: '#8fb6c9',
  gradient: ['#16203c', '#070b13'],
  category: 'meditation',
  audio: 'rain-window.mp3',
  breathing: BREATHING,
  lighting: {
    autoExposure: true,
    autoExposureKey: 0.055,
  },
  create(ctx: SceneContext): SceneInstance {
    return createRainWindow(ctx);
  },
};

export default rainwindowScene;
