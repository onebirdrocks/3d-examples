/**
 * 钢琴音色合成（Web Audio）
 * ---------------------------------------------------------------
 * 场景「废墟里的钢琴」的发声模块。
 *
 * 一个音 = 三层：
 * 1. **基频 + 两个泛音**（1× / 2× / 3×），用 `OscillatorNode` + `GainNode`
 *    各自独立配比，模拟被击中的琴弦里同时存在的基音与泛音列；
 * 2. **槌击噪声**：15 毫秒的带通噪声，给出木头敲击的那一下「咔」；
 * 3. **低通滤波 + 指数包络**：滤波器的截止频率从明亮（击弦瞬间）一路关闭到
 *    暗淡（余音），模拟真实钢琴「起音亮、随后变暗」的音色衰减。
 *
 * 全部节点挂在调用方给的 `AudioContext`（场景用 `ctx.listener.context`，
 * 与播放器的环境音共用同一个上下文），不自己 new AudioContext。
 */

/** A4 = MIDI 69 = 440Hz。 */
const A4_MIDI = 69;
const A4_FREQ = 440;

/** MIDI 音高 → 频率（Hz）。 */
export function midiToFreq(midi: number): number {
  return A4_FREQ * Math.pow(2, (midi - A4_MIDI) / 12);
}

/** 一个正在发声的音。 */
interface Voice {
  /** 音的包络（音量）。 */
  readonly env: GainNode;
  /** 振荡器与噪声源，停止时统一断开。 */
  readonly sources: AudioScheduledSourceNode[];
  /** 应当停止的时刻（秒），0 表示还没到停止时间。 */
  stopAt: number;
}

/** 合成器选项。 */
export interface PianoSynthOptions {
  /** 总音量 0~1（多个音叠加时不会削顶）。 */
  volume?: number;
}

/**
 * 钢琴音色合成器。
 *
 * 用法：
 * ```ts
 * const synth = new PianoSynth(ctx.listener.context);
 * synth.press(60);   // 按下
 * synth.release(60); // 松开（音量快速释放）
 * synth.update();    // 每帧调用：收尾已经结束的音
 * synth.dispose();   // 释放：停掉所有振荡器
 * ```
 */
export class PianoSynth {
  private readonly context: AudioContext;
  private readonly master: GainNode;
  private readonly noise: AudioBuffer;
  private readonly voices = new Map<number, Voice>();
  /** 已经按下但还没有真正发声（等待音频上下文恢复）的音。 */
  private readonly pending = new Set<number>();
  private disposed = false;

  constructor(context: AudioContext, options: PianoSynthOptions = {}) {
    this.context = context;
    this.master = context.createGain();
    this.master.gain.value = options.volume ?? 0.45;
    this.master.connect(context.destination);
    this.noise = createNoiseBuffer(context);
  }

  /** 音频上下文是否已在运行（浏览器要求用户手势后才能出声）。 */
  get ready(): boolean {
    return !this.disposed && this.isRunning();
  }

  /** 读取上下文状态（绕开 TS 对 `state` 的窄化）。 */
  private isRunning(): boolean {
    return (this.context.state as AudioContextState) === 'running';
  }

  /** 尝试恢复音频上下文（需要在用户手势里调用）。 */
  async resume(): Promise<boolean> {
    if (this.disposed) return false;
    if (this.isRunning()) return true;
    try {
      await this.context.resume();
    } catch {
      return false;
    }
    return this.isRunning();
  }

  /** 按下一个键：起音。 */
  press(midi: number, velocity = 1): void {
    if (this.disposed) return;
    if (this.voices.has(midi)) return;

    if (!this.isRunning()) {
      // 浏览器要求用户手势：先恢复，恢复成功后再补发这个音
      this.pending.add(midi);
      void this.resume().then((ok) => {
        if (!ok || !this.pending.has(midi)) return;
        this.pending.delete(midi);
        this.startVoice(midi, velocity);
      });
      return;
    }

    this.startVoice(midi, velocity);
  }

