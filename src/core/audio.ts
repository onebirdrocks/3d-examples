import * as THREE from 'three';
import type { AudioAnalysis } from './audio-analysis.js';
import type { AudioLayerDefinition, SceneDefinition, SceneMode } from '../scenes/types.js';
import { assetUrl } from './loader.js';

/**
 * 环境音播放器
 * ---------------------------------------------------------------
 * 两种用法：
 *
 * 1. **单曲**（`AmbientAudio.play(url)`）—— 一个场景一首配乐。
 * 2. **多路图层**（`AmbientAudio.setLayers([...])`）—— 风声 / 水声 / 虫鸣 / 乐声
 *    各占一路，用户可以分别调节音量；场景再通过 `applyMode(mode)` 按环境预设
 *    （晴夜 / 雨夜）调整各路配比。
 *
 * 每路内部都是「多段素材首尾相接 + 交叉淡化」的循环，接缝听不出来。
 */

/**
 * 创建一个共享的**混响总线**。
 *
 * 用程序化生成的脉冲响应（早期反射 + 指数衰减噪声）做卷积，
 * 让空间音源听起来真的在「一个房间里」，而不是贴在耳边。
 * 返回的 GainNode 作为混响输入，音源把它接上去即可。
 */
export type ReverbBus = GainNode & { dispose(): void };

