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
  PARTICLE_SPACE_GLSL,
  applyHaze,
  createSkyDome,
} from './lib.js';

/**
 * 旷野风声 / Open Snowfield
 *
 * 无边的雪原：低矮的雪丘起伏，被风卷起的雪雾贴着地表流动，远处的地平线
 * 在灰白的天光里模糊成一条线。极简、极静。
 *
 * 音乐驱动：
 * - pulse → 风的强度（雪雾的流速、密度）；
 * - bass → 雪丘上极缓慢的起伏；mid → 雪雾的流动；treble → 细碎雪粒的闪烁；
 * - level → 能见度（雾的浓度）与整体亮度。
 */

const BREATHING = { inhale: 6, hold: 2, exhale: 8, holdOut: 2 };
const FOV = 50;

const HAZE = 0xc3ccd4;

/* ------------------------------------------------------------------ *
 * 雪雾粒子
 * ------------------------------------------------------------------ */

const DRIFT_VERT = /* glsl */ `
attribute float aSize;
attribute float aPhase;
attribute float aSeed;

uniform float uTime;
uniform float uScale;
uniform float uOpacity;
uniform float uHeight;
uniform float uRadius;
uniform float uWind;

varying float vAlpha;
varying float vSoft;

${PARTICLE_SPACE_GLSL}

void main() {
  vec3 p = position;

  // 贴地：高度始终压在地面附近
  p.y = 0.06 + fract( aSeed ) * uHeight + sin( uTime * 0.25 + aPhase * 6.2831 ) * 0.1;

  // 风：横向漂移并在边界处循环
  p.x = mod( p.x + uTime * uWind + uRadius, uRadius * 2.0 ) - uRadius;
  p.z = mod( p.z + uRadius + sin( uTime * 0.06 + aPhase ) * 0.8, uRadius * 2.0 ) - uRadius;

  vec3 world = particleSpaceTransform( p );
  vec4 mv = modelViewMatrix * vec4( world, 1.0 );
  gl_Position = projectionMatrix * mv;

  // 边缘淡出，避免粒子在边界处突然出现
  float d = length( p.xz ) / uRadius;
  float fade = smoothstep( 1.0, 0.78, d ) * smoothstep( 0.0, 0.12, d );

  float shimmer = 0.82 + 0.18 * sin( uTime * 0.4 + aPhase * 3.1 );
  float nearFade = smoothstep( 1.5, 5.0, -mv.z );
  vAlpha = uOpacity * fade * shimmer * nearFade;
  vSoft = 0.6 + 0.4 * fract( aSeed * 7.3 );

  gl_PointSize = aSize * uScale / max( 1.0, -mv.z );
}
`;

const DRIFT_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uColor;

varying float vAlpha;
varying float vSoft;

${GLSL_OUTPUT_FUNCS}

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot( c, c );
  if ( d2 > 0.25 ) discard;
  float falloff = exp( -d2 * ( 3.2 + vSoft * 4.0 ) );
  float a = falloff * vAlpha;
  if ( a < 0.004 ) discard;
  gl_FragColor = vec4( uColor, a );
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * 雪面
 * ------------------------------------------------------------------ */

const SNOW_HEIGHT = /* glsl */ `
float snowHeight( vec2 p ) {
  float dune = fbm2( p * 0.028, 4 ) - 0.5;
  float drift = fbm2( p * 0.14 + 7.3, 3 ) - 0.5;
  return dune * 2.6 + drift * 0.55;
}
`;

/* ------------------------------------------------------------------ *
 * 场景
 * ------------------------------------------------------------------ */

