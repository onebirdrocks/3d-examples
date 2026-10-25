import type { BreathingPattern } from '../scenes/types.js';
import { createBreathSample, sampleBreath } from './breath.js';

/**
 * 音频分析：把正在播放的音乐转成可驱动画面的数值。
 *
 * 设计目标：**让 3D 效果跟随音乐变换**。
 * - `pulse`：主脉冲。音乐开启时由低频起音触发（快起慢落），画面用它做呼吸/涨落；
 *   没有音乐时自动回落到场景声明的呼吸节奏，保证画面永远不是死的。
 * - `level`：整体响度（0~1），用于调制亮度、粒子密度、雾浓度等。
 * - `bass / mid / treble`：三个频段能量，用于分层驱动不同视觉元素。
 */
export class AudioAnalysis {
  private analyser: AnalyserNode | null = null;
  private freqData: Uint8Array<ArrayBuffer> | null = null;
  private timeData: Uint8Array<ArrayBuffer> | null = null;

  private smoothedLevel = 0;
  private smoothedBass = 0;
  private smoothedMid = 0;
  private smoothedTreble = 0;
  private pulseEnv = 0;
  private previousBass = 0;

  private readonly breath = createBreathSample();
  private fallbackPattern: BreathingPattern | null = null;

  /** 是否有真实音频输入。 */
  get active(): boolean {
    return this.analyser !== null;
  }

  /** 整体响度（0~1）。 */
  get level(): number {
    return this.smoothedLevel;
  }

  /** 低频能量（0~1）。 */
  get bass(): number {
    return this.smoothedBass;
  }

  /** 中频能量（0~1）。 */
  get mid(): number {
    return this.smoothedMid;
  }

  /** 高频能量（0~1）。 */
  get treble(): number {
    return this.smoothedTreble;
  }

  /**
   * 主脉冲（0~1）。
   * 音乐播放时跟随低频起音；未播放时跟随呼吸节奏。
   */
  get pulse(): number {
    if (this.analyser) return this.pulseEnv;
    if (!this.fallbackPattern) return 0;
    return this.breath.level;
  }

  /** 当前呼吸相位名（无音乐时的兜底节奏）。 */
  get breathPhase(): string {
    return this.breath.phase;
  }

  /**
   * 呼吸相位强度（0 = 完全呼出，1 = 充满）。
   * 有音乐时它仍然按声明的呼吸节奏走，可用来给音乐本身塑形
   * （吸气更亮更满、呼气更柔更暗）。
   */
  get breathLevel(): number {
    return this.breath.level;
  }

  /** 绑定一个 AnalyserNode。 */
  attach(analyser: AnalyserNode): void {
    this.analyser = analyser;
    this.freqData = new Uint8Array(analyser.frequencyBinCount);
    this.timeData = new Uint8Array(analyser.fftSize);
  }

  /** 断开音频输入，回到呼吸兜底。 */
  detach(): void {
    this.analyser = null;
    this.freqData = null;
    this.timeData = null;
  }

  /** 设置无音频时的兜底呼吸节奏。 */
  setFallback(pattern: BreathingPattern | null): void {
    this.fallbackPattern = pattern;
  }

  /** 每帧更新。 */
  update(delta: number, elapsed: number): void {
    if (this.fallbackPattern) {
      sampleBreath(this.fallbackPattern, elapsed, this.breath);
    }

    if (!this.analyser || !this.freqData || !this.timeData) {
      this.smoothedLevel *= 0.94;
      this.smoothedBass *= 0.94;
      this.smoothedMid *= 0.94;
      this.smoothedTreble *= 0.94;
      this.pulseEnv *= Math.exp(-delta / 0.5);
      this.previousBass = this.smoothedBass;
      return;
    }

    this.analyser.getByteFrequencyData(this.freqData);
    this.analyser.getByteTimeDomainData(this.timeData);

    // 频段划分：低 0~12%、中 12~45%、高 45~100%
    const bins = this.freqData.length;
    const bassEnd = Math.max(1, Math.floor(bins * 0.12));
    const midEnd = Math.max(bassEnd + 1, Math.floor(bins * 0.45));

    let bassSum = 0;
    for (let i = 0; i < bassEnd; i += 1) bassSum += this.freqData[i];
    let midSum = 0;
    for (let i = bassEnd; i < midEnd; i += 1) midSum += this.freqData[i];
    let trebleSum = 0;
    for (let i = midEnd; i < bins; i += 1) trebleSum += this.freqData[i];

    const bass = bassSum / bassEnd / 255;
    const mid = midSum / (midEnd - bassEnd) / 255;
    const treble = trebleSum / (bins - midEnd) / 255;

    // 响度用时域信号的 RMS，比频段平均更接近听感
    let squareSum = 0;
    for (let i = 0; i < this.timeData.length; i += 1) {
      const v = (this.timeData[i] - 128) / 128;
      squareSum += v * v;
    }
    const rms = Math.sqrt(squareSum / this.timeData.length);

    const smooth = 1 - Math.exp(-delta * 6);
    this.smoothedBass += (bass - this.smoothedBass) * smooth;
    this.smoothedMid += (mid - this.smoothedMid) * smooth;
    this.smoothedTreble += (treble - this.smoothedTreble) * smooth;
    this.smoothedLevel += (Math.min(1, rms * 3.2) - this.smoothedLevel) * smooth;

    // 起音检测：低频能量突然上升时触发一次脉冲，随后缓慢衰减
    const onset = Math.max(0, this.smoothedBass - this.previousBass);
    this.pulseEnv = Math.max(this.pulseEnv * Math.exp(-delta / 0.42), Math.min(1, onset * 7));
    this.previousBass = this.smoothedBass;
  }
}
