/**
 * 环境音播放器
 * ---------------------------------------------------------------
 * 用 Web Audio API 播放冥想场景的背景音乐：
 * - 解码为 AudioBuffer，整曲循环；
 * - 循环接缝处做交叉淡化（crossfade），听感上无缝；
 * - 切换场景时在旧曲与新曲之间做渐变切换；
 * - 支持音量、暂停、恢复与淡入淡出。
 *
 * 说明：浏览器要求音频必须由用户手势触发，因此首次 play() 会在被拒绝时
 * 抛出错误，由界面提示用户点击开启。
 */

import * as THREE from 'three';
import type { AudioAnalysis } from './audio-analysis.js';

export interface AmbientAudioOptions {
  /** 循环接缝的交叉淡化时长（秒）。 */
  crossfade?: number;
  /** 切换曲目时的渐变时长（秒）。 */
  transition?: number;
  /** 淡入时长（秒）。 */
  fadeIn?: number;
}

const DEFAULT_CROSSFADE = 1.4;

/**
 * 创建一个共享的**混响总线**。
 *
 * 用程序化生成的脉冲响应（早期反射 + 指数衰减噪声）做卷积，
 * 让空间音源听起来真的在「一个房间里」，而不是贴在耳边。
 * 返回的 GainNode 作为混响输入，音源把它接上去即可。
 */
export function createReverbBus(context: BaseAudioContext, wetness = 0.32): GainNode {
  const convolver = context.createConvolver();
  convolver.buffer = createImpulseResponse(context, 1.8, 2.6);

  const input = context.createGain();
  input.gain.value = 1;
  const wet = context.createGain();
  wet.gain.value = wetness;

  input.connect(convolver);
  convolver.connect(wet);
  wet.connect(context.destination);
  return input;
}

/** 程序化生成一段脉冲响应。 */
function createImpulseResponse(
  context: BaseAudioContext,
  duration: number,
  decay: number,
): AudioBuffer {
  const rate = context.sampleRate;
  const length = Math.max(1, Math.floor(rate * duration));
  const buffer = context.createBuffer(2, length, rate);

  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    // 指数衰减的噪声尾巴
    for (let i = 0; i < length; i += 1) {
      const t = i / length;
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * 0.45;
    }
    // 几个早期反射，左右声道错开一点点
    const taps: [number, number][] = [
      [11, 0.55],
      [23, 0.42],
      [37, 0.32],
      [53, 0.26],
      [79, 0.18],
    ];
    for (const [delayMs, gain] of taps) {
      const index = Math.floor((delayMs / 1000) * rate) + channel * 17;
      if (index < length) data[index] += gain * (channel === 0 ? 1 : -1);
    }
  }
  return buffer;
}

