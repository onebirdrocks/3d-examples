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
  applyHaze,
  createGlowTexture,
  createRainStreaks,
  createSkyDome,
} from './lib.js';

/**
 * 雨夜街道 / Rainy Street
 *
 * 一条窄街：湿沥青把两侧的霓虹招牌揉成一片模糊的水光，远处有暖色窗光，
 * 细雨在灯下成束可见，地面积水泛着缓慢扩散的涟漪。
 *
 * 音乐驱动：
 * - pulse（低频起音 / 呼吸兜底）→ 雨势强弱（雨丝长度、密度、涟漪速度）；
 * - level → 霓虹与窗光的亮度、地面的湿润反光；
 * - bass → 积水的晃动幅度；mid → 霓虹的缓慢明灭；treble → 雨滴与涟漪的细碎闪烁。
 */

const BREATHING = { inhale: 6, hold: 2, exhale: 8 };
const FOV = 52;

const HAZE_COLOR = 0x0a1018;

/* ------------------------------------------------------------------ *
 * 立面贴图
 * ------------------------------------------------------------------ */

/** 一面砖墙：暗色砖缝 + 零星亮着的窗。 */
function createFacadeTexture(size: number, seed: number, warm: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');

  let state = seed >>> 0;
  const random = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };

  ctx.fillStyle = '#0b0e14';
  ctx.fillRect(0, 0, size, size);

  // 砖缝
  const rows = 26;
  const rh = size / rows;
  for (let r = 0; r < rows; r += 1) {
    const offset = (r % 2) * 0.5;
    for (let c = -1; c < 9; c += 1) {
      const bw = size / 8;
      const x = (c + offset) * bw;
      const y = r * rh;
      const shade = 14 + Math.floor(random() * 12);
      ctx.fillStyle = `rgb(${shade},${shade + 2},${shade + 6})`;
      ctx.fillRect(x + 1, y + 1, bw - 2, rh - 2);
    }
  }

  // 窗
  const cols = 4;
  const winRows = 5;
  const margin = size * 0.1;
  const cellW = (size - margin * 2) / cols;
  const cellH = (size - margin * 2) / winRows;
  for (let r = 0; r < winRows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const x = margin + c * cellW + cellW * 0.22;
      const y = margin + r * cellH + cellH * 0.2;
      const w = cellW * 0.56;
      const h = cellH * 0.5;
      const roll = random();
      if (roll < 0.34) {
        // 暗窗
        ctx.fillStyle = '#070910';
        ctx.fillRect(x, y, w, h);
      } else {
        const bright = 0.35 + random() * 0.65;
        const r0 = Math.round(255 * bright * (0.72 + warm * 0.28));
        const g0 = Math.round(255 * bright * (0.62 + warm * 0.22));
        const b0 = Math.round(255 * bright * (0.42 + warm * 0.12));
        ctx.fillStyle = `rgb(${r0},${g0},${b0})`;
        ctx.fillRect(x, y, w, h);
        // 窗框
        ctx.strokeStyle = 'rgba(8,10,16,0.9)';
        ctx.lineWidth = Math.max(1, size / 256);
        ctx.strokeRect(x, y, w, h);
        ctx.beginPath();
        ctx.moveTo(x + w / 2, y);
        ctx.lineTo(x + w / 2, y + h);
        ctx.stroke();
      }
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'facade';
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

/* ------------------------------------------------------------------ *
 * 霓虹在地面的倒影
 * ------------------------------------------------------------------ */

const SMEAR_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorld;

void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SMEAR_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uColor;
uniform float uIntensity;
uniform float uTime;
uniform float uWidth;

varying vec2 vUv;
varying vec3 vWorld;

${GLSL_HASH}
${GLSL_NOISE2}
${GLSL_OUTPUT_FUNCS}

void main() {
  // 横向：紧贴招牌的一条光带，越远越散
  float lateral = 1.0 - smoothstep( 0.0, uWidth, abs( vUv.x - 0.5 ) * 2.0 );
  // 纵向：越靠近招牌越亮
  float along = pow( clamp( vUv.y, 0.0, 1.0 ), 1.7 );

  // 水面把光带揉碎
  float n = fbm2( vec2( vUv.x * 7.0, vUv.y * 3.0 - uTime * 0.22 ), 3 );
  float ripple = 0.55 + 0.85 * n;

  float a = lateral * along * ripple * uIntensity;
  if ( a < 0.004 ) discard;

  gl_FragColor = vec4( uColor * a, a );
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * 涟漪
 * ------------------------------------------------------------------ */

const RIPPLE_VERT = /* glsl */ `
varying vec3 vWorld;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const RIPPLE_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uIntensity;
uniform float uSpeed;
uniform vec2 uCenters[6];

varying vec3 vWorld;

${GLSL_HASH}
${GLSL_NOISE2}
${GLSL_OUTPUT_FUNCS}

void main() {
  // 只有积水的地方才看得见涟漪（与地面的湿度遮罩一致）
  float wet = smoothstep( 0.42, 0.78, fbm2( vWorld.xz * 0.38, 3 ) );
  if ( wet < 0.02 ) discard;

  float rings = 0.0;
  for ( int i = 0; i < 6; i++ ) {
    float phase = fract( uTime * uSpeed * ( 0.85 + float( i ) * 0.07 ) + float( i ) * 0.37 );
    float radius = phase * 2.1;
    float d = distance( vWorld.xz, uCenters[i] );
    float ring = smoothstep( 0.16, 0.0, abs( d - radius ) ) * ( 1.0 - phase );
    rings += ring;
  }

  float a = clamp( rings, 0.0, 1.0 ) * wet * uIntensity;
  if ( a < 0.004 ) discard;

  gl_FragColor = vec4( vec3( 0.62, 0.72, 0.86 ) * a, a );
  ${GLSL_OUTPUT}
}
`;

/* ------------------------------------------------------------------ *
 * 场景
 * ------------------------------------------------------------------ */

interface NeonSign {
  mesh: THREE.Mesh;
  glow: THREE.Sprite;
  smear: THREE.Mesh;
  smearMaterial: THREE.ShaderMaterial;
  material: THREE.MeshBasicMaterial;
  baseColor: THREE.Color;
  light: THREE.PointLight | null;
}

function createRainyStreet(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  root.name = 'rainy-street-scene';

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 600);
  camera.position.set(0, 1.6, 5.2);

  const quality = THREE.MathUtils.clamp(ctx.quality, 0.4, 2);
  const driver = new AudioDriver();

  let state = 90210;
  const random = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };

  // ── 天空（远处的天光，给远景一点底色） ────────────────────────────────
  const sky = createSkyDome({
    zenith: 0x05070d,
    horizon: 0x121a26,
    ground: 0x070a10,
    radius: 320,
    bandColor: 0x2a3242,
    bandStrength: 0.35,
    bandY: 0.02,
    bandWidth: 0.14,
  });
  root.add(sky.mesh);

  // ── 地面 ──────────────────────────────────────────────────────────────
  const baseGround = ctx.env.createGround(90);
  baseGround.position.y = -0.08;
  baseGround.receiveShadow = false;
  const baseGroundMaterial = (baseGround as THREE.Mesh).material as THREE.MeshStandardMaterial;
  baseGroundMaterial.envMap = ctx.env.envMap;
  baseGroundMaterial.envMapIntensity = 0.04;
  root.add(baseGround);

  const streetUniforms = {
    uTime: { value: 0 },
  };

  const streetMaterial = new THREE.MeshStandardMaterial({
    color: 0x05070b,
    roughness: 0.5,
    metalness: 0.28,
  });
  // 显式挂 envMap，否则 scene.environment 会以满强度参与 IBL
  streetMaterial.envMap = ctx.env.envMap;
  streetMaterial.envMapIntensity = 0.22;
  applyHaze(streetMaterial, { color: HAZE_COLOR, near: 8, far: 46 });

  const previousCompile = streetMaterial.onBeforeCompile;
  streetMaterial.onBeforeCompile = (shader, renderer) => {
    previousCompile?.(shader, renderer);
    shader.uniforms.uTime = streetUniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorldPos;')
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\n\tvWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nvarying vec3 vWorldPos;\nuniform float uTime;\n${GLSL_HASH}\n${GLSL_NOISE2}`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
  float wet = smoothstep( 0.42, 0.78, fbm2( vWorldPos.xz * 0.38, 3 ) );
  diffuseColor.rgb *= mix( 1.0, 0.4, wet );`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
  roughnessFactor = mix( 0.72, 0.045, wet );`,
      );
  };
  streetMaterial.needsUpdate = true;

  const streetGeometry = new THREE.PlaneGeometry(9, 58, 1, 1);
  streetGeometry.rotateX(-Math.PI / 2);
  const street = new THREE.Mesh(streetGeometry, streetMaterial);
  street.name = 'wet-street';
  street.position.set(0, 0.02, -20);
  root.add(street);

  // 人行道
  const sidewalkMaterial = new THREE.MeshStandardMaterial({
    color: 0x14171d,
    roughness: 0.88,
    metalness: 0.02,
  });
  sidewalkMaterial.envMap = ctx.env.envMap;
  sidewalkMaterial.envMapIntensity = 0.06;
  applyHaze(sidewalkMaterial, { color: HAZE_COLOR, near: 10, far: 46 });

  for (const side of [-1, 1]) {
    const geometry = new THREE.BoxGeometry(1.5, 0.16, 58);
    const walk = new THREE.Mesh(geometry, sidewalkMaterial);
    walk.name = 'sidewalk';
    walk.position.set(side * 4.35, 0.08, -20);
    root.add(walk);
  }

  // ── 建筑立面 ─────────────────────────────────────────────────────────
  const facadeTextures = [
    createFacadeTexture(256, 11, 0.9),
    createFacadeTexture(256, 29, 0.55),
    createFacadeTexture(256, 47, 0.75),
    createFacadeTexture(256, 83, 0.3),
  ];
  const facadeMaterials = facadeTextures.map((texture) => {
    const material = new THREE.MeshStandardMaterial({
      color: 0x383e49,
      roughness: 0.94,
      metalness: 0.0,
      map: texture,
    });
    material.envMap = ctx.env.envMap;
    material.envMapIntensity = 0.05;
    applyHaze(material, { color: HAZE_COLOR, near: 9, far: 44 });
    return material;
  });

  for (const side of [-1, 1]) {
    for (let i = 0; i < 9; i += 1) {
      const length = 4.4 + random() * 2.4;
      const height = 6.5 + random() * 7.5;
      const depth = 5 + random() * 3.5;
      const z = 6.5 - i * 5.7 - random() * 1.4;

      const geometry = new THREE.BoxGeometry(depth, height, length);
      // 让窗户的排布跟随建筑尺寸，而不是被拉伸
      const uv = geometry.getAttribute('uv') as THREE.BufferAttribute;
      for (let v = 0; v < uv.count; v += 1) {
        uv.setXY(v, uv.getX(v) * (length / 5.5), uv.getY(v) * (height / 9));
      }
      uv.needsUpdate = true;

      const building = new THREE.Mesh(
        geometry,
        facadeMaterials[Math.floor(random() * facadeMaterials.length)],
      );
      building.name = 'facade';
      building.position.set(side * (3.6 + depth / 2), height / 2, z);
      root.add(building);
    }
  }

  // ── 霓虹招牌 ─────────────────────────────────────────────────────────
  const glowTexture = createGlowTexture(128, 2.2);
  const signs: NeonSign[] = [];

  const signSpecs: {
    side: number;
    z: number;
    y: number;
    w: number;
    h: number;
    color: number;
    vertical: boolean;
    light: number;
  }[] = [
    { side: -1, z: -4.2, y: 3.4, w: 0.5, h: 3.2, color: 0xff2e88, vertical: true, light: 1 },
    { side: 1, z: -2.6, y: 2.6, w: 2.4, h: 0.44, color: 0x25e0ff, vertical: false, light: 1 },
    { side: -1, z: -7.4, y: 4.6, w: 0.44, h: 2.2, color: 0xffb14e, vertical: true, light: 1 },
    { side: 1, z: -12.8, y: 3.1, w: 1.8, h: 0.4, color: 0x9a6cff, vertical: false, light: 0 },
    { side: -1, z: -18.5, y: 2.4, w: 2.2, h: 0.42, color: 0x6cff9e, vertical: false, light: 0 },
    { side: 1, z: -24.0, y: 4.9, w: 0.46, h: 2.6, color: 0xff2e88, vertical: true, light: 0 },
    { side: -1, z: -30.5, y: 3.2, w: 2.6, h: 0.42, color: 0x25e0ff, vertical: false, light: 0 },
  ];

  for (const spec of signSpecs) {
    const material = new THREE.MeshBasicMaterial({ color: spec.color, toneMapped: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(spec.w, spec.h), material);
    mesh.name = 'neon-sign';
    mesh.position.set(spec.side * 3.55, spec.y, spec.z);
    mesh.rotation.y = spec.side < 0 ? Math.PI / 2 : -Math.PI / 2;
    root.add(mesh);

    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture,
        color: spec.color,
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    glow.name = 'neon-glow';
    glow.scale.setScalar(Math.max(spec.w, spec.h) * 1.7);
    glow.position.set(spec.side * 3.42, spec.y, spec.z);
    root.add(glow);

    // 地面上的倒影：沿着视线方向拉长的一条水光
    const smearMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(spec.color) },
        uIntensity: { value: 0.4 },
        uTime: { value: 0 },
        uWidth: { value: 0.55 },
      },
      vertexShader: SMEAR_VERT,
      fragmentShader: SMEAR_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const smearLength = 9;
    const smear = new THREE.Mesh(new THREE.PlaneGeometry(2.2, smearLength), smearMaterial);
    smear.name = 'neon-smear';
    smear.rotation.x = -Math.PI / 2;
    smear.position.set(spec.side * 2.9, 0.035, spec.z + smearLength / 2);
    root.add(smear);

    let light: THREE.PointLight | null = null;
    if (spec.light > 0) {
      light = new THREE.PointLight(spec.color, 14, 16, 2);
      light.position.set(spec.side * 3.0, spec.y, spec.z);
      root.add(light);
    }

    signs.push({ mesh, glow, smear, smearMaterial, material, baseColor: new THREE.Color(spec.color), light });
  }

  // ── 街灯 ─────────────────────────────────────────────────────────────
  const lampMaterial = new THREE.MeshStandardMaterial({
    color: 0x1a1d23,
    roughness: 0.7,
    metalness: 0.5,
  });
  lampMaterial.envMap = ctx.env.envMap;
  lampMaterial.envMapIntensity = 0.1;

  const lampHeadMaterial = new THREE.MeshBasicMaterial({ color: 0xffd7a0, toneMapped: false });

  const lampPositions: THREE.Vector3[] = [
    new THREE.Vector3(3.1, 4.35, -4.6),
    new THREE.Vector3(-3.2, 4.05, -15.4),
  ];
  const lampLights: THREE.PointLight[] = [];

  for (const position of lampPositions) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, position.y, 8), lampMaterial);
    pole.name = 'lamp-pole';
    pole.position.set(position.x, position.y / 2, position.z);
    root.add(pole);

    const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.16, 0.3), lampHeadMaterial);
    head.name = 'lamp-head';
    head.position.copy(position);
    root.add(head);

    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture,
        color: 0xffc98a,
        transparent: true,
        opacity: 0.6,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    halo.name = 'lamp-halo';
    halo.scale.setScalar(2.6);
    halo.position.copy(position);
    root.add(halo);

    const light = new THREE.PointLight(0xffc27a, 26, 18, 2);
    light.position.copy(position);
    light.position.y -= 0.1;
    root.add(light);
    lampLights.push(light);
  }

  // 街道尽头：暖色窗光，给远景一个可读的深度
  const farFacadeMaterial = new THREE.MeshStandardMaterial({ color: 0x191d26, roughness: 0.95 });
  farFacadeMaterial.envMap = ctx.env.envMap;
  farFacadeMaterial.envMapIntensity = 0.05;
  const farFacade = new THREE.Mesh(new THREE.BoxGeometry(14, 9, 2), farFacadeMaterial);
  farFacade.name = 'far-facade';
  farFacade.position.set(0.6, 4.5, -47);
  root.add(farFacade);

  const farWindowMaterial = new THREE.MeshBasicMaterial({ color: 0xffc078, toneMapped: false });
  for (let i = 0; i < 7; i += 1) {
    const windowMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 1.1), farWindowMaterial);
    windowMesh.name = 'far-window';
    windowMesh.position.set(-4.6 + i * 1.7, 1.6 + (i % 3) * 2.1, -45.9);
    root.add(windowMesh);
  }
  const farGlow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture,
      color: 0xffb066,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  farGlow.name = 'far-glow';
  farGlow.scale.set(16, 11, 1);
  farGlow.position.set(0.6, 3.4, -45);
  root.add(farGlow);

  // ── 涟漪层 ───────────────────────────────────────────────────────────
  const rippleMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uIntensity: { value: 0.5 },
      uSpeed: { value: 0.16 },
      uCenters: {
        value: [
          new THREE.Vector2(-1.2, -3.5),
          new THREE.Vector2(1.6, -8.2),
          new THREE.Vector2(-2.1, -13.4),
          new THREE.Vector2(0.8, -19.0),
          new THREE.Vector2(2.2, -25.5),
          new THREE.Vector2(-1.4, -31.0),
        ],
      },
    },
    vertexShader: RIPPLE_VERT,
    fragmentShader: RIPPLE_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const rippleGeometry = new THREE.PlaneGeometry(9, 58, 1, 1);
  rippleGeometry.rotateX(-Math.PI / 2);
  const ripples = new THREE.Mesh(rippleGeometry, rippleMaterial);
  ripples.name = 'ripples';
  ripples.position.set(0, 0.045, -20);
  root.add(ripples);

  // ── 雨 ───────────────────────────────────────────────────────────────
  const rainSpace = new ParticleSpace({
    radius: 11,
    spin: 0.004,
    tilt: 0.03,
    position: [0, 3.4, -8],
  });
  const lightPositions = [
    lampPositions[0],
    lampPositions[1],
    new THREE.Vector3(-3.0, 3.4, 1.2),
    new THREE.Vector3(3.0, 2.6, -2.6),
  ];
  const rain = createRainStreaks(rainSpace, {
    count: Math.round(3400 * quality),
    radius: 11,
    height: 13,
    lights: lightPositions,
    color: new THREE.Color(0xc4d8ea),
    seed: 5150,
  });
  root.add(rain.lines);

  // ── 灯光 ─────────────────────────────────────────────────────────────
  const lights = ctx.env.createStudioLights();
  lights.traverse((child) => {
    if (child instanceof THREE.Light) {
      child.intensity *= 0.2;
      child.castShadow = false;
      child.color.setHex(0x2c3a52);
    }
  });
  root.add(lights);

  return {
    root,
    camera,
    immersive: false,
    xrDistance: 3,
    framing: { distance: 5.2, height: 1.6, targetY: 1.9, width: 7.2 },
    update(time: number, delta: number, context: SceneContext): void {
      driver.update(context, delta);

      const pulse = driver.pulse;
      const level = driver.level;

      streetUniforms.uTime.value = time;
      sky.uniforms.uTime.value = time;
      sky.uniforms.uLevel.value = level;

      // 雨势：脉冲越大，雨越大越急
      rain.uniforms.uTime.value = time;
      rain.uniforms.uLength.value = 0.2 + pulse * 0.38;
      rain.uniforms.uSpeed.value = 6.2 + pulse * 3.4 + driver.treble * 1.6;
      rain.uniforms.uOpacity.value = 0.5 + level * 0.3;
      rain.uniforms.uIntensity.value = 0.45 + pulse * 0.8;

      rainSpace.breathe = 1 + pulse * 0.04;
      rainSpace.breathPhase = pulse;
      rainSpace.update(delta, time);

      // 涟漪随脉冲加快、随低频加深
      rippleMaterial.uniforms.uTime.value = time;
      rippleMaterial.uniforms.uSpeed.value = 0.1 + pulse * 0.14;
      rippleMaterial.uniforms.uIntensity.value = 0.28 + pulse * 0.5 + driver.bass * 0.16;

      // 霓虹：中频带来缓慢的明灭，高频带来细碎闪烁
      for (const sign of signs) {
        const flicker = 0.86 + 0.14 * Math.sin(time * 0.7 + sign.mesh.position.z * 1.7);
        const shimmer = 0.9 + 0.1 * Math.sin(time * 11 + sign.mesh.position.y * 3.1);
        const value = (0.72 + level * 0.5 + pulse * 0.12) * flicker * shimmer;
        sign.material.color.copy(sign.baseColor).multiplyScalar(value);
        sign.glow.material.opacity = 0.34 + value * 0.34;
        sign.smearMaterial.uniforms.uTime.value = time;
        sign.smearMaterial.uniforms.uIntensity.value = 0.24 + value * 0.3;
        if (sign.light) sign.light.intensity = 8 + value * 12;
      }

      // 街灯：整体亮度跟着响度走
      for (const light of lampLights) {
        light.intensity = 18 + level * 16 + pulse * 4;
      }

      // 空气透视：响度越大，雾越浓（能见度下降）
      streetMaterial.envMapIntensity = 0.16 + level * 0.16;
    },
    dispose(): void {
      for (const texture of facadeTextures) texture.dispose();
      glowTexture.dispose();
      disposeObject(root);
    },
  };
}

export const rainyStreetScene: SceneDefinition = {
  id: 'rainy-street',
  title: '雨夜街道',
  subtitle: 'Rainy Street',
  description: '湿沥青把霓虹揉成一片模糊的水光，细雨在灯下成束落下。',
  tags: ['雨夜', '霓虹', '街道'],
  accent: '#ff5c9d',
  gradient: ['#2a1830', '#070a12'],
  category: 'environment',
  audio: 'rain-window.mp3',
  breathing: BREATHING,
  create(ctx: SceneContext): SceneInstance {
    return createRainyStreet(ctx);
  },
};

export default rainyStreetScene;
