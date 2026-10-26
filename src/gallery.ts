import './styles/app.css';
import { SCENES, SCENE_CATEGORIES } from './scenes/index.js';
import type { SceneDefinition } from './scenes/types.js';
import type { Stage } from './core/stage.js';
import type { AmbientAudio } from './core/audio.js';
import type { XrExplorer } from './xr/explorer.js';
import { assetUrl } from './core/loader.js';
import { favorites, filterScenes, galleryParams, readGalleryView, toggleFavorite } from './core/library.js';

const grid = document.querySelector<HTMLElement>('#grid')!;
const filters = document.querySelector<HTMLElement>('#filters')!;
const search = document.querySelector<HTMLInputElement>('#scene-search')!;
const resultCount = document.querySelector<HTMLElement>('#result-count')!;
const empty = document.querySelector<HTMLElement>('#gallery-empty')!;
const xrButton = document.querySelector<HTMLButtonElement>('#enter-xr')!;
const xrChip = document.querySelector<HTMLElement>('#xr-chip')!;
const xrNote = document.querySelector<HTMLElement>('#xr-note')!;
const canvas = document.querySelector<HTMLCanvasElement>('#xr-canvas')!;
const view = readGalleryView();
if (!SCENE_CATEGORIES.some((category) => category.id === view.category)) view.category = 'all';
search.value = view.query;

for (const element of document.querySelectorAll('[data-scene-count]')) element.textContent = String(SCENES.length);
document.querySelector('#scene-count')!.textContent = `${SCENES.length} 个场景`;
document.querySelector<HTMLMetaElement>('meta[name="description"]')!.content = `探索 ${SCENES.length} 个实时 3D 场景，在网页中欣赏光影、静心和助眠，兼容设备可进入沉浸体验。`;
document.querySelector('#footer-status')!.textContent = `${SCENES.length} 个场景 · 静态预览`;

const thumbnails = new Map(SCENES.map((scene) => [scene.id, assetUrl(`thumbnails/${scene.id}.webp`)]));
const cards = new Map<string, HTMLElement>();
const labels: Record<string, string> = { procedural: '程序化效果', model: '模型 · 材质', meditation: '冥想', sleep: '助眠', environment: '真实环境', simulation: '模拟', game: '小游戏' };

function buildCard(def: SceneDefinition, index: number): HTMLElement {
  const card = document.createElement('article');
  card.className = 'card';
  card.style.setProperty('--accent', def.accent);
  card.style.setProperty('--g0', def.gradient[0]);
  card.style.setProperty('--g1', def.gradient[1]);
  card.style.animationDelay = `${Math.min(index, 9) * 35}ms`;
  card.dataset.category = def.category;
  const link = document.createElement('a');
  link.className = 'card__link';
  const media = document.createElement('div');
  media.className = 'card__media';
  const image = document.createElement('img');
  image.className = 'card__img';
  image.alt = `${def.title} 场景预览`;
  image.width = 560;
  image.height = 350;
  image.loading = index < 3 ? 'eager' : 'lazy';
  image.decoding = 'async';
  const missing = document.createElement('span');
  missing.className = 'card__missing';
  missing.textContent = '预览暂不可用，仍可打开场景';
  missing.hidden = true;
  image.addEventListener('load', () => image.classList.add('is-ready'));
  image.addEventListener('error', () => { image.hidden = true; missing.hidden = false; });
  image.src = thumbnails.get(def.id)!;
  media.append(image, missing);
  const category = document.createElement('span');
  category.className = 'card__cat';
  category.textContent = labels[def.category];
  const ordinal = document.createElement('span');
  ordinal.className = 'card__index';
  ordinal.textContent = String(index + 1).padStart(2, '0');
  media.append(category, ordinal);
  if (def.audio || def.audioPlaylist?.length || def.audioLayers?.length) {
    const sound = document.createElement('span');
    sound.className = 'card__sound';
    sound.textContent = '环境音';
    media.append(sound);
  }
  const body = document.createElement('div');
  body.className = 'card__body';
  const title = document.createElement('h3');
  title.className = 'card__title';
  title.textContent = def.title;
  const subtitle = document.createElement('span');
  subtitle.className = 'card__sub';
  subtitle.textContent = def.subtitle;
  title.append(subtitle);
  const description = document.createElement('p');
  description.className = 'card__desc';
  description.textContent = def.description;
  const tags = document.createElement('ul');
  tags.className = 'card__tags';
  for (const tag of def.tags) { const item = document.createElement('li'); item.textContent = tag; tags.append(item); }
  body.append(title, description, tags);
  link.append(media, body);
  link.addEventListener('click', savePosition);
  const favorite = document.createElement('button');
  favorite.type = 'button';
  favorite.className = 'card__favorite';
  favorite.addEventListener('click', () => { toggleFavorite(def.id); });
  card.append(link, favorite);
  return card;
}

