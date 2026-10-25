import * as THREE from 'three';
import { LightProbeGenerator } from 'three/addons/lights/LightProbeGenerator.js';
import type { SceneDefinition, SceneLighting } from '../scenes/types.js';

/** 自动曝光的测量分辨率（够用且便宜）。 */
const LUMINANCE_SIZE = 16;
/** 每隔多少帧测一次亮度（同步回读有少量管线停顿，不必每帧都做）。 */
const MEASURE_INTERVAL = 6;
/** 实时反射立方图的边长。 */
const REFLECTION_SIZE = 256;

/**
 * 场景光照装置（真实感内核）
 * ---------------------------------------------------------------
 * 把「真实感」里最有效的三件事做成核心层能力，场景只需声明意图：
 *
 * 1. **自动曝光**：把画面渲染到 16×16 的小图上测平均亮度，像眼睛一样
 *    平滑地调整 `toneMappingExposure`。暗场冥想场景不再"死黑"，
 *    亮场也不会过曝。测量用异步读回，不阻塞渲染。
 * 2. **实时环境反射**：用 `CubeCamera` 抓取场景自身作为环境贴图，
 *    于是湿沥青上反射的是**真的**霓虹楼体，而不是一张静态贴图。
 * 3. **间接光探针**：用同一张立方图烘焙 SH 探针（`LightProbeGenerator`），
 *    墙面与地面能接到来自窗户 / 霓虹的间接漫反射。
 *
 * 另外统一处理**阴影柔和度**：放大 PCF 的采样半径，让硬边阴影变软。
 */
export class LightingRig {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly hostScene: THREE.Scene;

  private readonly luminanceRT: THREE.WebGLRenderTarget;
  private readonly luminancePixels = new Uint8Array(LUMINANCE_SIZE * LUMINANCE_SIZE * 4);
  private luminanceFrame = 0;

  private cubeRT: THREE.WebGLCubeRenderTarget | null = null;
  private cubeCamera: THREE.CubeCamera | null = null;
  private pmremRT: THREE.WebGLRenderTarget | null = null;
  private readonly pmrem: THREE.PMREMGenerator;
  private probe: THREE.LightProbe | null = null;
  private probePending = false;
  private reflectionFrame = 0;

  private exposure = 1;
  private exposureTarget = 1;
  private sceneExposure = 1;
  private luminance = 0.18;
  private config: SceneLighting = {};

