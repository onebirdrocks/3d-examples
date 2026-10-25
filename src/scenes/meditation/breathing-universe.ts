/**
 * 呼吸宇宙 / Breathing Universe
 * ---------------------------------------------------------------
 * 无限暗色宇宙中悬浮的一颗半透明能量球。
 *
 * - 球体由数万颗发光微粒 + 数百条流动光丝构成，形成有机的「呼吸」结构
 * - 严格 4 秒吸气 / 6 秒呼气：半径、辉光强度、丝线流速都跟着呼吸走
 * - 音乐的低频起伏叠加在呼吸之上，做二次调制（粒子亮度、丝线流速）
 * - 相机完全静止，构图始终居中；所有周期性运动都以呼吸周期为基准，因此无缝循环
 *
 * 配色：柔和薰衣草 / 冰蓝 / 淡青 / 微光银，背景是深午夜蓝。
 */
import * as THREE from 'three';
import type { BreathingPattern, SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { GLSL_OUTPUT, GLSL_OUTPUT_FUNCS } from './lib/gfx.js';

/** 吸气 4 秒、呼气 6 秒，两端各留极短的停顿。 */
const BREATHING: BreathingPattern = { inhale: 4, hold: 0.4, exhale: 6, holdOut: 0.4 };

/** 能量球的基础半径（米）。 */
const SPHERE_RADIUS = 1.0;
/** 球心高度：齐视平线。 */
const CENTER_Y = 1.55;
/** 相机到球心的距离。 */
const CAMERA_DISTANCE = 4.2;

const COLOR_LAVENDER = new THREE.Color('#b9a6ff');
const COLOR_ICY = new THREE.Color('#93a6ff');
const COLOR_CYAN = new THREE.Color('#cdeeff');
const COLOR_SILVER = new THREE.Color('#e2e8f5');

/* ------------------------------------------------------------------ *
 * 粒子外壳
 * ------------------------------------------------------------------ */

const SHELL_VERT = /* glsl */ `
attribute float aSeed;
attribute float aPhase;
attribute float aRand;

uniform float uTime;
uniform float uBreath;
uniform float uSize;
uniform float uPixelRatio;
uniform float uFlow;

varying float vTone;
varying float vShade;
varying float vEdge;

void main() {
  vec3 dir = normalize( position );

  // 呼吸：球体缓慢胀缩
  float radius = 1.0 + uBreath * 0.15;

  // 有机流动：沿两个切向做极缓慢的摆动，像悬浮在水里的浮游光尘
  vec3 tangent = normalize( cross( dir, vec3( 0.0, 1.0, 0.0 ) ) + vec3( 0.0001, 0.0, 0.0001 ) );
  vec3 bitangent = cross( dir, tangent );

  float t = uTime * uFlow + aPhase;
  float wobble = sin( t * 1.7 + dir.y * 2.6 ) * 0.55 + sin( t * 1.13 + dir.x * 3.4 ) * 0.45;
  float offset = ( 0.028 + 0.022 * uBreath ) * wobble;

  vec3 pos = dir * ( radius + aRand * 0.028 ) + ( tangent * cos( t + aSeed * 6.2831 ) + bitangent * sin( t + aSeed * 6.2831 ) ) * offset;

  vec4 mv = modelViewMatrix * vec4( pos, 1.0 );
  float depth = -mv.z;

  // 相机背后的点：直接丢弃，否则 240/depth 会让点尺寸爆成巨方块
  if ( depth <= 0.05 ) {
    gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
    gl_PointSize = 0.0;
    vTone = 0.0;
    vShade = 0.0;
    vEdge = 0.0;
    return;
  }

  gl_Position = projectionMatrix * mv;

  float size = uSize * ( 0.55 + aRand * 0.9 ) * ( 1.0 + uBreath * 0.22 );
  gl_PointSize = min( size * uPixelRatio * ( 240.0 / depth ), 26.0 * uPixelRatio );

  // 明暗：朝向相机的更亮，背面更暗 —— 立刻产生体积感
  vec3 viewDir = normalize( cameraPosition - ( modelMatrix * vec4( pos, 1.0 ) ).xyz );
  vShade = 0.30 + 0.70 * pow( max( 0.0, dot( dir, viewDir ) ), 0.85 );

  // 边缘：正对视线方向的粒子带一点银边
  vEdge = pow( 1.0 - abs( dot( dir, viewDir ) ), 3.0 );

  // 色调：沿缓慢变化的噪声在薰衣草 / 冰蓝 / 淡青之间流转
  vTone = fract( aSeed * 7.31 + uTime * 0.011 + sin( dir.y * 3.0 + uTime * 0.02 ) * 0.08 );
}
`;

const SHELL_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uColorLavender;
uniform vec3 uColorIcy;
uniform vec3 uColorCyan;
uniform vec3 uColorSilver;
uniform float uOpacity;
uniform float uGlow;

varying float vTone;
varying float vShade;
varying float vEdge;

${GLSL_OUTPUT_FUNCS}

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length( c );
  if ( d > 0.5 ) discard;

  // 柔和的圆点衰减
  float a = smoothstep( 0.5, 0.02, d );
  a *= a;

  vec3 col = mix( uColorLavender, uColorIcy, smoothstep( 0.18, 0.82, vTone ) );
  col = mix( col, uColorCyan, smoothstep( 0.66, 1.0, vTone ) * 0.6 );
  col = mix( col, uColorSilver, vEdge * 0.55 );

  gl_FragColor = vec4( col * vShade * uGlow, a * uOpacity * vShade );
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * 流动光丝
 * ------------------------------------------------------------------ */

const FILAMENT_VERT = /* glsl */ `
attribute float aArc;
attribute float aSeed;

uniform float uTime;
uniform float uBreath;
uniform float uSpeed;

varying float vGlow;
varying float vTone;

void main() {
  // 沿丝线跑动的光脉冲
  float travel = fract( uTime * uSpeed + aSeed );
  float d = abs( fract( aArc - travel + 0.5 ) - 0.5 );
  vGlow = exp( -d * 34.0 ) * 0.95 + 0.035;
  vTone = fract( aSeed * 5.77 + aArc * 0.5 );
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const FILAMENT_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uColorLavender;
uniform vec3 uColorCyan;
uniform vec3 uColorSilver;
uniform float uOpacity;

varying float vGlow;
varying float vTone;

${GLSL_OUTPUT_FUNCS}

void main() {
  vec3 col = mix( uColorLavender, uColorCyan, vTone * 0.55 );
  col = mix( col, uColorSilver, pow( vTone, 3.0 ) * 0.5 );
  gl_FragColor = vec4( col * vGlow, uOpacity * vGlow );
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * 背景穹顶
 * ------------------------------------------------------------------ */

const DOME_VERT = /* glsl */ `
varying vec3 vDir;

void main() {
  vDir = normalize( position );
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const DOME_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGlow;
uniform float uBreath;
uniform float uTime;

varying vec3 vDir;

${GLSL_OUTPUT_FUNCS}

void main() {
  float y = vDir.y;
  vec3 col = mix( uHorizon, uZenith, smoothstep( -0.25, 0.75, y ) );

  // 极淡的暖色余晖，给暗部一点层次
  float warm = exp( -abs( y + 0.05 ) * 5.5 ) * 0.35;
  col += uGlow * warm * ( 0.6 + 0.4 * uBreath );

  // 细微的带状条纹，避免大面积纯色
  float band = sin( atan( vDir.x, vDir.z ) * 3.0 + uTime * 0.012 + y * 2.0 ) * 0.5 + 0.5;
  col += vec3( 0.006, 0.008, 0.016 ) * band;

  gl_FragColor = vec4( col, 1.0 );
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * 构建工具
 * ------------------------------------------------------------------ */

/** 确定性伪随机，保证每次打开画面一致。 */
function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 生成球面上的「光丝」曲线：倾斜大圆 + 正弦扰动，形成有机的环带。 */
function buildFilaments(
  bandCount: number,
  strandsPerBand: number,
  segments: number,
): { positions: Float32Array; arcs: Float32Array; seeds: Float32Array } {
  const random = makeRandom(9137);
  const totalLines = bandCount * strandsPerBand;
  const verticesPerLine = (segments - 1) * 2;
  const vertexCount = totalLines * verticesPerLine;

  const positions = new Float32Array(vertexCount * 3);
  const arcs = new Float32Array(vertexCount);
  const seeds = new Float32Array(vertexCount);

  const point = new THREE.Vector3();
  const next = new THREE.Vector3();
  let vertex = 0;

  for (let band = 0; band < bandCount; band += 1) {
    // 大圆的法线：随机倾斜
    const tilt = random() * Math.PI;
    const azimuth = random() * Math.PI * 2;
    const normal = new THREE.Vector3(
      Math.sin(tilt) * Math.cos(azimuth),
      Math.cos(tilt),
      Math.sin(tilt) * Math.sin(azimuth),
    );
    const basisA = new THREE.Vector3(0, 1, 0).cross(normal).normalize();
    const basisB = normal.clone().cross(basisA).normalize();

    const bandPhase = random() * Math.PI * 2;
    const warp = 2.2 + random() * 4.6;

    for (let strand = 0; strand < strandsPerBand; strand += 1) {
      const spread = (strand - (strandsPerBand - 1) / 2) * 0.022;
      const seed = random();

      for (let s = 0; s < segments - 1; s += 1) {
        const a0 = (s / (segments - 1)) * Math.PI * 2 + bandPhase + spread;
        const a1 = ((s + 1) / (segments - 1)) * Math.PI * 2 + bandPhase + spread;

        sampleFilament(normal, basisA, basisB, a0, warp, point);
        sampleFilament(normal, basisA, basisB, a1, warp, next);

        positions[vertex * 3] = point.x;
        positions[vertex * 3 + 1] = point.y;
        positions[vertex * 3 + 2] = point.z;
        arcs[vertex] = s / (segments - 1);
        seeds[vertex] = seed;
        vertex += 1;

        positions[vertex * 3] = next.x;
        positions[vertex * 3 + 1] = next.y;
        positions[vertex * 3 + 2] = next.z;
        arcs[vertex] = (s + 1) / (segments - 1);
        seeds[vertex] = seed;
        vertex += 1;
      }
    }
  }

  return { positions, arcs, seeds };
}

/** 大圆上的一个点，叠加正弦扰动形成有机的弯曲丝带。 */
function sampleFilament(
  normal: THREE.Vector3,
  basisA: THREE.Vector3,
  basisB: THREE.Vector3,
  angle: number,
  warp: number,
  out: THREE.Vector3,
): void {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  out
    .copy(basisA)
    .multiplyScalar(c)
    .addScaledVector(basisB, s)
    .addScaledVector(normal, Math.sin(angle * warp) * 0.16)
    .normalize()
    .multiplyScalar(SPHERE_RADIUS * 1.002);
}

/**
 * 沿同样的曲线采样出稠密点云 —— 让光丝变成「柔软的光絮」而不是几何线条。
 */
function buildFilamentDust(
  bandCount: number,
  strandsPerBand: number,
  samples: number,
): { positions: Float32Array; seeds: Float32Array } {
  const random = makeRandom(9137);
  const total = bandCount * strandsPerBand;
  const positions = new Float32Array(total * samples * 3);
  const seeds = new Float32Array(total * samples);
  const point = new THREE.Vector3();
  let index = 0;

  for (let band = 0; band < bandCount; band += 1) {
    const tilt = random() * Math.PI;
    const azimuth = random() * Math.PI * 2;
    const normal = new THREE.Vector3(
      Math.sin(tilt) * Math.cos(azimuth),
      Math.cos(tilt),
      Math.sin(tilt) * Math.sin(azimuth),
    );
    const basisA = new THREE.Vector3(0, 1, 0).cross(normal).normalize();
    const basisB = normal.clone().cross(basisA).normalize();
    const bandPhase = random() * Math.PI * 2;
    const warp = 2.2 + random() * 4.6;

    for (let strand = 0; strand < strandsPerBand; strand += 1) {
      const spread = (strand - (strandsPerBand - 1) / 2) * 0.022;
      const seed = random();
      for (let i = 0; i < samples; i += 1) {
        const a = (i / (samples - 1)) * Math.PI * 2 + bandPhase + spread;
        sampleFilament(normal, basisA, basisB, a, warp, point);
        positions[index * 3] = point.x;
        positions[index * 3 + 1] = point.y;
        positions[index * 3 + 2] = point.z;
        seeds[index] = seed;
        index += 1;
      }
    }
  }

  return { positions, seeds };
}

function createBreathingUniverse(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'breathing-universe';

  const quality = THREE.MathUtils.clamp(ctx.quality, 0.5, 2);
  const random = makeRandom(20261025);

  /* ---------------- 相机：完全静止 ---------------- */

  const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 120);
  camera.position.set(0, CENTER_Y, CAMERA_DISTANCE);
  camera.lookAt(0, CENTER_Y, 0);
  camera.updateProjectionMatrix();

  /* ---------------- 背景穹顶 ---------------- */

  const domeUniforms = {
    uZenith: { value: new THREE.Color('#04060f') },
    uHorizon: { value: new THREE.Color('#0b1024') },
    uGlow: { value: new THREE.Color('#241a3a') },
    uBreath: { value: 0 },
    uTime: { value: 0 },
  };
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(48, 32, 24),
    new THREE.ShaderMaterial({
      uniforms: domeUniforms,
      vertexShader: DOME_VERT,
      fragmentShader: DOME_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    }),
  );
  dome.name = 'universe-dome';
  dome.renderOrder = -1000;
  root.add(dome);

  /* ---------------- 能量球（会呼吸的整体） ---------------- */

  const orb = new THREE.Group();
  orb.name = 'energy-orb';
  orb.position.set(0, CENTER_Y, 0);
  root.add(orb);

  /* ---- 粒子外壳 ---- */

  const shellCount = Math.round(34000 * quality);
  const shellPositions = new Float32Array(shellCount * 3);
  const shellSeeds = new Float32Array(shellCount);
  const shellPhases = new Float32Array(shellCount);
  const shellRands = new Float32Array(shellCount);

  for (let i = 0; i < shellCount; i += 1) {
    // 球面均匀分布
    const u = random() * 2 - 1;
    const theta = random() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - u * u));
    shellPositions[i * 3] = r * Math.cos(theta);
    shellPositions[i * 3 + 1] = u;
    shellPositions[i * 3 + 2] = r * Math.sin(theta);
    shellSeeds[i] = random();
    shellPhases[i] = random() * Math.PI * 2;
    shellRands[i] = random();
  }

  const shellGeometry = new THREE.BufferGeometry();
  shellGeometry.setAttribute('position', new THREE.BufferAttribute(shellPositions, 3));
  shellGeometry.setAttribute('aSeed', new THREE.BufferAttribute(shellSeeds, 1));
  shellGeometry.setAttribute('aPhase', new THREE.BufferAttribute(shellPhases, 1));
  shellGeometry.setAttribute('aRand', new THREE.BufferAttribute(shellRands, 1));

  const shellUniforms = {
    uTime: { value: 0 },
    uBreath: { value: 0 },
    uSize: { value: 1.75 },
    uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
    uFlow: { value: 0.07 },
    uOpacity: { value: 0.34 },
    uGlow: { value: 1 },
    uColorLavender: { value: COLOR_LAVENDER },
    uColorIcy: { value: COLOR_ICY },
    uColorCyan: { value: COLOR_CYAN },
    uColorSilver: { value: COLOR_SILVER },
  };

  const shell = new THREE.Points(
    shellGeometry,
    new THREE.ShaderMaterial({
      uniforms: shellUniforms,
      vertexShader: SHELL_VERT,
      fragmentShader: SHELL_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  shell.name = 'energy-particles';
  shell.frustumCulled = false;
  orb.add(shell);

  /* ---- 流动光丝 ---- */

  const bandCount = Math.max(30, Math.round(56 * quality));
  const strandsPerBand = 5;
  const segments = 96;
  const filaments = buildFilaments(bandCount, strandsPerBand, segments);

  const filamentGeometry = new THREE.BufferGeometry();
  filamentGeometry.setAttribute('position', new THREE.BufferAttribute(filaments.positions, 3));
  filamentGeometry.setAttribute('aArc', new THREE.BufferAttribute(filaments.arcs, 1));
  filamentGeometry.setAttribute('aSeed', new THREE.BufferAttribute(filaments.seeds, 1));

  const filamentUniforms = {
    uTime: { value: 0 },
    uBreath: { value: 0 },
    uSpeed: { value: 0.05 },
    uOpacity: { value: 0.5 },
    uColorLavender: { value: COLOR_LAVENDER },
    uColorCyan: { value: COLOR_CYAN },
    uColorSilver: { value: COLOR_SILVER },
  };

  const filamentMesh = new THREE.LineSegments(
    filamentGeometry,
    new THREE.ShaderMaterial({
      uniforms: filamentUniforms,
      vertexShader: FILAMENT_VERT,
      fragmentShader: FILAMENT_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  filamentMesh.name = 'energy-filaments';
  filamentMesh.frustumCulled = false;
  orb.add(filamentMesh);

  /* ---- 光丝点云：把线条变成柔软的光絮 ---- */

  const dustSamples = 46;
  const filamentDust = buildFilamentDust(bandCount, strandsPerBand, dustSamples);

  const filamentDustGeometry = new THREE.BufferGeometry();
  filamentDustGeometry.setAttribute(
    'position',
    new THREE.BufferAttribute(filamentDust.positions, 3),
  );
  filamentDustGeometry.setAttribute('aSeed', new THREE.BufferAttribute(filamentDust.seeds, 1));

  const filamentDustUniforms = {
    uTime: { value: 0 },
    uBreath: { value: 0 },
    uSpeed: { value: 0.05 },
    uSize: { value: 3.9 },
    uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
    uOpacity: { value: 0.4 },
    uColorLavender: { value: COLOR_LAVENDER },
    uColorCyan: { value: COLOR_CYAN },
  };

  const filamentDustPoints = new THREE.Points(
    filamentDustGeometry,
    new THREE.ShaderMaterial({
      uniforms: filamentDustUniforms,
      vertexShader: /* glsl */ `
        attribute float aSeed;
        uniform float uTime;
        uniform float uBreath;
        uniform float uSpeed;
        uniform float uSize;
        uniform float uPixelRatio;
        varying float vGlow;
        varying float vTone;
        void main() {
          vec4 mv = modelViewMatrix * vec4( position, 1.0 );
          float depth = -mv.z;
          if ( depth <= 0.05 ) {
            gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
            gl_PointSize = 0.0;
            vGlow = 0.0;
            vTone = 0.0;
            return;
          }
          gl_Position = projectionMatrix * mv;
          float travel = fract( uTime * uSpeed + aSeed );
          float d = abs( fract( fract( aSeed * 3.17 ) - travel + 0.5 ) - 0.5 );
          vGlow = exp( -d * 14.0 );
          vTone = fract( aSeed * 5.77 );
          gl_PointSize = min( uSize * uPixelRatio * ( 240.0 / depth ) * ( 0.6 + vGlow * 0.8 ), 18.0 * uPixelRatio );
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uColorLavender;
        uniform vec3 uColorCyan;
        uniform float uOpacity;
        varying float vGlow;
        varying float vTone;
        ${GLSL_OUTPUT_FUNCS}
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length( c );
          if ( d > 0.5 ) discard;
          float a = smoothstep( 0.5, 0.0, d );
          a *= a;
          vec3 col = mix( uColorLavender, uColorCyan, vTone * 0.7 );
          gl_FragColor = vec4( col * ( 0.25 + vGlow * 0.9 ), a * uOpacity * ( 0.2 + vGlow ) );
          ${GLSL_OUTPUT}
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  filamentDustPoints.name = 'energy-filament-dust';
  filamentDustPoints.frustumCulled = false;
  orb.add(filamentDustPoints);

  /* ---- 内核：球心一团柔和的光，让内部不是空的 ---- */

  const coreUniforms = { uIntensity: { value: 0.35 } };
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(SPHERE_RADIUS * 0.62, 48, 32),
    new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color('#7f8cff') },
        uIntensity: coreUniforms.uIntensity,
      },
      vertexShader: /* glsl */ `
        varying vec3 vNormalW;
        varying vec3 vViewW;
        void main() {
          vec4 world = modelMatrix * vec4( position, 1.0 );
          vNormalW = normalize( mat3( modelMatrix ) * normal );
          vViewW = normalize( cameraPosition - world.xyz );
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uColor;
        uniform float uIntensity;
        varying vec3 vNormalW;
        varying vec3 vViewW;
        ${GLSL_OUTPUT_FUNCS}
        void main() {
          float f = pow( abs( dot( normalize( vNormalW ), normalize( vViewW ) ) ), 2.4 );
          gl_FragColor = vec4( uColor * f * uIntensity, f * uIntensity );
          ${GLSL_OUTPUT}
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.FrontSide,
    }),
  );
  core.name = 'energy-core';
  core.position.set(0, CENTER_Y, 0);
  root.add(core);

  /* ---- 光晕壳：代替后处理的辉光，XR 下同样成立 ---- */

  const createHalo = (radius: number, color: string, power: number): THREE.Mesh => {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(color) },
        uIntensity: { value: 1 },
        uPower: { value: power },
      },
      vertexShader: /* glsl */ `
        varying vec3 vNormalW;
        varying vec3 vViewW;
        void main() {
          vec4 world = modelMatrix * vec4( position, 1.0 );
          vNormalW = normalize( mat3( modelMatrix ) * normal );
          vViewW = normalize( cameraPosition - world.xyz );
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uColor;
        uniform float uIntensity;
        uniform float uPower;
        varying vec3 vNormalW;
        varying vec3 vViewW;
        ${GLSL_OUTPUT_FUNCS}
        void main() {
          float f = pow( 1.0 - abs( dot( normalize( vNormalW ), normalize( vViewW ) ) ), uPower );
          gl_FragColor = vec4( uColor * f * uIntensity, f * uIntensity );
          ${GLSL_OUTPUT}
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 32), material);
    mesh.position.set(0, CENTER_Y, 0);
    return mesh;
  };

  const innerHalo = createHalo(SPHERE_RADIUS * 1.07, '#8fa8ff', 4.2);
  innerHalo.name = 'halo-inner';
  innerHalo.renderOrder = -4;
  root.add(innerHalo);

  const outerHalo = createHalo(SPHERE_RADIUS * 2.3, '#7b7fff', 2.0);
  outerHalo.name = 'halo-outer';
  outerHalo.renderOrder = -5;
  root.add(outerHalo);

  /* ---- 边缘薄壳：菲涅尔亮边 ---- */

  const rim = new THREE.Mesh(
    new THREE.SphereGeometry(SPHERE_RADIUS * 1.035, 64, 48),
    new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color('#cfe0ff') },
        uIntensity: { value: 0.5 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vNormalW;
        varying vec3 vViewW;
        void main() {
          vec4 world = modelMatrix * vec4( position, 1.0 );
          vNormalW = normalize( mat3( modelMatrix ) * normal );
          vViewW = normalize( cameraPosition - world.xyz );
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uColor;
        uniform float uIntensity;
        varying vec3 vNormalW;
        varying vec3 vViewW;
        ${GLSL_OUTPUT_FUNCS}
        void main() {
          float f = pow( 1.0 - abs( dot( normalize( vNormalW ), normalize( vViewW ) ) ), 6.5 );
          gl_FragColor = vec4( uColor * f * uIntensity, f * uIntensity );
          ${GLSL_OUTPUT}
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
    }),
  );
  rim.name = 'energy-rim';
  rim.position.set(0, CENTER_Y, 0);
  root.add(rim);

  /* ---------------- 稀疏星尘 ---------------- */

  const dustCount = Math.round(900 * quality);
  const dustPositions = new Float32Array(dustCount * 3);
  const dustSeeds = new Float32Array(dustCount);
  for (let i = 0; i < dustCount; i += 1) {
    const radius = 6 + random() * 22;
    const u = random() * 2 - 1;
    const theta = random() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - u * u));
    dustPositions[i * 3] = r * Math.cos(theta) * radius;
    dustPositions[i * 3 + 1] = u * radius * 0.6;
    dustPositions[i * 3 + 2] = r * Math.sin(theta) * radius;
    dustSeeds[i] = random();
  }
  const dustGeometry = new THREE.BufferGeometry();
  dustGeometry.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3));
  dustGeometry.setAttribute('aSeed', new THREE.BufferAttribute(dustSeeds, 1));

  const dustUniforms = {
    uTime: { value: 0 },
    uSize: { value: 1.15 },
    uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
    uOpacity: { value: 0.42 },
    uColor: { value: new THREE.Color('#cdd8f0') },
  };

  const dust = new THREE.Points(
    dustGeometry,
    new THREE.ShaderMaterial({
      uniforms: dustUniforms,
      vertexShader: /* glsl */ `
        attribute float aSeed;
        uniform float uTime;
        uniform float uSize;
        uniform float uPixelRatio;
        varying float vTwinkle;
        void main() {
          vec3 p = position;
          p.y += sin( uTime * 0.03 + aSeed * 6.2831 ) * 0.35;
          p.x += cos( uTime * 0.021 + aSeed * 4.1 ) * 0.25;
          vec4 mv = modelViewMatrix * vec4( p, 1.0 );
          float depth = -mv.z;
          if ( depth <= 0.05 ) {
            gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
            gl_PointSize = 0.0;
            vTwinkle = 0.0;
            return;
          }
          gl_Position = projectionMatrix * mv;
          gl_PointSize = min( uSize * uPixelRatio * ( 240.0 / depth ), 14.0 * uPixelRatio );
          vTwinkle = 0.45 + 0.55 * sin( uTime * 0.35 + aSeed * 12.0 );
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform float uOpacity;
        uniform vec3 uColor;
        varying float vTwinkle;
        ${GLSL_OUTPUT_FUNCS}
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length( c );
          if ( d > 0.5 ) discard;
          float a = smoothstep( 0.5, 0.0, d );
          a *= a;
          gl_FragColor = vec4( uColor * vTwinkle, a * uOpacity * vTwinkle );
          ${GLSL_OUTPUT}
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  dust.name = 'stardust';
  dust.frustumCulled = false;
  root.add(dust);

  return {
    root,
    camera,
    // 相机自己固定，核心不再摆位
    ownsCamera: true,
    immersive: false,
    xrDistance: 2.6,
    framing: { distance: CAMERA_DISTANCE, height: CENTER_Y, targetY: CENTER_Y },
    update(time: number, delta: number, context: SceneContext): void {
      // 呼吸强度：优先用音乐驱动，没有音乐时自动回落到 4/6 的呼吸节奏
      const breath = context.audio.breathLevel;
      // 音乐的缓慢起伏作为二次调制
      const music = context.audio.level;
      const shimmer = context.audio.pulse;

      // 球体缓慢胀缩
      const scale = 1 + breath * 0.15;
      orb.scale.setScalar(scale);

      shellUniforms.uTime.value = time;
      shellUniforms.uBreath.value = breath;
      shellUniforms.uGlow.value = 0.5 + music * 0.3 + breath * 0.12;
      shellUniforms.uOpacity.value = 0.3 + breath * 0.1;
      shellUniforms.uFlow.value = 0.055 + music * 0.05;

      filamentUniforms.uTime.value = time;
      filamentUniforms.uBreath.value = breath;
      filamentUniforms.uSpeed.value = 0.045 + music * 0.035 + breath * 0.012;
      filamentUniforms.uOpacity.value = 0.26 + breath * 0.18 + shimmer * 0.08;

      domeUniforms.uTime.value = time;
      domeUniforms.uBreath.value = breath;

      const innerMaterial = innerHalo.material as THREE.ShaderMaterial;
      innerMaterial.uniforms.uIntensity.value = 0.13 + breath * 0.16 + music * 0.1;
      const outerMaterial = outerHalo.material as THREE.ShaderMaterial;
      outerMaterial.uniforms.uIntensity.value = 0.075 + breath * 0.1 + music * 0.06;

      const rimMaterial = rim.material as THREE.ShaderMaterial;
      rimMaterial.uniforms.uIntensity.value = 0.1 + breath * 0.14 + shimmer * 0.06;

      dustUniforms.uTime.value = time;
      dustUniforms.uOpacity.value = 0.32 + music * 0.3;

      filamentDustUniforms.uTime.value = time;
      filamentDustUniforms.uBreath.value = breath;
      filamentDustUniforms.uSpeed.value = filamentUniforms.uSpeed.value;
      filamentDustUniforms.uOpacity.value = 0.4 + breath * 0.26 + shimmer * 0.1;

      coreUniforms.uIntensity.value = 0.17 + breath * 0.2 + music * 0.12;

      void delta;
    },
    dispose(): void {
      shellGeometry.dispose();
      filamentGeometry.dispose();
      dustGeometry.dispose();
      filamentDustGeometry.dispose();
      root.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.material) {
          const material = mesh.material as THREE.Material;
          material.dispose();
        }
      });
    },
  };
}

export const breathingUniverseScene: SceneDefinition = {
  id: 'breathing-universe',
  title: '呼吸宇宙',
  subtitle: 'Breathing Universe',
  description: '无限暗色宇宙里悬浮的一颗能量球，4 秒吸气、6 秒呼气，跟着音乐缓慢起伏。',
  tags: ['呼吸', '宇宙', '冥想'],
  accent: '#9fb4ff',
  gradient: ['#0b1024', '#04060f'],
  category: 'meditation',
  // 三段曲目首尾相接、交叉淡化连续播放，撑起十分钟不重复的声景
  audioPlaylist: ['universe-1.mp3', 'universe-2.mp3', 'universe-3.mp3'],
  breathing: BREATHING,
  lighting: {
    exposure: 0.82,
  },
  create(ctx: SceneContext): SceneInstance {
    return createBreathingUniverse(ctx);
  },
};

export default breathingUniverseScene;
