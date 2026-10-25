/**
 * 冥想场景共用的呼吸节奏工具。
 *
 * 实现已经上移到 core/breath.ts（音频分析需要用同一套节奏做兜底），
 * 这里保留转发，避免各场景的引用路径变化。
 */
export {
  breathCycle,
  createBreathSample,
  sampleBreath,
  smootherstep,
} from '../../../core/breath.js';

export type { BreathPhase, BreathSample } from '../../../core/breath.js';
