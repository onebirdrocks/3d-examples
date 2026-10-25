import './styles/app.css';
import './styles/viewer.css';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SCENES, getSceneById, getSceneIndex } from './scenes/index.js';
import type { SceneDefinition } from './scenes/types.js';
import { Stage } from './core/stage.js';
import { AmbientAudio } from './core/audio.js';
import { assetUrl } from './core/loader.js';
import { BreathingGuide } from './ui/breathing-guide.js';
import { XrExplorer } from './xr/explorer.js';

const canvas = document.querySelector<HTMLCanvasElement>('#scene-canvas')!;
const titleEl = document.querySelector<HTMLElement>('#scene-title')!;
const subtitleEl = document.querySelector<HTMLElement>('#scene-subtitle')!;
const indexEl = document.querySelector<HTMLElement>('#scene-index')!;
const descEl = document.querySelector<HTMLElement>('#scene-desc')!;
const tagsEl = document.querySelector<HTMLElement>('#scene-tags')!;
const loadingEl = document.querySelector<HTMLElement>('#loading')!;
const selectEl = document.querySelector<HTMLSelectElement>('#scene-select')!;
const xrButton = document.querySelector<HTMLButtonElement>('#enter-xr')!;
const banner = document.querySelector<HTMLElement>('#xr-banner')!;
const audioCtl = document.querySelector<HTMLElement>('#audio-ctl')!;
const soundToggle = document.querySelector<HTMLButtonElement>('#sound-toggle')!;
const volumeEl = document.querySelector<HTMLInputElement>('#volume')!;

const stage = new Stage({ canvas, quality: 1 });
const audio = new AmbientAudio();
audio.attachAnalysis(stage.audio);
let controls: OrbitControls | null = null;
let explorer: XrExplorer | null = null;
let guide: BreathingGuide | null = null;
let current: SceneDefinition | null = null;
let loadToken = 0;
let soundOn = false;

// OrbitControls 需要每帧调用 update() 才能正确处理阻尼
stage.addFrameListener(() => {
  controls?.update();
  guide?.update(stage.elapsed);
});

/* ---------------- 场景选择器 ---------------- */

SCENES.forEach((def, index) => {
  const option = document.createElement('option');
  option.value = def.id;
  option.textContent = `${String(index + 1).padStart(2, '0')} · ${def.title}`;
  selectEl.append(option);
});

selectEl.addEventListener('change', () => {
  void switchTo(selectEl.value);
});

document.querySelector('#prev-scene')?.addEventListener('click', () => {
  void step(-1);
});

document.querySelector('#next-scene')?.addEventListener('click', () => {
  void step(1);
});

/* ---------------- 场景装载 ---------------- */

function updateMeta(def: SceneDefinition): void {
  const index = getSceneIndex(def.id);
  titleEl.textContent = def.title;
  subtitleEl.textContent = def.subtitle;
  indexEl.textContent = `场景 ${String(index + 1).padStart(2, '0')} / ${SCENES.length}`;
  descEl.textContent = def.description;
  selectEl.value = def.id;
  document.documentElement.style.setProperty('--accent', def.accent);

  tagsEl.replaceChildren();
  for (const tag of def.tags) {
    const item = document.createElement('li');
    item.textContent = tag;
    tagsEl.append(item);
  }
}

