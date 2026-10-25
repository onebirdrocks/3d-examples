/**
 * 助眠场景的音频驱动。
 *
 * `ctx.audio` 给出的 pulse / level / bass / mid / treble 都会抖，
 * 这里再做一层「时间常数很大」的平滑（上升约 1 秒、回落约 2 秒），
 * 让画面只是缓慢地涨落，而不是跟着音乐抖动。
 *
 * 另外要注意：核心层的 `audio.pulse` 在没有音乐时会回落到场景声明的呼吸节奏，
 * 但只有宿主（viewer / gallery）设置了 fallback 才会这样。
 * 为了让场景在实验室页面里也是活的，这里同时采样一份自己的呼吸相位作为下限。
 */
import * as THREE from 'three';
import type { BreathingPattern, SceneContext } from '../types.js';
import { createBreathSample, sampleBreath } from '../../core/breath.js';

/** 平滑后的音频状态。 */
export interface SleepAudioState {
  /** 音乐脉冲（已平滑）。没有音乐时为 0。 */
  pulse: number;
  /** 主驱动 = max(音乐脉冲, 呼吸相位)，保证画面永远在动。 */
  drive: number;
  /** 呼吸相位（0~1），无音乐时的兜底节奏。 */
  breath: number;
  /** 整体响度。 */
  level: number;
  /** 低频能量。 */
  bass: number;
  /** 中频能量。 */
  mid: number;
  /** 高频能量。 */
  treble: number;
  /** 当前是否有真实音乐在播。 */
  active: boolean;
}

export class SleepAudioDrive {
  readonly state: SleepAudioState = {
    pulse: 0,
    drive: 0,
    breath: 0,
    level: 0,
    bass: 0,
    mid: 0,
    treble: 0,
    active: false,
  };

  private readonly breathSample = createBreathSample();

  constructor(private readonly pattern: BreathingPattern) {}

  /** 每帧推进。 */
  update(time: number, delta: number, ctx: SceneContext): void {
    const audio = ctx.audio;
    const state = this.state;

    state.active = audio.active;

    // 场景自己的呼吸相位：与核心的兜底节奏一致，但即使宿主没设置 fallback 也有效。
    const breath = sampleBreath(this.pattern, time, this.breathSample).level;
    state.breath = breath;

    // 音乐脉冲：上升稍快、回落很慢 → 音乐听起来像潮水而不是心跳。
    const music = audio.pulse;
    state.pulse = THREE.MathUtils.damp(
      state.pulse,
      music,
      music > state.pulse ? 1.2 : 0.45,
      delta,
    );

    // 主驱动：音乐脉冲优先，没有音乐时用呼吸相位兜底。
    const target = Math.max(music, breath);
    state.drive = THREE.MathUtils.damp(
      state.drive,
      target,
      target > state.drive ? 1.0 : 0.5,
      delta,
    );

    state.level = THREE.MathUtils.damp(state.level, audio.level, 0.9, delta);
    state.bass = THREE.MathUtils.damp(state.bass, audio.bass, 0.8, delta);
    state.mid = THREE.MathUtils.damp(state.mid, audio.mid, 0.9, delta);
    state.treble = THREE.MathUtils.damp(state.treble, audio.treble, 1.1, delta);
  }
}
