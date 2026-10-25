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
 * 烛火
 *
 * 暗室的一支蜡烛：火焰由噪声驱动着极缓慢地摇曳，烛光在墙上铺开一片暖色光晕，
 * 蜡烛的影子在墙上随火苗极慢地晃动，光锥里浮着细小尘埃。
 * 呼吸让火苗的亮度与墙上的光晕微微起伏。
 */

const BREATHING = { inhale: 4, hold: 2, exhale: 6, holdOut: 2 };

const FOV = 46;

/** 蜡烛顶端（灯芯）的高度。 */
const WICK_Y = 0.222;

const FLAME_VERT = /* glsl */ `
uniform float uTime;
uniform float uSway;
uniform float uHeight;

varying float vHeight;
varying float vNoise;

${GLSL_HASH}
${GLSL_NOISE3}

void main() {
  vec3 p = position;
  float h = clamp(p.y / uHeight, 0.0, 1.0);

  // 噪声驱动、幅度只有几毫米的缓缓摇曳
  float n = fbm3(vec3(p.y * 9.0, uTime * 0.035, 0.0));
  float n2 = fbm3(vec3(p.y * 7.0 + 4.1, uTime * 0.028, 1.7));
  p.x += n * uSway * h * h;
  p.z += n2 * uSway * 0.7 * h * h;

  vHeight = h;
  vNoise = n * 0.6 + n2 * 0.4;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const FLAME_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uColorHot;
uniform vec3 uColorTip;
uniform float uIntensity;

varying float vHeight;
varying float vNoise;

${GLSL_OUTPUT_FUNCS}

void main() {
  float h = vHeight;
  vec3 col = mix(uColorHot, uColorTip, smoothstep(0.08, 0.92, h));
  col *= 0.82 + 0.34 * (vNoise * 0.5 + 0.5);

  float alpha = (1.0 - smoothstep(0.3, 1.0, h)) * uIntensity;
  alpha *= smoothstep(0.0, 0.07, h);
  if (alpha < 0.003) discard;

  gl_FragColor = vec4(col, alpha);
  ${GLSL_OUTPUT}
}
`;

/** 火焰的外形：一枚被拉长的水滴。 */
function createFlameGeometry(): THREE.BufferGeometry {
  const profile = [
    new THREE.Vector2(0, 0),
    new THREE.Vector2(0.011, 0.005),
    new THREE.Vector2(0.019, 0.016),
    new THREE.Vector2(0.021, 0.032),
    new THREE.Vector2(0.017, 0.052),
    new THREE.Vector2(0.011, 0.074),
    new THREE.Vector2(0.004, 0.09),
    new THREE.Vector2(0, 0.098),
  ];
  return new THREE.LatheGeometry(profile, 20);
}