  constructor(renderer: THREE.WebGLRenderer, hostScene: THREE.Scene) {
    this.renderer = renderer;
    this.hostScene = hostScene;

    this.pmrem = new THREE.PMREMGenerator(renderer);

    this.luminanceRT = new THREE.WebGLRenderTarget(LUMINANCE_SIZE, LUMINANCE_SIZE, {
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
  }

  /** 当前生效的曝光倍率（已平滑）。 */
  get currentExposure(): number {
    return this.exposure * this.sceneExposure;
  }

  /** 按场景声明重新配置。 */
  configure(def: SceneDefinition | undefined): void {
    this.config = def?.lighting ?? {};
    this.sceneExposure = this.config.exposure ?? 1;

    this.teardownReflection();

    if (this.config.realTimeReflection || this.config.lightProbe) {
      const size = REFLECTION_SIZE;
      this.cubeRT = new THREE.WebGLCubeRenderTarget(size, {
        type: THREE.HalfFloatType,
        generateMipmaps: true,
        minFilter: THREE.LinearMipmapLinearFilter,
        magFilter: THREE.LinearFilter,
      });
      this.cubeCamera = new THREE.CubeCamera(0.1, 120, this.cubeRT);
      this.cubeCamera.position.set(0, 1.2, 0);
      this.hostScene.add(this.cubeCamera);
    }

    // 场景切换时曝光平滑过渡，而不是"啪"地切过去
    this.exposureTarget = this.exposure;
  }

  /** 卸载当前场景的光照装置。 */
  teardown(): void {
    this.teardownReflection();
    this.config = {};
    this.sceneExposure = 1;
  }

  private teardownReflection(): void {
    if (this.cubeCamera) {
      this.hostScene.remove(this.cubeCamera);
      this.cubeCamera = null;
    }
    if (this.probe) {
      this.hostScene.remove(this.probe);
      this.probe = null;
    }
    this.cubeRT?.dispose();
    this.cubeRT = null;
    this.pmremRT?.dispose();
    this.pmremRT = null;
  }

  /**
   * 每帧推进。
   * @param camera 当前渲染用的相机（网页模式是场景相机）
   * @param delta 秒
   */
  update(camera: THREE.Camera, delta: number): void {
    this.updateExposure(camera, delta);
    this.updateReflection(camera, delta);
  }

  /* ---------------- 自动曝光 ---------------- */

  private updateExposure(camera: THREE.Camera, delta: number): void {
    const wantAuto = this.config.autoExposure === true;
    const inXR = this.renderer.xr.isPresenting;

    if (wantAuto && !inXR) {
      this.luminanceFrame += 1;
      if (this.luminanceFrame >= MEASURE_INTERVAL) {
        this.luminanceFrame = 0;
        this.measureLuminance(camera);
      }
    }

    // 目标曝光：自动模式按目标平均亮度反比，静态模式保持 1（只吃场景声明的倍率）
    const key = this.config.autoExposureKey ?? 0.18;
    const autoTarget = this.config.autoExposure
      ? THREE.MathUtils.clamp(key / (this.luminance + 0.02), 0.4, 2.4)
      : 1;

    this.exposureTarget = autoTarget;
    // 眼睛适应光线的速度：变亮稍快、变暗稍慢
    const rising = autoTarget > this.exposure;
    this.exposure = THREE.MathUtils.damp(this.exposure, this.exposureTarget, rising ? 0.9 : 1.6, delta);
    this.renderer.toneMappingExposure = this.exposure * this.sceneExposure;
  }

  private measureLuminance(camera: THREE.Camera): void {
    const renderer = this.renderer;
    const prevToneMapping = renderer.toneMapping;
    const prevAutoClear = renderer.autoClear;
    const prevEnv = this.hostScene.environment;

    try {
      // 测量的是线性亮度，所以关掉色调映射
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.autoClear = true;
      this.hostScene.environment = null;

      renderer.setRenderTarget(this.luminanceRT);
      renderer.clear();
      renderer.render(this.hostScene, camera);
      renderer.setRenderTarget(null);
    } finally {
      renderer.toneMapping = prevToneMapping;
      renderer.autoClear = prevAutoClear;
      this.hostScene.environment = prevEnv;
    }

    // 同步读回：16×16 的回读开销极小，而且结果确定
    // （异步 PIXEL_PACK_BUFFER 读回在部分软件渲染实现上会返回垃圾数据）
    try {
      renderer.readRenderTargetPixels(
        this.luminanceRT,
        0,
        0,
        LUMINANCE_SIZE,
        LUMINANCE_SIZE,
        this.luminancePixels,
      );
    } catch {
      return;
    }

    let sum = 0;
    const data = this.luminancePixels;
    for (let i = 0; i < data.length; i += 4) {
      // 近似感知亮度（Rec.709）
      const r = data[i] / 255;
      const g = data[i + 1] / 255;
      const b = data[i + 2] / 255;
      sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    const average = sum / (LUMINANCE_SIZE * LUMINANCE_SIZE);
    // 平滑，避免亮度跳变引起曝光抖动
    this.luminance += (average - this.luminance) * 0.35;
  }

  /**
   * 立即把曝光对齐到当前画面亮度（不做平滑）。
   * 缩略图烘焙用得上：只有几帧，没有时间等曝光慢慢适应。
   */
  snapExposure(camera: THREE.Camera): void {
    if (!this.config.autoExposure) return;
    this.measureLuminance(camera);
    const key = this.config.autoExposureKey ?? 0.18;
    this.exposureTarget = THREE.MathUtils.clamp(key / (this.luminance + 0.02), 0.4, 2.4);
    this.exposure = this.exposureTarget;
    this.renderer.toneMappingExposure = this.exposure * this.sceneExposure;
  }

  /* ---------------- 实时环境反射 / 间接光探针 ---------------- */

  private updateReflection(camera: THREE.Camera, delta: number): void {
    const cubeCamera = this.cubeCamera;
    const cubeRT = this.cubeRT;
    if (!cubeCamera || !cubeRT) return;

    const interval = this.config.reflectionInterval ?? 45;
    this.reflectionFrame += 1;
    if (this.reflectionFrame < interval) return;
    this.reflectionFrame = 0;

    const renderer = this.renderer;
    const prevAutoClear = renderer.autoClear;
    const prevToneMapping = renderer.toneMapping;

    try {
      // 抓取时先摘掉环境贴图，避免自反馈
      this.hostScene.environment = null;
      renderer.autoClear = true;
      cubeCamera.update(renderer, this.hostScene);
    } finally {
      renderer.autoClear = prevAutoClear;
      renderer.toneMapping = prevToneMapping;
    }

    // three r152+ 的 PBR 环境贴图必须是 PMREM 处理过的 CubeUV 纹理，
    // 直接把原始 CubeTexture 当 scene.environment 会采样错误（画面全黑）。
    if (this.config.realTimeReflection) {
      const next = this.pmrem.fromCubemap(cubeRT.texture);
      this.pmremRT?.dispose();
      this.pmremRT = next;
      this.hostScene.environment = next.texture;
    }

    // 用同一张立方图烘焙间接光探针
    if (this.config.lightProbe && !this.probePending) {
      this.probePending = true;
      void LightProbeGenerator.fromCubeRenderTarget(renderer, cubeRT)
        .then((probe) => {
          if (this.probe) this.hostScene.remove(this.probe);
          this.probe = probe;
          this.hostScene.add(probe);
        })
        .catch(() => {
          /* 探针失败不影响主画面 */
        })
        .finally(() => {
          this.probePending = false;
        });
    }

    void camera;
    void delta;
  }

  /** 释放资源。 */
  dispose(): void {
    this.teardownReflection();
    this.luminanceRT.dispose();
    this.pmrem.dispose();
  }
}