function createSnowfield(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'snowfield-scene';

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 900);
  camera.position.set(0, 1.7, 6.5);

  const quality = THREE.MathUtils.clamp(ctx.quality, 0.4, 2);
  const driver = new AudioDriver();

  // ── 天空（阴天的灰白） ───────────────────────────────────────────────
  const sky = createSkyDome({
    zenith: 0x6d7a89,
    horizon: 0xa6b2be,
    ground: 0x86939f,
    radius: 700,
    bandColor: 0xbcc7d1,
    bandStrength: 0.3,
    bandY: 0.02,
    bandWidth: 0.12,
  });
  root.add(sky.mesh);

  // ── 地面 ─────────────────────────────────────────────────────────────
  const baseGround = ctx.env.createGround(600);
  baseGround.position.y = -2.4;
  const baseGroundMaterial = (baseGround as THREE.Mesh).material as THREE.MeshStandardMaterial;
  baseGroundMaterial.envMap = ctx.env.envMap;
  baseGroundMaterial.envMapIntensity = 0.05;
  root.add(baseGround);

  const snowUniforms = {
    uTime: { value: 0 },
    uRipple: { value: 0 },
    uWind: { value: 0 },
  };

  const snowMaterial = new THREE.MeshStandardMaterial({
    color: 0xd9e3ef,
    roughness: 0.93,
    metalness: 0.0,
  });
  snowMaterial.envMap = ctx.env.envMap;
  snowMaterial.envMapIntensity = 0.12;
  applyHaze(snowMaterial, { color: HAZE, near: 28, far: 185 });

  const previousCompile = snowMaterial.onBeforeCompile;
  snowMaterial.onBeforeCompile = (shader, renderer) => {
    previousCompile?.(shader, renderer);
    shader.uniforms.uTime = snowUniforms.uTime;
    shader.uniforms.uRipple = snowUniforms.uRipple;
    shader.uniforms.uWind = snowUniforms.uWind;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\nuniform float uTime;\nuniform float uRipple;\nvarying vec3 vSnowWorld;\n${GLSL_HASH}\n${GLSL_NOISE2}\n${SNOW_HEIGHT}`,
      )
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\n\tvSnowWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;',
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
  float duneH = snowHeight( transformed.xz );
  // 相机附近压平，避免站进雪丘里
  duneH *= smoothstep( 9.0, 46.0, distance( transformed.xz, vec2( 0.0, 66.5 ) ) );
  transformed.y += duneH;
  // 低频带来的、极缓慢的雪面起伏
  transformed.y += sin( transformed.x * 0.085 + uTime * 0.33 ) * cos( transformed.z * 0.065 - uTime * 0.21 ) * uRipple;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nuniform float uTime;\nuniform float uWind;\nvarying vec3 vSnowWorld;\n${GLSL_HASH}\n${GLSL_NOISE2}`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
  // 风吹出的雪纹：沿风向缓慢移动，让「风」看得见
  float streak = fbm2( vec2( vSnowWorld.x * 0.32 + uTime * uWind * 0.3, vSnowWorld.z * 0.055 ), 3 );
  diffuseColor.rgb *= 0.9 + 0.16 * streak;`,
      );
  };
  snowMaterial.needsUpdate = true;

  const segments = Math.round(190 * quality);
  const snowGeometry = new THREE.PlaneGeometry(420, 420, segments, segments);
  snowGeometry.rotateX(-Math.PI / 2);
  const snow = new THREE.Mesh(snowGeometry, snowMaterial);
  snow.name = 'snowfield';
  snow.position.set(0, 0, -60);
  root.add(snow);

  // 远处的雪脊，给地平线一点层次
  const ridgeMaterial = new THREE.MeshStandardMaterial({
    color: 0xa4b0bd,
    roughness: 1,
    metalness: 0,
  });
  ridgeMaterial.envMap = ctx.env.envMap;
  ridgeMaterial.envMapIntensity = 0.05;
  applyHaze(ridgeMaterial, { color: HAZE, near: 90, far: 320 });

  for (let i = 0; i < 4; i += 1) {
    const ridge = new THREE.Mesh(new THREE.ConeGeometry(70 + i * 26, 9 + i * 3, 6, 1), ridgeMaterial);
    ridge.name = 'distant-ridge';
    ridge.position.set(-190 + i * 130, -2 + i * 0.6, -250 - i * 42);
    ridge.scale.set(1.7, 1, 0.5);
    root.add(ridge);
  }

  // ── 贴地的雪雾 ───────────────────────────────────────────────────────
  const driftSpace = new ParticleSpace({
    radius: 13,
    spin: 0.008,
    tilt: 0.04,
    position: [0, 0.05, 1.5],
  });

  const driftCount = Math.round(1500 * quality);
  const driftPositions = new Float32Array(driftCount * 3);
  const driftSizes = new Float32Array(driftCount);
  const driftPhases = new Float32Array(driftCount);
  const driftSeeds = new Float32Array(driftCount);

  let state = 60613;
  const random = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };

  for (let i = 0; i < driftCount; i += 1) {
    driftPositions[i * 3] = (random() * 2 - 1) * 13;
    driftPositions[i * 3 + 1] = random();
    driftPositions[i * 3 + 2] = (random() * 2 - 1) * 13;
    driftSizes[i] = 0.35 + random() * 0.95;
    driftPhases[i] = random();
    driftSeeds[i] = random();
  }

  const driftGeometry = new THREE.BufferGeometry();
  driftGeometry.setAttribute('position', new THREE.BufferAttribute(driftPositions, 3));
  driftGeometry.setAttribute('aSize', new THREE.BufferAttribute(driftSizes, 1));
  driftGeometry.setAttribute('aPhase', new THREE.BufferAttribute(driftPhases, 1));
  driftGeometry.setAttribute('aSeed', new THREE.BufferAttribute(driftSeeds, 1));

  const driftUniforms = {
    uTime: { value: 0 },
    uScale: { value: 600 },
    uOpacity: { value: 0.3 },
    uHeight: { value: 0.62 },
    uRadius: { value: 13 },
    uWind: { value: 0.5 },
    uColor: { value: new THREE.Color(0xf2f6fa) },
    particleMatrix: driftSpace.uniform,
  };

  const driftMaterial = new THREE.ShaderMaterial({
    uniforms: driftUniforms,
    vertexShader: DRIFT_VERT,
    fragmentShader: DRIFT_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
  });

  const drift = new THREE.Points(driftGeometry, driftMaterial);
  drift.name = 'snow-drift';
  drift.frustumCulled = false;
  drift.renderOrder = 2;
  root.add(drift);

  // ── 灯光 ─────────────────────────────────────────────────────────────
  const lights = ctx.env.createStudioLights();
  lights.traverse((child) => {
    if (child instanceof THREE.Light) {
      child.intensity *= 0.35;
      child.castShadow = false;
      child.color.setHex(0xd8e2ec);
    }
  });
  root.add(lights);

  const skyLight = new THREE.HemisphereLight(0xcfdce8, 0x8b98a6, 1.15);
  root.add(skyLight);

  const updateScale = (context: SceneContext): void => {
    const halfFov = THREE.MathUtils.degToRad(FOV) * 0.5;
    driftUniforms.uScale.value =
      (context.height * 0.5 * context.renderer.getPixelRatio()) / Math.tan(halfFov);
  };
  updateScale(ctx);

  return {
    root,
    camera,
    immersive: true,
    xrDistance: 3,
    framing: { distance: 6.5, height: 1.7, targetY: 1.55, width: 24 },
    update(time: number, delta: number, context: SceneContext): void {
      driver.update(context, delta);

      const pulse = driver.pulse;
      const level = driver.level;

      sky.uniforms.uTime.value = time;
      sky.uniforms.uLevel.value = level;

      // 风：脉冲决定雪雾的流速与密度
      driftUniforms.uTime.value = time;
      driftUniforms.uWind.value = 0.3 + pulse * 2.2 + driver.mid * 0.6;
      driftUniforms.uOpacity.value = 0.07 + pulse * 0.2 + level * 0.05;
      updateScale(context);

      driftSpace.breathe = 1 + pulse * 0.03;
      driftSpace.breathPhase = pulse;
      driftSpace.update(delta, time);

      // 雪丘：低频带来极缓慢的起伏
      snowUniforms.uTime.value = time;
      snowUniforms.uRipple.value = driver.bass * 0.34 + pulse * 0.1;
      snowUniforms.uWind.value = 0.2 + pulse * 1.5 + driver.mid * 0.45;

      // 能见度：响度越大，雾越浓
      snowMaterial.envMapIntensity = 0.08 + level * 0.08;
      sky.uniforms.uBandStrength.value = 0.45 + level * 0.35;
      skyLight.intensity = 1.0 + level * 0.45;
    },
    dispose(): void {
      disposeObject(root);
    },
  };
}

export const snowfieldScene: SceneDefinition = {
  id: 'snowfield',
  title: '旷野风声',
  subtitle: 'Open Snowfield',
  description: '无边的雪原上，雪雾贴着地面被风推着走，地平线模糊成一条线。',
  tags: ['雪原', '风', '极简'],
  accent: '#cfe0ee',
  gradient: ['#8fa3b4', '#3d4a57'],
  category: 'environment',
  audio: 'snowfield-wind.mp3',
  breathing: BREATHING,
  create(ctx: SceneContext): SceneInstance {
    return createSnowfield(ctx);
  },
};

export default snowfieldScene;
