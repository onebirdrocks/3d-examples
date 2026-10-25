import './styles/app.css';
import { SCENES, SCENE_CATEGORIES } from './scenes/index.js';
import type { SceneDefinition } from './scenes/types.js';
import { ThumbnailBaker } from './core/preview.js';
import { Stage } from './core/stage.js';
import { AmbientAudio } from './core/audio.js';
import { XrExplorer } from './xr/explorer.js';

const grid = document.querySelector<HTMLElement>('#grid')!;
const filters = document.querySelector<HTMLElement>('#filters')!;
const xrButton = document.querySelector<HTMLButtonElement>('#enter-xr')!;
const xrChip = document.querySelector<HTMLElement>('#xr-chip')!;
const xrNote = document.querySelector<HTMLElement>('#xr-note')!;
const footerStatus = document.querySelector<HTMLElement>('#footer-status')!;
const canvas = document.querySelector<HTMLCanvasElement>('#xr-canvas')!;

const thumbnails = new Map<string, string>();

document.querySelector('#scene-count')!.textContent = `${SCENES.length} 个场景`;

/* ---------------- 卡片 ---------------- */

const cardElements = new Map<string, HTMLElement>();

const CATEGORY_LABEL: Record<string, string> = {
  procedural: 'Procedural',
  model: 'Model',
  meditation: 'Meditation',
  sleep: 'Sleep',
  environment: 'Ambient',
};

function buildCard(def: SceneDefinition, index: number): HTMLElement {
  const card = document.createElement('a');
  card.className = 'card';
  card.href = `./scene.html?id=${encodeURIComponent(def.id)}`;
  card.style.setProperty('--accent', def.accent);
  card.style.setProperty('--g0', def.gradient[0]);
  card.style.setProperty('--g1', def.gradient[1]);
  card.style.animationDelay = `${Math.min(index, 9) * 45}ms`;
  card.dataset.category = def.category;

  const media = document.createElement('div');
  media.className = 'card__media';

  const image = document.createElement('img');
  image.className = 'card__img';
  image.alt = `${def.title} 场景预览`;
  image.decoding = 'async';
  media.append(image);

  const category = document.createElement('span');
  category.className = 'card__cat';
  category.textContent = CATEGORY_LABEL[def.category] ?? def.category;
  media.append(category);

  if (def.audio) {
    const sound = document.createElement('span');
    sound.className = 'card__sound';
    sound.textContent = '环境音';
    media.append(sound);
  }

  const ordinal = document.createElement('span');
  ordinal.className = 'card__index';
  ordinal.textContent = String(index + 1).padStart(2, '0');
  media.append(ordinal);

  const body = document.createElement('div');
  body.className = 'card__body';

  const title = document.createElement('h3');
  title.className = 'card__title';
  title.textContent = def.title;
  const sub = document.createElement('span');
  sub.className = 'card__sub';
  sub.textContent = def.subtitle;
  title.append(sub);

  const desc = document.createElement('p');
  desc.className = 'card__desc';
  desc.textContent = def.description;

  const tags = document.createElement('ul');
  tags.className = 'card__tags';
  for (const tag of def.tags) {
    const item = document.createElement('li');
    item.textContent = tag;
    tags.append(item);
  }

  body.append(title, desc, tags);
  card.append(media, body);
  return card;
}

SCENES.forEach((def, index) => {
  const card = buildCard(def, index);
  cardElements.set(def.id, card);
  grid.append(card);
});

/* ---------------- 筛选 ---------------- */

let activeCategory: string = 'all';

SCENE_CATEGORIES.forEach((category) => {
  const button = document.createElement('button');
  button.className = 'filter';
  button.type = 'button';
  button.textContent = category.label;
  button.setAttribute('aria-pressed', String(category.id === activeCategory));
  button.addEventListener('click', () => {
    activeCategory = category.id;
    filters.querySelectorAll('.filter').forEach((el) => {
      el.setAttribute('aria-pressed', String(el === button));
    });
    SCENES.forEach((def) => {
      cardElements.get(def.id)?.classList.toggle('is-hidden', activeCategory !== 'all' && def.category !== activeCategory);
    });
  });
  filters.append(button);
});

document.querySelector('#scroll-gallery')?.addEventListener('click', () => {
  document.querySelector('#gallery')?.scrollIntoView({ behavior: 'smooth' });
});

/* ---------------- 缩略图烘焙 ---------------- */

