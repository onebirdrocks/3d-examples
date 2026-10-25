import * as THREE from 'three';
import type { SceneDefinition } from '../scenes/types.js';

export interface ScenePanel {
  def: SceneDefinition;
  /** 缩略图平面（射线拾取目标）。 */
  hit: THREE.Mesh;
  group: THREE.Group;
  /** 高亮边框。 */
  glow: THREE.Mesh;
  label: THREE.Mesh;
}

/** 把文字绘制到画布上并生成纹理（用于 XR 面板标题）。 */
export function createLabelTexture(def: SceneDefinition): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 192;
  const ctx = canvas.getContext('2d')!;

  const gradient = ctx.createLinearGradient(0, 0, canvas.width, 0);
  gradient.addColorStop(0, def.gradient[0]);
  gradient.addColorStop(1, def.gradient[1]);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = 'rgba(6, 8, 14, .72)';
  ctx.fillRect(0, 96, canvas.width, 96);

  ctx.fillStyle = '#ffffff';
  ctx.font = '600 54px "PingFang SC", "Hiragino Sans GB", system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(def.title, 28, 46);

  ctx.fillStyle = def.accent;
  ctx.font = '500 30px ui-monospace, "SF Mono", Menlo, monospace';
  ctx.fillText(def.subtitle.toUpperCase(), 28, 142);

  ctx.fillStyle = 'rgba(255,255,255,.42)';
  ctx.font = '400 26px "PingFang SC", system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(def.tags.join('  ·  '), canvas.width - 28, 142);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/** 把 data URL 图片转成可用于面板的纹理。 */
export function createImageTexture(dataUrl: string | undefined, fallback: SceneDefinition): THREE.Texture {
  const texture = new THREE.Texture();
  const image = new Image();
  image.decoding = 'async';
  image.onload = () => {
    texture.image = image;
    texture.needsUpdate = true;
  };
  image.src = dataUrl ?? '';

  // 缩略图未就绪时用渐变色块占位
  const placeholder = document.createElement('canvas');
  placeholder.width = 64;
  placeholder.height = 40;
  const pctx = placeholder.getContext('2d')!;
  const gradient = pctx.createLinearGradient(0, 0, 64, 40);
  gradient.addColorStop(0, fallback.gradient[0]);
  gradient.addColorStop(1, fallback.gradient[1]);
  pctx.fillStyle = gradient;
  pctx.fillRect(0, 0, 64, 40);
  texture.image = placeholder;
  texture.needsUpdate = true;

  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

const PANEL_WIDTH = 0.94;
const PANEL_HEIGHT = 0.59;
/** 单层最多放多少个面板，超出就往上叠一层。 */
const PANELS_PER_RING = 8;

/**
 * 空间场景墙：场景面板环绕用户排布。
 *
 * 场景数量多时不会挤成一圈，而是分成若干层「环形塔」：
 * 内层低、外层高且远，逐层向外上方展开，用户环视 + 抬头即可浏览全部场景。
 */
export function buildSceneWall(
  scenes: readonly SceneDefinition[],
  thumbnails: Map<string, string>,
): { group: THREE.Group; panels: ScenePanel[] } {
  const group = new THREE.Group();
  group.name = 'scene-wall';

  const total = scenes.length;
  const panels: ScenePanel[] = [];
  if (!total) return { group, panels };

  // 把场景尽量均匀地分到多层里
  const ringCount = Math.max(1, Math.ceil(total / PANELS_PER_RING));
  const perRing: number[] = [];
  let remaining = total;
  for (let i = 0; i < ringCount; i += 1) {
    const left = ringCount - i;
    const count = Math.ceil(remaining / left);
    perRing.push(count);
    remaining -= count;
  }

  let index = 0;
  perRing.forEach((count, ring) => {
    const radius = 3.0 + ring * 1.05;
    const height = 1.35 + ring * 0.82;
    // 每层错开半格，避免上下层垂直对齐、看起来像栅栏
    const offset = ring * (Math.PI / count);

    for (let i = 0; i < count; i += 1) {
      const def = scenes[index];
      index += 1;
      if (!def) return;

      const angle = (i / count) * Math.PI * 2 + offset;

      const panelGroup = new THREE.Group();
      panelGroup.position.set(
        Math.sin(angle) * radius,
        height,
        -Math.cos(angle) * radius,
      );
      panelGroup.rotation.y = -angle;

      const image = createImageTexture(thumbnails.get(def.id), def);
      const hit = new THREE.Mesh(
        new THREE.PlaneGeometry(PANEL_WIDTH, PANEL_HEIGHT),
        new THREE.MeshBasicMaterial({ map: image, toneMapped: false }),
      );
      hit.userData.sceneId = def.id;
      panelGroup.add(hit);

      const glow = new THREE.Mesh(
        new THREE.PlaneGeometry(PANEL_WIDTH + 0.07, PANEL_HEIGHT + 0.07),
        new THREE.MeshBasicMaterial({
          color: new THREE.Color(def.accent),
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          toneMapped: false,
        }),
      );
      glow.position.z = -0.012;
      panelGroup.add(glow);

      const label = new THREE.Mesh(
        new THREE.PlaneGeometry(PANEL_WIDTH, 0.17),
        new THREE.MeshBasicMaterial({
          map: createLabelTexture(def),
          transparent: true,
          toneMapped: false,
        }),
      );
      label.position.set(0, -(PANEL_HEIGHT / 2 + 0.095), 0.002);
      panelGroup.add(label);

      // 背板：让面板在透视/雾化环境下仍有实体感
      const backing = new THREE.Mesh(
        new THREE.PlaneGeometry(PANEL_WIDTH + 0.12, PANEL_HEIGHT + 0.36),
        new THREE.MeshBasicMaterial({
          color: 0x0a0e18,
          transparent: true,
          opacity: 0.72,
          toneMapped: false,
        }),
      );
      backing.position.z = -0.02;
      panelGroup.add(backing);

      group.add(panelGroup);
      panels.push({ def, hit, group: panelGroup, glow, label });
    }
  });

  return { group, panels };
}

/** 生成一段用于提示用户操作的文字纹理。 */
export function createNoticeTexture(title: string, subtitle: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = 'rgba(8, 11, 20, .82)';
  const radius = 28;
  ctx.beginPath();
  ctx.roundRect(8, 8, canvas.width - 16, canvas.height - 16, radius);
  ctx.fill();

  ctx.strokeStyle = 'rgba(140, 180, 255, .35)';
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.font = '600 60px "PingFang SC", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(title, canvas.width / 2, 96);

  ctx.fillStyle = 'rgba(190, 210, 245, .75)';
  ctx.font = '400 38px "PingFang SC", system-ui, sans-serif';
  ctx.fillText(subtitle, canvas.width / 2, 170);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
