import * as THREE from 'three';
import { GLSL_OUTPUT, GLSL_OUTPUT_FUNCS } from './glsl-output.js';

/**
 * 渐变天幕：给「悬浮在暗处」的场景一个极暗但不死黑的背景，
 * 避免出现大片纯黑，也让画面边缘有可读的层次。
 */

const DOME_VERT = /* glsl */ `
varying vec3 vDir;

void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const DOME_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uGlow;
uniform float uLevel;

varying vec3 vDir;

${GLSL_OUTPUT_FUNCS}

void main() {
  float h = vDir.y;

  vec3 col = mix(uHorizon, uZenith, smoothstep(-0.1, 0.85, h));
  col = mix(col, uGround, smoothstep(0.0, -0.4, h));

  // 地平线附近的一层薄雾光
  float band = exp(-abs(h) * 5.0);
  col += uGlow * band * (0.12 + 0.14 * uLevel);

  // 轻微抖动，避免大面积渐变出现色带
  float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  col += dither * 0.004;

  gl_FragColor = vec4(col, 1.0);
  ${GLSL_OUTPUT}
}
`;

export interface GradientDome {
  mesh: THREE.Mesh;
  uniforms: {
    uZenith: { value: THREE.Color };
    uHorizon: { value: THREE.Color };
    uGround: { value: THREE.Color };
    uGlow: { value: THREE.Color };
    uLevel: { value: number };
  };
}

/** 生成一层包裹整个场景的渐变天幕。 */
export function createGradientDome(options: {
  zenith: number;
  horizon: number;
  ground: number;
  glow: number;
  radius?: number;
}): GradientDome {
  const uniforms: GradientDome['uniforms'] = {
    uZenith: { value: new THREE.Color(options.zenith) },
    uHorizon: { value: new THREE.Color(options.horizon) },
    uGround: { value: new THREE.Color(options.ground) },
    uGlow: { value: new THREE.Color(options.glow) },
    uLevel: { value: 0 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: DOME_VERT,
    fragmentShader: DOME_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
  });

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(options.radius ?? 90, 32, 20), material);
  mesh.name = 'gradient-dome';
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;

  return { mesh, uniforms };
}
