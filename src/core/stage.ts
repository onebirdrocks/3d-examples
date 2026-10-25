import * as THREE from 'three';
import { createEnvironment } from './environment.js';
import { applyFraming } from './framing.js';
import { AudioAnalysis } from './audio-analysis.js';
import type { SceneContext, SceneEnvironment, SceneInstance } from '../scenes/types.js';

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

  private instance: SceneInstance | null = null;
  private readonly timer = new THREE.Timer();
  private elapsedTime = 0;
  private quality: number;
  private readonly maxPixelRatio: number;
  private resizeObserver: ResizeObserver | null = null;
  private running = false;
  private xrActive = false;
  private updateErrorReported = false;
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
  }

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
    };
  }

  /** 挂载一个场景实例，卸载上一个。 */
  mount(instance: SceneInstance): void {
    this.unmount();

    this.instance = instance;
    this.hostScene.add(instance.root);
    this.applyPlacement();
    this.applyFraming(instance);
  }

  /** 标记当前是否处于 XR 会话中（影响内容在用户前方的摆放）。 */
  setXRActive(active: boolean): void {
    this.xrActive = active;
    this.applyPlacement();
  }

  private applyPlacement(): void {
    const instance = this.instance;
    if (!instance) return;
    // 仅在 XR 会话中把非环绕型内容推到用户正前方，网页模式保持原始构图。
    const distance = instance.xrDistance ?? DEFAULT_XR_DISTANCE;
    instance.root.position.z = this.xrActive && !instance.immersive ? -distance : 0;
  }

  /** 卸载当前场景并释放资源。 */
  unmount(): void {
    if (!this.instance) return;
    this.hostScene.remove(this.instance.root);
    this.instance.dispose();
    this.instance = null;
  }

  private applyFraming(instance: SceneInstance): void {
    if (instance.ownsCamera) return;
    const framing = instance.framing;
    if (!framing) return;
    applyFraming(instance.camera, framing);
  }

  /** 启动主循环（使用 renderer.setAnimationLoop 以兼容 WebXR）。 */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer.reset();
    this.renderer.setAnimationLoop(this.frame);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.renderer.setAnimationLoop(null);
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
    this.elapsedTime += delta;

    this.audio.update(delta, this.elapsedTime);

    for (const listener of this.frameListeners) {
      listener(this.elapsedTime, delta);
    }

    const instance = this.instance;
    if (instance) {
      try {
        instance.update(this.elapsedTime, delta, this.context);
      } catch (error) {
        // 单个场景的异常不应打断整个渲染循环，只报告一次
        if (!this.updateErrorReported) {
          this.updateErrorReported = true;
          console.error('[stage] 场景 update 抛出异常', error);
        }
      }
    }

    const camera = instance?.camera ?? this.fallbackCamera;
    this.renderer.render(this.hostScene, camera);
  };

  /** 更新视口尺寸（XR 会话中由 XR 管理器接管，不做处理）。 */
  resize(): void {
    if (this.renderer.xr.isPresenting) return;

    const canvas = this.renderer.domElement;
    const width = Math.max(1, canvas.clientWidth || window.innerWidth);
    const height = Math.max(1, canvas.clientHeight || window.innerHeight);

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.maxPixelRatio));
    this.renderer.setSize(width, height, false);

    const camera = this.instance?.camera ?? this.fallbackCamera;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();

    // 画幅变化后重新计算取景距离
    if (this.instance) this.applyFraming(this.instance);
  }

  dispose(): void {
    this.stop();
    this.unmount();
    this.resizeObserver?.disconnect();
    window.removeEventListener('resize', this.handleWindowResize);
    this.renderer.dispose();
  }
}
