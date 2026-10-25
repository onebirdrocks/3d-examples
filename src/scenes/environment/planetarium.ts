/**
 * 星象仪 / Planetarium
 * ---------------------------------------------------------------
 * 站在一座圆顶天象仪**内部**抬头看：脚下的地面属于你，头顶 15 米高的深色穹顶
 * 罩住整个视野；繁星点点，一道银河横贯天顶；几颗行星沿着倾角各异的轨道
 * 缓慢运行；正中央偏下的投影仪投出一道缓慢旋转的光锥，扫过穹顶时，
 * 被扫到的那片星空会短暂地亮起来。
 *
 * 构成：
 * - 穹顶：SphereGeometry 的内表面（side: BackSide），程序化星点用核心层的
 *   「粒子空间」承载（整片星空靠一个 4×4 矩阵整体旋转，CPU 零成本）；
 * - 银河：另一层加性混合的球壳，用 fbm 噪声算出银河带与其中的暗尘带；
 * - 行星：几个小球体沿不同倾角、大小悬殊的轨道运行，带自转，
 *   轨迹用极细的暗色环线表示；
 * - 投影仪：中心偏下的小装置，向上投出一道半透明的旋转光锥。
 *
 * 音乐驱动：
 * - pulse → 星星的闪烁频率与投影仪光束的亮度；
 * - bass → 行星轨道的缓慢进动；
 * - level → 银河的亮度。
 */

