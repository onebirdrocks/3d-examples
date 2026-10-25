/**
 * 落雪夜 / Silent Snowfall
 * ---------------------------------------------------------------
 * 深夜的雪。雪花极缓地飘落（掉完一整段大约 30 秒），每一片在顶点着色器里
 * 都有自己的横向漂移相位，所以永远不会出现整齐划一的「雨」。
 * 远处下方有一栋小屋，窗里透出一点暖黄；地面是厚雪，借着窗光泛出微弱的反光。
 * 整体极暗极静，只有雪在动、窗光在亮。
 *
 * 音乐如何驱动画面：
 * - `pulse` → 窗里的暖光微微明灭；
 * - `bass` → 雪的整体密度与飘落幅度（风更「沉」时雪更密）；
 * - `level` → 雪幕亮度；
 * - `treble` → 雪片边缘的细碎高光。
 */
import * as THREE from 'three';
import type { SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { disposeObject } from '../../core/loader.js';
import { ParticleSpace } from '../../core/particle-space.js';
import { GLSL_HASH, GLSL_OUTPUT, GLSL_OUTPUT_FUNCS } from './glsl.js';
import { SLEEP_CATEGORY, configureStandard, dimLights } from './palette.js';
import { SleepAudioDrive } from './audio-drive.js';
import { createPointGeometry, createPointMaterial, updatePointScale } from './points.js';

const BREATHING = { inhale: 5, hold: 3, exhale: 7 };

const FOV = 52;

/** 小屋的位置：远处、偏下。 */
const CABIN_POS = new THREE.Vector3(-2.6, 0, -9.5);

/** 雪幕覆盖的高度范围（米）。 */
const SNOW_SPAN = 16;

/* ------------------------------------------------------------------ *
 * 背景：深夜的蓝黑
 * ------------------------------------------------------------------ */

const SKY_VERT = /* glsl */ `
varying vec3 vDir;

void main() {
  vDir = normalize( position );
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const SKY_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform float uLevel;

varying vec3 vDir;

${GLSL_HASH}
${GLSL_OUTPUT_FUNCS}

// 稀疏的星：极暗，几乎只是几点微光
float starField( vec3 dir ) {
  vec3 p = dir * 62.0;
  vec3 cell = floor( p );
  vec3 f = fract( p ) - 0.5;
  float h = hash13( cell );
  float on = step( 0.9955, h );
  float d = length( f );
  float twinkle = 0.72 + 0.28 * sin( uLevel * 2.0 + h * 60.0 );
  return on * exp( -d * d * 70.0 ) * twinkle;
}

void main() {
  float y = vDir.y;
  vec3 col = mix( uHorizon, uZenith, smoothstep( -0.02, 0.62, y ) );
  col = mix( col, uGround, smoothstep( 0.0, -0.26, y ) );
  col += vec3( 0.62, 0.70, 0.86 ) * starField( normalize( vDir ) ) * 0.42 * smoothstep( 0.02, 0.28, y );
  gl_FragColor = vec4( col, 1.0 );
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * 雪：每片有独立的横向漂移相位
 * ------------------------------------------------------------------ */

const SNOW_VERT = /* glsl */ `
attribute float aSize;
attribute float aPhase;
attribute float aDrift;

uniform float uTime;
uniform float uScale;
uniform float uBass;
uniform float uLevel;
uniform float uTreble;
uniform float uSpan;

varying float vAlpha;
varying float vSparkle;

void main() {
  vec3 p = position;

  // 垂直方向：极缓地下落，掉完整段 uSpan 需要约 30 秒
  float fall = uTime * ( uSpan / 30.0 ) * ( 0.78 + 0.44 * aDrift );
  p.y = mod( p.y - fall + uSpan * 0.5, uSpan ) - uSpan * 0.5;

  // 横向漂移：每片雪自己的相位与频率，绝不成群结队
  float t = uTime * 0.12 + aPhase * 6.2831;
  float amp = 0.16 + 0.5 * aDrift + uBass * 0.28;
  p.x += sin( t ) * amp;
  p.z += cos( t * 0.83 + aPhase * 3.1 ) * amp * 0.8;
  p.x += sin( uTime * 0.041 + aPhase * 12.7 ) * 0.24;
  p.z += cos( uTime * 0.037 + aPhase * 9.3 ) * 0.2;

  vec4 mv = modelViewMatrix * vec4( particleSpaceTransform( p ), 1.0 );
  gl_Position = projectionMatrix * mv;

  // 明暗极缓；高只带来一点点边缘的细碎微光
  float dim = 0.82 + 0.18 * sin( uTime * 0.07 + aPhase * 9.1 );
  vAlpha = dim * ( 0.62 + 0.7 * uLevel );
  vSparkle = uTreble * 0.5;

  gl_PointSize = min( uScale * aSize * ( 0.9 + 0.25 * uBass ) / max( 1.0, -mv.z ), 7.0 );
}
`;

const SNOW_FRAG = /* glsl */ `
precision highp float;

uniform float uOpacity;

varying float vAlpha;
varying float vSparkle;

${GLSL_OUTPUT_FUNCS}

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot( c, c );
  if ( d2 > 0.25 ) discard;

  // 柔边圆点，中间略实
  float core = exp( -d2 * 13.0 );
  float edge = exp( -d2 * 4.5 ) * 0.3;
  float alpha = ( core + edge ) * vAlpha * uOpacity;
  if ( alpha < 0.004 ) discard;

  vec3 tint = mix( vec3( 0.80, 0.86, 1.0 ), vec3( 1.0, 0.97, 0.92 ), vSparkle );
  gl_FragColor = vec4( tint, alpha );
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * 地面上的雪光：小屋窗光落在雪地上的一小片反射
 * ------------------------------------------------------------------ */

const SNOW_GROUND_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uWarm;
uniform float uPulse;
uniform float uLevel;
uniform vec3 uLampPos;

varying vec3 vWorld;

${GLSL_HASH}
${GLSL_OUTPUT_FUNCS}

void main() {
  // 雪面上一层很淡的颗粒感（细密，不要出现方块）
  float grain = hash12( floor( vWorld.xz * 180.0 ) );
  vec3 col = vec3( 0.026, 0.030, 0.042 ) * ( 0.7 + 0.6 * grain );

  // 窗光在雪面上的反射：靠近小屋的那一小片更亮
  float d = distance( vWorld.xz, uLampPos.xz );
  float glow = exp( -d * d * 0.55 );
  col += uWarm * glow * ( 0.22 + 0.3 * uPulse );

  // 远处的雪渐渐融进夜色
  float dist = length( vWorld - cameraPosition );
  float fade = 1.0 - smoothstep( 6.0, 26.0, dist );
  col *= 0.18 + 0.82 * fade;
  col *= 0.72 + 0.4 * uLevel;

  gl_FragColor = vec4( col, 1.0 );
  ${GLSL_OUTPUT}
}
`;

const SNOW_GROUND_VERT = /* glsl */ `
varying vec3 vWorld;

void main() {
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

function createSnowfall(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'snowfall-scene';

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 260);
  camera.position.set(0, 1.55, 5.6);
  camera.lookAt(CABIN_POS.x * 0.5, 1.15, CABIN_POS.z * 0.55);

  // ── 夜空 ──────────────────────────────────────────────────────────────
  const skyUniforms = {
    uZenith: { value: new THREE.Color(0x04060f) },
    uHorizon: { value: new THREE.Color(0x0a1020) },
    uGround: { value: new THREE.Color(0x03050b) },
    uLevel: { value: 0 },
  };
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(150, 32, 20),
    new THREE.ShaderMaterial({
      uniforms: skyUniforms,
      vertexShader: SKY_VERT,
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

  // ── 雪地 ──────────────────────────────────────────────────────────────
  // 用核心给的地面（一张水平大平面），换掉材质做成会反光的雪面
  const ground = ctx.env.createGround(70) as THREE.Mesh;
  const groundUniforms = {
    uWarm: { value: new THREE.Color(0xffb974) },
    uPulse: { value: 0 },
    uLevel: { value: 0 },
    uLampPos: { value: new THREE.Vector3(CABIN_POS.x, 0.98, CABIN_POS.z + 1.2) },
  };
  ground.material = new THREE.ShaderMaterial({
    uniforms: groundUniforms,
    vertexShader: SNOW_GROUND_VERT,
    fragmentShader: SNOW_GROUND_FRAG,
  });
  ground.name = 'snow-ground';
  ground.position.y = 0;
  root.add(ground);

  // ── 小屋 ──────────────────────────────────────────────────────────────
  const cabin = new THREE.Group();
  cabin.name = 'cabin';
  cabin.position.copy(CABIN_POS);
  root.add(cabin);

  const wallMaterial = new THREE.MeshStandardMaterial({
    color: 0x0a0c12,
    roughness: 0.95,
    metalness: 0,
  });
  configureStandard(wallMaterial, ctx.env.envMap, 0.05);

  const body = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.7, 1.9), wallMaterial);
  body.name = 'cabin-body';
  body.position.y = 0.85;
  cabin.add(body);

  // 屋顶：两片斜板交成屋脊
  const roofMaterial = new THREE.MeshStandardMaterial({
    color: 0x11141c,
    roughness: 0.9,
    metalness: 0,
  });
  configureStandard(roofMaterial, ctx.env.envMap, 0.06);

  for (const side of [-1, 1]) {
    const roof = new THREE.Mesh(new THREE.BoxGeometry(1.68, 0.1, 2.2), roofMaterial);
    roof.name = 'cabin-roof';
    // 屋脊落在 x = 0：斜板中心沿 x 偏移半长的投影
    roof.position.set(side * 0.56, 2.02, 0);
    roof.rotation.z = side * -0.6;
    cabin.add(roof);
  }

  // 屋脊上的一点积雪
  const snowCap = new THREE.Mesh(
    new THREE.BoxGeometry(0.16, 0.07, 2.24),
    new THREE.MeshStandardMaterial({ color: 0x1b2333, roughness: 1, metalness: 0 }),
  );
  snowCap.name = 'cabin-snow';
  snowCap.position.y = 2.51;
  cabin.add(snowCap);

  // 窗：一小块暖黄
  const windowUniforms = {
    uPulse: { value: 0 },
  };
  const windowMaterial = new THREE.ShaderMaterial({
    uniforms: windowUniforms,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uPulse;
      varying vec2 vUv;
      ${GLSL_OUTPUT_FUNCS}
      void main() {
        vec3 warm = vec3( 1.0, 0.72, 0.36 );
        // 窗内的光不均匀，边缘更暗
        vec2 d = abs( vUv - 0.5 ) * 2.0;
        float edge = ( 1.0 - smoothstep( 0.55, 1.0, max( d.x, d.y ) ) );
        float flick = 0.86 + 0.14 * sin( uPulse * 6.2831 + vUv.y * 3.0 );
        gl_FragColor = vec4( warm * edge * flick * ( 0.75 + 0.45 * uPulse ), edge );
        ${GLSL_OUTPUT}
      }
    `,
    transparent: true,
    depthWrite: false,
  });
  const windowMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.44, 0.34), windowMaterial);
  windowMesh.name = 'cabin-window';
  windowMesh.position.set(0.32, 0.98, 0.96);
  cabin.add(windowMesh);

  // 窗光的暖光晕
  const haloTexture = (() => {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx2 = canvas.getContext('2d');
    if (!ctx2) throw new Error('无法创建 2D 画布上下文');
    const image = ctx2.createImageData(128, 128);
    for (let y = 0; y < 128; y += 1) {
      for (let x = 0; x < 128; x += 1) {
        const dx = (x + 0.5 - 64) / 64;
        const dy = (y + 0.5 - 64) / 64;
        const d = Math.min(1, Math.hypot(dx, dy));
        const a = Math.pow(1 - d, 3.0);
        const i = (y * 128 + x) * 4;
        image.data[i] = 255;
        image.data[i + 1] = 210;
        image.data[i + 2] = 150;
        image.data[i + 3] = Math.round(a * 255);
      }
    }
    ctx2.putImageData(image, 0, 0);
    const texture = new THREE.CanvasTexture(canvas);
    texture.name = 'window-halo';
    texture.needsUpdate = true;
    return texture;
  })();

  const haloMaterial = new THREE.MeshBasicMaterial({
    map: haloTexture,
    color: 0xffc487,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const halo = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 3.6), haloMaterial);
  halo.name = 'cabin-halo';
  halo.position.set(0.32, 0.98, 1.05);
  cabin.add(halo);

  // 窗光在雪面上的一小片暖色反射
  const windowLight = new THREE.PointLight(0xffb066, 2.2, 9, 2);
  windowLight.name = 'window-light';
  windowLight.position.set(CABIN_POS.x + 0.32, 0.98, CABIN_POS.z + 1.2);
  root.add(windowLight);

  // ── 雪幕 ──────────────────────────────────────────────────────────────
  const space = new ParticleSpace({
    radius: 9,
    spin: 0.005,
    tilt: 0.1,
    position: [0, 3.4, 0],
  });

  const snowUniforms = {
    uTime: { value: 0 },
    uScale: { value: 600 },
    uOpacity: { value: 0.62 },
    uBass: { value: 0 },
    uLevel: { value: 0 },
    uTreble: { value: 0 },
    uSpan: { value: SNOW_SPAN },
  };
  const snowGeometry = createPointGeometry({
    count: Math.floor(7000 * ctx.quality),
    seed: 7734,
    radius: 7,
    size: 0.03,
    attributes: [{ name: 'aDrift', size: 1, min: 0, max: 1 }],
  });
  const snowMaterial = createPointMaterial(space, {
    vertexShader: SNOW_VERT,
    fragmentShader: SNOW_FRAG,
    uniforms: snowUniforms,
  });
  const snow = new THREE.Points(snowGeometry, snowMaterial);
  snow.name = 'snowfall';
  snow.frustumCulled = false;
  root.add(snow);

  // ── 灯光 ──────────────────────────────────────────────────────────────
  const lights = ctx.env.createStudioLights();
  dimLights(lights, 0.035, 0x35405c);
  root.add(lights);

  const audio = new SleepAudioDrive(BREATHING);

  return {
    root,
    camera,
    immersive: true,
    xrDistance: 3,
    framing: { distance: 5.6, height: 1.55, targetY: 1.15, width: 9 },
    update(time: number, delta: number, context: SceneContext): void {
      audio.update(time, delta, context);
      const state = audio.state;

      space.breathe = 1 + state.bass * 0.06 + state.drive * 0.03;
      space.breathPhase = state.breath;
      space.update(delta, time);

      snowUniforms.uTime.value = time;
      snowUniforms.uBass.value = state.bass;
      snowUniforms.uLevel.value = state.level;
      snowUniforms.uTreble.value = state.treble;
      snowUniforms.uOpacity.value = 0.62 + state.level * 0.38;
      updatePointScale(snowUniforms.uScale, context, FOV);

      skyUniforms.uLevel.value = state.level;

      // 窗光随音乐脉冲微微明灭
      windowUniforms.uPulse.value = state.pulse;
      haloMaterial.opacity = 0.42 + state.pulse * 0.3;
      halo.scale.setScalar(0.94 + state.pulse * 0.12);
      windowLight.intensity = 1.9 + state.pulse * 1.1 + state.level * 0.5;

      // 雪地上的窗光反射
      groundUniforms.uPulse.value = state.pulse;
      groundUniforms.uLevel.value = state.level;
    },
    dispose(): void {
      haloTexture.dispose();
      disposeObject(root);
    },
  };
}

export const snowfallScene: SceneDefinition = {
  id: 'snowfall',
  title: '落雪夜',
  subtitle: 'Silent Snowfall',
  description: '雪无声地落了一整夜，远处小屋的窗里还留着一点暖黄的光。',
  tags: ['雪', '夜', '小屋'],
  accent: '#8fa6c8',
  gradient: ['#0d1526', '#03050b'],
  category: SLEEP_CATEGORY,
  audio: 'enigma-monastery.mp3',
  breathing: BREATHING,
  lighting: {
    autoExposure: true,
    autoExposureKey: 0.065,
  },
  create(ctx: SceneContext): SceneInstance {
    return createSnowfall(ctx);
  },
};

export default snowfallScene;