export function createReverbBus(context: BaseAudioContext, wetness = 0.32, destination: AudioNode = context.destination): ReverbBus {
  const convolver = context.createConvolver();
  convolver.buffer = createImpulseResponse(context, 1.8, 2.6);

  const input = context.createGain();
  input.gain.value = 1;
  const wet = context.createGain();
  wet.gain.value = wetness;

  input.connect(convolver);
  convolver.connect(wet);
  wet.connect(destination);
  const bus = input as ReverbBus;
  bus.dispose = () => {
    input.disconnect();
    convolver.disconnect();
    wet.disconnect();
    convolver.buffer = null;
  };
  return bus;
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

export interface AmbientAudioOptions {
  /** 循环接缝的交叉淡化时长（秒）。 */
  crossfade?: number;
  /** 切换曲目时的渐变时长（秒）。 */
  transition?: number;
  /** 淡入时长（秒）。 */
  fadeIn?: number;
}

const DEFAULT_CROSSFADE = 1.4;

/** 一路声音。 */
interface AudioChannel {
  readonly id: string;
  /** 该路的音量节点，接到总线。 */
  readonly gain: GainNode;
  buffers: AudioBuffer[];
  index: number;
  active: { source: AudioBufferSourceNode; gain: GainNode; timer: number } | null;
  readonly voices: Set<{ source: AudioBufferSourceNode; gain: GainNode }>;
  /** 用户设定的基础音量 0~1。 */
  volume: number;
  /** 环境预设带来的倍率。 */
  multiplier: number;
}

export class AmbientAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private breathGain: GainNode | null = null;
  private breathFilter: BiquadFilterNode | null = null;
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly channels = new Map<string, AudioChannel>();
  private readonly options: Required<AmbientAudioOptions>;
  private volume = 0.55;
  private analysis: AudioAnalysis | null = null;
  private requestToken = 0;
  private sessionGain = 1;

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

  /** 是否正在播放。 */
  get isPlaying(): boolean {
    if (this.context?.state !== 'running') return false;
    for (const channel of this.channels.values()) {
      if (channel.active) return true;
    }
    return false;
  }

  /** 当前主通道名（兼容旧接口）。 */
  get current(): string | null {
    return this.channels.has('main') ? 'main' : null;
  }

  get currentVolume(): number {
    return this.volume;
  }

  /** 网页与 XR 共用场景音频入口，暂停后继续使用已有图层与混音设置。 */
  async playScene(def: SceneDefinition, mode: SceneMode | null = def.modes?.[0] ?? null): Promise<void> {
    let playback: Promise<void>;
    if (def.audioLayers?.length) {
      playback = this.setLayers(def.audioLayers.map((layer) => ({
        ...layer,
        urls: layer.urls.map((name) => assetUrl(`audio/${name}`)),
      })));
    } else if (def.audioPlaylist?.length || def.audio) {
      const names = def.audioPlaylist?.length ? def.audioPlaylist : [def.audio!];
      playback = this.play(names.map((name) => assetUrl(`audio/${name}`)));
    } else {
      this.stop();
      return;
    }
    const token = this.requestToken;
    await playback;
    if (token === this.requestToken) this.applyMode(mode);
  }

  /* ------------------------------------------------------------------ *
   * 多路图层
   * ------------------------------------------------------------------ */

  /**
   * 建立多路声音图层并开始循环播放。
   * 每路有独立的音量，用户可以分别调节。
   */
  async setLayers(layers: readonly AudioLayerDefinition[]): Promise<void> {
    const token = ++this.requestToken;
    const context = this.ensureContext();
    await this.resumeIfPossible();
    if (token !== this.requestToken) return;

    const same = layers.length === this.channels.size && layers.every((layer) => {
      const channel = this.channels.get(layer.id);
      const paths = this.bufferPaths.get(layer.id);
      return channel?.buffers.length && paths?.length === layer.urls.length &&
        layer.urls.every((url, index) => paths[index] === url);
    });
    if (same) {
      this.resumeChannels();
      return;
    }

    // 停掉所有旧通道（包括主通道），否则两层声音会叠在一起
    for (const id of [...this.channels.keys()]) {
      this.stopChannel(id);
    }

    await Promise.all(layers.map(async (layer) => {
      const channel = this.createChannel(layer.id, layer.volume ?? 0.4);
      this.bufferPaths.set(layer.id, [...layer.urls]);
      for (const url of layer.urls) {
        try {
          const buffer = await this.loadBuffer(url);
          if (token !== this.requestToken) return;
          channel.buffers.push(buffer);
        } catch (error) {
          if (token !== this.requestToken) return;
          console.warn(`[audio] 图层「${layer.label}」加载失败`, error);
        }
      }
    }));
    if (token !== this.requestToken) return;
    if (![...this.channels.values()].some((channel) => channel.buffers.length)) {
      throw new Error('环境音未能加载，请重试');
    }
    const now = context.currentTime;
    for (const channel of this.channels.values()) {
      if (channel.buffers.length) {
        this.startChannelLoop(channel, now, this.options.fadeIn);
      }
    }
    this.analysis?.attach(this.analyser!);
  }

  /** 设定某一图层的音量 0~1。 */
  setLayerVolume(id: string, volume: number): void {
    const channel = this.channels.get(id);
    if (!channel) return;
    channel.volume = Math.max(0, Math.min(1, volume));
    this.applyChannelGain(channel);
  }

  /** 设定某一图层的倍率（环境预设用）。 */
  setLayerMultiplier(id: string, multiplier: number): void {
    const channel = this.channels.get(id);
    if (!channel) return;
    channel.multiplier = Math.max(0, Math.min(2, multiplier));
    this.applyChannelGain(channel);
  }

  /**
   * 应用环境预设：按倍率调整各图层音量。
   * 预设里没提到的图层保持原样。
   */
  applyMode(mode: SceneMode | null): void {
    if (!mode?.audio) return;
    for (const [id, multiplier] of Object.entries(mode.audio)) {
      this.setLayerMultiplier(id, multiplier);
    }
  }

  /** 当前各图层的音量（供界面回显）。 */
  getLayerVolumes(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [id, channel] of this.channels) {
      result[id] = channel.volume;
    }
    return result;
  }

  private applyChannelGain(channel: AudioChannel): void {
    if (!this.context) return;
    // 总音量由 master 统一控制，这里只管该路自己的音量与模式倍率
    const target = Math.max(0.0001, channel.volume * channel.multiplier);
    channel.gain.gain.setTargetAtTime(target, this.context.currentTime, 0.12);
  }

  private createChannel(id: string, volume: number): AudioChannel {
    const context = this.ensureContext();
    const gain = context.createGain();
    gain.gain.value = 0.0001;
    gain.connect(this.master!);
    const channel: AudioChannel = {
      id,
      gain,
      buffers: [],
      index: 0,
      active: null,
      voices: new Set(),
      volume,
      multiplier: 1,
    };
    this.channels.set(id, channel);
    this.applyChannelGain(channel);
    this.setMasterGain(this.volume);
    return channel;
  }

  /* ------------------------------------------------------------------ *
   * 单曲
   * ------------------------------------------------------------------ */

  /**
   * 播放指定音频（相对站点根路径，例如 'audio/rain-window.mp3'）。
   * 也可以传一个数组：多首曲目会首尾相接、交叉淡化连续播放。
   */
  async play(pathOrPaths: string | string[]): Promise<void> {
    const token = ++this.requestToken;
    const context = this.ensureContext();
    await this.resumeIfPossible();
    if (token !== this.requestToken) return;

    const paths = Array.isArray(pathOrPaths) ? pathOrPaths : [pathOrPaths];

    // 停掉多路图层，主通道独占
    for (const id of [...this.channels.keys()]) {
      if (id !== 'main') this.stopChannel(id);
    }

    const existing = this.channels.get('main');
    const same =
      existing &&
      existing.buffers.length === paths.length &&
      paths.every((p, i) => this.bufferPaths.get(existing.id)?.[i] === p);
    if (same) {
      this.resumeChannels();
      return;
    }

    this.stopChannel('main');
    const channel = this.createChannel('main', 1);
    this.bufferPaths.set('main', paths);

    for (const p of paths) {
      try {
        const buffer = await this.loadBuffer(p);
        if (token !== this.requestToken) return;
        channel.buffers.push(buffer);
      } catch (error) {
        if (token !== this.requestToken) return;
        console.warn('[audio] 音频加载失败', p, error);
      }
    }
    if (!channel.buffers.length) throw new Error('环境音未能加载，请重试');

    this.startChannelLoop(channel, context.currentTime, this.options.transition);
    this.analysis?.attach(this.analyser!);
  }

  private readonly bufferPaths = new Map<string, string[]>();

  /** 暂停（重新播放会从头开始）。 */
  pause(): void {
    ++this.requestToken;
    if (!this.context) return;
    const now = this.context.currentTime;
    for (const channel of this.channels.values()) {
      window.clearTimeout(channel.active?.timer);
      channel.active = null;
      for (const voice of channel.voices) {
        voice.gain.gain.cancelScheduledValues(now);
        voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
        voice.gain.gain.linearRampToValueAtTime(0.0001, now + 0.6);
        try {
          voice.source.stop(now + 0.6);
        } catch {
          /* 已经停止 */
        }
      }
    }
    this.analysis?.detach();
  }

  /** 停止并清除全部声音。 */
  stop(): void {
    ++this.requestToken;
    for (const id of [...this.channels.keys()]) {
      this.stopChannel(id);
    }
    this.channels.clear();
    this.bufferPaths.clear();
    this.analysis?.detach();
  }

  private stopChannel(id: string): void {
    const channel = this.channels.get(id);
    if (!channel) return;
    window.clearTimeout(channel.active?.timer);
    channel.active = null;
    for (const voice of channel.voices) {
      try {
        voice.source.stop();
      } catch {
        /* 已经停止 */
      }
      voice.source.disconnect();
      voice.gain.disconnect();
    }
    channel.voices.clear();
    channel.gain.disconnect();
    this.channels.delete(id);
    this.bufferPaths.delete(id);
  }

  private resumeChannels(): void {
    this.setMasterGain(this.volume);
    for (const channel of this.channels.values()) {
      if (!channel.active && channel.buffers.length) {
        this.startChannelLoop(channel, this.context!.currentTime, this.options.fadeIn);
      }
    }
    this.analysis?.attach(this.analyser!);
  }

  /** 设置总线音量（0~1），影响所有图层。 */
  setVolume(value: number): void {
    this.volume = Math.max(0, Math.min(1, value));
    this.setMasterGain(this.volume);
  }

  setSessionGain(value: number): void {
    this.sessionGain = THREE.MathUtils.clamp(value, 0, 1);
    this.setMasterGain(this.volume);
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

  /** 释放全部资源。 */
  dispose(): void {
    this.stop();
    this.buffers.clear();
    this.master?.disconnect();
    this.breathGain?.disconnect();
    this.breathFilter?.disconnect();
    this.analyser?.disconnect();
    this.analysis?.detach();
    // AudioContext 与场景音源共用，播放器只释放自己的节点。
    this.context = null;
    this.master = null;
    this.breathGain = null;
    this.breathFilter = null;
    this.analyser = null;
  }

  /* ------------------------------------------------------------------ *
   * 内部
   * ------------------------------------------------------------------ */

  private ensureContext(): AudioContext {
    if (this.context) return this.context;
    // 与 three 的 AudioListener / PositionalAudio 共用同一个原生 AudioContext，
    // 避免双上下文带来的额外开销与不同步。
    const context = THREE.AudioContext.getContext() as unknown as AudioContext;
    this.context = context;
    this.master = context.createGain();
    this.master.gain.value = 0.0001;

    // 呼吸塑形：总线 → 呼吸增益 → 低通（吸气更亮更满、呼气更柔）→ 分析器 → 输出
    this.breathGain = context.createGain();
    this.breathGain.gain.value = 1;
    this.breathFilter = context.createBiquadFilter();
    this.breathFilter.type = 'lowpass';
    this.breathFilter.frequency.value = 14000;
    this.breathFilter.Q.value = 0.3;

    this.master.connect(this.breathGain);
    this.breathGain.connect(this.breathFilter);

    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.72;
    this.breathFilter.connect(this.analyser);
    this.analyser.connect(context.destination);
    this.analysis?.attach(this.analyser);

    return context;
  }

  private async resumeIfPossible(): Promise<void> {
    if (!this.context || this.context.state !== 'suspended') return;
    // 被自动播放策略挡住时 resume() 可能一直 pending，不能无限等它 ——
    // 否则后面的缓冲区加载全部卡住，音频永远不 ready。
    await Promise.race([
      this.context.resume().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 300)),
    ]);
  }

  private setMasterGain(value: number): void {
    if (!this.context || !this.master) return;
    const now = this.context.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(Math.max(0.0001, value * this.sessionGain), now, 0.12);
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
   * 启动一路的循环播放。
   * 每隔 (时长 - 交叉淡化) 秒启动一个新的声源，并在开头 X 秒内与上一个声源交叉淡化，
   * 从而消除 MP3 循环接缝的断点与爆音。多段素材则依次轮转，播到末尾再回到第一段。
   */
  private startChannelLoop(channel: AudioChannel, when: number, fadeIn: number): void {
    const context = this.context!;
    const buffer = channel.buffers[channel.index % channel.buffers.length];
    if (!buffer) return;

    const crossfade = Math.min(this.options.crossfade, buffer.duration * 0.2);

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = false;

    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.linearRampToValueAtTime(1, when + fadeIn);
    source.connect(gain).connect(channel.gain);
    const voice = { source, gain };
    channel.voices.add(voice);
    source.onended = () => {
      channel.voices.delete(voice);
      source.disconnect();
      gain.disconnect();
    };
    source.start(when);

    channel.active = { source, gain, timer: 0 };

    const interval = Math.max(0.5, buffer.duration - crossfade);
    const timer = window.setTimeout(() => {
      if (channel.active?.source !== source) return;
      channel.index = (channel.index + 1) % channel.buffers.length;
      this.startChannelLoop(channel, context.currentTime, crossfade);
    }, Math.max(0, (when + interval - context.currentTime) * 1000));
    channel.active.timer = timer;
  }
}
