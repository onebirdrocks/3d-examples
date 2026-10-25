/**
 * 助眠场景共用的 GLSL 片段。
 *
 * 关于 three r186：
 * ShaderMaterial 会被统一转换成 GLSL ES 3.00，而
 * `<tonemapping_fragment>` / `<colorspace_fragment>` 这两个 chunk 是**赋值语句**，
 * 只能出现在 `main()` 内部。因此这里沿用工程里的做法：
 * - `GLSL_OUTPUT_FUNCS` 放在 main() 之前的全局作用域，负责定义收尾函数；
 * - `GLSL_OUTPUT` 放在 main() 内、gl_FragColor 赋值之后，负责调用它。
 * 千万别把 `#include <tonemapping_fragment>` 写到 main() 外面，否则材质编译失败、场景全黑。
 *
 * 每个片段都带 `#ifndef` 守卫，因此可以安全地同时包含多个片段
 * （例如 GLSL_NOISE2 与 GLSL_NOISE3 都需要哈希函数）。
 */

/** 哈希函数（2D / 3D）。 */
export const GLSL_HASH = /* glsl */ `
#ifndef LUMEN_ATLAS_HASH
#define LUMEN_ATLAS_HASH

float hash12( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}

float hash13( vec3 p3 ) {
  p3 = fract( p3 * 0.1031 );
  p3 += dot( p3, p3.zyx + 31.32 );
  return fract( ( p3.x + p3.y ) * p3.z );
}

#endif
`;

/** 2D 值噪声与 fbm，用于雾、火焰、浪线等细节。 */
export const GLSL_NOISE2 = /* glsl */ `
#ifndef LUMEN_ATLAS_NOISE2
#define LUMEN_ATLAS_NOISE2

${GLSL_HASH}

float vnoise2( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  float a = hash12( i );
  float b = hash12( i + vec2( 1.0, 0.0 ) );
  float c = hash12( i + vec2( 0.0, 1.0 ) );
  float d = hash12( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y );
}

float fbm2( vec2 p ) {
  float sum = 0.0;
  float amp = 0.5;
  for ( int i = 0; i < 3; i++ ) {
    sum += amp * vnoise2( p );
    p *= 2.07;
    amp *= 0.5;
  }
  return sum;
}

#endif
`;

/** 3D 值噪声与 fbm，用于缓慢流动的体积感。 */
export const GLSL_NOISE3 = /* glsl */ `
#ifndef LUMEN_ATLAS_NOISE3
#define LUMEN_ATLAS_NOISE3

${GLSL_HASH}

float vnoise3( vec3 p ) {
  vec3 i = floor( p );
  vec3 f = fract( p );
  vec3 u = f * f * ( 3.0 - 2.0 * f );
  float n000 = hash13( i + vec3( 0.0, 0.0, 0.0 ) );
  float n100 = hash13( i + vec3( 1.0, 0.0, 0.0 ) );
  float n010 = hash13( i + vec3( 0.0, 1.0, 0.0 ) );
  float n110 = hash13( i + vec3( 1.0, 1.0, 0.0 ) );
  float n001 = hash13( i + vec3( 0.0, 0.0, 1.0 ) );
  float n101 = hash13( i + vec3( 1.0, 0.0, 1.0 ) );
  float n011 = hash13( i + vec3( 0.0, 1.0, 1.0 ) );
  float n111 = hash13( i + vec3( 1.0, 1.0, 1.0 ) );
  float x00 = mix( n000, n100, u.x );
  float x10 = mix( n010, n110, u.x );
  float x01 = mix( n001, n101, u.x );
  float x11 = mix( n011, n111, u.x );
  float y0 = mix( x00, x10, u.y );
  float y1 = mix( x01, x11, u.y );
  return mix( y0, y1, u.z );
}

float fbm3( vec3 p ) {
  float sum = 0.0;
  float amp = 0.5;
  for ( int i = 0; i < 3; i++ ) {
    sum += amp * vnoise3( p );
    p *= 2.07;
    amp *= 0.5;
  }
  return sum;
}

#endif
`;

/** 抖动：给暗部渐变加一点噪声，避免出现色带。 */
export const GLSL_DITHER = /* glsl */ `
#ifndef LUMEN_ATLAS_DITHER
#define LUMEN_ATLAS_DITHER

float dither( vec2 p ) {
  return fract( sin( dot( p, vec2( 12.9898, 78.233 ) ) ) * 43758.5453123 );
}

#endif
`;

/**
 * 统一的色调映射与色彩空间处理（定义在全局作用域）。
 * 依赖 three 注入的 `toneMapping()` 与 `linearToOutputTexel()`。
 */
export const GLSL_OUTPUT_FUNCS = /* glsl */ `
#ifndef LUMEN_ATLAS_OUTPUT_FUNCS
#define LUMEN_ATLAS_OUTPUT_FUNCS

vec4 finalizeOutput( vec4 c ) {
  #if defined( TONE_MAPPING )
    c.rgb = toneMapping( c.rgb );
  #endif
  return linearToOutputTexel( c );
}

#endif
`;

/** 放在 main() 内、gl_FragColor 赋值之后。 */
export const GLSL_OUTPUT = /* glsl */ `
  gl_FragColor = finalizeOutput( gl_FragColor );
`;
