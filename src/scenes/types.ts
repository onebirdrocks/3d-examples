import type { Object3D, PerspectiveCamera, Texture, WebGLRenderer, AudioListener, Vector3 } from 'three';
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
  /**
   * 空间音频监听器：位置每帧跟随当前相机（XR 下是头显位置）。
   * 场景可用 `new THREE.PositionalAudio(ctx.listener)` 把音源锚在场景里的某个位置，
   * 用户转头时声音会从对应方向传来。
   */
  readonly listener: AudioListener;
  /**
   * 共享混响总线的输入节点（可选）。
   * 场景把空间音源接到它上面，声音就会带上房间感。
   */
  readonly reverb?: AudioNode;
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
   * 可选：XR 中用户捏合 / 拖拽时的交互钩子。
   * 场景里把可抓取的对象标记为 `userData.pinchable = true`，
   * 命中时 `info.hit` 为 true，`info.point` 是命中点（场景局部坐标）。
   */
  onPinch?(info: PinchInfo): void;
  /**
   * 切换环境预设时由核心层调用。
   * 场景把 `mode.params` 解释成自己的画面参数。
   */
  setMode?(mode: SceneMode): void;
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

/** 场景分类：程序化效果 / 模型材质 / 冥想 / 助眠 / 真实环境 / 模拟。 */
export type SceneCategory = 'procedural' | 'model' | 'meditation' | 'sleep' | 'environment' | 'simulation';

/**
 * 捏合交互信息。
 * 在 XR 中，用户的手（或手柄）捏合时会向场景派发这个结构。
 */
export interface PinchInfo {
  /** 捏合阶段：开始 / 移动 / 结束。 */
  phase: 'start' | 'move' | 'end';
  /** 捏合强度（0~1）。 */
  strength: number;
  /** 命中点坐标（场景根节点局部空间）。 */
  point: Vector3;
  /** 手 / 控制器位置（场景根节点局部空间）。 */
  hand: Vector3;
  /** 是否命中了标记了 `userData.pinchable` 的对象。 */
  hit: boolean;
}

/**
 * 声音图层：一路可独立调节音量的环境声。
 * 场景可以声明多路（如风 / 水 / 虫鸣 / 音乐），由界面提供独立的混音推子。
 */
export interface AudioLayerDefinition {
  /** 图层 id */
  readonly id: string;
  /** 界面显示名 */
  readonly label: string;
  /** 音频文件（相对 public/audio），多段会首尾相接交叉淡化连续播放 */
  readonly urls: readonly string[];
  /** 默认音量 0~1 */
  readonly volume?: number;
}

/**
 * 环境预设：可切换的天气 / 氛围档位。
 * 切换时会同时改变画面参数与各声音图层的配比，而不必换整个场景。
 */
export interface SceneMode {
  readonly id: string;
  readonly label: string;
  /** 场景自行解释的参数（例如云量、雨强、雾浓度）。 */
  readonly params?: Readonly<Record<string, number>>;
  /** 该模式下各声音图层的音量倍率。 */
  readonly audio?: Readonly<Record<string, number>>;
}

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

/**
 * 场景的光照与真实感偏好。全部可选，由核心层统一实现，
 * 场景只需要声明意图，不必自己写渲染管线。
 */
export interface SceneLighting {
  /** 目标曝光倍率（默认 1），用于整体压暗 / 提亮。 */
  exposure?: number;
  /** 自动曝光：按画面亮度像眼睛一样平滑调整曝光。 */
  autoExposure?: boolean;
  /**
   * 自动曝光的目标平均亮度（0~1）。
   * 默认 0.18（中灰）。暗场冥想类场景应调到 0.05~0.08，
   * 否则画面会被提亮成白天，失去夜色氛围。
   */
  autoExposureKey?: number;
  /** 实时环境反射：用 CubeCamera 抓取场景自身作为环境贴图。 */
  realTimeReflection?: boolean;
  /** 实时反射的采样间隔（帧），默认 45。 */
  reflectionInterval?: number;
  /** 间接光探针：从场景自身烘焙 SH 间接漫反射。 */
  lightProbe?: boolean;
  /** 阴影柔和度（0~1），放大 PCF 采样半径，让硬边阴影变软。 */
  softShadows?: number;
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
   * 多路声音图层。有它时界面会显示分层混音推子，
   * 否则退化为单一音量滑块 + `audio` 单曲。
   */
  readonly audioLayers?: readonly AudioLayerDefinition[];
  /**
   * 可切换的环境预设（如「晴夜」「雨夜」）。
   * 切换会同时改变画面参数与声音配比，而不必换场景。
   */
  readonly modes?: readonly SceneMode[];
  /**
   * 背景音乐文件名（位于 public/audio/ 下）。
   * 仅冥想类场景使用；播放器会循环播放并做交叉淡化。
   */
  readonly audio?: string;
  /**
   * 背景音乐播放列表（可选）。
   * 多首曲目会首尾相接、交叉淡化连续播放，用几段素材撑起很长且不重复的声景。
   * 与 `audio` 二选一；两者都填时以 `audioPlaylist` 为准。
   */
  readonly audioPlaylist?: readonly string[];
  /** 呼吸节奏，冥想类场景用于同步画面脉动与引导提示。 */
  readonly breathing?: BreathingPattern;
  /** 光照与真实感偏好，由核心层统一实现。 */
  readonly lighting?: SceneLighting;
  /** 创建场景实例。 */
  create(ctx: SceneContext): SceneInstance | Promise<SceneInstance>;
}