  /** 松开一个键：阻尼器落下，音量快速释放。 */
  release(midi: number): void {
    this.pending.delete(midi);
    const voice = this.voices.get(midi);
    if (!voice) return;

    const now = this.context.currentTime;
    const gain = voice.env.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(Math.max(0.0001, gain.value), now);
    gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    voice.stopAt = now + 0.22;
  }

  /** 是否正在发声（用于 UI 提示）。 */
  isPlaying(midi: number): boolean {
    return this.voices.has(midi);
  }

  /** 每帧调用：把已经结束的音收尾。 */
  update(): void {
    if (this.disposed || this.voices.size === 0) return;
    const now = this.context.currentTime;
    for (const [midi, voice] of this.voices) {
      if (voice.stopAt > 0 && now >= voice.stopAt) this.stopVoice(midi);
    }
  }

  /** 释放：停掉所有振荡器。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const midi of Array.from(this.voices.keys())) this.stopVoice(midi);
    this.pending.clear();
    try {
      this.master.disconnect();
    } catch {
      /* 已经断开 */
    }
  }

  /** 真正创建一个音的节点图。 */
  private startVoice(midi: number, velocity: number): void {
    const ctx = this.context;
    const now = ctx.currentTime;
    const freq = midiToFreq(midi);

    // 低通：击弦瞬间明亮，随后一路「关闭」到暗淡
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.8;
    filter.frequency.setValueAtTime(Math.min(14000, freq * 16), now);
    filter.frequency.exponentialRampToValueAtTime(Math.max(300, freq * 3.0), now + 1.2);

    const preGain = ctx.createGain();
    preGain.gain.value = 0.9;
    filter.connect(preGain);

    // 包络：6 毫秒起音，之后指数衰减；低音衰减更久
    const env = ctx.createGain();
    const peak = 0.3 * Math.max(0.15, Math.min(1, velocity));
    const decay = 1.2 + 3.4 * Math.pow(0.5, (midi - 21) / 60);
    env.gain.setValueAtTime(0.0001, now);
    env.gain.exponentialRampToValueAtTime(peak, now + 0.006);
    env.gain.exponentialRampToValueAtTime(0.0001, now + decay);
    preGain.connect(env);
    env.connect(this.master);

    const sources: AudioScheduledSourceNode[] = [];

    // 基频 + 两个泛音
    const partials: { ratio: number; gain: number; type: OscillatorType }[] = [
      { ratio: 1, gain: 1.0, type: 'triangle' },
      { ratio: 2, gain: 0.34, type: 'sine' },
      { ratio: 3, gain: 0.13, type: 'sine' },
    ];
    for (const partial of partials) {
      const osc = ctx.createOscillator();
      osc.type = partial.type;
      osc.frequency.setValueAtTime(freq * partial.ratio, now);
      const gain = ctx.createGain();
      gain.gain.value = partial.gain;
      osc.connect(gain);
      gain.connect(filter);
      osc.start(now);
      sources.push(osc);
    }

    // 槌击噪声：15 毫秒的一小簇
    const noise = ctx.createBufferSource();
    noise.buffer = this.noise;
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.value = Math.min(6000, Math.max(400, freq * 6));
    noiseFilter.Q.value = 0.9;
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.09, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(preGain);
    noise.start(now);
    sources.push(noise);

    this.voices.set(midi, { env, sources, stopAt: 0 });
  }

  /** 停掉并清理一个音。 */
  private stopVoice(midi: number): void {
    const voice = this.voices.get(midi);
    if (!voice) return;
    this.voices.delete(midi);
    for (const source of voice.sources) {
      try {
        source.stop();
      } catch {
        /* 已经停止 */
      }
      source.disconnect();
    }
    try {
      voice.env.disconnect();
    } catch {
      /* 已经断开 */
    }
  }
}

/** 生成一小段白噪声（槌击声用）。 */
function createNoiseBuffer(context: AudioContext): AudioBuffer {
  const length = Math.floor(context.sampleRate * 0.12);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / length);
  }
  return buffer;
}
