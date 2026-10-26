import * as THREE from 'three';
import { HandSkeleton } from './hand-skeleton.js';
import type { Stage } from '../core/stage.js';
import type { AmbientAudio } from '../core/audio.js';
import type { PinchInfo, SceneDefinition } from '../scenes/types.js';
import { buildSceneWall, createNoticeTexture, type ScenePanel } from './wall.js';

export type XrMode = 'wall' | 'scene' | 'ar';

export interface XrExplorerOptions {
  stage: Stage;
  scenes: readonly SceneDefinition[];
  /** 场景 id → 缩略图 data URL。 */
  thumbnails: Map<string, string>;
  /** 可选的环境音播放器：进入沉浸场景时同步播放该场景的音乐。 */
  audio?: AmbientAudio;
  /** 保留网页上用户选择的静音状态；未提供时默认播放。 */
  audioEnabled?: () => boolean;
  /** AR 模式的 DOM 叠层根节点（用于显示操作提示）。 */
  overlayRoot?: HTMLElement;
  onModeChange?: (mode: XrMode, scene: SceneDefinition | null) => void;
}

/** 持久锚点的本地存储键。 */
const ANCHOR_STORAGE_KEY = 'lumen-atlas:persistent-anchors';

interface StoredAnchor {
  /** 持久锚点句柄。 */
  handle: string;
  /** 场景 id。 */
  sceneId: string;
  /** 放置位置。 */
  position: [number, number, number];
  /** 放置朝向。 */
  quaternion: [number, number, number, number];
}

/** 读取本地保存的持久锚点。 */
function loadStoredAnchors(): StoredAnchor[] {
  try {
    const raw = localStorage.getItem(ANCHOR_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredAnchor[]) : [];
  } catch {
    return [];
  }
}

