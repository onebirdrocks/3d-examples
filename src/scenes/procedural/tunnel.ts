import * as THREE from 'three';
import type { SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { disposeObject } from '../../core/loader.js';
import { GLSL_OUTPUT } from './lib/noise.js';
import { mulberry32 } from './lib/math.js';

/**
 * 无限隧道
 * 自驱相机（ownsCamera），场景本身沿 +Z 朝用户飞来：
 * 多边形肋环用 InstancedMesh 循环复用，管壁霓虹条纹沿轴流动，粒子拖尾强化速度感。
 * XR 中 three 接管相机，隧道迎面而来的动效保持一致。
 */

const TUNNEL_RADIUS = 4.4;
const TUNNEL_LENGTH = 300;
const RIB_COUNT = 34;
const RIB_SPACING = 4.2;
const RIB_START = -124;
const SPEED = 19;
const RAIL_COUNT = 6;

const WALL_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorldPos;

void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const WALL_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uSpeed;
uniform float uLength;
uniform float uRadius;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uCoreColor;

varying vec2 vUv;
varying vec3 vWorldPos;

void main() {
  float z = vUv.y * uLength;
  float a = vUv.x;
  float t = uTime * uSpeed;

  // 沿轴流动的窄脉冲
  float flow = fract(z * 0.052 - t * 0.052);
  float band = exp(-pow((flow - 0.5) * 7.0, 2.0));

  // 环向细线
  float ribs = pow(0.5 + 0.5 * sin(a * 6.2831853 * 40.0), 44.0);

  // 沿轴流动的环状光环
  float rings = pow(0.5 + 0.5 * cos(z * 0.784 - t * 0.784), 46.0);

  vec3 tint = mix(uColorA, uColorB, 0.5 + 0.5 * sin(a * 6.2831853 * 2.0 + t * 0.15));
  float glow = band * 0.42 + ribs * 0.22 + rings * 0.34;

  // 管壁底色 + 远处渐暗
  vec3 col = vec3(0.004, 0.006, 0.014);
  float dist = length(vWorldPos - cameraPosition);
  float fade = exp(-max(dist - 6.0, 0.0) * 0.022);

  col += tint * glow * (0.07 + 0.44 * fade);
  col += uCoreColor * exp(-max(dist - 6.0, 0.0) * 0.045) * 0.07;

  gl_FragColor = vec4(col, 1.0);
  ${GLSL_OUTPUT}
}
`;

const RAIL_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorldPos;

void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const RAIL_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uSpeed;
uniform float uLength;
uniform vec3 uColor;

varying vec2 vUv;
varying vec3 vWorldPos;

void main() {
  float z = vUv.y * uLength;
  float t = uTime * uSpeed;
  float pulse = exp(-pow(fract(z * 0.045 - t * 0.45) - 0.5, 2.0) * 70.0);
  float dist = length(vWorldPos - cameraPosition);
  float fade = exp(-max(dist - 4.0, 0.0) * 0.016);
  vec3 col = uColor * (0.08 + pulse * 1.5) * fade;
  gl_FragColor = vec4(col, 1.0);
  ${GLSL_OUTPUT}
}
`;

const GLOW_VERT = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const GLOW_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uColor;
uniform float uTime;

varying vec2 vUv;

void main() {
  vec2 p = vUv - 0.5;
  float r = length(p) * 2.0;
  float core = exp(-r * r * 9.0) * 0.5;
  float halo = exp(-r * 2.6) * 0.16;
  float flicker = 0.92 + 0.08 * sin(uTime * 3.1);
  gl_FragColor = vec4(uColor * (core + halo) * flicker, 1.0);
  ${GLSL_OUTPUT}
}
`;

function createTunnel(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'tunnel-scene';

  const camera = new THREE.PerspectiveCamera(76, 1, 0.05, 600);
  camera.position.set(0, 0, 0);
  camera.rotation.set(0, 0, 0);

  const quality = THREE.MathUtils.clamp(ctx.quality, 0.4, 2);
  const rng = mulberry32(97531);

  // ── 管壁 ──────────────────────────────────────────────────────────────
  const wallUniforms = {
    uTime: { value: 0 },
    uSpeed: { value: SPEED },
    uLength: { value: TUNNEL_LENGTH },
    uRadius: { value: TUNNEL_RADIUS },
    uColorA: { value: new THREE.Color(0x2fe6ff) },
    uColorB: { value: new THREE.Color(0xff3ba7) },
    uCoreColor: { value: new THREE.Color(0x6d4bff) },
  };

  const wallGeometry = new THREE.CylinderGeometry(
    TUNNEL_RADIUS,
    TUNNEL_RADIUS,
    TUNNEL_LENGTH,
    40,
    1,
    true,
  );
  wallGeometry.rotateX(Math.PI / 2);

  const wallMaterial = new THREE.ShaderMaterial({
    uniforms: wallUniforms,
    vertexShader: WALL_VERT,
    fragmentShader: WALL_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
  });

  const wall = new THREE.Mesh(wallGeometry, wallMaterial);
  wall.name = 'tunnel-wall';
  wall.renderOrder = -5;
  root.add(wall);

  // ── 肋环（实例化，循环复用） ──────────────────────────────────────────
  const ribGeometry = new THREE.TorusGeometry(TUNNEL_RADIUS - 0.16, 0.075, 4, 8);
  const ribMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const ribs = new THREE.InstancedMesh(ribGeometry, ribMaterial, RIB_COUNT);
  ribs.name = 'ribs';
  ribs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  ribs.frustumCulled = false;
  ribs.renderOrder = 1;

  const ribZ = new Float32Array(RIB_COUNT);
  const ribMatrix = new THREE.Matrix4();
  const ribColor = new THREE.Color();
  for (let i = 0; i < RIB_COUNT; i++) {
    ribZ[i] = RIB_START + i * RIB_SPACING;
  }
  root.add(ribs);

  // ── 轴向霓虹导轨 ──────────────────────────────────────────────────────
  const railUniforms = {
    uTime: { value: 0 },
    uSpeed: { value: SPEED },
    uLength: { value: TUNNEL_LENGTH },
    uColor: { value: new THREE.Color(0x54f0ff) },
  };
  const railMaterial = new THREE.ShaderMaterial({
    uniforms: railUniforms,
    vertexShader: RAIL_VERT,
    fragmentShader: RAIL_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const railGeometry = new THREE.CylinderGeometry(0.055, 0.055, TUNNEL_LENGTH, 6, 1, true);
  railGeometry.rotateX(Math.PI / 2);
  for (let i = 0; i < RAIL_COUNT; i++) {
    const angle = (i / RAIL_COUNT) * Math.PI * 2 + 0.26;
    const rail = new THREE.Mesh(railGeometry, railMaterial);
    rail.name = 'rail';
    rail.position.set(
      Math.cos(angle) * (TUNNEL_RADIUS - 0.42),
      Math.sin(angle) * (TUNNEL_RADIUS - 0.42),
      0,
    );
    rail.renderOrder = 2;
    root.add(rail);
  }

  // ── 速度拖尾粒子 ──────────────────────────────────────────────────────
  const streakCount = Math.round(170 * quality);
  const streakPositions = new Float32Array(streakCount * 6);
  const streakColors = new Float32Array(streakCount * 6);
  const streakAngle = new Float32Array(streakCount);
  const streakRadius = new Float32Array(streakCount);
  const streakHead = new THREE.Color(0x39c8ff);
  const streakTail = new THREE.Color(0x0a2a55);

  for (let i = 0; i < streakCount; i++) {
    streakAngle[i] = rng() * Math.PI * 2;
    streakRadius[i] = 1.1 + rng() * (TUNNEL_RADIUS - 1.4);
    const z = -TUNNEL_LENGTH * 0.42 + rng() * TUNNEL_LENGTH * 0.5;
    const i6 = i * 6;
    streakPositions[i6] = Math.cos(streakAngle[i]) * streakRadius[i];
    streakPositions[i6 + 1] = Math.sin(streakAngle[i]) * streakRadius[i];
    streakPositions[i6 + 2] = z;
    streakPositions[i6 + 3] = streakPositions[i6];
    streakPositions[i6 + 4] = streakPositions[i6 + 1];
    streakPositions[i6 + 5] = z - 1;
    streakColors[i6] = streakHead.r;
    streakColors[i6 + 1] = streakHead.g;
    streakColors[i6 + 2] = streakHead.b;
    streakColors[i6 + 3] = streakTail.r;
    streakColors[i6 + 4] = streakTail.g;
    streakColors[i6 + 5] = streakTail.b;
  }

  const streakGeometry = new THREE.BufferGeometry();
  const streakPositionAttribute = new THREE.BufferAttribute(streakPositions, 3);
  streakPositionAttribute.setUsage(THREE.DynamicDrawUsage);
  streakGeometry.setAttribute('position', streakPositionAttribute);
  streakGeometry.setAttribute('color', new THREE.BufferAttribute(streakColors, 3));

  const streakMaterial = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const streaks = new THREE.LineSegments(streakGeometry, streakMaterial);
  streaks.name = 'streaks';
  streaks.frustumCulled = false;
  streaks.renderOrder = 3;
  root.add(streaks);

  // ── 尽头的辉光 ────────────────────────────────────────────────────────
  const glowUniforms = {
    uColor: { value: new THREE.Color(0x8ad8ff) },
    uTime: { value: 0 },
  };
  const glowMaterial = new THREE.ShaderMaterial({
    uniforms: glowUniforms,
    vertexShader: GLOW_VERT,
    fragmentShader: GLOW_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const endGlow = new THREE.Mesh(new THREE.PlaneGeometry(26, 26), glowMaterial);
  endGlow.name = 'end-glow';
  endGlow.position.z = -TUNNEL_LENGTH * 0.46;
  endGlow.renderOrder = 0;
  root.add(endGlow);

  // ── 灯光（隧道内仅需微弱补光） ────────────────────────────────────────
  const lights = ctx.env.createStudioLights();
  lights.traverse((child) => {
    if (child instanceof THREE.Light) {
      child.intensity *= 0.12;
      child.castShadow = false;
    }
  });
  root.add(lights);

  const tunnelLight = new THREE.PointLight(0x66d8ff, 22, 26, 1.8);
  tunnelLight.position.set(0, 0, -8);
  root.add(tunnelLight);

  return {
    root,
    camera,
    immersive: true,
    ownsCamera: true,
    xrDistance: 3,
    framing: { distance: 4, height: 1.5, targetY: 1.4 },
    update(time: number, delta: number, _context: SceneContext): void {
      wallUniforms.uTime.value = time;
      railUniforms.uTime.value = time;
      glowUniforms.uTime.value = time;

      // 肋环沿 +Z 飞向用户，越过相机后回收到远端
      const step = SPEED * delta;
      for (let i = 0; i < RIB_COUNT; i++) {
        ribZ[i] += step;
        if (ribZ[i] > 6) {
          ribZ[i] -= RIB_COUNT * RIB_SPACING;
        }
        ribMatrix.makeTranslation(0, 0, ribZ[i]);
        ribs.setMatrixAt(i, ribMatrix);

        // 越近越亮，形成连续的光环拖尾
        const near = 1 - Math.min(1, Math.max(0, (ribZ[i] + 10) / 22));
        const hue = (i / RIB_COUNT) * 0.8 + ribZ[i] * 0.004;
        ribColor.setHSL((hue % 1) * 0.85 + 0.45, 0.95, 0.2 * (0.25 + near * 0.75));
        ribs.setColorAt(i, ribColor);
      }
      ribs.instanceMatrix.needsUpdate = true;
      if (ribs.instanceColor) ribs.instanceColor.needsUpdate = true;

      // 拖尾粒子：越靠近相机拖得越长
      for (let i = 0; i < streakCount; i++) {
        const i6 = i * 6;
        streakPositions[i6 + 2] += step * 1.35;
        if (streakPositions[i6 + 2] > 4) {
          streakAngle[i] = rng() * Math.PI * 2;
          streakRadius[i] = 1.1 + rng() * (TUNNEL_RADIUS - 1.4);
          streakPositions[i6] = Math.cos(streakAngle[i]) * streakRadius[i];
          streakPositions[i6 + 1] = Math.sin(streakAngle[i]) * streakRadius[i];
          streakPositions[i6 + 2] = -TUNNEL_LENGTH * 0.44 + rng() * 20;
        }
        const z = streakPositions[i6 + 2];
        const stretch = 0.6 + 6.5 * Math.max(0, 1 + z / 40);
        streakPositions[i6 + 3] = streakPositions[i6];
        streakPositions[i6 + 4] = streakPositions[i6 + 1];
        streakPositions[i6 + 5] = z - stretch;
      }
      streakPositionAttribute.needsUpdate = true;

      // 自行驱动的相机：轻微悬浮与侧摆（XR 中由 XR 相机接管）
      camera.position.set(
        Math.sin(time * 0.63) * 0.14,
        Math.sin(time * 0.87 + 1.2) * 0.11,
        0,
      );
      camera.rotation.set(
        Math.sin(time * 0.41) * 0.012,
        Math.sin(time * 0.33) * 0.018,
        Math.sin(time * 0.55) * 0.016,
      );
    },
    dispose(): void {
      disposeObject(root);
    },
  };
}

export const tunnelScene: SceneDefinition = {
  id: 'tunnel',
  title: '无限隧道',
  subtitle: 'Endless Tunnel',
  description: '霓虹肋环迎面飞来，轴向条纹与粒子拖尾把速度感拉满。',
  tags: ['隧道', '霓虹', '速度'],
  accent: '#3ee0ff',
  gradient: ['#06283c', '#07040f'],
  category: 'procedural',
  create(ctx: SceneContext): SceneInstance {
    return createTunnel(ctx);
  },
};

export default tunnelScene;