export class AmbientAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private currentPath: string | null = null;
  private active: { source: AudioBufferSourceNode; gain: GainNode; timer: number } | null = null;
  /** 播放列表：多首曲目首尾相接交叉淡化，可以撑起很长的不重复体验。 */
  private playlist: string[] = [];
  private playlistBuffers: AudioBuffer[] = [];
  private playlistIndex = 0;
  private breathFilter: BiquadFilterNode | null = null;
  private breathGain: GainNode | null = null;
  private readonly options: Required<AmbientAudioOptions>;
  private volume = 0.55;

  constructor(options: AmbientAudioOptions = {}) {
    this.options = {
      crossfade: options.crossfade ?? DEFAULT_CROSSFADE,
      transition: options.transition ?? 1.8,
      fadeIn: options.fadeIn ?? 2.2,
    };
  }

  /**
   * 把频谱分析接到外部的分析器上，用于驱动画面随音乐变化。
   * 不接的话，场景仍可用呼吸节奏兜底。
   */
  attachAnalysis(analysis: AudioAnalysis): void {
    this.analysis = analysis;
  }

  private analysis: AudioAnalysis | null = null;

  /** 是否正在播放。 */
  get isPlaying(): boolean {
    return this.active !== null;
  }

  /** 当前曲目路径。 */
  get current(): string | null {
    return this.currentPath;
  }

  get currentVolume(): number {
    return this.volume;
  }

  /**
   * 播放指定音频（相对站点根路径，例如 'audio/rain-window.mp3'）。
   *
   * 也可以传一个数组：多首曲目会首尾相接、交叉淡化连续播放，
   * 用几段素材就能撑起十分钟以上不重复的冥想声景。
   *
   * 同一首重复调用不会重启；换曲会做交叉过渡。
   */
  async play(pathOrPaths: string | string[]): Promise<void> {
    const context = this.ensureContext();
    if (context.state === 'suspended') {
      // 被自动播放策略挡住时 resume() 可能一直 pending，不能无限等它 ——
      // 否则后面的缓冲区加载全部卡住，音频永远不 ready。
      await Promise.race([
        context.resume().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 300)),
      ]);
    }

    const paths = Array.isArray(pathOrPaths) ? pathOrPaths : [pathOrPaths];
    const same = this.active && paths.length === this.playlist.length && paths.every((p, i) => p === this.playlist[i]);
    if (same) {
      // 同一组已经在放，直接恢复
      this.setMasterGain(this.volume);
      return;
    }

    // 预载全部曲目，保证交叉淡化时不会因为解码而卡顿
    this.playlist = paths;
    this.playlistBuffers = [];
    for (const p of paths) {
      this.playlistBuffers.push(await this.loadBuffer(p));
    }
    this.playlistIndex = 0;

    const buffer = this.playlistBuffers[0];
    const path = paths[0];

    const now = context.currentTime;
    const crossfade = this.options.transition;

    if (this.active) {
      // 旧曲淡出
      const old = this.active;
      old.gain.gain.cancelScheduledValues(now);
      old.gain.gain.setValueAtTime(old.gain.gain.value, now);
      old.gain.gain.linearRampToValueAtTime(0.0001, now + crossfade);
      window.setTimeout(() => {
        try {
          old.source.stop();
        } catch {
          /* 已经停止 */
        }
      }, (crossfade + 0.2) * 1000);
      this.active = null;
    }

    this.currentPath = path;
    this.startLoop(buffer, now, crossfade);
  }

  /**
   * 用呼吸节奏给音乐塑形：吸气时音量与亮度略微抬起，呼气时收窄变柔。
   * @param level 0（呼气末）~ 1（吸气满）
   */
  setBreathShape(level: number): void {
    if (!this.context || !this.breathGain || !this.breathFilter) return;
    const clamped = Math.max(0, Math.min(1, level));
    const now = this.context.currentTime;
    this.breathGain.gain.setTargetAtTime(0.76 + clamped * 0.24, now, 0.35);
    this.breathFilter.frequency.setTargetAtTime(900 + clamped * 13000, now, 0.4);
  }

  /** 暂停（保留当前曲目位置，重新播放会从头开始）。 */
  pause(): void {
    if (!this.active || !this.context) return;
    const now = this.context.currentTime;
    this.active.gain.gain.cancelScheduledValues(now);
    this.active.gain.gain.setValueAtTime(this.active.gain.gain.value, now);
    this.active.gain.gain.linearRampToValueAtTime(0.0001, now + 0.6);
    const active = this.active;
    this.active = null;
    this.analysis?.detach();
    window.setTimeout(() => {
      try {
        active.source.stop();
      } catch {
        /* 已经停止 */
      }
    }, 800);
  }

  /** 停止并清除当前曲目。 */
  stop(): void {
    if (!this.active) return;
    try {
      this.active.source.stop();
    } catch {
      /* 已经停止 */
    }
    this.active = null;
    this.currentPath = null;
    this.playlist = [];
    this.playlistBuffers = [];
    this.playlistIndex = 0;
    this.analysis?.detach();
  }

  /** 设置音量（0~1）。 */
  setVolume(value: number): void {
    this.volume = Math.max(0, Math.min(1, value));
    if (!this.context || !this.master) return;
    const now = this.context.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(this.volume, now, 0.08);
  }

  /** 释放全部资源。 */
  dispose(): void {
    this.stop();
    this.buffers.clear();
    void this.context?.close();
    this.context = null;
    this.master = null;
  }

  private ensureContext(): AudioContext {
    if (this.context) return this.context;
    // 与 three 的 AudioListener / PositionalAudio 共用同一个原生 AudioContext，
    // 避免双上下文带来的额外开销与不同步。
    const context = THREE.AudioContext.getContext() as unknown as AudioContext;
    this.context = context;
    this.master = context.createGain();
    this.master.gain.value = 0.0001;

    // 呼吸塑形：主音量 → 呼吸增益 → 低通（吸气更亮、呼气更柔）→ 分析器 → 输出
    this.breathGain = context.createGain();
    this.breathGain.gain.value = 1;
    this.breathFilter = context.createBiquadFilter();
    this.breathFilter.type = 'lowpass';
    this.breathFilter.frequency.value = 14000;
    this.breathFilter.Q.value = 0.3;

    this.master.connect(this.breathGain);
    this.breathGain.connect(this.breathFilter);

    // 频谱分析接在主音量之后，场景据此驱动画面
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.72;
    this.breathFilter.connect(this.analyser);
    this.analyser.connect(context.destination);
    this.analysis?.attach(this.analyser);

    return context;
  }

  private setMasterGain(value: number): void {
    if (!this.context || !this.master) return;
    const now = this.context.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(Math.max(0.0001, value), now, 0.12);
  }

  private async loadBuffer(path: string): Promise<AudioBuffer> {
    const cached = this.buffers.get(path);
    if (cached) return cached;

    const context = this.ensureContext();
    const response = await fetch(path);
    if (!response.ok) throw new Error(`环境音加载失败：${path} (${response.status})`);
    const bytes = await response.arrayBuffer();
    let buffer: AudioBuffer;
    try {
      buffer = await context.decodeAudioData(bytes);
    } catch (error) {
      throw new Error(
        `音频解码失败：${path}（${bytes.byteLength} 字节，${response.headers.get('content-type') ?? '未知类型'}）`,
        { cause: error },
      );
    }
    this.buffers.set(path, buffer);
    return buffer;
  }

  /**
   * 启动循环播放。
   * 每隔 (时长 - 交叉淡化) 秒启动一个新的声源，并在开头 X 秒内与上一个声源交叉淡化，
   * 从而消除 MP3 循环接缝的断点与爆音。
   */
  private startLoop(buffer: AudioBuffer, when: number, fadeIn: number): void {
    const context = this.context!;
    const master = this.master!;
    const crossfade = Math.min(this.options.crossfade, buffer.duration * 0.2);

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = false;

    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.linearRampToValueAtTime(1, when + fadeIn);
    source.connect(gain).connect(master);
    source.start(when);

    this.active = { source, gain, timer: 0 };
    this.setMasterGain(this.volume);

    // 递归安排下一次接缝：播放列表轮转，播到末尾再回到第一首
    const interval = Math.max(0.5, buffer.duration - crossfade);
    const scheduleNext = (nextWhen: number): void => {
      const timer = window.setTimeout(() => {
        if (!this.active || this.active.source !== source) return;
        this.playlistIndex = (this.playlistIndex + 1) % Math.max(1, this.playlistBuffers.length);
        const next = this.playlistBuffers[this.playlistIndex];
        if (!next) return;
        this.currentPath = this.playlist[this.playlistIndex] ?? this.currentPath;
        this.startLoop(next, nextWhen, crossfade);
      }, Math.max(0, (nextWhen - context.currentTime) * 1000));
      if (this.active) this.active.timer = timer;
    };

    scheduleNext(when + interval);
  }
}
