import type { BreathingPattern } from '../scenes/types.js';

/** 呼吸的四个阶段。 */
export type BreathPhase = 'inhale' | 'hold' | 'exhale' | 'holdOut';

export interface BreathSample {
  /** 0 = 完全呼气，1 = 充满气。 */
  level: number;
  phase: BreathPhase;
  /** 当前阶段内的进度 0~1。 */
  progress: number;
  /** 一轮完整呼吸的时长（秒）。 */
  cycle: number;
}

/** 五次缓动：两端速度为零，适合呼吸这种需要「无感」过渡的运动。 */
export function smootherstep(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/** 一轮呼吸的总时长（秒）。 */
export function breathCycle(pattern: BreathingPattern): number {
  return Math.max(0.001, pattern.inhale + pattern.hold + pattern.exhale + (pattern.holdOut ?? 0));
}

/** 预分配一份采样结果，避免每帧新建对象。 */
export function createBreathSample(): BreathSample {
  return { level: 0, phase: 'inhale', progress: 0, cycle: 1 };
}

/**
 * 按时间采样呼吸相位，结果写入 out。
 *
 * - inhale：0 → 1，用 smootherstep 平滑上升
 * - hold：保持 1
 * - exhale：1 → 0，平滑下降
 * - holdOut：保持 0
 */
export function sampleBreath(pattern: BreathingPattern, time: number, out: BreathSample): BreathSample {
  const cycle = breathCycle(pattern);
  let t = time % cycle;
  if (t < 0) t += cycle;

  const inhale = Math.max(pattern.inhale, 1e-4);
  const hold = Math.max(pattern.hold, 1e-4);
  const exhale = Math.max(pattern.exhale, 1e-4);
  const holdOut = Math.max(pattern.holdOut ?? 0, 1e-4);

  const endInhale = inhale;
  const endHold = endInhale + hold;
  const endExhale = endHold + exhale;

  let level: number;
  let phase: BreathPhase;
  let progress: number;

  if (t < endInhale) {
    phase = 'inhale';
    progress = t / inhale;
    level = smootherstep(progress);
  } else if (t < endHold) {
    phase = 'hold';
    progress = (t - endInhale) / hold;
    level = 1;
  } else if (t < endExhale) {
    phase = 'exhale';
    progress = (t - endHold) / exhale;
    level = 1 - smootherstep(progress);
  } else {
    phase = 'holdOut';
    progress = (t - endExhale) / holdOut;
    level = 0;
  }

  out.level = level;
  out.phase = phase;
  out.progress = progress;
  out.cycle = cycle;
  return out;
}
