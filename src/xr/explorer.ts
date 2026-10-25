import * as THREE from 'three';
import type { Stage } from '../core/stage.js';
import type { AmbientAudio } from '../core/audio.js';
import type { SceneDefinition } from '../scenes/types.js';
import { buildSceneWall, createNoticeTexture, type ScenePanel } from './wall.js';

export type XrMode = 'wall' | 'scene';

export interface XrExplorerOptions {
  stage: Stage;
  scenes: readonly SceneDefinition[];
  /** 场景 id → 缩略图 data URL。 */
  thumbnails: Map<string, string>;
  /** 可选的环境音播放器：进入沉浸场景时同步播放该场景的音乐。 */
  audio?: AmbientAudio;
  onModeChange?: (mode: XrMode, scene: SceneDefinition | null) => void;
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
  private readonly onModeChange?: (mode: XrMode, scene: SceneDefinition | null) => void;

  private session: XRSession | null = null;
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

  private readonly raycaster = new THREE.Raycaster();
  private readonly tmpOrigin = new THREE.Vector3();
  private readonly tmpDir = new THREE.Vector3();
  private readonly tmpMatrix = new THREE.Matrix4();
  private readonly tmpQuat = new THREE.Quaternion();

  constructor(options: XrExplorerOptions) {
    this.stage = options.stage;
    this.scenes = options.scenes;
    this.thumbnails = options.thumbnails;
    this.audio = options.audio;
    this.onModeChange = options.onModeChange;
    this.stage.addFrameListener(this.update);
  }

  /** 当前是否支持 immersive-vr。 */
  static async isSupported(): Promise<boolean> {
    const xr = navigator.xr;
    if (!xr) return false;
    try {
      return await xr.isSessionSupported('immersive-vr');
    } catch {
      return false;
    }
  }

  /** 请求进入沉浸会话（必须由用户手势触发）。 */
  async enter(initial?: SceneDefinition): Promise<void> {
    const xr = navigator.xr;
    if (!xr) throw new Error('当前浏览器不支持 WebXR');

    const session = await xr.requestSession('immersive-vr', {
      optionalFeatures: [
        'local-floor',
        'bounded-floor',
        'hand-tracking',
        'layers',
        'light-estimation',
      ],
    });

    await this.stage.renderer.xr.setSession(session);
    this.session = session;
    session.addEventListener('end', this.handleSessionEnd);
    session.addEventListener('select', this.handleSelect);

    this.stage.hostScene.background = new THREE.Color(0x03050b);
    this.stage.setXRActive(true);
    this.stage.start();

    if (initial) {
      await this.showScene(initial);
    } else {
      this.showWall();
    }
  }

  private readonly handleSessionEnd = () => {
    this.session = null;
    this.clearWall();
    this.clearBackPanel();
    this.stage.unmount();
    this.stage.setXRActive(false);
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

  /** 切回场景墙。 */
  showWall(): void {
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
  async showScene(def: SceneDefinition): Promise<void> {
    this.mode = 'scene';
    this.activeScene = def;
    this.onModeChange?.('scene', def);

    this.showLoading(def.title);
    this.transition = 0;
    this.pendingAction = () => {
      this.clearWall();
      this.clearLoadingPanel();
      void this.mountScene(def);
    };
  }

  private async mountScene(def: SceneDefinition): Promise<void> {
    try {
      const instance = await def.create(this.stage.context);
      this.stage.mount(instance);
      this.createBackPanel(def);
      await this.playSceneAudio(def);
    } catch (error) {
      console.error('[xr] 场景加载失败', error);
      this.showLoading('场景加载失败，请返回');
    }
  }

  /** 沉浸场景同步播放该场景的环境音（没有音乐的场景保持静音）。 */
  private async playSceneAudio(def: SceneDefinition): Promise<void> {
    if (!this.audio) return;
    if (!def.audio) {
      this.audio.stop();
      return;
    }
    try {
      await this.audio.play(`audio/${def.audio}`);
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
    } else if (this.activeScene) {
      this.updateBackPanelHover();
    }
  };

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
    (this.loadingPanel.material as THREE.Material).dispose();
    this.loadingPanel = null;
  }

  private clearBackPanel(): void {
    if (!this.backPanel) return;
    this.stage.hostScene.remove(this.backPanel);
    this.backPanel.geometry.dispose();
    (this.backPanel.material as THREE.Material).dispose();
    this.backPanel = null;
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
    await this.session?.end();
  }
}
