/**
 * 「three.js 硬核能力」两个场景（GPU 潮汐 / 熔核等值面）共用的 GLSL 片段。
 *
 * 这里刻意与 lib/noise.ts 解耦：GPU 计算着色器需要一套自带的噪声，
 * 不依赖正在被并行修改的共享文件，避免互相影响。
 * 色调映射 / 色彩空间的收尾统一走共享的 lib/glsl-output.ts。
 *
 * 所有片段都用 `#ifndef` 守卫，重复引用不会造成重复定义。
 */

/**
 * 三维哈希与梯度噪声（Perlin）以及 fbm 叠加。
 *
 * `hcFbm3` 的输出大致落在 -1 ~ 1 之间（大部分质量集中在 0 附近），
 * 因此 `abs(fbm)` 的等值线天然形成细长的脉络网络。
 */
export const GLSL_HARDCORE_NOISE = /* glsl */ `
#ifndef LUMEN_HARDCORE_NOISE
#define LUMEN_HARDCORE_NOISE

vec3 hcHash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}

float hcPerlin3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

  vec3 g000 = hcHash33(i + vec3(0.0, 0.0, 0.0)) * 2.0 - 1.0;
  vec3 g100 = hcHash33(i + vec3(1.0, 0.0, 0.0)) * 2.0 - 1.0;
  vec3 g010 = hcHash33(i + vec3(0.0, 1.0, 0.0)) * 2.0 - 1.0;
  vec3 g110 = hcHash33(i + vec3(1.0, 1.0, 0.0)) * 2.0 - 1.0;
  vec3 g001 = hcHash33(i + vec3(0.0, 0.0, 1.0)) * 2.0 - 1.0;
  vec3 g101 = hcHash33(i + vec3(1.0, 0.0, 1.0)) * 2.0 - 1.0;
  vec3 g011 = hcHash33(i + vec3(0.0, 1.0, 1.0)) * 2.0 - 1.0;
  vec3 g111 = hcHash33(i + vec3(1.0, 1.0, 1.0)) * 2.0 - 1.0;

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

float hcFbm3(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    sum += amp * hcPerlin3(p);
    p *= 2.03;
    amp *= 0.5;
  }
  return sum;
}

float hcFbm3Oct(vec3 p, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    sum += amp * hcPerlin3(p);
    p *= 2.03;
    amp *= 0.5;
  }
  return sum;
}

#endif
`;

/**
 * 三维 curl noise（无散度流场）。
 *
 * 取一个向量势 Ψ = (perlin, perlin, perlin)（三个分量用不同偏移，避免各分量同相），
 * 再用前向差分求旋度 ∇ × Ψ。旋度天然无散度，因此粒子不会聚成一团或散架。
 */
export const GLSL_HARDCORE_CURL = /* glsl */ `
#ifndef LUMEN_HARDCORE_CURL
#define LUMEN_HARDCORE_CURL

vec3 hcPotential3(vec3 p) {
  return vec3(
    hcPerlin3(p + vec3(0.0, 0.0, 0.0)),
    hcPerlin3(p + vec3(31.416, 47.853, 12.793)),
    hcPerlin3(p + vec3(-17.313, 8.629, 93.221))
  );
}

vec3 hcCurl3(vec3 p) {
  const float e = 0.3;
  vec3 p0 = hcPotential3(p);
  vec3 px = hcPotential3(p + vec3(e, 0.0, 0.0));
  vec3 py = hcPotential3(p + vec3(0.0, e, 0.0));
  vec3 pz = hcPotential3(p + vec3(0.0, 0.0, e));

  return vec3(
    (py.z - p0.z) - (pz.y - p0.y),
    (pz.x - p0.x) - (px.z - p0.z),
    (px.y - p0.y) - (py.x - p0.x)
  ) / e;
}

#endif
`;
