import * as THREE from 'three';
import { createEnvironment } from './environment.js';
import { applyFraming } from './framing.js';
import { AudioAnalysis } from './audio-analysis.js';
import { LightingRig } from './lighting.js';
import { createReverbBus, type ReverbBus } from './audio.js';
import { SpatialAudioBus } from './spatial-audio.js';
import type {
  SceneContext,
  SceneDefinition,
  SceneEnvironment,
  SceneInstance,
  SceneMode,
} from '../scenes/types.js';

/** XR 中非环绕型场景与用户之间的默认距离（米）。 */
const DEFAULT_XR_DISTANCE = 3;

export interface StageOptions {
  canvas: HTMLCanvasElement;
  /** 画质系数，0.5 ~ 2。 */
  quality?: number;
  /** 像素比上限。 */
  maxPixelRatio?: number;
}

/**
 * 运行时舞台：管理渲染器、环境、场景装载与主循环。
 * 同时驱动普通网页模式与 WebXR 沉浸模式（three 会在 XR 中自动接管相机）。
 */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly hostScene = new THREE.Scene();
  readonly fallbackCamera: THREE.PerspectiveCamera;
  readonly env: SceneEnvironment;
  /** 音频分析：场景据此让 3D 跟随音乐变化。 */
  readonly audio = new AudioAnalysis();
  /** 空间音频监听器：每帧跟随当前相机（XR 下是头显位置）。 */
  readonly listener = new THREE.AudioListener();
  readonly spatialAudio = new SpatialAudioBus();
  /** 光照装置：自动曝光 / 实时环境反射 / 间接光探针。 */
  private readonly rig: LightingRig;
  /** 共享混响总线（空间音源接上去就有房间感）。 */
  private readonly reverb: ReverbBus;

  private instance: SceneInstance | null = null;
  private readonly timer = new THREE.Timer();
  private elapsedTime = 0;
  private quality: number;
  private readonly maxPixelRatio: number;
  private resizeObserver: ResizeObserver | null = null;
  private running = false;
  private wantsToRun = false;
  private paused = false;
  private reducedMotion = false;
  private contextLost = false;
  private soundEnabled = true;
  private soundVolume = 0.55;
  private sessionGain = 1;
  private xrActive = false;
  private manualPlacement = false;
  private updateErrorReported = false;
  private rigSoftness = 0;
  private activeMode: SceneMode | null = null;
  private readonly frameListeners = new Set<(time: number, delta: number) => void>();

  constructor(options: StageOptions) {
    this.quality = options.quality ?? 1;
    this.maxPixelRatio = options.maxPixelRatio ?? 2;

    this.renderer = new THREE.WebGLRenderer({
      canvas: options.canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.maxPixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local-floor');

    this.env = createEnvironment(this.renderer);
    this.hostScene.environment = this.env.envMap;
    this.rig = new LightingRig(this.renderer, this.hostScene);
    this.reverb = createReverbBus(this.listener.context, 0.32, this.listener.getInput());
    this.syncSoundGain();
    this.timer.connect(document);
    document.addEventListener('visibilitychange', this.syncLoop);
    this.renderer.xr.addEventListener('sessionend', this.syncLoop);
    canvasEventSetup(this.renderer.domElement, this.handleContextLost, this.handleContextRestored);

    this.fallbackCamera = new THREE.PerspectiveCamera(55, 1, 0.05, 300);
    this.fallbackCamera.position.set(0, 1.5, 4.5);

    this.resize();

    const canvas = options.canvas;
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(canvas);
    } else {
      window.addEventListener('resize', this.handleWindowResize);
    }
  }

  private handleWindowResize = () => this.resize();

  /** 当前画质系数。 */
  get currentQuality(): number {
    return this.quality;
  }

  /** 场景启动以来的累计秒数（与场景 update 的 time 同源）。 */
  get elapsed(): number {
    return this.elapsedTime;
  }

  setQuality(value: number): void {
    this.quality = THREE.MathUtils.clamp(value, 0.4, 2);
    this.resize();
  }

  get visualPaused(): boolean { return this.paused || this.reducedMotion; }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.syncLoop();
    this.renderOnce();
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
    this.syncLoop();
    this.renderOnce();
  }

  setSoundEnabled(enabled: boolean): void {
    this.soundEnabled = enabled;
    this.spatialAudio.setEnabled(enabled);
    this.syncSoundGain();
  }

  setSoundVolume(volume: number): void {
    this.soundVolume = THREE.MathUtils.clamp(volume, 0, 1);
    this.syncSoundGain();
  }

  setSessionGain(gain: number): void {
    this.sessionGain = THREE.MathUtils.clamp(gain, 0, 1);
    this.syncSoundGain();
  }

  private syncSoundGain(): void {
    this.listener.setMasterVolume(this.soundEnabled ? this.soundVolume * this.sessionGain : 0);
  }

  private readonly handleContextLost = (event: Event) => {
    event.preventDefault();
    this.contextLost = true;
    this.syncLoop();
    window.dispatchEvent(new Event('stage-renderererror'));
  };

  private readonly handleContextRestored = () => {
    window.dispatchEvent(new Event('stage-renderererror'));
  };

  /** 当前挂载的场景实例。 */
  get current(): SceneInstance | null {
    return this.instance;
  }

  /** 是否处于 XR 会话中。 */
  get isPresenting(): boolean {
    return this.renderer.xr.isPresenting;
  }

  /** 场景上下文，随视口与 XR 状态变化。 */
  get context(): SceneContext {
    const size = new THREE.Vector2();
    this.renderer.getSize(size);
    return {
      renderer: this.renderer,
      env: this.env,
      quality: this.quality,
      isXR: this.renderer.xr.isPresenting,
      width: Math.max(1, Math.floor(size.x)),
      height: Math.max(1, Math.floor(size.y)),
      audio: this.audio,
      listener: this.listener,
      reverb: this.reverb,
      spatialAudio: this.spatialAudio,
    };
  }

  /** 挂载一个场景实例，卸载上一个。 */
  mount(instance: SceneInstance, def?: SceneDefinition): void {
    this.unmount();

    this.instance = instance;
    this.updateErrorReported = false;
    this.hostScene.add(instance.root);
    this.applyPlacement();
    this.applyFraming(instance);
    this.rig.configure(def);
    this.rigSoftness = def?.lighting?.softShadows ?? 0;
    this.applySoftShadows(instance);
    if (this.activeMode) this.instance.setMode?.(this.activeMode);
    if (this.visualPaused) {
      instance.update(this.elapsedTime, 0, this.context);
      this.renderOnce();
    }
  }

  /**
   * 切换环境预设（晴夜 / 雨夜一类）。
   * 会同时通知当前场景与之后挂载的场景。
   */
  setMode(mode: SceneMode | null): void {
    this.activeMode = mode;
    if (mode) this.instance?.setMode?.(mode);
  }

  get currentMode(): SceneMode | null {
    return this.activeMode;
  }

  /** 按场景声明放大阴影采样半径，让硬边阴影变软。 */
  private applySoftShadows(instance: SceneInstance): void {
    const soft = this.rigSoftness;
    if (!soft) return;
    instance.root.traverse((child) => {
      const light = child as THREE.DirectionalLight & THREE.SpotLight & THREE.PointLight;
      if (!light.isLight || !light.castShadow) return;
      const shadow = light.shadow;
      if (!shadow) return;
      shadow.radius = 1 + soft * 7;
      if (shadow.mapSize.width < 2048) {
        shadow.mapSize.set(2048, 2048);
        shadow.map?.dispose();
        shadow.map = null;
      }
    });
  }

  /** 标记当前是否处于 XR 会话中（影响内容在用户前方的摆放）。 */
  setXRActive(active: boolean): void {
    this.xrActive = active;
    this.applyPlacement();
    this.syncLoop();
  }

  private applyPlacement(): void {
    const instance = this.instance;
    if (!instance || this.manualPlacement) return;
    // 仅在 XR 会话中把非环绕型内容推到用户正前方，网页模式保持原始构图。
    const distance = instance.xrDistance ?? DEFAULT_XR_DISTANCE;
    instance.root.position.z = this.xrActive && !instance.immersive ? -distance : 0;
  }

  /**
   * 手动摆放模式：交给外部（例如 AR 命中测试放置）直接设置内容的位置，
   * 核心不再覆盖 root 的偏移。
   */
  setManualPlacement(enabled: boolean): void {
    this.manualPlacement = enabled;
    if (!enabled) this.applyPlacement();
  }

  /** 卸载当前场景并释放资源。 */
  unmount(): void {
    if (!this.instance) return;
    this.hostScene.remove(this.instance.root);
    this.spatialAudio.clear(this.instance.root);
    this.instance.dispose();
    this.instance = null;
    this.rig.teardown();
    this.rigSoftness = 0;
  }

  private applyFraming(instance: SceneInstance): void {
    if (instance.ownsCamera) return;
    const framing = instance.framing;
    if (!framing) return;
    applyFraming(instance.camera, framing);
  }

  /** 启动主循环（使用 renderer.setAnimationLoop 以兼容 WebXR）。 */
  start(): void {
    this.wantsToRun = true;
    this.syncLoop();
  }

  stop(): void {
    this.wantsToRun = false;
    this.syncLoop();
  }

  private readonly syncLoop = () => {
    const xr = this.xrActive || this.renderer.xr.isPresenting;
    const shouldRun = this.wantsToRun && !this.contextLost && (xr || (!document.hidden && !this.visualPaused));
    if (shouldRun === this.running) return;
    this.running = shouldRun;
    this.timer.reset();
    this.renderer.setAnimationLoop(shouldRun ? this.frame : null);
  };

  renderOnce(): void {
    if (this.contextLost || this.renderer.xr.isPresenting) return;
    const camera = this.instance?.camera ?? this.fallbackCamera;
    this.syncListener(camera);
    this.renderer.render(this.hostScene, camera);
  }

  /**
   * 注册每帧回调（在场景 update 之前执行）。
   * XR 相关逻辑需要挂在渲染循环里，才能拿到有效的 XRFrame。
   */
  addFrameListener(listener: (time: number, delta: number) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  private readonly frame = () => {
    this.timer.update();
    const delta = Math.min(this.timer.getDelta(), 0.05);
    if (!this.visualPaused) this.elapsedTime += delta;

    this.audio.update(delta, this.elapsedTime);

    for (const listener of this.frameListeners) {
      listener(this.elapsedTime, delta);
    }

    const instance = this.instance;
    if (instance && !this.visualPaused) {
      try {
        instance.update(this.elapsedTime, delta, this.context);
      } catch (error) {
        // 单个场景的异常不应打断整个渲染循环，只报告一次
        if (!this.updateErrorReported) {
          this.updateErrorReported = true;
          console.error('[stage] 场景 update 抛出异常', error);
          window.dispatchEvent(new Event('stage-sceneerror'));
        }
      }
    }

    const camera = instance?.camera ?? this.fallbackCamera;
    this.syncListener(camera);
    this.rig.update(camera, delta);
    this.renderer.render(this.hostScene, camera);
  };

  /**
   * 让空间音频监听器跟随当前相机。
   * XR 下跟随头显（XR 相机第一视角），网页模式跟随自由相机。
   */
  private syncListener(camera: THREE.Camera): void {
    const listener = this.listener;

    if (this.renderer.xr.isPresenting) {
      const xrCamera = this.renderer.xr.getCamera();
      const view = xrCamera.cameras[0];
      if (view) {
        view.getWorldPosition(listener.position);
        view.getWorldQuaternion(listener.quaternion);
        listener.updateMatrixWorld(true);
        return;
      }
    }

    camera.getWorldPosition(listener.position);
    camera.getWorldQuaternion(listener.quaternion);
    listener.updateMatrixWorld(true);
  }

  /** 更新视口尺寸（XR 会话中由 XR 管理器接管，不做处理）。 */
  resize(): void {
    if (this.renderer.xr.isPresenting) return;

    const canvas = this.renderer.domElement;
    const width = Math.max(1, canvas.clientWidth || window.innerWidth);
    const height = Math.max(1, canvas.clientHeight || window.innerHeight);

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.maxPixelRatio) * Math.min(1, this.quality));
    this.renderer.setSize(width, height, false);

    const camera = this.instance?.camera ?? this.fallbackCamera;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();

    // 画幅变化后重新计算取景距离
    if (this.instance) this.applyFraming(this.instance);
    if (this.visualPaused) this.renderOnce();
  }

  dispose(): void {
    this.stop();
    this.unmount();
    this.resizeObserver?.disconnect();
    window.removeEventListener('resize', this.handleWindowResize);
    document.removeEventListener('visibilitychange', this.syncLoop);
    this.renderer.xr.removeEventListener('sessionend', this.syncLoop);
    this.timer.dispose();
    this.renderer.domElement.removeEventListener('webglcontextlost', this.handleContextLost);
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.handleContextRestored);
    this.spatialAudio.clear();
    this.rig.dispose();
    this.env.dispose?.();
    this.reverb.dispose();
    this.renderer.dispose();
  }
}

function canvasEventSetup(canvas: HTMLCanvasElement, onLost: (event: Event) => void, onRestored: () => void): void {
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);
}