SCENES.forEach((def, index) => { const card = buildCard(def, index); cards.set(def.id, card); grid.append(card); });
for (const category of SCENE_CATEGORIES) {
  const button = document.createElement('button');
  button.className = 'filter';
  button.type = 'button';
  button.textContent = category.label;
  button.dataset.category = category.id;
  button.addEventListener('click', () => { view.category = category.id; render(); });
  filters.append(button);
}

function render(): void {
  const focused = document.activeElement instanceof HTMLElement && document.activeElement.closest('.card') ? document.activeElement : null;
  const selected = filterScenes(SCENES, view);
  const visible = new Set(selected.map((scene) => scene.id));
  const saved = favorites();
  for (const def of SCENES) {
    const card = cards.get(def.id)!;
    card.classList.toggle('is-hidden', !visible.has(def.id));
    const params = galleryParams(view);
    params.set('id', def.id);
    card.querySelector<HTMLAnchorElement>('a')!.href = `./scene.html?${params}`;
    const button = card.querySelector<HTMLButtonElement>('.card__favorite')!;
    const active = saved.includes(def.id);
    button.textContent = active ? '已收藏' : '收藏';
    button.setAttribute('aria-label', `${active ? '取消收藏' : '收藏'}${def.title}`);
    button.setAttribute('aria-pressed', String(active));
  }
  selected.forEach((def) => grid.append(cards.get(def.id)!));
  if (focused) {
    const target = focused.closest('.is-hidden')
      ? grid.querySelector<HTMLElement>('.card:not(.is-hidden) a') ?? document.querySelector<HTMLElement>(`[data-collection="${view.collection}"]`)
      : focused;
    target?.focus({ preventScroll: true });
  }
  for (const button of filters.querySelectorAll<HTMLButtonElement>('button')) button.setAttribute('aria-pressed', String(button.dataset.category === view.category));
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-collection]')) button.setAttribute('aria-pressed', String(button.dataset.collection === view.collection));
  resultCount.textContent = `${selected.length} 个场景`;
  empty.hidden = selected.length > 0;
  const params = galleryParams(view).toString();
  history.replaceState(null, '', `${location.pathname}${params ? `?${params}` : ''}${location.hash}`);
}

function savePosition(): void {
  try { sessionStorage.setItem('lumen-atlas:gallery-position', JSON.stringify({ view: galleryParams(view).toString(), y: scrollY })); } catch { /* 浏览不中断 */ }
}
const restorePosition = new URLSearchParams(location.search).get('restore') === '1';
render();
if (restorePosition) {
  try {
    const saved = JSON.parse(sessionStorage.getItem('lumen-atlas:gallery-position') ?? 'null');
    if (saved?.view === galleryParams(view).toString() && Number.isFinite(saved.y)) {
      requestAnimationFrame(() => scrollTo({ top: Math.max(0, saved.y), behavior: 'instant' }));
    }
  } catch { /* 首次浏览 */ }
}
window.addEventListener('pagehide', savePosition);
window.addEventListener('pageshow', () => render());
window.addEventListener('storage', () => render());
window.addEventListener('library-changed', () => render());
search.addEventListener('input', () => { view.query = search.value.slice(0, 120); render(); });
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-collection]')) button.addEventListener('click', () => { view.collection = button.dataset.collection!; render(); });
document.querySelector('#reset-filters')!.addEventListener('click', () => { view.category = 'all'; view.query = ''; view.collection = 'all'; search.value = ''; render(); });
document.querySelector('#scroll-gallery')!.addEventListener('click', () => document.querySelector('#gallery')!.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }));

