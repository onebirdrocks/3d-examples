/**
 * 雾中灯塔 / Lighthouse in Fog
 * ---------------------------------------------------------------
 * 浓雾里的灯塔：塔身在雾中若隐若现，顶部的灯束缓慢旋转（约 10 秒一圈）。
 * 光束扫过的地方，雾团会被短暂照亮；海面几乎看不见，只有偶尔一道浪线。
 * 极其神秘，能催眠。
 *
 * 音乐如何驱动画面：
 * - `pulse` → 灯束的亮度（扫过时雾被照亮得更明显）与旋转的微弱加速；
 * - `bass` → 雾的浓度；
 * - `level` → 整体可见度；
 * - `treble` → 海面浪线的细碎微光。
 */
import * as THREE from 'three';
import type { SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { disposeObject } from '../../core/loader.js';
import { GLSL_DITHER, GLSL_HASH, GLSL_NOISE3, GLSL_OUTPUT, GLSL_OUTPUT_FUNCS } from './glsl.js';
import { SLEEP_CATEGORY, configureStandard, dimLights } from './palette.js';
import { SleepAudioDrive } from './audio-drive.js';

const BREATHING = { inhale: 6, hold: 2, exhale: 8, holdOut: 2 };

const FOV = 52;

/** 灯塔高度。 */
const TOWER_HEIGHT = 9.4;

/** 灯室（光源）高度。 */
const LAMP_Y = TOWER_HEIGHT + 0.42;

/** 灯束一圈的秒数。 */
const BEAM_PERIOD = 10;

/* ------------------------------------------------------------------ *
 * 雾层：几层半透明面片，靠近灯束时被照亮
 * ------------------------------------------------------------------ */

const FOG_VERT = /* glsl */ `
varying vec3 vWorld;

void main() {
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FOG_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uDensity;
uniform float uLevel;
uniform vec3 uFogColor;
uniform vec3 uBeamColor;
uniform vec3 uLampPos;
uniform float uBeamAngle;
uniform float uBeamWidth;
uniform float uPulse;

varying vec3 vWorld;

${GLSL_HASH}
${GLSL_NOISE3}
${GLSL_DITHER}
${GLSL_OUTPUT_FUNCS}

void main() {
  // 雾的自身密度：低频让雾更浓
  float n = fbm3( vWorld * 0.14 + vec3( uTime * 0.02, 0.0, -uTime * 0.015 ) );
  float n2 = fbm3( vWorld * 0.42 - vec3( 0.0, uTime * 0.03, 0.0 ) );
  float density = smoothstep( 0.2, 0.68, n * 0.72 + n2 * 0.28 ) * uDensity;

  // 上下两端淡出，避免看见壳的边缘
  float vert = smoothstep( -7.0, -1.0, vWorld.y ) * ( 1.0 - smoothstep( 13.0, 19.0, vWorld.y ) );

  vec3 col = uFogColor * density * ( 0.85 + 1.1 * uLevel );

  // ── 灯束照亮雾 ────────────────────────────────────────────────────
  // 只有当片元在灯束的方位角范围内、且在灯的下方才被照亮
  vec3 toFrag = vWorld - uLampPos;
  float dist = length( toFrag );
  vec3 dir = toFrag / max( dist, 0.0001 );

  // 灯束的水平方向（绕 Y 轴旋转）
  vec3 beamDir = vec3( cos( uBeamAngle ), 0.0, sin( uBeamAngle ) );
  float align = dot( dir, beamDir );

  // 只有略微向下、且方位角对齐时才可见
  float cone = smoothstep( uBeamWidth, 1.0, align ) * smoothstep( 0.1, -0.28, dir.y );
  float falloff = 1.0 / ( 1.0 + dist * 0.16 );

  // 光束扫过雾团时，噪声决定哪些团被照亮
  float clumps = 0.4 + 1.0 * n;
  float lit = cone * falloff * clumps * ( 0.55 + 0.9 * uPulse );
  col += uBeamColor * lit * 2.2;

  float alpha = ( density * 1.15 + lit * 0.55 ) * vert;
  if ( alpha < 0.004 ) discard;

  col += ( dither( gl_FragCoord.xy ) - 0.5 ) * 0.004;
  gl_FragColor = vec4( col, alpha );
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * 灯束本体：加性混合的锥体
 * ------------------------------------------------------------------ */

const BEAM_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vNormalV;
varying vec3 vViewV;

void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  vNormalV = normalize( normalMatrix * normal );
  vViewV = normalize( -mv.xyz );
  gl_Position = projectionMatrix * mv;
}
`;

const BEAM_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uIntensity;
uniform vec3 uBeamColor;

varying vec2 vUv;
varying vec3 vNormalV;
varying vec3 vViewV;

${GLSL_HASH}
${GLSL_OUTPUT_FUNCS}

void main() {
  // 沿光束长度衰减：近灯口最亮，越远越淡（uv.y = 0 是灯口）
  float along = 1.0 - smoothstep( 0.0, 1.0, vUv.y );
  along *= along;

  // 边缘越掠射，视线穿过的「雾体积」越多 → 边缘更亮，读起来像一束光
  float rim = 1.0 - abs( dot( normalize( vNormalV ), normalize( vViewV ) ) );
  rim = pow( clamp( rim, 0.0, 1.0 ), 1.6 );

  // 极缓的空气抖动
  float shimmer = 0.86 + 0.14 * sin( uTime * 0.6 + vUv.y * 7.0 );

  float alpha = along * ( 0.22 + 0.78 * rim ) * uIntensity * shimmer * 0.5;
  if ( alpha < 0.004 ) discard;

  gl_FragColor = vec4( uBeamColor * alpha, alpha );
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * 海面：几乎看不见，只有偶尔一道浪线
 * ------------------------------------------------------------------ */

const SEA_VERT = /* glsl */ `
varying vec3 vWorld;
varying vec2 vUv;

void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SEA_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uLevel;
uniform float uTreble;
uniform float uPulse;
uniform vec3 uSeaColor;
uniform vec3 uBeamColor;
uniform vec3 uLampPos;
uniform float uBeamAngle;

varying vec3 vWorld;
varying vec2 vUv;

${GLSL_HASH}
${GLSL_NOISE3}
${GLSL_DITHER}
${GLSL_OUTPUT_FUNCS}

void main() {
  vec3 toFrag = vWorld - uLampPos;
  float dist = length( toFrag );
  vec3 dir = toFrag / max( dist, 0.0001 );
  vec3 beamDir = vec3( cos( uBeamAngle ), 0.0, sin( uBeamAngle ) );
  float align = dot( dir, beamDir );
  float inBeam = smoothstep( 0.86, 1.0, align ) * smoothstep( 0.05, -0.05, dir.y );

  // 浪线：非常稀疏的横向条纹
  float rows = vWorld.z * 0.62 + uTime * 0.021;
  float wave = sin( rows * 6.2831 + hash12( vec2( floor( rows ), 3.0 ) ) * 6.0 );
  float line = smoothstep( 0.955, 0.995, wave );

  vec3 col = uSeaColor * ( 0.3 + 0.5 * uLevel );
  col += uBeamColor * line * inBeam * ( 0.5 + 0.9 * uPulse + uTreble * 0.6 );

  // 远处完全融进雾里
  float fade = 1.0 - smoothstep( 6.0, 42.0, dist );
  float alpha = ( 0.10 + line * 0.55 ) * fade;

  col += ( dither( gl_FragCoord.xy ) - 0.5 ) * 0.004;
  gl_FragColor = vec4( col, alpha );
  ${GLSL_OUTPUT}
}
`;

function createFogLighthouse(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'fog-lighthouse-scene';

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 300);
  camera.position.set(0, 3.6, 15.5);
  camera.lookAt(0, 4.4, 0);

  // ── 雾底色穹顶 ──────────────────────────────────────────────────────────
  const skyUniforms = {
    uZenith: { value: new THREE.Color(0x0a0e14) },
    uHorizon: { value: new THREE.Color(0x141a22) },
    uGround: { value: new THREE.Color(0x070a0e) },
  };
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(140, 32, 20),
    new THREE.ShaderMaterial({
      uniforms: skyUniforms,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize( position );
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uZenith;
        uniform vec3 uHorizon;
        uniform vec3 uGround;
        varying vec3 vDir;
        ${GLSL_OUTPUT_FUNCS}
        void main() {
          float y = vDir.y;
          vec3 col = mix( uHorizon, uZenith, smoothstep( -0.02, 0.7, y ) );
          col = mix( col, uGround, smoothstep( 0.0, -0.25, y ) );
          gl_FragColor = vec4( col, 1.0 );
          ${GLSL_OUTPUT}
        }
      `,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    }),
  );
  sky.name = 'fog-sky';
  sky.renderOrder = -1000;
  sky.frustumCulled = false;
  root.add(sky);

  // ── 海面 ──────────────────────────────────────────────────────────────
  const seaUniforms = {
    uTime: { value: 0 },
    uLevel: { value: 0 },
    uTreble: { value: 0 },
    uPulse: { value: 0 },
    uSeaColor: { value: new THREE.Color(0x1b2530) },
    uBeamColor: { value: new THREE.Color(0xffe2ab) },
    uLampPos: { value: new THREE.Vector3(0, LAMP_Y, 0) },
    uBeamAngle: { value: 0 },
  };
  const seaGeometry = new THREE.PlaneGeometry(120, 120, 1, 1);
  seaGeometry.rotateX(-Math.PI / 2);
  const sea = new THREE.Mesh(
    seaGeometry,
    new THREE.ShaderMaterial({
      uniforms: seaUniforms,
      vertexShader: SEA_VERT,
      fragmentShader: SEA_FRAG,
      transparent: true,
      depthWrite: false,
    }),
  );
  sea.name = 'sea';
  sea.position.y = 0;
  sea.renderOrder = 1;
  root.add(sea);

  // ── 灯塔 ──────────────────────────────────────────────────────────────
  const towerMaterial = new THREE.MeshStandardMaterial({
    color: 0x2e3742,
    roughness: 0.9,
    metalness: 0,
  });
  configureStandard(towerMaterial, ctx.env.envMap, 0.18);

  const tower = new THREE.Mesh(
    new THREE.CylinderGeometry(0.92, 1.34, TOWER_HEIGHT, 24, 1),
    towerMaterial,
  );
  tower.name = 'tower';
  tower.position.y = TOWER_HEIGHT * 0.5;
  root.add(tower);

  // 塔基
  const base = new THREE.Mesh(new THREE.CylinderGeometry(1.42, 1.72, 0.7, 24, 1), towerMaterial);
  base.name = 'tower-base';
  base.position.y = 0.35;
  root.add(base);

  // 灯室的栏杆
  const railMaterial = new THREE.MeshStandardMaterial({
    color: 0x222a34,
    roughness: 0.82,
    metalness: 0.25,
  });
  configureStandard(railMaterial, ctx.env.envMap, 0.24);

  const gallery = new THREE.Mesh(new THREE.CylinderGeometry(1.12, 1.12, 0.1, 24, 1), railMaterial);
  gallery.name = 'gallery';
  gallery.position.y = TOWER_HEIGHT + 0.05;
  root.add(gallery);

  for (let i = 0; i < 10; i += 1) {
    const angle = (i / 10) * Math.PI * 2;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.42, 6, 1), railMaterial);
    post.name = 'rail-post';
    post.position.set(Math.cos(angle) * 1.04, TOWER_HEIGHT + 0.28, Math.sin(angle) * 1.04);
    root.add(post);
  }

  // 灯室本体
  const lantern = new THREE.Mesh(
    new THREE.CylinderGeometry(0.56, 0.56, 0.72, 20, 1, true),
    railMaterial,
  );
  lantern.name = 'lantern';
  lantern.position.y = LAMP_Y - 0.1;
  root.add(lantern);

  // 灯室的锥顶
  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.68, 0.52, 20, 1), railMaterial);
  cap.name = 'lantern-cap';
  cap.position.y = LAMP_Y + 0.52;
  root.add(cap);

  // 灯本身
  const lampMaterial = new THREE.MeshBasicMaterial({
    color: 0xffe9bd,
    transparent: true,
    opacity: 0.95,
  });
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.17, 16, 12), lampMaterial);
  lamp.name = 'lamp';
  lamp.position.y = LAMP_Y;
  root.add(lamp);

  const lampLight = new THREE.PointLight(0xffe0aa, 2.4, 12, 2);
  lampLight.name = 'lamp-light';
  lampLight.position.set(0, LAMP_Y, 0);
  root.add(lampLight);

  // ── 灯束 ──────────────────────────────────────────────────────────────
  const beamUniforms = {
    uTime: { value: 0 },
    uIntensity: { value: 0.55 },
    uBeamColor: { value: new THREE.Color(0xffe0aa) },
  };
  const beamMaterial = new THREE.ShaderMaterial({
    uniforms: beamUniforms,
    vertexShader: BEAM_VERT,
    fragmentShader: BEAM_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });

  const beamPivot = new THREE.Group();
  beamPivot.name = 'beam-pivot';
  beamPivot.position.set(0, LAMP_Y, 0);
  root.add(beamPivot);

  // 两条相对的光束：锥体从灯口向外扩散
  // 窄端在灯口（z = 0），宽端在远处（z = 18）
  const beamGeometry = new THREE.CylinderGeometry(3.4, 0.14, 18, 24, 1, true);
  beamGeometry.rotateX(Math.PI / 2);
  beamGeometry.translate(0, 0, 9);

  for (const side of [0, 1]) {
    const beam = new THREE.Mesh(beamGeometry, beamMaterial);
    beam.name = `beam-${side}`;
    beam.rotation.y = side * Math.PI;
    beam.renderOrder = 3;
    beamPivot.add(beam);
  }

  // ── 雾层：几层同心圆筒壳，从内外两侧看都有雾 ──────────────────────
  const fogUniformsList: { value: number }[] = [];
  const fogMaterials: THREE.ShaderMaterial[] = [];
  const fogRadii = [9, 15, 22, 31];
  for (let i = 0; i < fogRadii.length; i += 1) {
    const uniforms = {
      uTime: { value: 0 },
      uDensity: { value: 0.5 },
      uLevel: { value: 0 },
      uPulse: { value: 0 },
      uFogColor: { value: new THREE.Color(0x4a5c6e) },
      uBeamColor: { value: new THREE.Color(0xffe2ab) },
      uLampPos: { value: new THREE.Vector3(0, LAMP_Y, 0) },
      uBeamAngle: { value: 0 },
      uBeamWidth: { value: 0.988 },
    };
    fogUniformsList.push(uniforms.uTime);
    fogMaterials.push(
      new THREE.ShaderMaterial({
        uniforms,
        vertexShader: FOG_VERT,
        fragmentShader: FOG_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.NormalBlending,
        side: THREE.DoubleSide,
      }),
    );

    const fog = new THREE.Mesh(
      new THREE.CylinderGeometry(fogRadii[i], fogRadii[i], 26, 40, 1, true),
      fogMaterials[i],
    );
    fog.name = `fog-layer-${i}`;
    fog.position.y = 6;
    fog.renderOrder = 2 + i;
    root.add(fog);
  }

  const lights = ctx.env.createStudioLights();
  dimLights(lights, 0.03, 0x2a3644);
  root.add(lights);

  const audio = new SleepAudioDrive(BREATHING);
  let beamAngle = 0;

  return {
    root,
    camera,
    immersive: true,
    xrDistance: 3,
    framing: { distance: 15.5, height: 3.6, targetY: 4.4, width: 18 },
    update(time: number, delta: number, context: SceneContext): void {
      audio.update(time, delta, context);
      const state = audio.state;

      // ── 灯束旋转：一圈约 10 秒，脉冲带来一点点额外的推力 ──────────
      const beamSpeed = (Math.PI * 2) / BEAM_PERIOD;
      beamAngle += beamSpeed * delta * (1 + state.pulse * 0.35);
      beamPivot.rotation.y = beamAngle;

      const beamIntensity = 0.42 + state.pulse * 0.45 + state.level * 0.2;
      beamUniforms.uTime.value = time;
      beamUniforms.uIntensity.value = beamIntensity;

      lampMaterial.opacity = 0.7 + state.pulse * 0.3;
      lamp.scale.setScalar(0.92 + state.pulse * 0.16);
      lampLight.intensity = 1.9 + state.pulse * 1.6 + state.level * 0.6;

      // ── 雾层 ────────────────────────────────────────────────────────
      for (let i = 0; i < fogMaterials.length; i += 1) {
        const uniforms = fogMaterials[i].uniforms;
        uniforms.uTime.value = time;
        uniforms.uLevel.value = state.level;
        uniforms.uPulse.value = state.pulse;
        uniforms.uBeamAngle.value = beamAngle;
        // 低频让雾更浓
        uniforms.uDensity.value = 0.5 + state.bass * 0.55 + state.drive * 0.18;
      }
      fogUniformsList.forEach((uniform) => {
        uniform.value = time;
      });

      // ── 海面 ────────────────────────────────────────────────────────
      seaUniforms.uTime.value = time;
      seaUniforms.uLevel.value = state.level;
      seaUniforms.uTreble.value = state.treble;
      seaUniforms.uPulse.value = state.pulse;
      seaUniforms.uBeamAngle.value = beamAngle;
    },
    dispose(): void {
      disposeObject(root);
    },
  };
}

export const fogLighthouseScene: SceneDefinition = {
  id: 'fog-lighthouse',
  title: '雾中灯塔',
  subtitle: 'Lighthouse in Fog',
  description: '灯束在浓雾里一圈一圈地转，海面藏起来，只等它下一次扫过来。',
  tags: ['灯塔', '浓雾', '海'],
  accent: '#9fb6c9',
  gradient: ['#1a232e', '#06090d'],
  category: SLEEP_CATEGORY,
  audio: 'enigma-ritual.mp3',
  breathing: BREATHING,
  create(ctx: SceneContext): SceneInstance {
    return createFogLighthouse(ctx);
  },
};

export default fogLighthouseScene;
