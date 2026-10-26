import * as THREE from 'three';
import { assetUrl } from './loader.js';

export interface SpatialSourceOptions {
  /** 音频地址（相对站点根路径或绝对 URL）。 */
  url: string;
  /** 音源在场景中的位置。 */
  position: THREE.Vector3 | [number, number, number];
  /** 音量 0~1。 */
  volume?: number;
  /** 是否循环（默认循环）。 */
  loop?: boolean;
  /** 声源开始衰减的距离（米）。 */
  refDistance?: number;
  /** 最远可听距离（米）。 */
  maxDistance?: number;
  /** 共享混响总线的输入节点（可选）：接上后声音带上房间感。 */
  reverbNode?: AudioNode;
  /** 预览图不下载或播放音效。 */
  enabled?: boolean;
  controller?: SpatialAudioBus;
}

/** 统一管理场景内音源的静音和释放，不依赖异步下载完成顺序。 */
export class SpatialAudioBus {
  private readonly sources = new Set<SpatialSource>();
  private enabled = true;

  add(source: SpatialSource): void {
    this.sources.add(source);
    source.setEnabled(this.enabled);
  }

  remove(source: SpatialSource): void { this.sources.delete(source); }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    for (const source of this.sources) source.setEnabled(enabled);
  }

  clear(root?: THREE.Object3D): void {
    for (const source of [...this.sources]) {
      let owner: THREE.Object3D | null = source.sound;
      while (root && owner && owner !== root) owner = owner.parent;
      if (!root || owner === root) source.dispose();
    }
  }
}

/**
 * 一个**空间音源**。
 *
 * three 的 `PositionalAudio` 用原生 `PannerNode` 定位声源，
 * 配合跟随相机的 `AudioListener`（见 `Stage.listener`），
 * 用户在 VR 里转头时，环境声会从对应方向传来 —— 这是头显里最直接的感知升级。
 *
 * 在此之上再做两件事，让它更"真实"：
 * - **几何遮挡**：从听者到声源做射线检测，被挡住时高频被吃掉、音量下降
 *   （就像真实世界里隔着墙听声音）；
 * - **共享混响**：接到主混响卷积上，房间里听起来有空间感。
 */
export class SpatialSource {
  readonly sound: THREE.PositionalAudio;

  private readonly baseVolume: number;
  private readonly filter: BiquadFilterNode | null = null;
  private readonly occluders: THREE.Object3D[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private readonly dir = new THREE.Vector3();
  private readonly origin = new THREE.Vector3();
  private blocked = 0;
  private frame = 0;
  private occludersCollected = false;
  private disposed = false;
  private enabled = true;
  private readonly abort = new AbortController();
  private readonly controller?: SpatialAudioBus;

  constructor(
    sound: THREE.PositionalAudio,
    options: SpatialSourceOptions,
    reverbInput?: AudioNode,
  ) {
    this.sound = sound;
    this.baseVolume = options.volume ?? 0.5;
    this.controller = options.controller;

    const context = sound.context;
    const bus = reverbInput ?? options.reverbNode;
    if (context) {
      this.filter = context.createBiquadFilter();
      this.filter.type = 'lowpass';
      this.filter.frequency.value = 20000;
      this.filter.Q.value = 0.4;
      sound.getOutput().connect(this.filter);
      if (bus) this.filter.connect(bus);
    }
    this.controller?.add(this);
  }

  async load(url: string): Promise<void> {
    try {
      const buffer = await loadAudioBuffer(this.sound.context, url, this.abort.signal);
      if (this.disposed) return;
      this.sound.setBuffer(buffer);
      this.setEnabled(this.enabled);
    } catch (error) {
      if (!this.disposed && !this.abort.signal.aborted) {
        console.warn('[spatial-audio] 空间音源暂不可用', error);
      }
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (this.disposed) return;
    if (!enabled && this.sound.isPlaying) this.sound.pause();
    else if (enabled && this.sound.buffer && !this.sound.isPlaying) this.sound.play();
  }

  /** 每帧调用：周期性做遮挡检测并平滑应用。 */
  update(listener: THREE.AudioListener, root: THREE.Object3D, delta: number): void {
    this.frame += 1;
    if (this.frame % 6 === 0) {
      this.checkOcclusion(listener, root);
    }

    // 平滑：被遮挡时高频逐渐被吃掉，音量随之下降
    const target = this.blocked > 0.5 ? 620 : 20000;
    if (this.filter) {
      this.filter.frequency.value = THREE.MathUtils.damp(
        this.filter.frequency.value,
        target,
        6,
        delta,
      );
    }
    this.sound.setVolume(this.baseVolume * (1 - this.blocked * 0.7));
  }

  private checkOcclusion(listener: THREE.AudioListener, root: THREE.Object3D): void {
    if (!this.occludersCollected) {
      this.occludersCollected = true;
      root.traverse((child) => {
        if (child instanceof THREE.Mesh && child.visible) this.occluders.push(child);
      });
    }
    if (this.occluders.length === 0) {
      this.blocked = 0;
      return;
    }

    listener.getWorldPosition(this.origin);
    this.sound.getWorldPosition(this.dir);
    this.dir.sub(this.origin);
    const distance = this.dir.length();
    if (distance < 0.001) return;
    this.dir.divideScalar(distance);

    this.raycaster.set(this.origin, this.dir);
    this.raycaster.far = distance - 0.05;
    const hits = this.raycaster.intersectObjects(this.occluders, false);
    const target = hits.length > 0 ? 1 : 0;
    this.blocked += (target - this.blocked) * 0.4;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    this.controller?.remove(this);
    if (this.sound.isPlaying) this.sound.stop();
    this.sound.disconnect();
    this.filter?.disconnect();
  }
}

/**
 * 在场景某个位置放置一个**空间音源**。
 *
 * @param root 场景根节点（音源会挂到它下面）
 * @param listener 跟随相机的监听器
 * @param options 音源配置
 * @param reverbInput 共享混响的输入节点（可选）
 */
export function attachSpatialSource(
  root: THREE.Object3D,
  listener: THREE.AudioListener,
  options: SpatialSourceOptions,
  reverbInput?: AudioNode,
): SpatialSource {
  const sound = new THREE.PositionalAudio(listener);

  const position = Array.isArray(options.position)
    ? new THREE.Vector3(options.position[0], options.position[1], options.position[2])
    : options.position.clone();
  sound.position.copy(position);

  sound.setRefDistance(options.refDistance ?? 2.5);
  sound.setMaxDistance(options.maxDistance ?? 60);
  sound.setLoop(options.loop ?? true);
  sound.setVolume(options.volume ?? 0.5);
  sound.setDistanceModel('exponential');

  root.add(sound);

  const source = new SpatialSource(sound, options, reverbInput);
  if (options.enabled !== false) void source.load(options.url);
  return source;
}

/** 抓取并解码音频。 */
async function loadAudioBuffer(context: BaseAudioContext, url: string, signal: AbortSignal): Promise<AudioBuffer> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`空间音源加载失败：${url} (${response.status})`);
  const bytes = await response.arrayBuffer();
  return context.decodeAudioData(bytes);
}

export { assetUrl };