/* 空间体验只在用户需要时初始化渲染器。 */
let runtime: { Stage: typeof import('./core/stage.js').Stage; AmbientAudio: typeof import('./core/audio.js').AmbientAudio; XrExplorer: typeof import('./xr/explorer.js').XrExplorer } | undefined;
let stage: Stage | undefined;
let ambient: AmbientAudio | undefined;
let explorer: XrExplorer | undefined;
let supported = false;
let starting = false;
async function loadRuntime(): Promise<void> {
  const [stageModule, audioModule, xrModule] = await Promise.all([import('./core/stage.js'), import('./core/audio.js'), import('./xr/explorer.js')]);
  runtime = { ...stageModule, ...audioModule, ...xrModule };
}
function ensureStage(): Stage {
  if (!runtime) throw new Error('空间体验尚未准备好，请重试');
  if (!stage) { stage = new runtime.Stage({ canvas }); ambient = new runtime.AmbientAudio(); ambient.attachAnalysis(stage.audio); }
  return stage;
}
function updateXRButton(): void { xrButton.disabled = !supported || starting || !!stage?.isPresenting; }

async function setupXR(): Promise<void> {
  try {
    supported = window.isSecureContext && !!navigator.xr && await navigator.xr.isSessionSupported('immersive-vr');
    if (supported) {
      await loadRuntime();
      xrChip.textContent = '支持沉浸体验';
      xrChip.classList.add('chip--ok');
      xrNote.textContent = '当前设备可进入沉浸浏览。真实空间放置是否可用，可在场景页查看。';
    } else {
      xrChip.textContent = '网页浏览';
      xrNote.textContent = window.isSecureContext ? '当前可直接在网页浏览全部场景；兼容头显可使用沉浸体验。' : '网页浏览已就绪；空间体验需要 HTTPS 链接和兼容设备。';
    }
  } catch { xrNote.textContent = '空间体验暂未就绪，仍可浏览全部场景。'; supported = false; }
  updateXRButton();
}
xrButton.addEventListener('click', async () => {
  if (!supported || starting || stage?.isPresenting) return;
  starting = true;
  updateXRButton();
  xrNote.textContent = '正在启动沉浸体验…';
  try {
    const currentStage = ensureStage();
    explorer ??= new runtime!.XrExplorer({ stage: currentStage, scenes: SCENES, thumbnails, audio: ambient, onModeChange: (_mode, scene) => { xrNote.textContent = scene ? `沉浸浏览：${scene.title}` : '沉浸浏览：场景墙'; } });
    await explorer.enter();
    document.body.classList.toggle('xr-active', currentStage.isPresenting);
  } catch (error) {
    document.body.classList.remove('xr-active');
    if (error instanceof DOMException && error.name === 'NotSupportedError') supported = false;
    xrNote.textContent = error instanceof DOMException && error.name === 'NotAllowedError' ? '未获得空间体验权限，可再次尝试；网页场景仍可正常浏览。' : '空间体验未能启动，请重试或直接浏览网页场景。';
  } finally { starting = false; updateXRButton(); }
});
window.addEventListener('xr-sessionended', () => { document.body.classList.remove('xr-active'); queueMicrotask(updateXRButton); });
window.addEventListener('stage-renderererror', () => { document.body.classList.remove('xr-active'); xrNote.textContent = '空间画面暂不可用，请刷新页面重试；网页场景索引仍可使用。'; });
void setupXR();
if (new URLSearchParams(location.search).get('wall') === '1') void loadRuntime().then(() => { const current = ensureStage(); explorer = new runtime!.XrExplorer({ stage: current, scenes: SCENES, thumbnails }); document.body.classList.add('xr-active'); current.fallbackCamera.position.set(0, 1.45, 0); current.fallbackCamera.lookAt(0, 1.45, -2.7); current.start(); explorer.showWall(); });
