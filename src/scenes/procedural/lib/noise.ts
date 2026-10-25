/**
 * 程序化场景共用的 GLSL 片段。
 * 这里只放纯字符串，方便任意场景按需拼接，避免六个文件重复几百行噪声代码。
 */

/** 哈希函数集合（Dave Hoskins 风格）。 */
export const GLSL_HASH = /* glsl */ `
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
`;

/** 3D 梯度噪声（Perlin）、2D 值噪声以及两者的 fbm 叠加。 */
export const GLSL_NOISE = /* glsl */ `
float perlin3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

  vec3 g000 = hash33(i + vec3(0.0, 0.0, 0.0)) * 2.0 - 1.0;
  vec3 g100 = hash33(i + vec3(1.0, 0.0, 0.0)) * 2.0 - 1.0;
  vec3 g010 = hash33(i + vec3(0.0, 1.0, 0.0)) * 2.0 - 1.0;
  vec3 g110 = hash33(i + vec3(1.0, 1.0, 0.0)) * 2.0 - 1.0;
  vec3 g001 = hash33(i + vec3(0.0, 0.0, 1.0)) * 2.0 - 1.0;
  vec3 g101 = hash33(i + vec3(1.0, 0.0, 1.0)) * 2.0 - 1.0;
  vec3 g011 = hash33(i + vec3(0.0, 1.0, 1.0)) * 2.0 - 1.0;
  vec3 g111 = hash33(i + vec3(1.0, 1.0, 1.0)) * 2.0 - 1.0;

  float n000 = dot(g000, f - vec3(0.0, 0.0, 0.0));
  float n100 = dot(g100, f - vec3(1.0, 0.0, 0.0));
  float n010 = dot(g010, f - vec3(0.0, 1.0, 0.0));
  float n110 = dot(g110, f - vec3(1.0, 1.0, 0.0));
  float n001 = dot(g001, f - vec3(0.0, 0.0, 1.0));
  float n101 = dot(g101, f - vec3(1.0, 0.0, 1.0));
  float n011 = dot(g011, f - vec3(0.0, 1.0, 1.0));
  float n111 = dot(g111, f - vec3(1.0, 1.0, 1.0));

  vec4 a = mix(vec4(n000, n100, n010, n110), vec4(n001, n101, n011, n111), f.z);
  vec2 b = mix(a.xy, a.zw, f.y);
  return mix(b.x, b.y, f.x);
}

float fbm3(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    sum += amp * perlin3(p);
    p *= 2.03;
    amp *= 0.5;
  }
  return sum;
}

float fbm3oct(vec3 p, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    sum += amp * perlin3(p);
    p *= 2.03;
    amp *= 0.5;
  }
  return sum;
}

float vnoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm2(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 5; i++) {
    sum += amp * vnoise2(p);
    p *= 2.07;
    amp *= 0.5;
  }
  return sum;
}

float fbm2oct(vec2 p, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    sum += amp * vnoise2(p);
    p *= 2.07;
    amp *= 0.5;
  }
  return sum;
}
`;

/** 2D 无散度流场（标量势的旋度），用于水面等流体扰动。 */
export const GLSL_CURL = /* glsl */ `
vec2 curl2(vec2 p, float t) {
  const float e = 0.35;
  float dz = perlin3(vec3(p.x, p.y + e, t)) - perlin3(vec3(p.x, p.y - e, t));
  float dx = perlin3(vec3(p.x + e, p.y, t)) - perlin3(vec3(p.x - e, p.y, t));
  return vec2(dz, -dx) / (2.0 * e);
}
`;

/** 常用小工具：饱和、remap、旋转。 */
export const GLSL_UTILS = /* glsl */ `
float saturate1(float x) {
  return clamp(x, 0.0, 1.0);
}

vec3 saturate3(vec3 x) {
  return clamp(x, vec3(0.0), vec3(1.0));
}

float remap(float x, float a, float b) {
  return clamp((x - a) / (b - a), 0.0, 1.0);
}

vec2 rot2(vec2 p, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec2(p.x * c - p.y * s, p.x * s + p.y * c);
}
`;

/** 自定义 ShaderMaterial 末尾统一的色调映射与色彩空间处理。 */
export const GLSL_OUTPUT = /* glsl */ `
#include <tonemapping_fragment>
#include <colorspace_fragment>
`;