async function switchTo(id: string): Promise<void> {
  const def = getSceneById(id);
  if (!def) return;

  const token = ++loadToken;
  current = def;
  updateMeta(def);

  const url = new URL(location.href);
  url.searchParams.set('id', def.id);
  history.replaceState(null, '', url.toString());

  loadingEl.hidden = false;
  disposeControls();
  guide?.dispose();
  guide = null;

  // 冥想场景：呼吸引导 + 环境音
  if (def.breathing) {
    guide = new BreathingGuide(def.breathing);
    canvas.parentElement?.append(guide.element);
  }
  // 没有音乐时，音频分析回落到该场景的呼吸节奏，保证画面不会静止
  stage.audio.setFallback(def.breathing ?? null);
  applyAudioForScene(def);

  try {
    const instance = await def.create(stage.context);
    if (token !== loadToken) {
      instance.dispose();
      return;
    }
    stage.mount(instance);
    setupControls(instance.ownsCamera ?? false);
    loadingEl.hidden = true;
  } catch (error) {
    console.error('[viewer] 场景加载失败', error);
    loadingEl.hidden = true;
    descEl.textContent = `场景加载失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

/** 根据场景是否带环境音来切换播放器界面，并尝试自动播放。 */
function applyAudioForScene(def: SceneDefinition): void {
  if (!def.audio) {
    audioCtl.hidden = true;
    audio.stop();
    soundOn = false;
    updateSoundButton();
    return;
  }

  audioCtl.hidden = false;
  const source = assetUrl(`audio/${def.audio}`);

  // 自动播放通常会被浏览器拦截（要求用户手势），失败后由用户点击开关。
  void audio
    .play(source)
    .then(() => {
      soundOn = true;
      updateSoundButton();
    })
    .catch((error) => {
      console.warn('[viewer] 环境音自动播放被拦截，等待用户开启', error);
      soundOn = false;
      updateSoundButton();
    });
}

function updateSoundButton(): void {
  soundToggle.classList.toggle('is-on', soundOn);
  audioCtl.classList.toggle('is-muted', !soundOn);
  soundToggle.title = soundOn ? '关闭环境音' : '开启环境音';
}

soundToggle.addEventListener('click', async () => {
  if (!current?.audio) return;
  const source = assetUrl(`audio/${current.audio}`);
  if (soundOn) {
    audio.pause();
    soundOn = false;
  } else {
    try {
      await audio.play(source);
      soundOn = true;
    } catch (error) {
      console.warn('[viewer] 环境音播放失败', error);
    }
  }
  updateSoundButton();
});

volumeEl.addEventListener('input', () => {
  audio.setVolume(Number(volumeEl.value) / 100);
});

function step(direction: 1 | -1): void {
  if (!current) return;
  const index = getSceneIndex(current.id);
  const next = SCENES[(index + direction + SCENES.length) % SCENES.length];
  void switchTo(next.id);
}

/* ---------------- 轨道控制 ---------------- */

function setupControls(disabled: boolean): void {
  disposeControls();
  if (disabled) return;

  const instance = stage.current;
  if (!instance) return;

  controls = new OrbitControls(instance.camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.enablePan = false;
  controls.minDistance = 0.6;
  controls.maxDistance = 40;
  controls.maxPolarAngle = Math.PI * 0.92;
  controls.target.set(0, instance.framing?.targetY ?? 1.2, 0);
  controls.update();
}

function disposeControls(): void {
  controls?.dispose();
  controls = null;
}

/* ---------------- 键盘 ---------------- */

window.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    step(-1);
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    step(1);
  }
});

/* ---------------- WebXR ---------------- */

void (async () => {
  const secure = window.isSecureContext;
  const supported = secure && (await XrExplorer.isSupported());
  if (supported) return;
  xrButton.disabled = true;
  xrButton.title = secure
    ? '当前设备不支持 immersive-vr（请在 Vision Pro 的 Safari 中打开）'
    : 'WebXR 需要 HTTPS 或 localhost 环境';
})();

xrButton.addEventListener('click', async () => {
  xrButton.disabled = true;
  try {
    if (!explorer) {
      explorer = new XrExplorer({
        stage,
        scenes: SCENES,
        thumbnails: new Map(),
        onModeChange: (mode, scene) => {
          banner.textContent =
            mode === 'scene' && scene
              ? `沉浸浏览中 · ${scene.title}　（捏合选择其他场景，或点击右下角返回场景墙）`
              : '沉浸浏览中 · 场景墙　（环视四周，捏合选择场景）';
          banner.classList.add('is-visible');
        },
      });
    }
    await explorer.enter(current ?? undefined);
  } catch (error) {
    console.error('[viewer] 沉浸会话启动失败', error);
    banner.textContent = `沉浸模式启动失败：${error instanceof Error ? error.message : String(error)}`;
    banner.classList.add('is-visible');
  } finally {
    xrButton.disabled = false;
  }
});

window.addEventListener('xr-sessionended', () => {
  banner.classList.remove('is-visible');
  // 会话结束后恢复网页模式的场景与轨道控制
  if (current) void switchTo(current.id);
});

/* ---------------- 启动 ---------------- */

stage.start();
const initialId = new URLSearchParams(location.search).get('id');
void switchTo(initialId ?? SCENES[0].id);