function createCandle(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'candle-scene';

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 120);
  camera.position.set(0, 0.62, 1.3);
  camera.lookAt(0, 0.52, 0);

  // ── 暗室 ──────────────────────────────────────────────────────────────
  const backdrop = createBackdropDome({
    zenith: 0x08070a,
    horizon: 0x17131a,
    ground: 0x060507,
    radius: 30,
  });
  root.add(backdrop.mesh);

  const ground = ctx.env.createGround(18) as THREE.Mesh;
  const groundMaterial = new THREE.MeshStandardMaterial({
    color: 0x0b0a0c,
    roughness: 1,
    metalness: 0,
    envMapIntensity: 0.05,
  });
  groundMaterial.envMap = ctx.env.envMap;
  disposeMeshMaterial(ground);
  ground.material = groundMaterial;
  root.add(ground);

  const wallMaterial = new THREE.MeshStandardMaterial({
    color: 0x14121a,
    roughness: 0.96,
    metalness: 0,
    envMapIntensity: 0.06,
  });
  wallMaterial.envMap = ctx.env.envMap;
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(16, 10), wallMaterial);
  wall.name = 'wall';
  wall.position.set(0, 1.6, -2.4);
  wall.receiveShadow = true;
  root.add(wall);

  // ── 烛台与蜡烛 ────────────────────────────────────────────────────────
  const dishMaterial = new THREE.MeshStandardMaterial({
    color: 0x191a1e,
    roughness: 0.7,
    metalness: 0.15,
    envMapIntensity: 0.12,
  });
  dishMaterial.envMap = ctx.env.envMap;
  const dish = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.16, 0.024, 40), dishMaterial);
  dish.name = 'dish';
  dish.position.y = 0.012;
  dish.castShadow = true;
  dish.receiveShadow = true;
  root.add(dish);

  const waxMaterial = new THREE.MeshStandardMaterial({
    color: 0xe6dcc6,
    roughness: 0.62,
    metalness: 0,
    emissive: 0x2b1608,
    emissiveIntensity: 1,
    envMapIntensity: 0.12,
  });
  waxMaterial.envMap = ctx.env.envMap;
  const candle = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.046, 0.19, 28), waxMaterial);
  candle.name = 'candle';
  candle.position.y = 0.024 + 0.095;
  candle.castShadow = true;
  candle.receiveShadow = true;
  root.add(candle);

  const wick = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0016, 0.0022, 0.016, 6),
    new THREE.MeshBasicMaterial({ color: 0x0a0806 }),
  );
  wick.name = 'wick';
  wick.position.y = WICK_Y - 0.004;
  root.add(wick);

  // ── 火焰 ──────────────────────────────────────────────────────────────
  const flameGeometry = createFlameGeometry();

  const outerFlameUniforms = {
    uTime: { value: 0 },
    uSway: { value: 0.004 },
    uHeight: { value: 0.098 },
    uColorHot: { value: new THREE.Color(0xffb066) },
    uColorTip: { value: new THREE.Color(0xd98f52) },
    uIntensity: { value: 0.85 },
  };
  const outerFlame = new THREE.Mesh(
    flameGeometry,
    new THREE.ShaderMaterial({
      uniforms: outerFlameUniforms,
      vertexShader: FLAME_VERT,
      fragmentShader: FLAME_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    }),
  );
  outerFlame.name = 'flame-outer';
  outerFlame.position.y = WICK_Y;
  outerFlame.renderOrder = 4;
  root.add(outerFlame);

  const innerFlameUniforms = {
    uTime: { value: 0 },
    uSway: { value: 0.003 },
    uHeight: { value: 0.06 },
    uColorHot: { value: new THREE.Color(0xfff0d0) },
    uColorTip: { value: new THREE.Color(0xffc98a) },
    uIntensity: { value: 1.1 },
  };
  const innerFlame = new THREE.Mesh(
    flameGeometry,
    new THREE.ShaderMaterial({
      uniforms: innerFlameUniforms,
      vertexShader: FLAME_VERT,
      fragmentShader: FLAME_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    }),
  );
  innerFlame.name = 'flame-inner';
  innerFlame.position.y = WICK_Y;
  innerFlame.scale.set(0.52, 0.62, 0.52);
  innerFlame.renderOrder = 5;
  root.add(innerFlame);

  // ── 光 ────────────────────────────────────────────────────────────────
  const pointLight = new THREE.PointLight(0xffab5e, 1.1, 6, 2);
  pointLight.position.set(0, WICK_Y + 0.035, 0);
  root.add(pointLight);

  const spot = new THREE.SpotLight(0xffb877, 2.2, 9, 0.85, 1, 1.4);
  spot.position.set(0, WICK_Y + 0.035, 0);
  spot.castShadow = true;
  spot.shadow.mapSize.set(1024, 1024);
  spot.shadow.camera.near = 0.1;
  spot.shadow.camera.far = 9;
  spot.shadow.bias = -0.0012;
  spot.shadow.normalBias = 0.02;
  spot.shadow.radius = 5;
  spot.target.position.set(0.85, 0.55, -2.4);
  root.add(spot);
  root.add(spot.target);

  const fill = new THREE.DirectionalLight(0x4a6488, 0.12);
  fill.position.set(3.5, 2.4, 2);
  root.add(fill);

  const lights = ctx.env.createStudioLights();
  dimStudioLights(lights, 0.04, 0x40342c);
  root.add(lights);

  // ── 墙上的暖色光晕 ────────────────────────────────────────────────────
  const glowTexture = createRadialGlowTexture(128, 2.4);
  const glowMaterial = new THREE.MeshBasicMaterial({
    map: glowTexture,
    color: 0xffa860,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 3.2), glowMaterial);
  glow.name = 'wall-glow';
  glow.position.set(0.12, 0.6, -2.36);
  root.add(glow);

  // ── 光锥里的尘埃 ──────────────────────────────────────────────────────
  const space = new ParticleSpace({
    radius: 0.5,
    spin: 0.012,
    tilt: 0.3,
    position: [0, 0.45, 0],
  });
  const dust = createSoftParticleField(space, Math.floor(150 * ctx.quality), {
    size: 0.011,
    color: new THREE.Color(0xf0d6a8),
    opacity: 0.34,
    seed: 6613,
    wander: 0.03,
  });
  root.add(dust.points);

  const breath = createBreathSample();
  const flameBase = new THREE.Vector3(0, WICK_Y + 0.035, 0);
  const targetBase = new THREE.Vector3(0.85, 0.55, -2.4);

  return {
    root,
    camera,
    immersive: false,
    xrDistance: 1.8,
    framing: { distance: 1.3, height: 0.62, targetY: 0.52, width: 1.6 },
    update(time: number, delta: number, context: SceneContext): void {
      sampleBreath(BREATHING, time, breath);
      const level = breath.level;

      space.breathe = 1 + level * 0.11;
      space.breathPhase = level;
      space.update(delta, time);
      wrapParticleField(dust.points, space.radius, delta, 0.006);

      dust.uniforms.uTime.value = time;
      dust.uniforms.uBreath.value = level;
      updateParticleScale(dust.uniforms, context, FOV);

      // 火苗摇曳：呼吸时倾得更明显一些
      const sway = 0.0035 + level * 0.0035;
      outerFlameUniforms.uTime.value = time;
      outerFlameUniforms.uSway.value = sway;
      outerFlameUniforms.uIntensity.value = 0.74 + level * 0.22;
      innerFlameUniforms.uTime.value = time;
      innerFlameUniforms.uSway.value = sway * 0.8;
      innerFlameUniforms.uIntensity.value = 0.95 + level * 0.3;

      // 火苗位置极慢地偏移，墙上的影子随之轻轻晃动
      const driftX = Math.sin(time * 0.16) * 0.006 + Math.sin(time * 0.071) * 0.004;
      const driftY = Math.cos(time * 0.13) * 0.003;
      pointLight.position.set(flameBase.x + driftX, flameBase.y + driftY, flameBase.z);
      spot.position.copy(pointLight.position);
      spot.target.position.set(targetBase.x + driftX * 4, targetBase.y + driftY * 4, targetBase.z);

      pointLight.intensity = 0.95 + level * 0.45;
      spot.intensity = 2.0 + level * 0.5;

      glowMaterial.opacity = 0.24 + level * 0.12;
      glow.scale.setScalar(0.97 + level * 0.07);
      glow.position.x = 0.12 + driftX * 2;

      backdrop.uniforms.uTime.value = time;
      backdrop.uniforms.uBreath.value = level;
    },
    dispose(): void {
      glowTexture.dispose();
      disposeObject(root);
    },
  };
}

export const candleScene: SceneDefinition = {
  id: 'candle',
  title: '烛火',
  subtitle: 'Candle Flame',
  description: '一支蜡烛在暗室里安静地烧着，火苗轻摇，墙上的暖光随之漫开。',
  tags: ['烛火', '暗室', '暖光'],
  accent: '#e0a46a',
  gradient: ['#241a14', '#07060a'],
  category: 'meditation',
  audio: 'candle-flame.mp3',
  breathing: BREATHING,
  create(ctx: SceneContext): SceneInstance {
    return createCandle(ctx);
  },
};

export default candleScene;
