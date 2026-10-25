import * as THREE from 'three';
import { createEnvironment } from './environment.js';
import { applyFraming } from './framing.js';
import { AudioAnalysis } from './audio-analysis.js';
import type { SceneContext, SceneDefinition, SceneEnvironment } from '../scenes/types.js';

export interface ThumbnailOptions {
  /** 缩略图像素宽高。 */
  width?: number;
  /** 烘焙前预热的帧数（让粒子/动画进入稳定状态）。 */
  warmupFrames?: number;
  /** 传给场景的画质系数，缩略图用较低画质以加快生成。 */
  quality?: number;
}

/**
 * 缩略图烘焙器。
 *
 * 用一台独立的、屏幕外的小渲染器把每个场景渲染成一张静态图（data URL），
 * 供画廊卡片和 XR 空间墙复用。烘焙完成后场景实例立即销毁，避免同时驻留 10 个场景。
 */
export class ThumbnailBaker {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly hostScene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(38, 16 / 10, 0.1, 600);
  private readonly env: SceneEnvironment;
  private readonly quality: number;
  private readonly warmupFrames: number;
  private readonly analysis = new AudioAnalysis();

  constructor(options: ThumbnailOptions = {}) {
    const width = options.width ?? 640;
    const height = Math.round((width * 10) / 16);
    this.quality = options.quality ?? 0.65;
    this.warmupFrames = options.warmupFrames ?? 3;

    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.env = createEnvironment(this.renderer);
    this.hostScene.environment = this.env.envMap;
    this.hostScene.background = new THREE.Color(0x070a12);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private get context(): SceneContext {
    const size = new THREE.Vector2();
    this.renderer.getSize(size);
    return {
      renderer: this.renderer,
      env: this.env,
      quality: this.quality,
      isXR: false,
      width: Math.max(1, Math.floor(size.x)),
      height: Math.max(1, Math.floor(size.y)),
      audio: this.analysis,
    };
  }

  /** 渲染一个场景并返回 PNG data URL。 */
  async bake(def: SceneDefinition, options: ThumbnailOptions = {}): Promise<string> {
    const warmup = options.warmupFrames ?? this.warmupFrames;
    const instance = await def.create(this.context);

    this.hostScene.add(instance.root);
    instance.root.position.set(0, 0, 0);
    instance.root.rotation.set(0, 0, 0);

    // 用场景自己的相机取景，保证缩略图与网页查看器构图一致
    const camera = instance.camera;
    camera.aspect = this.camera.aspect;
    camera.updateProjectionMatrix();
    if (instance.framing && !instance.ownsCamera) {
      applyFraming(camera, instance.framing);
    }

    for (let i = 0; i < warmup; i += 1) {
      const t = i / 60;
      instance.update(t, 1 / 60, this.context);
      this.renderer.render(this.hostScene, camera);
    }

    const url = this.canvas.toDataURL('image/png');

    this.hostScene.remove(instance.root);
    instance.dispose();

    return url;
  }

  dispose(): void {
    this.renderer.dispose();
  }
}