async function bakeThumbnails(): Promise<void> {
  const baker = new ThumbnailBaker({ width: 560, quality: 0.6, warmupFrames: 2 });
  let done = 0;
  const started = performance.now();

  for (const def of SCENES) {
    try {
      const url = await baker.bake(def);
      thumbnails.set(def.id, url);
      const image = cardElements.get(def.id)?.querySelector('img');
      if (image) {
        image.src = url;
        image.addEventListener('load', () => image.classList.add('is-ready'), { once: true });
        if (image.complete) image.classList.add('is-ready');
      }
    } catch (error) {
      console.warn(`[gallery] 场景「${def.title}」缩略图生成失败`, error);
    }
    done += 1;
    footerStatus.textContent = `缩略图 ${done} / ${SCENES.length}`;
    // 让出主线程，保证页面滚动与首屏渲染不被阻塞
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  }

  const total = ((performance.now() - started) / 1000).toFixed(1);
  if (Number(total) > 3) {
    console.info(`[gallery] 10 张缩略图烘焙完成，用时 ${total}s`);
  }
  footerStatus.textContent = `${SCENES.length} 个场景 · 缩略图就绪`;
  baker.dispose();

  if (new URLSearchParams(location.search).get('wall') === '1') {
    previewWall();
  }
}

/**
 * 调试入口：在桌面浏览器里以「用户站在场景墙中央」的视角预览 VR 空间墙。
 * 仅用于开发期核对空间布局，不会进入沉浸会话。
 */
function previewWall(): void {
  const currentStage = ensureStage();
  if (!explorer) {
    explorer = new XrExplorer({ stage: currentStage, scenes: SCENES, thumbnails });
  }
  document.body.classList.add('xr-active');
  currentStage.fallbackCamera.position.set(0, 1.45, 0);
  currentStage.fallbackCamera.lookAt(0, 1.45, -2.7);
  currentStage.fallbackCamera.updateProjectionMatrix();
  currentStage.start();
  explorer.showWall();
}

/* ---------------- WebXR ---------------- */

let stage: Stage | null = null;
let explorer: XrExplorer | null = null;
let ambient: AmbientAudio | null = null;

function ensureStage(): Stage {
  if (!stage) {
    stage = new Stage({ canvas, quality: 1, maxPixelRatio: 2 });
    ambient = new AmbientAudio();
    ambient.attachAnalysis(stage.audio);
  }
  return stage;
}

async function setupXR(): Promise<void> {
  const secure = window.isSecureContext;
  const supported = secure && (await XrExplorer.isSupported());

  if (supported) {
    xrChip.textContent = 'WebXR 就绪';
    xrChip.classList.add('chip--ok');
    xrButton.disabled = false;
    xrNote.textContent = '戴上 Vision Pro 后点击按钮，或在 Safari 中直接打开本页。';
  } else if (!secure) {
    xrChip.textContent = '需要 HTTPS';
    xrChip.classList.add('chip--off');
    xrButton.disabled = true;
    xrNote.textContent =
      '浏览器只在安全上下文（HTTPS 或 localhost）提供 WebXR。请把站点部署到 HTTPS 域名，或在 Vision Pro 的 Safari 中打开后即可体验空间浏览。';
  } else {
    xrChip.textContent = '本设备无沉浸模式';
    xrChip.classList.add('chip--off');
    xrButton.disabled = true;
    xrNote.textContent =
      '当前浏览器未提供 immersive-vr 会话。桌面端仍可浏览全部场景；请在 Vision Pro 的 Safari 中打开本页以体验空间浏览。';
  }
}

xrButton.addEventListener('click', async () => {
  xrButton.disabled = true;
  xrNote.textContent = '正在启动沉浸会话…';
  try {
    const currentStage = ensureStage();
    if (!explorer) {
      explorer = new XrExplorer({
        stage: currentStage,
        scenes: SCENES,
        thumbnails,
        audio: ambient ?? undefined,
        onModeChange: (_mode, scene) => {
          xrNote.textContent = scene ? `沉浸浏览：${scene.title}` : '沉浸浏览：场景墙';
        },
      });
    }
    document.body.classList.add('xr-active');
    await explorer.enter();
  } catch (error) {
    console.error('[gallery] 沉浸会话启动失败', error);
    xrNote.textContent =
      error instanceof Error ? `启动失败：${error.message}` : '启动失败，请重试。';
  } finally {
    xrButton.disabled = false;
  }
});

window.addEventListener('xr-sessionended', () => {
  document.body.classList.remove('xr-active');
});

void setupXR();
void bakeThumbnails();
