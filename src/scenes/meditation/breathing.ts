import * as THREE from 'three';
import type { SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { disposeObject } from '../../core/loader.js';
import { ParticleSpace, wrapParticleField } from '../../core/particle-space.js';
import { createBreathSample, sampleBreath } from './lib/breath.js';
import {
  GLSL_HASH,
  GLSL_NOISE3,
  GLSL_OUTPUT,
  GLSL_OUTPUT_FUNCS,
  createBackdropDome,
  createRadialGlowTexture,
  createSoftParticleField,
  dimStudioLights,
  disposeMeshMaterial,
  updateParticleScale,
} from './lib/gfx.js';

/**
 * 呼吸之光
 *
 * 暗室中央悬浮一团柔光：核心是一个缓慢流动的暖色光核，外面套着两层
 * 半透明球壳（噪声扰动出体积感），最外是一圈随呼吸起伏的薄光环；
 * 地面上有同步呼吸的柔光倒影。整团光与地上的尘埃一起随呼吸缓慢涨落。
 */

const BREATHING = { inhale: 4, hold: 7, exhale: 8 };

/** 光球悬浮的高度。 */
const ORB_Y = 1.32;

const FOV = 48;

const SHELL_VERT = /* glsl */ `
varying vec3 vNormalV;
varying vec3 vViewV;
varying vec3 vLocal;

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vLocal = position;
  vNormalV = normalize(normalMatrix * normal);
  vViewV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

const SHELL_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uIntensity;
uniform float uPower;
uniform float uFlow;
uniform vec3 uColor;
uniform vec3 uColorLow;

varying vec3 vNormalV;
varying vec3 vViewV;
varying vec3 vLocal;

${GLSL_HASH}
${GLSL_NOISE3}
${GLSL_OUTPUT_FUNCS}

void main() {
  float ndv = clamp(dot(normalize(vNormalV), normalize(vViewV)), 0.0, 1.0);
  float fres = pow(1.0 - ndv, uPower);

  // 极缓慢流动的体积感噪声
  float n = fbm3(vLocal * 2.4 + vec3(uTime * uFlow, uTime * uFlow * 0.42, -uTime * uFlow * 0.27));
  float body = 0.52 + 0.48 * (n * 0.5 + 0.5);

  float alpha = fres * body * uIntensity;
  if (alpha < 0.003) discard;

  vec3 col = mix(uColorLow, uColor, n * 0.5 + 0.5);
  gl_FragColor = vec4(col, alpha);
  ${GLSL_OUTPUT}
}
`;

const CORE_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uIntensity;
uniform vec3 uColor;

varying vec3 vNormalV;
varying vec3 vViewV;
varying vec3 vLocal;

${GLSL_HASH}
${GLSL_NOISE3}
${GLSL_OUTPUT_FUNCS}

void main() {
  float ndv = clamp(dot(normalize(vNormalV), normalize(vViewV)), 0.0, 1.0);
  float body = pow(ndv, 1.5);

  // 光核内部极缓慢的流动
  float n = fbm3(vLocal * 3.1 + vec3(0.0, uTime * 0.045, uTime * 0.02));
  float alpha = body * (0.78 + 0.34 * (n * 0.5 + 0.5)) * uIntensity;
  if (alpha < 0.003) discard;

  vec3 col = mix(uColor, vec3(1.0, 0.93, 0.82), 0.35 + 0.25 * (n * 0.5 + 0.5));
  gl_FragColor = vec4(col, alpha);
  ${GLSL_OUTPUT}
}
`;

function createBreathing(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'breathing-scene';

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 220);
  camera.position.set(0, 1.5, 3.0);
  camera.lookAt(0, 1.62, 0);

  // ── 暗室 ──────────────────────────────────────────────────────────────
  const backdrop = createBackdropDome({
    zenith: 0x070b16,
    horizon: 0x16203c,
    ground: 0x05070c,
    radius: 42,
  });
  root.add(backdrop.mesh);

  const ground = ctx.env.createGround(26) as THREE.Mesh;
  const groundMaterial = new THREE.MeshStandardMaterial({
    color: 0x0a0c11,
    roughness: 1,
    metalness: 0,
    envMapIntensity: 0.05,
  });
  groundMaterial.envMap = ctx.env.envMap;
  disposeMeshMaterial(ground);
  ground.material = groundMaterial;
  root.add(ground);

  // ── 光球 ──────────────────────────────────────────────────────────────
  const orb = new THREE.Group();
  orb.name = 'orb';
  orb.position.set(0, ORB_Y, 0);
  root.add(orb);

  const shellUniforms = {
    uTime: { value: 0 },
    uIntensity: { value: 0.4 },
    uPower: { value: 2.2 },
    uFlow: { value: 0.055 },
    uColor: { value: new THREE.Color(0xe8c48f) },
    uColorLow: { value: new THREE.Color(0x7d8f7a) },
  };
  const shellMaterial = new THREE.ShaderMaterial({
    uniforms: shellUniforms,
    vertexShader: SHELL_VERT,
    fragmentShader: SHELL_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const innerUniforms = {
    uTime: { value: 0 },
    uIntensity: { value: 0.4 },
    uPower: { value: 1.5 },
    uFlow: { value: 0.075 },
    uColor: { value: new THREE.Color(0xd9a066) },
    uColorLow: { value: new THREE.Color(0x9a7f5f) },
  };
  const innerMaterial = new THREE.ShaderMaterial({
    uniforms: innerUniforms,
    vertexShader: SHELL_VERT,
    fragmentShader: SHELL_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const coreUniforms = {
    uTime: { value: 0 },
    uIntensity: { value: 0.9 },
    uColor: { value: new THREE.Color(0xf2c489) },
  };
  const coreMaterial = new THREE.ShaderMaterial({
    uniforms: coreUniforms,
    vertexShader: SHELL_VERT,
    fragmentShader: CORE_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const outerShell = new THREE.Mesh(new THREE.SphereGeometry(0.62, 48, 32), shellMaterial);
  outerShell.name = 'outer-shell';
  outerShell.renderOrder = 2;
  orb.add(outerShell);

  const innerShell = new THREE.Mesh(new THREE.SphereGeometry(0.38, 40, 28), innerMaterial);
  innerShell.name = 'inner-shell';
  innerShell.renderOrder = 3;
  orb.add(innerShell);

  const core = new THREE.Mesh(new THREE.SphereGeometry(0.19, 32, 24), coreMaterial);
  core.name = 'core';
  core.renderOrder = 4;
  orb.add(core);

  // 薄光环
  const haloMaterial = new THREE.MeshBasicMaterial({
    color: 0xe8c48f,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const halo = new THREE.Mesh(new THREE.TorusGeometry(0.98, 0.0065, 6, 180), haloMaterial);
  halo.name = 'halo';
  halo.rotation.set(0.08, 0.22, 0);
  halo.renderOrder = 5;
  orb.add(halo);

  // ── 地面上的柔光倒影 ──────────────────────────────────────────────────
  const glowTexture = createRadialGlowTexture(128, 2.6);
  const reflectionMaterial = new THREE.MeshBasicMaterial({
    map: glowTexture,
    color: 0xe0a86c,
    transparent: true,
    opacity: 0.26,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const reflection = new THREE.Mesh(new THREE.PlaneGeometry(3.8, 3.8), reflectionMaterial);
  reflection.name = 'reflection';
  reflection.rotation.x = -Math.PI / 2;
  reflection.position.y = 0.012;
  root.add(reflection);

  const hotMaterial = new THREE.MeshBasicMaterial({
    map: glowTexture,
    color: 0xf0c489,
    transparent: true,
    opacity: 0.2,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const hotSpot = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.5), hotMaterial);
  hotSpot.name = 'reflection-hotspot';
  hotSpot.rotation.x = -Math.PI / 2;
  hotSpot.position.set(0, 0.02, 0.15);
  root.add(hotSpot);

  // 光球自身对地面的照亮
  const light = new THREE.PointLight(0xffcf9a, 2.2, 11, 2);
  light.position.set(0, ORB_Y, 0);
  root.add(light);

  // ── 空气里的尘埃 ──────────────────────────────────────────────────────
  const space = new ParticleSpace({
    radius: 3.4,
    spin: 0.008,
    tilt: 0.18,
    position: [0, 1.4, 0],
  });
  const dust = createSoftParticleField(space, Math.floor(420 * ctx.quality), {
    size: 0.028,
    color: new THREE.Color(0xd9c9a8),
    opacity: 0.42,
    seed: 4311,
    wander: 0.07,
  });
  root.add(dust.points);

  // ── 灯光 ──────────────────────────────────────────────────────────────
  const lights = ctx.env.createStudioLights();
  dimStudioLights(lights, 0.05, 0x3a4460);
  root.add(lights);

  const breath = createBreathSample();

  return {
    root,
    camera,
    immersive: false,
    xrDistance: 2.5,
    framing: { distance: 3.0, height: 1.5, targetY: 1.62, width: 3.4 },
    update(time: number, delta: number, context: SceneContext): void {
      sampleBreath(BREATHING, time, breath);
      const level = breath.level;

      // 整片粒子场参与呼吸
      space.breathe = 1 + level * 0.12;
      space.breathPhase = level;
      space.update(delta, time);
      wrapParticleField(dust.points, space.radius, delta, 0.012);

      dust.uniforms.uTime.value = time;
      dust.uniforms.uBreath.value = level;
      updateParticleScale(dust.uniforms, context, FOV);

      // 光球：涨落 + 亮度
      const scale = 1 + level * 0.13;
      orb.scale.setScalar(scale);
      orb.position.y = ORB_Y + Math.sin((time * Math.PI * 2) / 52) * 0.035;

      shellUniforms.uTime.value = time;
      shellUniforms.uIntensity.value = 0.26 + level * 0.2;
      innerUniforms.uTime.value = time;
      innerUniforms.uIntensity.value = 0.34 + level * 0.26;
      coreUniforms.uTime.value = time;
      coreUniforms.uIntensity.value = 0.72 + level * 0.34;

      halo.scale.setScalar(1 + level * 0.09);
      haloMaterial.opacity = 0.2 + level * 0.3;
      halo.rotation.z = time * 0.012;

      reflectionMaterial.opacity = 0.16 + level * 0.16;
      reflection.scale.setScalar(0.92 + level * 0.16);
      hotMaterial.opacity = 0.12 + level * 0.14;
      hotSpot.scale.setScalar(0.95 + level * 0.2);

      light.intensity = 1.5 + level * 1.9;
      backdrop.uniforms.uTime.value = time;
      backdrop.uniforms.uBreath.value = level;
    },
    dispose(): void {
      glowTexture.dispose();
      disposeObject(root);
    },
  };
}

export const breathingScene: SceneDefinition = {
  id: 'breathing',
  title: '呼吸之光',
  subtitle: 'Breathing Light',
  description: '暗室中央的一团柔光随呼吸缓缓涨落，跟着它吸气，也跟着它呼气。',
  tags: ['呼吸', '光', '静室'],
  accent: '#d9a066',
  gradient: ['#16203c', '#080c16'],
  category: 'meditation',
  audio: 'breathing-light.mp3',
  breathing: BREATHING,
  create(ctx: SceneContext): SceneInstance {
    return createBreathing(ctx);
  },
};

export default breathingScene;
