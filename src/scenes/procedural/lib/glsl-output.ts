/**
 * 自定义 ShaderMaterial 的收尾：色调映射 + 色彩空间转换。
 *
 * 注意：three r186 会把所有 ShaderMaterial 转成 GLSL ES 3.00，
 * `<tonemapping_fragment>` / `<colorspace_fragment>` 这两个 chunk 是赋值语句，
 * 只能出现在 `main()` 内部（放外面会导致整个材质编译失败、场景全黑）。
 * 因此这里拆成两份：
 * - GLSL_OUTPUT_FUNCS 放在 main() 之前的全局作用域，负责定义收尾函数；
 * - GLSL_OUTPUT 放在 main() 内、gl_FragColor 赋值之后，负责调用它。
 *
 * 两段都带 include guard：同一段 GLSL 被引用两次时不会重复定义。
 */
export const GLSL_OUTPUT_FUNCS = /* glsl */ `
#ifndef LUMEN_OUTPUT_FUNCS_GUARD
#define LUMEN_OUTPUT_FUNCS_GUARD
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
#ifndef LUMEN_OUTPUT_CALL_GUARD
#define LUMEN_OUTPUT_CALL_GUARD
  gl_FragColor = finalizeOutput( gl_FragColor );
#endif
`;
