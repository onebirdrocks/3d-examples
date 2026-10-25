/**
 * 月井 / Moon Well
 * ---------------------------------------------------------------
 * 夜里的一口古井：井沿垒着一圈石头，井中映着一轮月亮，
 * 水面随呼吸极缓地涨落，井边一株瘦枝，几片落叶慢慢打着旋儿。
 * 安静到近乎凝固——所有运动都以十秒为单位。
 *
 * 音乐如何驱动画面：
 * - `pulse` → 井水的涟漪幅度与水位涨落（画面最主要的运动）；
 * - `bass` → 水中月影的亮度；
 * - `level` → 整体亮度（石头的可辨度）；
 * - `drive` → 水面呼吸的深浅。
 */
import * as THREE from 'three';
import type { SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { disposeObject } from '../../core/loader.js';
import { ParticleSpace, createRandom } from '../../core/particle-space.js';
import { GLSL_HASH, GLSL_NOISE2, GLSL_OUTPUT, GLSL_OUTPUT_FUNCS } from './glsl.js';
import { SLEEP_CATEGORY, configureStandard, dimLights } from './palette.js';
import { SleepAudioDrive } from './audio-drive.js';
import { updatePointScale } from './points.js';
import { createMoteField, createNightDome, createRadialTexture } from './shared.js';

const BREATHING = { inhale: 4, hold: 4, exhale: 8 };

const FOV = 50;

/** 井沿石头所在半径。 */
const STONE_R = 0.7;

/** 井口内半径（水面半径）。 */
const WATER_R = 0.54;

/** 水面基准高度。 */
const WATER_Y = 0.44;

/* ------------------------------------------------------------------ *
 * 井水：月影 + 呼吸般的涟漪
 * ------------------------------------------------------------------ */

const WATER_VERT = /* glsl */ `
varying vec2 vLocal;

void main() {
  vLocal = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const WATER_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uPulse;
uniform float uBass;
uniform float uDrive;
uniform float uRadius;
uniform vec3 uDeepColor;
uniform vec3 uMoonColor;

varying vec2 vLocal;

${GLSL_HASH}
${GLSL_NOISE2}
${GLSL_OUTPUT_FUNCS}

void main() {
  float r = length( vLocal ) / uRadius;
  vec2 q = vLocal;

  // 极缓的水面起伏：整口井像在呼吸
  float swell = sin( uTime * 0.19 + r * 3.2 ) * 0.35 + 0.65;

  // 脉冲驱动的涟漪：从井心向外扩散，一圈要走好几秒
  float ripple = sin( r * 21.0 - uTime * 0.5 ) * exp( -r * 2.4 );

  // 水面本身的细碎波纹
  float fine = fbm2( q * 9.0 + vec2( uTime * 0.017, -uTime * 0.011 ) );

  vec3 col = uDeepColor * ( 0.62 + 0.5 * swell ) * ( 0.9 + 0.22 * fine );

  // 月影：被涟漪拉长的一片银白
  vec2 c = q - vec2( -0.12, -0.1 );
  c.y *= 0.2;
  float d = length( c );
  float glint = exp( -d * d * 26.0 );
  float shimmer = 0.25 + 1.15 * fbm2( vec2( q.x * 13.0, q.y * 5.0 - uTime * 0.06 ) );
  float moon = glint * shimmer * ( 0.6 + 0.9 * uBass + 0.3 * uPulse );
  col += uMoonColor * moon;

  // 涟漪的碎光
  col += uMoonColor * max( ripple, 0.0 ) * ( 0.05 + 0.1 * uPulse ) * ( 0.4 + 0.6 * swell );

  gl_FragColor = vec4( col, 1.0 );
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * 月亮与月晕
 * ------------------------------------------------------------------ */

const MOON_VERT = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const MOON_FRAG = /* glsl */ `
precision highp float;

uniform float uIntensity;
uniform vec3 uColor;

varying vec2 vUv;

${GLSL_OUTPUT_FUNCS}

void main() {
  vec2 p = vUv - 0.5;
  float d = length( p ) * 2.0;
  if ( d > 1.0 ) discard;

  // 月盘：边缘略暗，中心略亮
  float disc = 1.0 - smoothstep( 0.72, 1.0, d );
  float shade = 0.86 + 0.14 * ( 1.0 - d * d );
  float alpha = disc * shade * uIntensity;
  if ( alpha < 0.004 ) discard;

  gl_FragColor = vec4( uColor * alpha, alpha );
  ${GLSL_OUTPUT}
}
`;

const HALO_FRAG = /* glsl */ `
precision highp float;

uniform float uIntensity;
uniform vec3 uColor;

varying vec2 vUv;

${GLSL_OUTPUT_FUNCS}

void main() {
  vec2 p = vUv - 0.5;
  float d = length( p ) * 2.0;
  if ( d > 1.0 ) discard;

  float halo = exp( -d * d * 3.4 ) * 0.5;
  float alpha = halo * uIntensity;
  if ( alpha < 0.004 ) discard;

  gl_FragColor = vec4( uColor * alpha, alpha );
  ${GLSL_OUTPUT}
}
`;

/** 用一段折线拼出瘦枝：越往上越细。 */
function createBranchGeometry(random: () => number): THREE.BufferGeometry {
  const segments = 5;
  const positions: number[] = [];
  const radii: number[] = [];

  let x = 0.95;
  let y = 0.0;
  let z = -0.18;
  let dirX = -0.12;
  let dirY = 1;
  let dirZ = 0.04;
  let radius = 0.05;

  const length = 0.24;

  for (let i = 0; i < segments; i += 1) {
    const jitterX = (random() - 0.5) * 0.22;
    const jitterZ = (random() - 0.5) * 0.22;
    dirX += jitterX;
    dirY += (random() - 0.4) * 0.18;
    dirZ += jitterZ;

    const len = Math.hypot(dirX, dirY, dirZ);
    dirX /= len;
    dirY /= len;
    dirZ /= len;

    const nextX = x + dirX * length;
    const nextY = y + dirY * length;
    const nextZ = z + dirZ * length;

    // 一根圆柱：从 (x,y,z) 指向 (nextX,nextY,nextZ)
    const axis = new THREE.Vector3(nextX - x, nextY - y, nextZ - z);
    axis.normalize();

    const up = new THREE.Vector3(0, 1, 0);
    const side = new THREE.Vector3().crossVectors(axis, up);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.normalize();
    const normal = new THREE.Vector3().crossVectors(side, axis).normalize();

    const ring = 7;
    const corners: THREE.Vector3[] = [];
    for (let s = 0; s < ring; s += 1) {
      const a = (s / ring) * Math.PI * 2;
      corners.push(
        side
          .clone()
          .multiplyScalar(Math.cos(a))
          .addScaledVector(normal, Math.sin(a)),
      );
    }

    const start = new THREE.Vector3(x, y, z);
    const end = new THREE.Vector3(nextX, nextY, nextZ);
    const nextRadius = radius * 0.84;

    for (let s = 0; s < ring; s += 1) {
      const a = corners[s];
      const b = corners[(s + 1) % ring];

      const p0 = start.clone().addScaledVector(a, radius);
      const p1 = start.clone().addScaledVector(b, radius);
      const p2 = end.clone().addScaledVector(b, nextRadius);
      const p3 = end.clone().addScaledVector(a, nextRadius);

      positions.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
      positions.push(p0.x, p0.y, p0.z, p2.x, p2.y, p2.z, p3.x, p3.y, p3.z);
      radii.push(radius, radius, nextRadius, radius, nextRadius, nextRadius);
    }

    x = nextX;
    y = nextY;
    z = nextZ;
    radius = nextRadius;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aRadius', new THREE.Float32BufferAttribute(radii, 1));
  geometry.computeVertexNormals();
  return geometry;
}

const BRANCH_VERT = /* glsl */ `
attribute float aRadius;

varying float vShade;
varying vec3 vNormalW;
varying vec3 vWorld;

void main() {
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWorld = wp.xyz;
  vNormalW = normalize( mat3( modelMatrix ) * normal );
  vShade = clamp( aRadius * 26.0, 0.2, 1.0 );
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const BRANCH_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uColor;
uniform vec3 uMoonDir;
uniform float uLevel;

varying float vShade;
varying vec3 vNormalW;
varying vec3 vWorld;

${GLSL_OUTPUT_FUNCS}

void main() {
  vec3 N = normalize( vNormalW );
  vec3 V = normalize( cameraPosition - vWorld );
  float lambert = max( dot( N, uMoonDir ), 0.0 );

  vec3 col = uColor * ( 0.35 + 0.9 * lambert ) * ( 0.55 + 0.55 * uLevel );
  // 掠射角的一道月光边
  float rim = pow( 1.0 - max( dot( N, V ), 0.0 ), 3.0 );
  col += vec3( 0.55, 0.66, 0.85 ) * rim * 0.22;

  gl_FragColor = vec4( col, 1.0 );
  ${GLSL_OUTPUT}
}
`;

function createMoonWell(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'moon-well-scene';

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 180);
  camera.position.set(0, 1.35, 2.3);
  camera.lookAt(0, 0.62, 0);

  const random = createRandom(24680);

  // ── 夜色穹顶 ────────────────────────────────────────────────────────
  const dome = createNightDome({
    zenith: 0x0a1428,
    horizon: 0x101d33,
    ground: 0x04060c,
    radius: 80,
  });
  root.add(dome.mesh);

  // ── 地面 ────────────────────────────────────────────────────────────
  const ground = ctx.env.createGround(16) as THREE.Mesh;
  const groundMaterial = new THREE.MeshStandardMaterial({
    color: 0x0d1017,
    roughness: 1,
    metalness: 0,
  });
  configureStandard(groundMaterial, ctx.env.envMap, 0.06);
  ground.material = groundMaterial;
  ground.name = 'well-ground';
  root.add(ground);

  // ── 井体 ────────────────────────────────────────────────────────────
  const stoneMaterial = new THREE.MeshStandardMaterial({
    color: 0x5c6066,
    roughness: 0.95,
    metalness: 0,
    flatShading: true,
  });
  configureStandard(stoneMaterial, ctx.env.envMap, 0.14);

  // 井沿：两圈错开的石头
  const stoneGeometry = new THREE.DodecahedronGeometry(0.15, 0);
  const stones = new THREE.InstancedMesh(stoneGeometry, stoneMaterial, 26);
  stones.name = 'well-stones';
  stones.castShadow = false;
  stones.receiveShadow = false;
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const scale = new THREE.Vector3();
  const position = new THREE.Vector3();
  for (let i = 0; i < 26; i += 1) {
    const row = i < 13 ? 0 : 1;
    const index = row === 0 ? i : i - 13;
    const count = row === 0 ? 13 : 13;
    const angle = (index / count) * Math.PI * 2 + (row === 0 ? 0 : Math.PI / count);
    const radius = STONE_R - row * 0.012;
    const y = 0.66 - row * 0.2;

    position.set(Math.cos(angle) * radius, y + (random() - 0.5) * 0.02, Math.sin(angle) * radius);
    euler.set(random() * Math.PI, random() * Math.PI, random() * Math.PI);
    quaternion.setFromEuler(euler);
    const s = 0.86 + random() * 0.3;
    scale.set(s * (0.9 + random() * 0.2), s * 0.82, s * (0.9 + random() * 0.2));
    matrix.compose(position, quaternion, scale);
    stones.setMatrixAt(i, matrix);
  }
  stones.instanceMatrix.needsUpdate = true;
  stones.frustumCulled = false;
  root.add(stones);

  // 井壁：从井口一直往深处，暗到看不见底
  const shaftMaterial = new THREE.MeshStandardMaterial({
    color: 0x14161a,
    roughness: 1,
    metalness: 0,
    side: THREE.BackSide,
  });
  configureStandard(shaftMaterial, ctx.env.envMap, 0.03);
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(WATER_R, WATER_R * 0.72, 2.4, 32, 1, true),
    shaftMaterial,
  );
  shaft.name = 'well-shaft';
  shaft.position.set(0, WATER_Y - 1.2, 0);
  root.add(shaft);

  // 井底：一块几乎看不见的暗盘
  const bottomMaterial = new THREE.MeshStandardMaterial({
    color: 0x07080b,
    roughness: 1,
    metalness: 0,
  });
  configureStandard(bottomMaterial, ctx.env.envMap, 0.02);
  const bottom = new THREE.Mesh(new THREE.CircleGeometry(WATER_R * 0.74, 28), bottomMaterial);
  bottom.name = 'well-bottom';
  bottom.rotation.x = -Math.PI * 0.5;
  bottom.position.set(0, WATER_Y - 2.36, 0);
  root.add(bottom);

  // ── 井水 ────────────────────────────────────────────────────────────
  const waterUniforms = {
    uTime: { value: 0 },
    uPulse: { value: 0 },
    uBass: { value: 0 },
    uDrive: { value: 0 },
    uRadius: { value: WATER_R },
    uDeepColor: { value: new THREE.Color(0x0a1a26) },
    uMoonColor: { value: new THREE.Color(0xcfe0f2) },
  };
  const water = new THREE.Mesh(
    new THREE.CircleGeometry(WATER_R, 56),
    new THREE.ShaderMaterial({
      uniforms: waterUniforms,
      vertexShader: WATER_VERT,
      fragmentShader: WATER_FRAG,
      fog: false,
    }),
  );
  water.name = 'well-water';
  water.rotation.x = -Math.PI * 0.5;
  water.position.set(0, WATER_Y, 0);
  root.add(water);

  // ── 月亮与月晕 ──────────────────────────────────────────────────────
  const moonUniforms = {
    uIntensity: { value: 0.8 },
    uColor: { value: new THREE.Color(0xdfe9ff) },
  };
  const moon = new THREE.Mesh(
    new THREE.PlaneGeometry(0.62, 0.62),
    new THREE.ShaderMaterial({
      uniforms: moonUniforms,
      vertexShader: MOON_VERT,
      fragmentShader: MOON_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    }),
  );
  moon.name = 'moon';
  moon.position.set(-2.55, 2.05, -6.2);
  moon.renderOrder = 2;
  root.add(moon);

  const haloUniforms = {
    uIntensity: { value: 0.28 },
    uColor: { value: new THREE.Color(0x9db6dd) },
  };
  const halo = new THREE.Mesh(
    new THREE.PlaneGeometry(3.4, 3.4),
    new THREE.ShaderMaterial({
      uniforms: haloUniforms,
      vertexShader: MOON_VERT,
      fragmentShader: HALO_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    }),
  );
  halo.name = 'moon-halo';
  halo.position.copy(moon.position);
  halo.position.z += 0.05;
  halo.renderOrder = 1;
  root.add(halo);

  // ── 瘦枝 ────────────────────────────────────────────────────────────
  const branchGeometry = createBranchGeometry(random);
  const branchMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0x3c352a) },
      uMoonDir: { value: new THREE.Vector3(-0.28, 0.62, -0.74).normalize() },
      uLevel: { value: 0 },
    },
    vertexShader: BRANCH_VERT,
    fragmentShader: BRANCH_FRAG,
    fog: false,
  });
  const branch = new THREE.Mesh(branchGeometry, branchMaterial);
  branch.name = 'thin-branch';
  root.add(branch);

  // ── 落叶 ────────────────────────────────────────────────────────────
  const leafGeometry = new THREE.CircleGeometry(0.05, 8);
  const leafMaterial = new THREE.MeshStandardMaterial({
    color: 0x50432f,
    roughness: 1,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  configureStandard(leafMaterial, ctx.env.envMap, 0.12);

  // 静卧在井边的叶子
  for (let i = 0; i < 5; i += 1) {
    const leaf = new THREE.Mesh(leafGeometry, leafMaterial);
    const angle = random() * Math.PI * 2;
    const dist = 0.95 + random() * 0.5;
    leaf.name = `fallen-leaf-${i}`;
    leaf.position.set(Math.cos(angle) * dist, 0.012, Math.sin(angle) * dist);
    leaf.rotation.set(-Math.PI * 0.5 + (random() - 0.5) * 0.3, random() * Math.PI * 2, 0);
    leaf.scale.set(1, 0.62, 1);
    root.add(leaf);
  }

  // 还在打旋儿下落的叶子
  const fallingLeaves: THREE.Mesh[] = [];
  for (let i = 0; i < 3; i += 1) {
    const leaf = new THREE.Mesh(leafGeometry, leafMaterial);
    leaf.name = `falling-leaf-${i}`;
    leaf.scale.set(1, 0.62, 1);
    root.add(leaf);
    fallingLeaves.push(leaf);
  }

  // ── 井边的浮尘 ──────────────────────────────────────────────────────
  const moteSpace = new ParticleSpace({
    radius: 2.2,
    spin: 0.004,
    tilt: 0.1,
    position: [0, 0.9, 0],
  });
  const motes = createMoteField(moteSpace, Math.floor(140 * ctx.quality), {
    color: 0xa8bcd4,
    size: 0.022,
    seed: 5051,
    opacity: 0.32,
  });
  root.add(motes.points);

  // ── 灯光：月光 + 极弱的底光 ─────────────────────────────────────────
  const lights = ctx.env.createStudioLights();
  dimLights(lights, 0.05, 0x2b3a55);
  root.add(lights);

  const moonLight = new THREE.DirectionalLight(0xa8c0e8, 3.4);
  moonLight.name = 'moon-light';
  moonLight.position.set(-2.6, 3.4, 2.6);
  moonLight.target.position.set(0, 0.45, 0);
  moonLight.castShadow = false;
  root.add(moonLight);
  root.add(moonLight.target);

  // 井底的一点微光，暗示深处还有东西
  const deepLight = new THREE.PointLight(0x4d7fa8, 0.5, 2.2, 2);
  deepLight.name = 'deep-light';
  deepLight.position.set(0, WATER_Y - 0.4, 0);
  root.add(deepLight);

  // ── 井口边的一点柔光晕（把井沿从夜色里托出来） ──────────────────────
  const rimGlowTexture = createRadialTexture(256, 'rgba(120,150,190,0.55)', 'rgba(90,120,160,0.18)');
  const rimGlow = new THREE.Mesh(
    new THREE.PlaneGeometry(2.6, 2.6),
    new THREE.MeshBasicMaterial({
      map: rimGlowTexture,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0.22,
    }),
  );
  rimGlow.name = 'rim-glow';
  rimGlow.rotation.x = -Math.PI * 0.5;
  rimGlow.position.set(0, 0.015, 0);
  root.add(rimGlow);

  const audio = new SleepAudioDrive(BREATHING);

  // 落叶的初始状态（预生成，避免每帧新建）
  const leafState = fallingLeaves.map(() => ({
    angle: random() * Math.PI * 2,
    radius: 0.95 + random() * 0.45,
    height: 0.6 + random() * 1.1,
    spin: (random() - 0.5) * 0.5,
    fall: 0.012 + random() * 0.012,
    phase: random() * Math.PI * 2,
  }));

  return {
    root,
    camera,
    immersive: false,
    xrDistance: 1.6,
    framing: { distance: 2.3, height: 1.35, targetY: 0.62, width: 2.6 },
    update(time: number, delta: number, context: SceneContext): void {
      audio.update(time, delta, context);
      const state = audio.state;

      moteSpace.update(delta, time);

      // ── 井水：脉冲推起涟漪，呼吸带着水位涨落 ────────────────────────
      waterUniforms.uTime.value = time;
      waterUniforms.uPulse.value = state.pulse;
      waterUniforms.uBass.value = state.bass;
      waterUniforms.uDrive.value = state.drive;
      water.position.y = WATER_Y + state.drive * 0.012 + state.pulse * 0.004;

      // ── 月亮：低频让月影更亮一点 ────────────────────────────────────
      moonUniforms.uIntensity.value = 0.72 + state.level * 0.18 + state.bass * 0.08;
      haloUniforms.uIntensity.value = 0.22 + state.drive * 0.08;
      branchMaterial.uniforms.uLevel.value = state.level;

      // ── 井沿的柔光晕随呼吸微微起伏 ──────────────────────────────────
      (rimGlow.material as THREE.MeshBasicMaterial).opacity = 0.18 + state.drive * 0.08;
      rimGlow.scale.setScalar(0.98 + state.drive * 0.05);

      // ── 浮尘 ────────────────────────────────────────────────────────
      motes.uniforms.uTime.value = time;
      motes.uniforms.uLevel.value = state.level;
      motes.uniforms.uBreath.value = state.breath;
      updatePointScale(motes.uniforms.uScale, context, FOV);

      // ── 落叶：极慢地打着旋儿往下走 ──────────────────────────────────
      for (let i = 0; i < fallingLeaves.length; i += 1) {
        const leaf = fallingLeaves[i];
        const s = leafState[i];
        s.height -= s.fall * delta * (0.6 + state.drive * 0.5);
        s.angle += s.spin * delta * 0.35;
        if (s.height < 0.03) {
          s.height = 1.3 + (i % 3) * 0.25;
          s.angle = random() * Math.PI * 2;
          s.radius = 0.95 + random() * 0.45;
        }
        leaf.position.set(
          Math.cos(s.angle + time * 0.02) * s.radius,
          s.height,
          Math.sin(s.angle + time * 0.02) * s.radius,
        );
        leaf.rotation.set(
          time * 0.12 + s.phase,
          s.angle + time * 0.05,
          Math.sin(time * 0.2 + s.phase) * 0.6,
        );
      }

      // ── 穹顶 ────────────────────────────────────────────────────────
      dome.uniforms.uTime.value = time;
      dome.uniforms.uBreath.value = state.breath;

      deepLight.intensity = 0.35 + state.drive * 0.25;
    },
    dispose(): void {
      // InstancedMesh 额外持有 instanceMatrix 的 GPU buffer
      stones.dispose();
      rimGlowTexture.dispose();
      disposeObject(root);
    },
  };
}

export const moonWellScene: SceneDefinition = {
  id: 'moon-well',
  title: '月井',
  subtitle: 'Moon Well',
  description: '夜里的古井静得近乎凝固，井中映着一轮月亮，水面随呼吸极缓地涨落。',
  tags: ['古井', '月影', '冥想'],
  accent: '#8fa6c8',
  gradient: ['#131c2e', '#05070d'],
  category: SLEEP_CATEGORY,
  audio: 'moonwell-drone.mp3',
  breathing: BREATHING,
  lighting: {
    autoExposure: true,
    autoExposureKey: 0.065,
  },
  create(ctx: SceneContext): SceneInstance {
    return createMoonWell(ctx);
  },
};

export default moonWellScene;