import * as THREE from 'three';
import type { SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { disposeObject } from '../../core/loader.js';
import { ParticleSpace } from '../../core/particle-space.js';
import { AudioDriver, GLSL_HASH, GLSL_NOISE3, GLSL_OUTPUT, GLSL_OUTPUT_FUNCS, PARTICLE_SPACE_GLSL } from './lib.js';

const BREATHING = { inhale: 6, hold: 2, exhale: 8 };
const FOV = 62;

/** 穹顶半径（米）——站在里面抬头，穹顶要足够大才有「身处其中」的感觉。 */
const DOME_RADIUS = 15;
/** 星星所在的球壳半径。 */
const STAR_RADIUS = 14.3;
/** 银河所在的球壳半径（在星星内侧，加性混合）。 */
const GALAXY_RADIUS = 13.6;
/** 投影仪的位置（场景中心偏下）。 */
const PROJECTOR = new THREE.Vector3(0, 0.55, 0);
/** 光锥半角（弧度）。 */
const BEAM_HALF_ANGLE = 0.085;

/* ------------------------------------------------------------------ *
 * 穹顶
 * ------------------------------------------------------------------ */

const DOME_VERT = /* glsl */ `
#ifndef PLANETARIUM_DOME_VERT_GUARD
#define PLANETARIUM_DOME_VERT_GUARD
varying vec3 vDir;

void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
#endif
`;

const DOME_FRAG = /* glsl */ `
#ifndef PLANETARIUM_DOME_FRAG_GUARD
#define PLANETARIUM_DOME_FRAG_GUARD
precision highp float;

uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform float uLevel;
uniform float uPulse;

varying vec3 vDir;

${GLSL_HASH}
${GLSL_OUTPUT_FUNCS}

void main() {
  vec3 dir = normalize( vDir );
  float h = dir.y;

  // 从地平线的暖灰过渡到天顶的深蓝黑
  vec3 col = mix( uHorizon, uZenith, smoothstep( -0.05, 0.75, h ) );

  // 极缓慢的呼吸式明灭，避免死板
  col *= 0.94 + 0.05 * uPulse + 0.03 * uLevel;

  gl_FragColor = vec4( col, 1.0 );
  ${GLSL_OUTPUT}
}
#endif
`;

/* ------------------------------------------------------------------ *
 * 星空（粒子空间）
 * ------------------------------------------------------------------ */

const STAR_VERT = /* glsl */ `
#ifndef PLANETARIUM_STAR_VERT_GUARD
#define PLANETARIUM_STAR_VERT_GUARD
attribute float aSize;
attribute float aPhase;
attribute float aTint;

uniform float uTwinkle;
uniform float uScale;
uniform float uOpacity;
uniform vec3 uBeamAxis;
uniform float uBeamCos;
uniform float uBeamStrength;
uniform vec3 uProjector;
uniform vec3 uCool;
uniform vec3 uWarm;

varying float vAlpha;
varying vec3 vTint;

${PARTICLE_SPACE_GLSL}

void main() {
  // 整片星空由粒子空间矩阵整体旋转，CPU 零成本
  vec3 world = particleSpaceTransform( position );
  vec3 toStar = world - uProjector;
  float dist = length( toStar );
  vec3 dir = toStar / max( dist, 0.0001 );

  // 被光锥扫到的星星短暂变亮
  float beam = smoothstep( uBeamCos, 1.0, dot( dir, uBeamAxis ) );

  float twinkle = 0.76 + 0.24 * sin( uTwinkle + aPhase * 6.2831853 );

  vTint = mix( uCool, uWarm, aTint ) * ( 1.0 + beam * uBeamStrength * 1.7 );
  vAlpha = uOpacity * twinkle * ( 1.0 + beam * uBeamStrength * 2.4 );

  vec4 mv = modelViewMatrix * vec4( world, 1.0 );
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * uScale / max( 0.5, dist );
}
#endif
`;

const STAR_FRAG = /* glsl */ `
#ifndef PLANETARIUM_STAR_FRAG_GUARD
#define PLANETARIUM_STAR_FRAG_GUARD
precision highp float;

varying float vAlpha;
varying vec3 vTint;

${GLSL_OUTPUT_FUNCS}

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot( c, c );
  if ( d2 > 0.25 ) discard;
  float falloff = exp( -d2 * 9.0 );
  float a = falloff * vAlpha;
  if ( a < 0.003 ) discard;
  gl_FragColor = vec4( vTint, a );
  ${GLSL_OUTPUT}
}
#endif
`;

/* ------------------------------------------------------------------ *
 * 银河（加性球壳）
 * ------------------------------------------------------------------ */

const GALAXY_VERT = /* glsl */ `
#ifndef PLANETARIUM_GALAXY_VERT_GUARD
#define PLANETARIUM_GALAXY_VERT_GUARD
varying vec3 vDir;

void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
#endif
`;

const GALAXY_FRAG = /* glsl */ `
#ifndef PLANETARIUM_GALAXY_FRAG_GUARD
#define PLANETARIUM_GALAXY_FRAG_GUARD
precision highp float;

uniform vec3 uBandAxis;
uniform float uWidth;
uniform float uGain;
uniform float uTime;
uniform vec3 uBeamAxis;
uniform float uBeamCos;
uniform float uBeamStrength;
uniform vec3 uColorCool;
uniform vec3 uColorWarm;

varying vec3 vDir;

${GLSL_HASH}
${GLSL_NOISE3}
${GLSL_OUTPUT_FUNCS}

void main() {
  vec3 d = normalize( vDir );

  // 到银道面的角距 → 银河带
  float band = dot( d, uBandAxis );
  float core = exp( -( band * band ) / ( 2.0 * uWidth * uWidth ) );
  // 更亮的一条中脊
  float ridge = exp( -( band * band ) / ( 2.0 * 0.055 * 0.055 ) );

  // 团块与暗尘
  float clouds = fbm3( d * 3.2 + vec3( 0.0, uTime * 0.004, 0.0 ), 4 );
  float dust = fbm3( d * 14.0 + 11.3, 3 );

  float density = core * ( 0.22 + 0.8 * clouds ) + ridge * 0.42 * ( 0.3 + 0.7 * clouds );
  density *= smoothstep( 0.14, 0.86, dust + 0.22 );
  density = max( density, 0.0 );

  // 光锥扫过的地方，银河也更亮
  float beam = smoothstep( uBeamCos, 1.0, dot( d, uBeamAxis ) );
  density *= 1.0 + beam * uBeamStrength * 1.6;

  vec3 col = mix( uColorCool, uColorWarm, smoothstep( 0.42, 0.86, clouds ) ) * density * uGain;
  if ( col.r + col.g + col.b < 0.002 ) discard;

  gl_FragColor = vec4( col, 1.0 );
  ${GLSL_OUTPUT}
}
#endif
`;

/* ------------------------------------------------------------------ *
 * 投影仪光锥
 * ------------------------------------------------------------------ */

const BEAM_VERT = /* glsl */ `
#ifndef PLANETARIUM_BEAM_VERT_GUARD
#define PLANETARIUM_BEAM_VERT_GUARD
varying float vAlong;
varying vec3 vWorld;
varying vec3 vNormalW;

void main() {
  vAlong = -position.y;
  vNormalW = normalize( mat3( modelMatrix ) * normal );
  vec4 world = modelMatrix * vec4( position, 1.0 );
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
#endif
`;

const BEAM_FRAG = /* glsl */ `
#ifndef PLANETARIUM_BEAM_FRAG_GUARD
#define PLANETARIUM_BEAM_FRAG_GUARD
precision highp float;

uniform vec3 uColor;
uniform float uIntensity;
uniform float uLength;

varying float vAlong;
varying vec3 vWorld;
varying vec3 vNormalW;

${GLSL_OUTPUT_FUNCS}

void main() {
  // 靠近投影仪的一段淡入，末端再慢慢淡出 —— 中间那段才是看得见的光柱
  float along = smoothstep( 0.0, uLength * 0.14, vAlong )
    * ( 1.0 - smoothstep( uLength * 0.72, uLength, vAlong ) );

  // 锥面正对视线时最淡，边缘反而亮一点 —— 像被灯光擦过的光柱
  vec3 view = normalize( cameraPosition - vWorld );
  float edge = 0.35 + 0.65 * pow( abs( dot( normalize( vNormalW ), view ) ), 1.5 );

  float a = along * edge * uIntensity;
  if ( a < 0.003 ) discard;

  gl_FragColor = vec4( uColor * a, 1.0 );
  ${GLSL_OUTPUT}
}
#endif
`;

/* ------------------------------------------------------------------ *
 * 行星
 * ------------------------------------------------------------------ */

interface PlanetConfig {
  /** 轨道半径（米）。 */
  orbit: number;
  /** 公转角速度（rad/s）。 */
  speed: number;
  /** 初始相位。 */
  phase: number;
  /** 轨道倾角（弧度）。 */
  incline: number;
  /** 升交点经度（弧度）。 */
  node: number;
  /** 行星半径（米）。 */
  size: number;
  /** 颜色。 */
  color: number;
  /** 自转速度。 */
  spin: number;
}

const PLANETS: readonly PlanetConfig[] = [
  { orbit: 3.4, speed: 0.021, phase: 1.15, incline: 0.35, node: 0.6, size: 0.12, color: 0xc9a37a, spin: 0.35 },
  { orbit: 4.6, speed: 0.014, phase: 2.9, incline: -0.5, node: 1.9, size: 0.24, color: 0x8fb0c8, spin: 0.22 },
  { orbit: 5.8, speed: 0.01, phase: 4.6, incline: 0.55, node: 3.4, size: 0.4, color: 0xc98f6a, spin: 0.14 },
  { orbit: 7.0, speed: 0.0075, phase: 5.9, incline: -0.3, node: 0.9, size: 0.2, color: 0x9ad3c0, spin: 0.28 },
  { orbit: 8.4, speed: 0.0055, phase: 0.6, incline: 0.45, node: 2.6, size: 0.55, color: 0xb9a7d8, spin: 0.1 },
];

/* ------------------------------------------------------------------ *
 * 场景
 * ------------------------------------------------------------------ */

function createPlanetarium(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'planetarium-scene';

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 200);
  camera.position.set(0, 1.05, 0.7);

  const quality = THREE.MathUtils.clamp(ctx.quality, 0.4, 2);
  const driver = new AudioDriver();
  const envMap = ctx.env.envMap;

  // ── 穹顶 ───────────────────────────────────────────────────────────────
  const domeUniforms = {
    uZenith: { value: new THREE.Color(0x070b16) },
    uHorizon: { value: new THREE.Color(0x121a2e) },
    uLevel: { value: 0 },
    uPulse: { value: 0 },
  };

  const domeMaterial = new THREE.ShaderMaterial({
    uniforms: domeUniforms,
    vertexShader: DOME_VERT,
    fragmentShader: DOME_FRAG,
    side: THREE.BackSide,
    depthWrite: true,
    fog: false,
  });

  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(DOME_RADIUS, 64, 32, 0, Math.PI * 2, 0, Math.PI / 2),
    domeMaterial,
  );
  dome.name = 'planetarium-dome';
  dome.renderOrder = -10;
  root.add(dome);

  // 地面：脚下的暗色圆盘（做得很大，免得看到边缘）
  const ground = ctx.env.createGround(240) as THREE.Mesh;
  const groundMaterial = new THREE.MeshStandardMaterial({
    color: 0x06080e,
    roughness: 0.94,
    metalness: 0.05,
  });
  groundMaterial.envMap = envMap;
  groundMaterial.envMapIntensity = 0.04;
  ground.material = groundMaterial;
  root.add(ground);

  // ── 星空（粒子空间） ───────────────────────────────────────────────────
  const starSpace = new ParticleSpace({
    radius: 1,
    spin: 0.0045,
    tilt: 0.22,
    position: [0, 0, 0],
  });

  const starCount = Math.round(4200 * quality);
  const starPositions = new Float32Array(starCount * 3);
  const starSizes = new Float32Array(starCount);
  const starPhases = new Float32Array(starCount);
  const starTints = new Float32Array(starCount);
  {
    let state = 31337;
    const random = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    for (let i = 0; i < starCount; i += 1) {
      // 上半球的均匀面分布
      const y = random();
      const ring = Math.sqrt(Math.max(0, 1 - y * y));
      const phi = random() * Math.PI * 2;
      starPositions[i * 3] = Math.cos(phi) * ring * STAR_RADIUS;
      starPositions[i * 3 + 1] = y * STAR_RADIUS;
      starPositions[i * 3 + 2] = Math.sin(phi) * ring * STAR_RADIUS;

      // 亮度按幂律分布：绝大多数很暗，少数很亮
      const magnitude = Math.pow(random(), 3.2);
      starSizes[i] = 0.03 + magnitude * 0.15;
      starPhases[i] = random();
      starTints[i] = random();
    }
  }

  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
  starGeometry.setAttribute('aSize', new THREE.BufferAttribute(starSizes, 1));
  starGeometry.setAttribute('aPhase', new THREE.BufferAttribute(starPhases, 1));
  starGeometry.setAttribute('aTint', new THREE.BufferAttribute(starTints, 1));

  const starUniforms = {
    uTwinkle: { value: 0 },
    uScale: { value: 600 },
    uOpacity: { value: 0.9 },
    uBeamAxis: { value: new THREE.Vector3(0, 1, 0) },
    uBeamCos: { value: Math.cos(BEAM_HALF_ANGLE) },
    uBeamStrength: { value: 0.3 },
    uProjector: { value: PROJECTOR.clone() },
    uCool: { value: new THREE.Color(0xbcd4ff) },
    uWarm: { value: new THREE.Color(0xffd9b0) },
    particleMatrix: starSpace.uniform,
  };

  const starMaterial = new THREE.ShaderMaterial({
    uniforms: starUniforms,
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const stars = new THREE.Points(starGeometry, starMaterial);
  stars.name = 'star-field';
  stars.frustumCulled = false;
  stars.renderOrder = 2;
  root.add(stars);

  // ── 银河（加性球壳） ───────────────────────────────────────────────────
  // 银道面的法线：银河是一圈大圆，垂直于这个法线。
  // 取法线离天顶 35°、方位角 51°，让银河带正好从头顶斜穿过去。
  const bandAxis = new THREE.Vector3(
    Math.sin(0.61) * Math.cos(0.89),
    Math.cos(0.61),
    Math.sin(0.61) * Math.sin(0.89),
  ).normalize();

  const galaxyUniforms = {
    uBandAxis: { value: bandAxis },
    uWidth: { value: 0.17 },
    uGain: { value: 0.32 },
    uTime: { value: 0 },
    uBeamAxis: { value: starUniforms.uBeamAxis.value },
    uBeamCos: { value: starUniforms.uBeamCos.value },
    uBeamStrength: { value: starUniforms.uBeamStrength.value },
    uColorCool: { value: new THREE.Color(0x5c74c4) },
    uColorWarm: { value: new THREE.Color(0xf0d5a4) },
  };

  const galaxyMaterial = new THREE.ShaderMaterial({
    uniforms: galaxyUniforms,
    vertexShader: GALAXY_VERT,
    fragmentShader: GALAXY_FRAG,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const galaxy = new THREE.Mesh(
    new THREE.SphereGeometry(GALAXY_RADIUS, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2),
    galaxyMaterial,
  );
  galaxy.name = 'milky-way';
  galaxy.renderOrder = 1;
  galaxy.frustumCulled = false;
  root.add(galaxy);

  // ── 行星 ───────────────────────────────────────────────────────────────
  // 行星围着一台悬在穹顶下的「太阳仪」运行，整体抬到人眼之上
  const orrery = new THREE.Group();
  orrery.name = 'orrery';
  orrery.position.set(0, 2.05, 0);
  root.add(orrery);

  const orbitLineMaterial = new THREE.LineBasicMaterial({
    color: 0x1c2640,
    transparent: true,
    opacity: 0.6,
    depthWrite: false,
  });

  const planetGroups: THREE.Group[] = [];
  const planetMeshes: THREE.Mesh[] = [];
  const orbitSpins: THREE.Group[] = [];

  for (let i = 0; i < PLANETS.length; i += 1) {
    const cfg = PLANETS[i];

    const outer = new THREE.Group();
    outer.name = 'planet-orbit-outer';
    outer.rotation.y = cfg.node;

    const inner = new THREE.Group();
    inner.rotation.x = cfg.incline;

    const spin = new THREE.Group();
    spin.rotation.y = cfg.phase;

    const material = new THREE.MeshStandardMaterial({
      color: cfg.color,
      emissive: new THREE.Color(cfg.color),
      emissiveIntensity: 0.26,
      roughness: 0.78,
      metalness: 0.06,
    });
    material.envMap = envMap;
    material.envMapIntensity = 0.06;

    const mesh = new THREE.Mesh(new THREE.SphereGeometry(cfg.size, 28, 20), material);
    mesh.name = 'planet';
    mesh.position.x = cfg.orbit;
    mesh.castShadow = false;
    spin.add(mesh);

    // 轨迹：极细的暗色环线
    const points: THREE.Vector3[] = [];
    const segments = 128;
    for (let s = 0; s < segments; s += 1) {
      const a = (s / segments) * Math.PI * 2;
      points.push(new THREE.Vector3(Math.cos(a) * cfg.orbit, 0, Math.sin(a) * cfg.orbit));
    }
    const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), orbitLineMaterial);
    ring.name = 'planet-orbit';
    spin.add(ring);

    inner.add(spin);
    outer.add(inner);
    orrery.add(outer);

    planetGroups.push(outer);
    orbitSpins.push(spin);
    planetMeshes.push(mesh);
  }

  // ── 投影仪 ─────────────────────────────────────────────────────────────
  const projector = new THREE.Group();
  projector.name = 'projector';
  projector.position.copy(PROJECTOR);
  root.add(projector);

  const metalMaterial = new THREE.MeshStandardMaterial({
    color: 0x3d4657,
    roughness: 0.42,
    metalness: 0.75,
  });
  metalMaterial.envMap = envMap;
  metalMaterial.envMapIntensity = 0.3;

  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 0.14, 24), metalMaterial);
  body.position.y = -0.07;
  projector.add(body);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 24, 16), metalMaterial);
  head.position.y = 0.05;
  projector.add(head);

  const lensMaterial = new THREE.MeshBasicMaterial({ color: 0xfff3d6, toneMapped: true });
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.05, 20), lensMaterial);
  lens.position.y = 0.175;
  lens.rotation.x = -Math.PI / 2;
  projector.add(lens);

  // 光锥：几层嵌套的锥壳，叠出柔和的径向渐变
  const beamUniforms = {
    uColor: { value: new THREE.Color(0xffe6bd) },
    uLength: { value: 15.5 },
  };

  const beamMaterials: THREE.ShaderMaterial[] = [];
  const beamGains: number[] = [0.034, 0.029, 0.023, 0.017, 0.011, 0.006];
  const beamShells: THREE.Mesh[] = [];
  const SHELLS = beamGains.length;
  for (let i = 0; i < SHELLS; i += 1) {
    const t = (i + 1) / SHELLS;
    const radius = 15.5 * Math.tan(BEAM_HALF_ANGLE) * t;
    const geometry = new THREE.ConeGeometry(radius, 15.5, 36, 1, true);
    geometry.translate(0, -15.5 / 2, 0);

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: beamUniforms.uColor,
        uIntensity: { value: beamGains[i] },
        uLength: beamUniforms.uLength,
      },
      vertexShader: BEAM_VERT,
      fragmentShader: BEAM_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    beamMaterials.push(material);

    const shell = new THREE.Mesh(geometry, material);
    shell.name = 'beam-shell';
    shell.renderOrder = 3;
    beamShells.push(shell);
    root.add(shell);
  }

  // ── 灯光 ───────────────────────────────────────────────────────────────
  const projectorLight = new THREE.PointLight(0xffe0b0, 2.4, 30, 1.6);
  projectorLight.position.copy(PROJECTOR);
  root.add(projectorLight);

  // 天顶洒下来的一点冷光，让行星有明暗、能看出是球
  const zenithLight = new THREE.DirectionalLight(0xaec4ff, 0.5);
  zenithLight.position.set(0.4, 12, -0.6);
  root.add(zenithLight);

  const ambient = new THREE.HemisphereLight(0x2b3550, 0x07080d, 0.42);
  root.add(ambient);

  const lights = ctx.env.createStudioLights();
  lights.traverse((child) => {
    if (child instanceof THREE.Light) {
      child.intensity *= 0.05;
      child.castShadow = false;
      child.color.setHex(0x8fa8d8);
    }
  });
  root.add(lights);

  // ── 运行期状态 ─────────────────────────────────────────────────────────
  const beamAxis = new THREE.Vector3(0, 1, 0);
  const beamQuat = new THREE.Quaternion();
  const down = new THREE.Vector3(0, -1, 0);
  let twinklePhase = 0;
  // 光锥从画面斜前方开始，随后缓缓扫过整个穹顶
  let beamAngle = -0.95;
  const nodeAngles = PLANETS.map((cfg) => cfg.node);

  return {
    root,
    camera,
    immersive: true,
    xrDistance: 3,
    framing: { distance: 0.8, height: 1.0, targetY: 1.7 },

    update(time: number, delta: number, context: SceneContext): void {
      driver.update(context, delta);

      const pulse = driver.pulse;
      const level = driver.level;
      const bass = driver.bass;

      // 星星的闪烁频率跟着脉冲走
      twinklePhase += delta * (0.55 + pulse * 2.4);
      starUniforms.uTwinkle.value = twinklePhase;
      starUniforms.uScale.value =
        (context.height * 0.5 * context.renderer.getPixelRatio()) / Math.tan(THREE.MathUtils.degToRad(FOV) / 2);

      // 整片星空随粒子空间极缓地转
      starSpace.breathe = 1 + pulse * 0.012;
      starSpace.breathPhase = pulse;
      starSpace.update(delta, time);

      // ── 投影仪的光锥缓慢旋转，扫过穹顶 ────────────────────────────────
      beamAngle += delta * (0.045 + pulse * 0.03);
      const tilt = 0.56;
      beamAxis.set(
        Math.sin(tilt) * Math.cos(beamAngle),
        Math.cos(tilt),
        Math.sin(tilt) * Math.sin(beamAngle),
      ).normalize();

      const beamStrength = 0.22 + pulse * 0.85;
      starUniforms.uBeamAxis.value.copy(beamAxis);
      starUniforms.uBeamStrength.value = beamStrength;
      galaxyUniforms.uBeamStrength.value = beamStrength;

      beamQuat.setFromUnitVectors(down, beamAxis);
      for (const shell of beamShells) {
        shell.quaternion.copy(beamQuat);
        shell.position.copy(PROJECTOR);
      }

      beamUniforms.uColor.value.setHex(pulse > 0.5 ? 0xfff0d2 : 0xffe6bd);
      const beamBase = 0.55 + pulse * 1.5;
      for (let i = 0; i < beamMaterials.length; i += 1) {
        beamMaterials[i].uniforms.uIntensity.value = beamGains[i] * beamBase;
      }
      lensMaterial.color.setRGB(1, 0.94 + pulse * 0.05, 0.84 + pulse * 0.1);
      projectorLight.intensity = 1.8 + pulse * 2.2;

      // ── 银河的亮度跟着响度走 ───────────────────────────────────────────
      galaxyUniforms.uGain.value = 0.32 + level * 0.4;
      galaxyUniforms.uTime.value = time;
      domeUniforms.uLevel.value = level;
      domeUniforms.uPulse.value = pulse;

      // ── 行星：轨道进动跟着低频走 ───────────────────────────────────────
      for (let i = 0; i < PLANETS.length; i += 1) {
        const cfg = PLANETS[i];
        const spin = orbitSpins[i];
        spin.rotation.y = cfg.phase + time * cfg.speed;

        // 进动：极缓慢，低频起音时更明显
        nodeAngles[i] += delta * (0.004 + bass * 0.05);
        planetGroups[i].rotation.y = nodeAngles[i];

        planetMeshes[i].rotation.y = time * cfg.spin;
      }

      // 场景整体的呼吸式起伏：站在穹顶下，内容极缓地浮沉
      root.position.y = Math.sin(time * 0.11) * 0.016;
    },

    dispose(): void {
      disposeObject(root);
    },
  };
}

export const planetariumScene: SceneDefinition = {
  id: 'planetarium',
  title: '星象仪',
  subtitle: 'Planetarium',
  description: '站在圆顶天象仪内部抬头，银河横贯天顶，一束投影的光缓缓扫过星空。',
  tags: ['天象仪', '星空', '银河', '沉浸'],
  accent: '#9db4e8',
  gradient: ['#1a2440', '#05070f'],
  category: 'environment',
  audio: 'enigma-monastery.mp3',
  breathing: BREATHING,
  lighting: {
    autoExposure: true,
    autoExposureKey: 0.06,
  },
  create(ctx: SceneContext): SceneInstance {
    return createPlanetarium(ctx);
  },
};

export default planetariumScene;
