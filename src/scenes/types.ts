import type { Object3D, PerspectiveCamera, Texture, WebGLRenderer } from 'three';
import type { AudioAnalysis } from '../core/audio-analysis.js';

/**
 * 场景可用的环境辅助。核心层创建后通过 SceneContext 传给每个场景。
 * 场景只允许使用这里的资源，不要自己创建 PMREM / IBL。
 */
export interface SceneEnvironment {
  /**
   * 由 RoomEnvironment 生成的 PMREM 环境贴图（IBL）。
   * 赋给材质时用 `scene.environment = ctx.env.envMap`，或直接作为材质 envMap。
   */
  readonly envMap: Texture;

  /** 一套三点布光（主光 + 冷色补光 + 暖色轮廓光），可直接 add 到场景根节点。 */
  createStudioLights(): Object3D;

  /** 位于 y=0 的阴影接收地面。 */
  createGround(size?: number): Object3D;
}

/** 场景创建时拿到的上下文。 */
export interface SceneContext {
  /** 渲染器实例（用于生成纹理、读取尺寸、设置像素比等）。 */
  readonly renderer: WebGLRenderer;
  /** 环境辅助（IBL、灯组、地面）。 */
  readonly env: SceneEnvironment;
  /**
   * 画质系数，建议范围 0.5 ~ 2。
   * 粒子数量、细分精度、后处理采样等一律乘以这个值再取整。
   */
  readonly quality: number;
  /** 是否正在 XR 沉浸会话中渲染。 */
  readonly isXR: boolean;
  /** 当前视口像素尺寸（XR 下为单眼尺寸）。 */
  readonly width: number;
  readonly height: number;
  /**
   * 音频分析：把正在播放的环境音转成可驱动画面的数值。
   * - `pulse`：主脉冲。音乐开启时跟随低频起音，未播放时回落到场景的呼吸节奏。
   * - `level` / `bass` / `mid` / `treble`：响度与频段能量（0~1）。
   * 场景应当用这些值驱动自身的涨落与明暗，实现「3D 跟随音乐变换」。
   */
  readonly audio: AudioAnalysis;
}

/** 场景运行期实例。 */
export interface SceneInstance {
  /** 场景根节点，由核心层挂载与卸载。 */
  readonly root: Object3D;
  /** 非 XR 模式下的观察相机。核心层按 framing 摆位，每帧同步。 */
  readonly camera: PerspectiveCamera;
  /** 每帧更新。time 为会话内累计秒数，delta 为秒。 */
  update(time: number, delta: number, ctx: SceneContext): void;
  /** 释放几何体、材质、纹理等资源。 */
  dispose(): void;
  /**
   * 环绕型场景：内容围绕用户展开（例如银河、隧道、极光）。
   * 为 true 时 XR 中不会把内容前移，用户站在内容之中。
   */
  readonly immersive?: boolean;
  /**
   * 为 true 时场景自行驱动相机（核心不摆位、也不启用轨道控制器）。
   * 隧道、飞行类场景应设置此值。
   */
  readonly ownsCamera?: boolean;
  /** XR 中内容与用户之间的距离（米），默认 3。 */
  readonly xrDistance?: number;
  /** flat 模式下相机建议参数，核心据此摆位。 */
  readonly framing?: SceneFraming;
}

/** 相机取景建议。 */
export interface SceneFraming {
  /** 相机到内容中心的距离（米）。 */
  distance: number;
  /** 相机高度（米）。 */
  height: number;
  /** 相机注视点的 Y 高度（米）。 */
  targetY: number;
  /**
   * 需要横向完整覆盖的宽度（米）。
   * 填写后，核心会按当前画幅比例自动把相机往后挪，保证画面完整不裁切；
   * 实际距离取 distance 与「覆盖该宽度所需距离」的较大值。
   */
  width?: number;
}

/** 场景分类：程序化效果 / 模型材质 / 冥想 / 助眠 / 真实环境。 */
export type SceneCategory = 'procedural' | 'model' | 'meditation' | 'sleep' | 'environment';

/** 呼吸节奏，用于冥想场景的引导动画。 */
export interface BreathingPattern {
  /** 吸气时长（秒）。 */
  inhale: number;
  /** 屏息时长（秒）。 */
  hold: number;
  /** 呼气时长（秒）。 */
  exhale: number;
  /** 呼气末屏息时长（秒），可省略。 */
  holdOut?: number;
}

/** 场景定义，对应画廊中的一张卡片。 */
export interface SceneDefinition {
  /** 唯一 id，用于 URL 与场景切换。 */
  readonly id: string;
  /** 中文标题。 */
  readonly title: string;
  /** 英文副标题。 */
  readonly subtitle: string;
  /** 一句话描述。 */
  readonly description: string;
  /** 标签，用于卡片筛选。 */
  readonly tags: readonly string[];
  /** 主题色（十六进制），用于卡片描边与 XR 面板高亮。 */
  readonly accent: string;
  /** 卡片背景渐变（两个十六进制色）。 */
  readonly gradient: readonly [string, string];
  /** 分类。 */
  readonly category: SceneCategory;
  /**
   * 背景音乐文件名（位于 public/audio/ 下）。
   * 仅冥想类场景使用；播放器会循环播放并做交叉淡化。
   */
  readonly audio?: string;
  /** 呼吸节奏，冥想类场景用于同步画面脉动与引导提示。 */
  readonly breathing?: BreathingPattern;
  /** 创建场景实例。 */
  create(ctx: SceneContext): SceneInstance | Promise<SceneInstance>;
}