/** 保存持久锚点。 */
function saveStoredAnchors(list: StoredAnchor[]): void {
  try {
    localStorage.setItem(ANCHOR_STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* 隐私模式下写不进去就算了 */
  }
}

/** 场景切换动画时长（秒）。 */
const TRANSITION = 0.45;
/** 视线停留触发所需时间（秒），用于无手柄 / 无手部输入的设备。 */
const DWELL_SECONDS = 1.4;

/**
 * WebXR 沉浸体验管理器。
 *
 * - wall 模式：10 个场景环绕用户排布，环视浏览，捏合 / 扳机 / 视线停留选择。
 * - scene 模式：选中的场景铺在用户面前，右下角有「返回场景墙」面板。
 */
export class XrExplorer {
  private readonly stage: Stage;
  private readonly scenes: readonly SceneDefinition[];
  private readonly thumbnails: Map<string, string>;
  private readonly audio?: AmbientAudio;
  private readonly audioEnabled?: () => boolean;
  private readonly overlayRoot?: HTMLElement;
  private readonly onModeChange?: (mode: XrMode, scene: SceneDefinition | null) => void;

  private session: XRSession | null = null;
  private starting = false;
  private sceneToken = 0;
  private wallGroup: THREE.Group | null = null;
  private panels: ScenePanel[] = [];
  private backPanel: THREE.Mesh | null = null;
  private loadingPanel: THREE.Mesh | null = null;

  private hovered: ScenePanel | null = null;
  private dwellTime = 0;
  private transition = 1;
  private pendingAction: (() => void) | null = null;
  private mode: XrMode = 'wall';
  private activeScene: SceneDefinition | null = null;

  /* 手部追踪与捏合 */
  private readonly handModels: ReturnType<Stage['renderer']['xr']['getHand']>[] = [];
  private readonly handSkeletons: HandSkeleton[] = [];
  private readonly pinching = new Set<unknown>();
  private readonly pinchInfo: PinchInfo = {
    phase: 'start',
    strength: 0,
    point: new THREE.Vector3(),
    hand: new THREE.Vector3(),
    hit: false,
  };
  private readonly pinchables: THREE.Object3D[] = [];
  private pinchHit = false;
  private readonly pinchPoint = new THREE.Vector3();
  private readonly pinchHand = new THREE.Vector3();

  /* AR 命中测试 */
  private hitTestSource: XRHitTestSource | null = null;
  private hitResult: XRHitTestResult | null = null;
  private reticle: THREE.Mesh | null = null;
  private arAnchor: XRAnchor | null = null;
  private arPlaced = false;
  private readonly arPosition = new THREE.Vector3();
  private readonly arQuaternion = new THREE.Quaternion();

  private readonly raycaster = new THREE.Raycaster();
  private readonly tmpOrigin = new THREE.Vector3();
  private readonly tmpDir = new THREE.Vector3();
  private readonly tmpMatrix = new THREE.Matrix4();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpVector = new THREE.Vector3();

  constructor(options: XrExplorerOptions) {
    this.stage = options.stage;
    this.scenes = options.scenes;
    this.thumbnails = options.thumbnails;
    this.audio = options.audio;
    this.audioEnabled = options.audioEnabled;
    this.overlayRoot = options.overlayRoot;
    this.onModeChange = options.onModeChange;
    this.stage.addFrameListener(this.update);
  }

  /** 当前是否支持指定的沉浸模式。 */
  static async isSupported(mode: 'immersive-vr' | 'immersive-ar' = 'immersive-vr'): Promise<boolean> {
    const xr = navigator.xr;
    if (!xr) return false;
    try {
      return await xr.isSessionSupported(mode);
    } catch {
      return false;
    }
  }

  /** 请求进入沉浸会话（必须由用户手势触发）。 */
  async enter(initial?: SceneDefinition): Promise<void> {
    await this.startSession('immersive-vr', {
      optionalFeatures: [
        'local-floor',
        'bounded-floor',
        'hand-tracking',
        'layers',
        'light-estimation',
      ],
    });

    try {
      this.session!.addEventListener('select', this.handleSelect);
      this.session!.addEventListener('selectend', this.handleSelectEnd);
      this.setupHandTracking();
      this.stage.hostScene.background = new THREE.Color(0x03050b);
      this.stage.setXRActive(true);
      this.stage.start();

      if (initial) {
        await this.showScene(initial);
      } else {
        this.showWall();
      }
    } catch (error) {
      await this.exit();
      throw error;
    }
  }

  private async startSession(mode: XRSessionMode, options: XRSessionInit): Promise<void> {
    if (this.starting || this.session) throw new Error('空间体验已在启动或运行中');
    const xr = navigator.xr;
    if (!xr) throw new Error('当前浏览器不支持空间体验');
    this.starting = true;
    try {
      const session = await xr.requestSession(mode, options);
      this.session = session;
      session.addEventListener('end', this.handleSessionEnd);
      // AR 设备不一定提供 local-floor，优先采用设备实际支持的参考空间。
      this.stage.renderer.xr.setReferenceSpaceType(
        session.enabledFeatures?.includes('local-floor') ? 'local-floor' : 'local',
      );
      await this.stage.renderer.xr.setSession(session);
      if (this.session !== session) throw new Error('空间体验已结束，请重试');
    } catch (error) {
      await this.exit();
      throw error;
    } finally {
      this.starting = false;
    }
  }

  /**
   * 接入 WebXR 手部追踪。
   *
   * three r186 会把每根手指的关节位姿写进 `renderer.xr.getHand(i).joints`，
   * 并在拇指与食指尖靠拢时派发 pinchstart / pinchend —— 比 select 事件精确得多。
   */
  private setupHandTracking(): void {
    const xrManager = this.stage.renderer.xr;

    for (let i = 0; i < 2; i += 1) {
      const hand = xrManager.getHand(i);
      const skeleton = new HandSkeleton(i === 0 ? 0x9fc6ff : 0xffc98f);
      hand.add(skeleton.group);
      this.stage.hostScene.add(hand);
      this.handModels.push(hand);
      this.handSkeletons.push(skeleton);
      hand.addEventListener('pinchstart', this.handlePinchStart);
      hand.addEventListener('pinchend', this.handlePinchEnd);
    }
  }

  /**
   * 进入 AR 模式：把场景放到用户真实空间里。
   *
   * 流程：请求 immersive-ar 会话（带 hit-test）→ 屏幕上出现一个贴合地面的
   * 指示环 → 用户看向想放置的位置 → 捏合/点击即放置 → 场景锚定在真实空间中。
   */
  async enterAr(initial: SceneDefinition): Promise<void> {
    await this.startSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: [
        'local-floor',
        'anchors',
        'light-estimation',
        'dom-overlay',
      ],
      ...(this.overlayRoot ? { domOverlay: { root: this.overlayRoot } } : {}),
    });

    const session = this.session!;
    try {
      session.addEventListener('select', this.handleArSelect);
      this.setupHandTracking();
      const viewerSpace = await session.requestReferenceSpace('viewer');
      if (typeof session.requestHitTestSource !== 'function') {
        throw new DOMException('当前设备不支持真实空间放置', 'NotSupportedError');
      }
      const source = await session.requestHitTestSource({ space: viewerSpace });
      if (this.session !== session) {
        source?.cancel();
        throw new Error('空间体验已结束，请重试');
      }
      if (!source) throw new DOMException('当前设备不支持真实空间放置', 'NotSupportedError');
      this.hitTestSource = source;
      this.arPlaced = false;
      this.createReticle();

      this.stage.hostScene.background = null;
      this.stage.setXRActive(true);
      this.stage.setManualPlacement(true);
      this.stage.start();
      this.stage.unmount();

      await this.showScene(initial, 'ar');
    } catch (error) {
      await this.exit();
      throw error;
    }
  }

  private createReticle(): void {
    if (this.reticle) return;
    const geometry = new THREE.RingGeometry(0.09, 0.13, 48);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({
      color: 0x8fc4ff,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
      toneMapped: false,
    });
    const reticle = new THREE.Mesh(geometry, material);
    reticle.name = 'ar-reticle';
    reticle.renderOrder = 999;
    reticle.visible = false;
    this.stage.hostScene.add(reticle);
    this.reticle = reticle;
  }

  /** 每帧更新命中测试结果与指示环位置。 */
  private updateReticle(): void {
    if (this.mode !== 'ar' || !this.hitTestSource || this.arPlaced) return;
    const reticle = this.reticle;
    if (!reticle) return;

    const frame = this.stage.renderer.xr.getFrame();
    const refSpace = this.stage.renderer.xr.getReferenceSpace();
    if (!frame || !refSpace) return;

    const results = frame.getHitTestResults(this.hitTestSource);
    if (!results.length) {
      reticle.visible = false;
      return;
    }

    const result = results[0];
    const pose = result.getPose(refSpace);
    if (!pose) {
      reticle.visible = false;
      return;
    }

    this.tmpMatrix.fromArray(pose.transform.matrix);
    this.arPosition.setFromMatrixPosition(this.tmpMatrix);
    this.arQuaternion.setFromRotationMatrix(this.tmpMatrix);
    reticle.position.copy(this.arPosition);
    reticle.quaternion.copy(this.arQuaternion);
    reticle.visible = true;
    this.hitResult = result;
  }

  private readonly handleArSelect = async () => {
    if (this.mode !== 'ar' || this.arPlaced) return;
    const instance = this.stage.current;
    const reticle = this.reticle;
    if (!instance || !reticle || !reticle.visible) return;

    instance.root.position.copy(this.arPosition);
    instance.root.quaternion.copy(this.arQuaternion);

    // 命中位姿已经包含真实表面的朝向，无需用附近的调试平面覆盖它。

    instance.root.visible = true;
    this.arPlaced = true;
    reticle.visible = false;

    // 尽量创建锚点，让场景稳稳留在真实空间里
    try {
      const session = this.session;
      const anchor = await this.hitResult?.createAnchor?.();
      if (anchor) {
        if (this.session !== session) {
          anchor.delete();
          return;
        }
        this.arAnchor = anchor;
        await this.persistAnchor(anchor, this.activeScene?.id ?? '');
      }
    } catch {
      // 设备不支持锚点时忽略：位置仍然可用，只是不会跟随环境微调
    }
  };

  /**
   * 申请持久锚点句柄并保存到本地。
   *
   * 仅在设备实际支持持久锚点时保存，普通 AR 放置不依赖此能力。
   */
  private async persistAnchor(anchor: XRAnchor, sceneId: string): Promise<void> {
    const request = (anchor as unknown as { requestPersistentHandle?: () => Promise<string> })
      .requestPersistentHandle;
    if (typeof request !== 'function') return;

    try {
      const handle = await request.call(anchor);
      if (this.arAnchor !== anchor) return;
      const list = loadStoredAnchors().filter((item) => item.sceneId !== sceneId);
      list.push({
        handle,
        sceneId,
        position: this.arPosition.toArray() as [number, number, number],
        quaternion: this.arQuaternion.toArray() as [number, number, number, number],
      });
      saveStoredAnchors(list);
    } catch (error) {
      console.warn('[xr] 持久锚点申请失败', error);
    }
  }

  /**
   * 尝试恢复上次放置的场景：找到对应的持久锚点就直接放回原位，
   * 免得每次都要重新对准平面。
   */
  private async restoreAnchor(session: XRSession, sceneId: string): Promise<boolean> {
    const stored = loadStoredAnchors().find((item) => item.sceneId === sceneId);
    if (!stored) return false;

    const restore = (session as unknown as {
      restorePersistentAnchor?: (handle: string) => Promise<XRAnchor>;
    }).restorePersistentAnchor;
    if (typeof restore !== 'function') return false;

    try {
      const anchor = await restore.call(session, stored.handle);
      if (this.session !== session) {
        anchor.delete();
        return false;
      }
      this.arAnchor = anchor;
      this.arPosition.set(...stored.position);
      this.arQuaternion.set(...stored.quaternion);
      this.arPlaced = true;
      if (this.reticle) this.reticle.visible = false;
      return true;
    } catch (error) {
      console.warn('[xr] 持久锚点恢复失败', error);
      return false;
    }
  }

  /** 锚点存在时，让内容跟随锚点微调位置。 */
  private updateAnchor(): void {
    if (!this.arAnchor) return;
    const frame = this.stage.renderer.xr.getFrame();
    const refSpace = this.stage.renderer.xr.getReferenceSpace();
    if (!frame || !refSpace) return;

    const pose = frame.getPose(this.arAnchor.anchorSpace, refSpace);
    if (!pose) return;
    this.tmpMatrix.fromArray(pose.transform.matrix);
    const instance = this.stage.current;
    if (!instance) return;
    instance.root.position.setFromMatrixPosition(this.tmpMatrix);
    instance.root.quaternion.setFromRotationMatrix(this.tmpMatrix);
  }

  private readonly handleSessionEnd = () => {
    this.session?.removeEventListener('end', this.handleSessionEnd);
    this.session?.removeEventListener('select', this.handleSelect);
    this.session?.removeEventListener('selectend', this.handleSelectEnd);
    this.session?.removeEventListener('select', this.handleArSelect);
    this.session = null;
    ++this.sceneToken;
    this.pendingAction = null;
    this.transition = 1;
    this.clearWall();
    this.clearLoadingPanel();
    this.clearBackPanel();
    this.clearReticle();
    this.hitTestSource?.cancel?.();
    this.hitTestSource = null;
    this.hitResult = null;
    this.arAnchor?.delete();
    this.arAnchor = null;
    this.arPlaced = false;
    this.pinching.clear();
    this.pinchHit = false;
    this.pinchables.length = 0;
    for (const hand of this.handModels) {
      hand.removeEventListener('pinchstart', this.handlePinchStart);
      hand.removeEventListener('pinchend', this.handlePinchEnd);
      this.stage.hostScene.remove(hand);
    }
    for (const skeleton of this.handSkeletons) {
      skeleton.group.removeFromParent();
      skeleton.dispose();
    }
    this.handModels.length = 0;
    this.handSkeletons.length = 0;
    this.stage.unmount();
    this.stage.setXRActive(false);
    this.stage.setManualPlacement(false);
    this.stage.renderer.xr.setReferenceSpaceType('local-floor');
    this.stage.hostScene.background = null;
    this.audio?.stop();
    this.mode = 'wall';
    this.activeScene = null;
    this.onModeChange?.('wall', null);
    window.dispatchEvent(new Event('xr-sessionended'));
  };

  private readonly handleSelect = (event: XRInputSourceEvent) => {
    const source = event.inputSource;
    const frame = event.frame ?? this.stage.renderer.xr.getFrame();
    const refSpace = this.stage.renderer.xr.getReferenceSpace();
    if (!frame || !refSpace || !source.targetRaySpace) return;

    const pose = frame.getPose(source.targetRaySpace, refSpace);
    if (!pose) return;

    this.tmpMatrix.fromArray(pose.transform.matrix);
    this.tmpOrigin.setFromMatrixPosition(this.tmpMatrix);
    this.tmpQuat.setFromRotationMatrix(this.tmpMatrix);
    this.tmpDir.set(0, 0, -1).applyQuaternion(this.tmpQuat).normalize();

    // 场景模式：先把捏合派发给场景（场景内可交互对象优先）
    if (this.mode === 'scene' && this.activeScene) {
      const hit = this.pickPinchable(this.tmpOrigin, this.tmpDir);
      if (hit) {
        this.pinchHit = true;
        this.pinchPoint.copy(hit);
        this.pinching.add(source);
        this.dispatchPinch('start');
        return;
      }
    }

    // 场景模式下优先命中「返回场景墙」
    if (this.mode === 'scene' && this.backPanel) {
      this.raycaster.set(this.tmpOrigin, this.tmpDir);
      this.raycaster.far = 10;
      if (this.raycaster.intersectObject(this.backPanel, false).length) {
        this.showWall();
        return;
      }
    }

    const hit = this.pickPanel(this.tmpOrigin, this.tmpDir);
    if (hit) {
      this.activate(hit);
      return;
    }

    if (this.hovered) this.activate(this.hovered);
  };

  private readonly handleSelectEnd = (event: XRInputSourceEvent) => {
    if (!this.pinching.has(event.inputSource)) return;
    this.pinching.delete(event.inputSource);
    this.dispatchPinch('end');
  };

  /* ---------------- 手部捏合 ---------------- */

  private readonly handlePinchStart = () => {
    if (this.mode === 'ar') return;
    this.pinching.add('hand');
    this.dispatchPinch('start');
  };

  private readonly handlePinchEnd = () => {
    this.pinching.delete('hand');
    this.dispatchPinch('end');
  };

  /** 每帧更新捏合中的手部位置并派发 move。 */
  private updatePinch(): void {
    if (this.pinching.size === 0) return;

    const instance = this.stage.current;
    if (!instance?.onPinch) return;

    const root = instance.root;
    root.updateWorldMatrix(true, false);

    // 捏合点 = 拇指尖与食指尖的中点
    const hand = this.stage.renderer.xr.getHand(0);
    const thumb = hand.joints?.['thumb-tip'];
    const index = hand.joints?.['index-finger-tip'];

    if (thumb && index) {
      thumb.getWorldPosition(this.tmpVector);
      index.getWorldPosition(this.pinchHand);
      this.tmpVector.add(this.pinchHand).multiplyScalar(0.5);
      this.pinchHand.copy(this.tmpVector);
    } else {
      return;
    }

    // 从相机朝捏合点发射射线，找到可交互对象
    const camera = this.stage.renderer.xr.getCamera();
    camera.getWorldPosition(this.tmpOrigin);
    this.tmpDir.copy(this.pinchHand).sub(this.tmpOrigin).normalize();

    const hit = this.pickPinchable(this.tmpOrigin, this.tmpDir);
    this.pinchHit = hit !== null;
    if (hit) this.pinchPoint.copy(hit);

    this.dispatchPinch('move');
  }

  /** 找出场景里标记了 userData.pinchable 的对象中被射线命中的那个。 */
  private pickPinchable(origin: THREE.Vector3, dir: THREE.Vector3): THREE.Vector3 | null {
    const instance = this.stage.current;
    if (!instance) return null;

    if (this.pinchables.length === 0) {
      this.pinchables.length = 0;
      instance.root.traverse((child) => {
        if (child.userData.pinchable) this.pinchables.push(child);
      });
    }
    if (this.pinchables.length === 0) return null;

    this.raycaster.set(origin, dir);
    this.raycaster.far = 20;
    const hits = this.raycaster.intersectObjects(this.pinchables, true);
    if (!hits.length) return null;

    const point = hits[0].point.clone();
    instance.root.worldToLocal(point);
    return point;
  }

  /** 把捏合信息派发给当前场景。 */
  private dispatchPinch(phase: 'start' | 'move' | 'end'): void {
    const instance = this.stage.current;
    if (!instance?.onPinch) return;

    this.pinchInfo.phase = phase;
    this.pinchInfo.strength = phase === 'end' ? 0 : 1;
    this.pinchInfo.hit = this.pinchHit;
    this.pinchInfo.point.copy(this.pinchPoint);
    this.pinchInfo.hand.copy(this.pinchHand);
    instance.onPinch(this.pinchInfo);
  }

  /** 切回场景墙。 */
  showWall(): void {
    ++this.sceneToken;
    this.pendingAction = null;
    this.pinchables.length = 0;
    this.pinching.clear();
    if (this.wallGroup) this.clearWall();
    this.stage.unmount();
    this.clearBackPanel();
    this.clearLoadingPanel();
    this.audio?.stop();

    const { group, panels } = buildSceneWall(this.scenes, this.thumbnails);
    this.wallGroup = group;
    this.panels = panels;
    this.stage.hostScene.add(group);
    group.scale.setScalar(0.001);
    this.transition = 0;

    this.mode = 'wall';
    this.activeScene = null;
    this.onModeChange?.('wall', null);
  }

  /** 进入某个场景的沉浸模式。 */
  async showScene(def: SceneDefinition, mode: 'scene' | 'ar' = 'scene'): Promise<void> {
    const token = ++this.sceneToken;
    this.pinchables.length = 0;
    this.pinching.clear();
    this.clearBackPanel();
    this.mode = mode;
    this.activeScene = def;
    this.onModeChange?.(mode, def);

    this.showLoading(def.title);
    this.transition = 0;
    this.pendingAction = () => {
      this.clearWall();
      this.clearLoadingPanel();
      void this.mountScene(def, token);
    };
  }

  private async mountScene(def: SceneDefinition, token: number): Promise<void> {
    try {
      const instance = await def.create(this.stage.context);
      if (token !== this.sceneToken) {
        instance.dispose();
        return;
      }
      const mode = def.modes?.find((item) => item.id === this.stage.currentMode?.id)
        ?? def.modes?.[0] ?? null;
      this.stage.setMode(mode);
      this.stage.audio.setFallback(def.breathing ?? null);
      this.stage.mount(instance, def);

      // AR 模式：先尝试恢复上次的持久锚点，没有再让用户手动放置
      if (this.mode === 'ar') {
        instance.root.visible = false;
        const restored =
          this.session && (await this.restoreAnchor(this.session, def.id));
        if (token !== this.sceneToken) return;
        if (restored) {
          instance.root.position.copy(this.arPosition);
          instance.root.quaternion.copy(this.arQuaternion);
          instance.root.visible = true;
        }
      }
      if (this.mode !== 'ar') this.createBackPanel(def);
      await this.playSceneAudio(def);
    } catch (error) {
      if (token !== this.sceneToken) return;
      console.error('[xr] 场景加载失败', error);
      this.showLoading('场景加载失败，请返回');
    }
  }

  /** 沉浸场景同步播放该场景的环境音（没有音乐的场景保持静音）。 */
  private async playSceneAudio(def: SceneDefinition): Promise<void> {
    if (!this.audio) return;
    if (this.audioEnabled?.() === false) {
      this.audio.pause();
      return;
    }
    try {
      await this.audio.playScene(def, this.stage.currentMode);
    } catch (error) {
      console.warn('[xr] 环境音播放失败', error);
    }
  }

  private activate(panel: ScenePanel): void {
    if (this.mode !== 'wall' || this.transition < 1) return;
    void this.showScene(panel.def);
  }

  /** 每帧：射线拾取、悬停高亮、过渡动画。 */
  private readonly update = (_time: number, delta: number) => {
    // 过渡动画与是否处于会话无关，保证任何进入路径都能完整播放
    if (this.transition < 1) {
      this.transition = Math.min(1, this.transition + delta / TRANSITION);
      const eased = 1 - Math.pow(1 - this.transition, 3);
      if (this.wallGroup) {
        this.wallGroup.scale.setScalar(Math.max(0.001, eased));
      }
      if (this.transition >= 1 && this.pendingAction) {
        const action = this.pendingAction;
        this.pendingAction = null;
        action();
      }
    }

    if (!this.session) return;

    if (this.mode === 'wall') {
      this.updateHover(delta);
    } else if (this.mode === 'ar') {
      this.updateReticle();
      this.updateAnchor();
    } else if (this.activeScene) {
      this.updateBackPanelHover();
    }

    this.updatePinch();
    this.updateHandSkeletons();
  };

  /** 用 WebXR 的关节数据刷新手部骨架。 */
  private updateHandSkeletons(): void {
    for (let i = 0; i < this.handModels.length; i += 1) {
      this.handSkeletons[i]?.update(this.handModels[i]);
    }
  }

  private updateHover(delta: number): void {
    const session = this.session;
    const frame = this.stage.renderer.xr.getFrame();
    const refSpace = this.stage.renderer.xr.getReferenceSpace();
    if (!session || !frame || !refSpace) return;

    let hovered: ScenePanel | null = null;
    let hasPointer = false;

    for (const source of session.inputSources) {
      if (!source.targetRaySpace) continue;
      if (source.targetRayMode !== 'gaze') hasPointer = true;
      const pose = frame.getPose(source.targetRaySpace, refSpace);
      if (!pose) continue;
      this.tmpMatrix.fromArray(pose.transform.matrix);
      this.tmpOrigin.setFromMatrixPosition(this.tmpMatrix);
      this.tmpQuat.setFromRotationMatrix(this.tmpMatrix);
      this.tmpDir.set(0, 0, -1).applyQuaternion(this.tmpQuat).normalize();
      hovered = this.pickPanel(this.tmpOrigin, this.tmpDir) ?? hovered;
    }

    // 视线兜底：从 XR 相机中心发射
    if (!hovered) {
      const xrCamera = this.stage.renderer.xr.getCamera();
      const view = xrCamera.cameras[0];
      if (view) {
        view.getWorldPosition(this.tmpOrigin);
        view.getWorldQuaternion(this.tmpQuat);
        this.tmpDir.set(0, 0, -1).applyQuaternion(this.tmpQuat).normalize();
        hovered = this.pickPanel(this.tmpOrigin, this.tmpDir);
      }
    }

    this.setHovered(hovered);

    // 只有在没有手柄/手部输入时，才启用视线停留选择
    if (!hasPointer) {
      if (hovered) {
        this.dwellTime += delta;
        if (this.dwellTime >= DWELL_SECONDS) {
          this.dwellTime = 0;
          this.activate(hovered!);
        }
      } else {
        this.dwellTime = 0;
      }
    }
  }

  private pickPanel(origin: THREE.Vector3, dir: THREE.Vector3): ScenePanel | null {
    if (!this.panels.length) return null;
    this.raycaster.set(origin, dir);
    this.raycaster.far = 30;
    const hits = this.raycaster.intersectObjects(
      this.panels.map((panel) => panel.hit),
      false,
    );
    if (!hits.length) return null;
    const id = hits[0].object.userData.sceneId as string;
    return this.panels.find((panel) => panel.def.id === id) ?? null;
  }

  private setHovered(panel: ScenePanel | null): void {
    if (panel === this.hovered) return;
    this.hovered = panel;
    for (const item of this.panels) {
      const target = item === panel ? 0.55 : 0;
      const material = item.glow.material as THREE.MeshBasicMaterial;
      material.opacity += (target - material.opacity) * 0.25;
      const scale = item === panel ? 1.06 : 1;
      item.group.scale.setScalar(item.group.scale.x + (scale - item.group.scale.x) * 0.25);
    }
  }

  private createBackPanel(def: SceneDefinition): void {
    this.clearBackPanel();

    const texture = createNoticeTexture('返回场景墙', `当前：${def.title}`);
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(0.52, 0.13),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false }),
    );
    panel.position.set(0.72, 0.98, -1.15);
    panel.rotation.y = -0.32;
    panel.userData.isBackPanel = true;
    this.stage.hostScene.add(panel);
    this.backPanel = panel;
  }

  private updateBackPanelHover(): void {
    const panel = this.backPanel;
    if (!panel) return;
    const frame = this.stage.renderer.xr.getFrame();
    const refSpace = this.stage.renderer.xr.getReferenceSpace();
    const session = this.session;
    if (!frame || !refSpace || !session) return;

    let pointing = false;
    for (const source of session.inputSources) {
      if (!source.targetRaySpace) continue;
      const pose = frame.getPose(source.targetRaySpace, refSpace);
      if (!pose) continue;
      this.tmpMatrix.fromArray(pose.transform.matrix);
      this.tmpOrigin.setFromMatrixPosition(this.tmpMatrix);
      this.tmpQuat.setFromRotationMatrix(this.tmpMatrix);
      this.tmpDir.set(0, 0, -1).applyQuaternion(this.tmpQuat).normalize();
      this.raycaster.set(this.tmpOrigin, this.tmpDir);
      this.raycaster.far = 10;
      if (this.raycaster.intersectObject(panel, false).length) {
        pointing = true;
        break;
      }
    }

    const material = panel.material as THREE.MeshBasicMaterial;
    material.opacity += ((pointing ? 1 : 0.82) - material.opacity) * 0.25;
    const scale = pointing ? 1.12 : 1;
    panel.scale.setScalar(panel.scale.x + (scale - panel.scale.x) * 0.25);
  }

  private showLoading(title: string): void {
    this.clearLoadingPanel();
    const texture = createNoticeTexture('正在载入', title);
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(0.9, 0.22),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false }),
    );
    panel.position.set(0, 1.55, -2.0);
    this.stage.hostScene.add(panel);
    this.loadingPanel = panel;
  }

  private clearLoadingPanel(): void {
    if (!this.loadingPanel) return;
    this.stage.hostScene.remove(this.loadingPanel);
    this.loadingPanel.geometry.dispose();
    (this.loadingPanel.material as THREE.MeshBasicMaterial).map?.dispose();
    (this.loadingPanel.material as THREE.Material).dispose();
    this.loadingPanel = null;
  }

  private clearBackPanel(): void {
    if (!this.backPanel) return;
    this.stage.hostScene.remove(this.backPanel);
    this.backPanel.geometry.dispose();
    (this.backPanel.material as THREE.MeshBasicMaterial).map?.dispose();
    (this.backPanel.material as THREE.Material).dispose();
    this.backPanel = null;
  }

  private clearReticle(): void {
    if (!this.reticle) return;
    this.stage.hostScene.remove(this.reticle);
    this.reticle.geometry.dispose();
    (this.reticle.material as THREE.Material).dispose();
    this.reticle = null;
  }

  private clearWall(): void {
    if (!this.wallGroup) return;
    this.stage.hostScene.remove(this.wallGroup);
    this.wallGroup.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        const material = child.material as THREE.MeshBasicMaterial;
        material.map?.dispose();
        material.dispose();
      }
    });
    this.wallGroup = null;
    this.panels = [];
    this.hovered = null;
  }

  /** 退出沉浸会话。 */
  async exit(): Promise<void> {
    const session = this.session;
    if (!session) return;
    try {
      await session.end();
    } finally {
      if (this.session === session) this.handleSessionEnd();
    }
  }
}
