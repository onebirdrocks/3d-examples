import './styles/app.css';
import './styles/viewer.css';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SCENES, getSceneById, getSceneIndex } from './scenes/index.js';
import type { AudioLayerDefinition, SceneDefinition, SceneMode } from './scenes/types.js';
import { Stage } from './core/stage.js';
import { AmbientAudio } from './core/audio.js';
import { BreathingGuide } from './ui/breathing-guide.js';
import { XrExplorer } from './xr/explorer.js';
import { assetUrl } from './core/loader.js';
import { favorites, filterScenes, galleryParams, QUALITY, readGalleryView, rememberScene, save, toggleFavorite, viewPreferences } from './core/library.js';
import { ViewingSession } from './ui/viewing-session.js';

function startViewer(): void {
  const canvas = document.querySelector<HTMLCanvasElement>('#scene-canvas')!;
  const titleEl = document.querySelector<HTMLElement>('#scene-title')!;
  const subtitleEl = document.querySelector<HTMLElement>('#scene-subtitle')!;
  const indexEl = document.querySelector<HTMLElement>('#scene-index')!;
  const descEl = document.querySelector<HTMLElement>('#scene-desc')!;
  const tagsEl = document.querySelector<HTMLElement>('#scene-tags')!;
  const loadingEl = document.querySelector<HTMLElement>('#loading')!;
  const selectEl = document.querySelector<HTMLSelectElement>('#scene-select')!;
  const xrButton = document.querySelector<HTMLButtonElement>('#enter-xr')!;
  const arButton = document.querySelector<HTMLButtonElement>('#enter-ar')!;
  const xrStatus = document.querySelector<HTMLElement>('#xr-status')!;
  const arOverlay = document.querySelector<HTMLElement>('#ar-overlay')!;
  const banner = document.querySelector<HTMLElement>('#xr-banner')!;
  const audioCtl = document.querySelector<HTMLElement>('#audio-ctl')!;
  const soundToggle = document.querySelector<HTMLButtonElement>('#sound-toggle')!;
  const volumeEl = document.querySelector<HTMLInputElement>('#volume')!;
  const mixer = document.querySelector<HTMLElement>('#mixer')!;
  const mixerToggle = document.querySelector<HTMLButtonElement>('#mixer-toggle')!;
  const mixerRows = document.querySelector<HTMLElement>('#mixer-rows')!;
  const modesEl = document.querySelector<HTMLElement>('#modes')!;
  const errorPanel = document.querySelector<HTMLElement>('#viewer-error')!;
  const retryButton = document.querySelector<HTMLButtonElement>('#retry-scene')!;
  const favoriteButton = document.querySelector<HTMLButtonElement>('#favorite-scene')!;
  const settings = document.querySelector<HTMLDetailsElement>('#experience-settings')!;
  const qualitySelect = document.querySelector<HTMLSelectElement>('#quality-select')!;
  const animationToggle = document.querySelector<HTMLButtonElement>('#animation-toggle')!;
  const reducedMotion = document.querySelector<HTMLInputElement>('#reduced-motion')!;
  const backgroundAudio = document.querySelector<HTMLInputElement>('#background-audio')!;
  const durationSelect = document.querySelector<HTMLSelectElement>('#session-duration')!;
  const countdown = document.querySelector<HTMLElement>('#session-countdown')!;
  const completedPanel = document.querySelector<HTMLElement>('#session-complete')!;
  const showControls = document.querySelector<HTMLButtonElement>('#show-controls')!;
  const preferences = viewPreferences();
  const browseView = readGalleryView();
  const filteredScenes = filterScenes(SCENES, browseView);
  const sceneList = filteredScenes.length ? filteredScenes : SCENES;
  const returnParams = galleryParams(browseView);
  returnParams.set('restore', '1');
  for (const link of document.querySelectorAll<HTMLAnchorElement>('.back-link, .viewer-message a')) link.href = `./index.html?${returnParams}`;

  const stage = new Stage({ canvas, quality: QUALITY[preferences.quality] });
  const audio = new AmbientAudio();
  audio.attachAnalysis(stage.audio);
  let controls: OrbitControls | null = null;
  let explorer: XrExplorer | null = null;
  let guide: BreathingGuide | null = null;
  let current: SceneDefinition | null = null;
  let loadToken = 0;
  let soundOn = false;
  let soundEnabled = preferences.soundEnabled;
  let audioLoading = false;
  let animationPaused = false;
  let backgroundSuspended = false;
  let rendererFailed = false;
  let audioToken = 0;
  let sceneReady = false;
  let xrStarting = false;
  let capabilityChecked = false;
  const xrSupport = { vr: false, ar: false };
  let bannerTimer: number | undefined;
  const mixerVolumes = new Map<string, Record<string, number>>();
  qualitySelect.value = preferences.quality;
  reducedMotion.checked = preferences.reducedMotion ?? matchMedia('(prefers-reduced-motion: reduce)').matches;
  backgroundAudio.checked = preferences.backgroundAudio;
  volumeEl.value = String(Math.round(preferences.volume * 100));
  audio.setVolume(preferences.volume);
  stage.setSoundVolume(preferences.volume);
  stage.setSoundEnabled(soundEnabled);
  stage.setReducedMotion(reducedMotion.checked);

  const session = new ViewingSession({
    onTick: (seconds) => { countdown.textContent = seconds ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} 后结束` : ''; },
    onGain: (gain) => { audio.setSessionGain(gain); stage.setSessionGain(gain); },
    onComplete: () => {
      cancelAudioRequest();
      soundEnabled = false;
      soundOn = false;
      audio.pause();
      stage.setSoundEnabled(false);
      animationPaused = true;
      stage.setPaused(true);
      durationSelect.value = '0';
      setControlsVisible(true);
      completedPanel.hidden = false;
      updateSoundButton();
      updateAnimationButton();
      void explorer?.exit();
    },
  });

  // OrbitControls 需要每帧调用 update() 才能正确处理阻尼
  stage.addFrameListener(() => {
    controls?.update();
    guide?.update(stage.elapsed);
    // 呼吸给音乐塑形：吸气时更亮更满，呼气时收窄变柔
    audio.setBreathShape(stage.audio.breathLevel);
  });

  /* ---------------- 场景选择器 ---------------- */

  sceneList.forEach((def) => {
    const option = document.createElement('option');
    option.value = def.id;
    option.textContent = `${String(getSceneIndex(def.id) + 1).padStart(2, '0')} · ${def.title}`;
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
    if (selectEl.value !== def.id) {
      const option = new Option(def.title, def.id);
      selectEl.append(option);
      selectEl.value = def.id;
    }
    document.title = `${def.title} · Lumen Atlas`;
    updateFavorite();
    document.documentElement.style.setProperty('--accent', def.accent);

    tagsEl.replaceChildren();
    for (const tag of def.tags) {
      const item = document.createElement('li');
      item.textContent = tag;
      tagsEl.append(item);
    }
  }

  async function switchTo(id: string): Promise<void> {
    if (rendererFailed) {
      showError('3D画面需要重新打开', '请刷新页面恢复画面连接。', () => location.reload(), '刷新重试');
      return;
    }
    const def = getSceneById(id);
    const token = ++loadToken;
    errorPanel.hidden = true;
    if (!def) {
      cancelAudioRequest();
      audio.stop();
      stage.unmount();
      sceneReady = false;
      titleEl.textContent = '找不到这个场景';
      showError('场景链接已失效', '可以返回索引重新选择，或打开第一个场景。', () => void switchTo(SCENES[0].id), '打开首个场景');
      return;
    }
    const sameScene = current?.id === def.id;
    current = def;
    stage.setPaused(animationPaused);
    updateMeta(def);

    const url = new URL(location.href);
    url.searchParams.set('id', def.id);
    history.replaceState(null, '', url.toString());

    loadingEl.hidden = false;
    sceneReady = false;
    updateXRButtons();
    disposeControls();
    guide?.dispose();
    guide = null;

    // 冥想场景：呼吸引导 + 环境音
    if (def.breathing) {
      guide = new BreathingGuide(def.breathing);
      guide.element.hidden = reducedMotion.checked;
      canvas.parentElement?.append(guide.element);
    }
    // 没有音乐时，音频分析回落到该场景的呼吸节奏，保证画面不会静止
    stage.audio.setFallback(def.breathing ?? null);
    applyAudioForScene(def, sameScene);

    try {
      const instance = await def.create(stage.context);
      if (token !== loadToken) {
        instance.dispose();
        return;
      }
      stage.mount(instance, def);
      rememberScene(def.id);
      setupControls(instance.ownsCamera ?? false);
      loadingEl.hidden = true;
      sceneReady = true;
      updateXRButtons();
      updateAnimationButton();
    } catch (error) {
      if (token !== loadToken) return;
      console.warn('[viewer] 场景加载失败', error);
      cancelAudioRequest();
      audio.stop();
      stage.unmount();
      stage.spatialAudio.clear();
      showError('场景暂未加载成功', '请检查网络后重试，或选择其他场景。', () => void switchTo(def.id));
    }
  }

  function showError(title: string, description: string, retry: () => void, label = '重试'): void {
    loadingEl.hidden = true;
    sceneReady = false;
    stage.setPaused(true);
    document.querySelector('#viewer-error-title')!.textContent = title;
    document.querySelector('#viewer-error-description')!.textContent = description;
    retryButton.textContent = label;
    retryButton.onclick = retry;
    errorPanel.hidden = false;
    setControlsVisible(true);
    updateXRButtons();
  }

  /** 根据场景是否带环境音来切换播放器界面，并尝试自动播放。 */
  function applyAudioForScene(def: SceneDefinition, preserveMode: boolean): void {
    // 环境预设
    buildModes(def.modes, preserveMode ? stage.currentMode?.id : undefined);
    mixerRows.replaceChildren();
    mixer.hidden = true;
    mixerToggle.classList.remove('is-on');
    mixerToggle.setAttribute('aria-expanded', 'false');

    const layers = def.audioLayers;
    if (layers?.length) {
      // 多路图层：每路一个独立推子
      audioCtl.hidden = false;
      mixerToggle.hidden = false;
      buildMixer(def, layers);
      void playAudio(def);
      return;
    }

    mixerToggle.hidden = true;

    if (!def.audio && !def.audioPlaylist?.length) {
      audioCtl.hidden = true;
      audio.stop();
      cancelAudioRequest();
      soundOn = false;
      updateSoundButton();
      return;
    }

    audioCtl.hidden = false;
    void playAudio(def);
  }

  function cancelAudioRequest(): void {
    ++audioToken;
    audioLoading = false;
    soundToggle.removeAttribute('aria-busy');
  }

  async function playAudio(def: SceneDefinition): Promise<void> {
    const token = ++audioToken;
    soundOn = false;
    updateSoundButton();
    stage.setSoundEnabled(soundEnabled && !backgroundSuspended);
    if (!soundEnabled || backgroundSuspended) {
      audio.stop();
      return;
    }
    audioLoading = true;
    soundToggle.setAttribute('aria-busy', 'true');
    try {
      await audio.playScene(def, activeMode);
      if (token !== audioToken || current !== def) return;
      for (const [id, volume] of Object.entries(mixerVolumes.get(def.id) ?? {})) {
        audio.setLayerVolume(id, volume);
      }
      audio.applyMode(activeMode);
      soundOn = audio.isPlaying;
    } catch (error) {
      if (token !== audioToken || current !== def) return;
      console.warn('[viewer] 环境音尚未播放，点击声音按钮可重试', error);
      soundOn = false;
    }
    audioLoading = false;
    soundToggle.removeAttribute('aria-busy');
    updateSoundButton();
  }

  /** 生成分层混音推子。 */
  function buildMixer(def: SceneDefinition, layers: readonly AudioLayerDefinition[]): void {
    const volumes = mixerVolumes.get(def.id) ?? Object.fromEntries(
      layers.map((layer) => [layer.id, layer.volume ?? 0.4]),
    );
    mixerVolumes.set(def.id, volumes);
    for (const layer of layers) {
      const row = document.createElement('label');
      row.className = 'mixer__row';

      const name = document.createElement('span');
      name.className = 'mixer__name';
      name.textContent = layer.label;

      const input = document.createElement('input');
      input.type = 'range';
      input.min = '0';
      input.max = '100';
      input.value = String(Math.round(volumes[layer.id] * 100));
      input.addEventListener('input', () => {
        volumes[layer.id] = Number(input.value) / 100;
        audio.setLayerVolume(layer.id, volumes[layer.id]);
      });

      row.append(name, input);
      mixerRows.append(row);
    }
  }

  /** 生成环境预设切换（晴夜 / 雨夜）。 */
  function buildModes(modes: readonly SceneMode[] | undefined, preferredId?: string): void {
    modesEl.replaceChildren();
    if (!modes?.length) {
      modesEl.hidden = true;
      activeMode = null;
      stage.setMode(null);
      return;
    }

    modesEl.hidden = false;
    for (const mode of modes) {
      const button = document.createElement('button');
      button.className = 'mode-btn';
      button.type = 'button';
      button.textContent = mode.label;
      button.addEventListener('click', () => {
        applyMode(mode);
      });
      modesEl.append(button);
    }
    applyMode(modes.find((mode) => mode.id === preferredId) ?? modes[0]);
  }

  /** 当前生效的环境预设。 */
  let activeMode: SceneMode | null = null;

  /** 应用环境预设：同时改变画面与声音配比。 */
  function applyMode(mode: SceneMode): void {
    activeMode = mode;
    stage.setMode(mode);
    audio.applyMode(mode);

    const modes = SCENES.find((scene) => scene.id === current?.id)?.modes ?? [];
    const index = Math.max(0, modes.findIndex((item) => item.id === mode.id));
    modesEl.querySelectorAll('.mode-btn').forEach((button, i) => {
      button.classList.toggle('is-active', i === index);
      button.setAttribute('aria-pressed', String(i === index));
    });
  }

  function updateSoundButton(): void {
    soundToggle.classList.toggle('is-on', soundOn);
    audioCtl.classList.toggle('is-muted', !soundOn);
    soundToggle.title = soundOn ? '关闭环境音' : '开启环境音';
    soundToggle.setAttribute('aria-label', soundToggle.title);
    soundToggle.setAttribute('aria-pressed', String(soundOn));
  }

  soundToggle.addEventListener('click', async () => {
    if (!current?.audio && !current?.audioPlaylist?.length && !current?.audioLayers?.length) return;
    if (soundOn || audioLoading) {
      soundEnabled = false;
      cancelAudioRequest();
      audio.pause();
      soundOn = false;
      audioLoading = false;
      stage.setSoundEnabled(false);
    } else {
      soundEnabled = true;
      await playAudio(current);
    }
    preferences.soundEnabled = soundEnabled;
    save('preferences', preferences);
    updateSoundButton();
  });

  mixerToggle.addEventListener('click', () => {
    settings.open = false;
    mixer.hidden = !mixer.hidden;
    mixerToggle.classList.toggle('is-on', !mixer.hidden);
    mixerToggle.setAttribute('aria-expanded', String(!mixer.hidden));
  });

  volumeEl.addEventListener('input', () => {
    const value = Number(volumeEl.value) / 100;
    audio.setVolume(value);
    // 空间音源（场景里的定向声源）走 listener 的主音量
    stage.setSoundVolume(value);
    preferences.volume = value;
    save('preferences', preferences);
  });

  function step(direction: 1 | -1): void {
    if (!current) return;
    const index = sceneList.findIndex((scene) => scene.id === current!.id);
    const cursor = index < 0 ? (direction > 0 ? -1 : 0) : index;
    const next = sceneList[(cursor + direction + sceneList.length) % sceneList.length];
    void switchTo(next.id);
  }

  /* ---------------- 轨道控制 ---------------- */

  function setupControls(disabled: boolean): void {
    disposeControls();
    if (disabled) return;

    const instance = stage.current;
    if (!instance) return;

    controls = new OrbitControls(instance.camera, canvas);
    controls.enableDamping = !stage.visualPaused;
    controls.dampingFactor = 0.06;
    controls.enablePan = false;
    controls.minDistance = 0.6;
    controls.maxDistance = 40;
    controls.maxPolarAngle = Math.PI * 0.92;
    controls.target.set(0, instance.framing?.targetY ?? 1.2, 0);
    controls.addEventListener('change', () => { if (stage.visualPaused) stage.renderOnce(); });
    controls.update();
  }

  function disposeControls(): void {
    controls?.dispose();
    controls = null;
  }

  /* ---------------- 键盘 ---------------- */

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { setControlsVisible(true); settings.open = false; mixer.hidden = true; }
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey ||
        xrStarting || stage.isPresenting || event.composedPath().some((target) =>
          target instanceof HTMLElement &&
          (target.matches('input, textarea, select, button, a, [role="slider"]') || target.isContentEditable),
        )) return;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      step(-1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      step(1);
    }
  });

  /* ---------------- WebXR ---------------- */

  function ensureExplorer(): XrExplorer {
    if (!explorer) {
      explorer = new XrExplorer({
        stage,
        scenes: SCENES,
        thumbnails: new Map(SCENES.map((scene) => [scene.id, assetUrl(`thumbnails/${scene.id}.webp`)])),
        audio,
        audioEnabled: () => soundEnabled && !backgroundSuspended && completedPanel.hidden,
        overlayRoot: arOverlay,
        onModeChange: (mode, scene) => {
          window.clearTimeout(bannerTimer);
          if (scene) {
            current = scene;
            updateMeta(scene);
          }
          arOverlay.hidden = mode !== 'ar';
          banner.textContent =
            mode === 'scene' && scene
              ? `沉浸浏览中 · ${scene.title}　（捏合选择其他场景，或点击右下角返回场景墙）`
              : mode === 'ar'
                ? 'AR 放置模式 · 移动视线找到平面，捏合放置'
                : '沉浸浏览中 · 场景墙　（环视四周，捏合选择场景）';
          banner.classList.add('is-visible');
        },
      });
    }
    return explorer;
  }

  function updateXRButtons(): void {
    const busy = xrStarting || stage.isPresenting;
    favoriteButton.disabled = !current;
    xrButton.disabled = !xrSupport.vr || !sceneReady || busy;
    arButton.disabled = !xrSupport.ar || !sceneReady || busy;
    selectEl.disabled = busy;
    qualitySelect.disabled = busy;
    for (const button of document.querySelectorAll<HTMLButtonElement>('#prev-scene, #next-scene')) {
      button.disabled = busy;
    }
    xrButton.title = xrSupport.vr ? '进入沉浸场景' : '当前设备或浏览器不支持沉浸模式';
    arButton.title = xrSupport.ar ? '在真实表面上放置场景' : '当前设备或浏览器不支持真实空间放置';
    if (xrStarting) xrStatus.textContent = '正在启动空间体验…';
    else if (stage.isPresenting) xrStatus.textContent = '退出空间体验后可继续在网页浏览。';
    else if (!capabilityChecked) xrStatus.textContent = '正在检查空间体验支持情况…';
    else if (!window.isSecureContext) xrStatus.textContent = '空间体验需要 HTTPS 链接；当前仍可浏览场景。';
    else if (!xrSupport.vr && !xrSupport.ar) xrStatus.textContent = '当前设备或浏览器不支持空间体验，可继续浏览场景。';
    else if (!xrSupport.ar) xrStatus.textContent = '可使用沉浸模式；真实空间放置需支持 AR 的设备与浏览器。';
    else if (!xrSupport.vr) xrStatus.textContent = '可放到真实空间；当前设备不支持沉浸模式。';
    else xrStatus.textContent = '空间体验已就绪，请选择一种方式进入。';
    if (capabilityChecked && !sceneReady && !loadingEl.hidden) {
      xrStatus.textContent += ' 场景载入后即可操作。';
    }
  }

  void (async () => {
    const secure = window.isSecureContext;
    const [vr, ar] = secure
      ? await Promise.all([
          XrExplorer.isSupported('immersive-vr'),
          XrExplorer.isSupported('immersive-ar'),
        ])
      : [false, false];

    xrSupport.vr = vr;
    xrSupport.ar = ar;
    capabilityChecked = true;
    updateXRButtons();
  })();

  async function startXR(mode: 'vr' | 'ar'): Promise<void> {
    if (!xrSupport[mode] || !sceneReady || xrStarting || stage.isPresenting || !current) return;
    xrStarting = true;
    settings.open = false;
    cancelAudioRequest();
    disposeControls();
    updateXRButtons();
    try {
      if (mode === 'ar') await ensureExplorer().enterAr(current);
      else await ensureExplorer().enter(current);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotSupportedError') {
        xrSupport[mode] = false;
      }
      const reason = error instanceof DOMException && error.name === 'NotAllowedError'
        ? '未获得权限，请允许浏览器打开空间体验后重试。'
        : error instanceof DOMException && error.name === 'NotSupportedError'
          ? '当前设备或浏览器不支持此体验，可选择其他方式浏览。'
          : '启动未完成，请重试。';
      console.warn('[viewer] 空间体验启动失败', error);
      banner.textContent = `${mode === 'ar' ? '真实空间放置' : '沉浸模式'}：${reason}`;
      banner.classList.add('is-visible');
      window.clearTimeout(bannerTimer);
      bannerTimer = window.setTimeout(() => banner.classList.remove('is-visible'), 7000);
      if (stage.current) setupControls(stage.current.ownsCamera ?? false);
    } finally {
      xrStarting = false;
      updateXRButtons();
    }
  }

  xrButton.addEventListener('click', () => void startXR('vr'));
  arButton.addEventListener('click', () => void startXR('ar'));

  window.addEventListener('xr-sessionended', () => {
    window.clearTimeout(bannerTimer);
    arOverlay.hidden = true;
    banner.classList.remove('is-visible');
    // 会话结束后恢复网页模式的场景与轨道控制
    if (current) void switchTo(current.id);
    updateXRButtons();
  });

  /* ---------------- 持续使用与体验设置 ---------------- */

  function updateFavorite(): void {
    const enabled = !!current && favorites().includes(current.id);
    favoriteButton.textContent = enabled ? '已收藏' : '收藏场景';
    favoriteButton.setAttribute('aria-pressed', String(enabled));
    favoriteButton.disabled = !current;
  }
  favoriteButton.addEventListener('click', () => { if (current) { toggleFavorite(current.id); updateFavorite(); } });
  window.addEventListener('storage', updateFavorite);

  function updateAnimationButton(): void {
    animationToggle.textContent = animationPaused ? '继续画面' : '暂停画面';
    animationToggle.setAttribute('aria-pressed', String(animationPaused));
    if (controls) controls.enableDamping = !stage.visualPaused;
  }
  animationToggle.addEventListener('click', () => { animationPaused = !animationPaused; stage.setPaused(animationPaused); updateAnimationButton(); });
  qualitySelect.addEventListener('change', () => {
    preferences.quality = qualitySelect.value as typeof preferences.quality;
    save('preferences', preferences);
    stage.setQuality(QUALITY[preferences.quality]);
    if (current) void switchTo(current.id);
  });
  reducedMotion.addEventListener('change', () => {
    preferences.reducedMotion = reducedMotion.checked;
    save('preferences', preferences);
    stage.setReducedMotion(reducedMotion.checked);
    if (guide) guide.element.hidden = reducedMotion.checked;
    updateAnimationButton();
  });
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (event) => {
    if (preferences.reducedMotion !== undefined) return;
    reducedMotion.checked = event.matches;
    stage.setReducedMotion(event.matches);
    if (guide) guide.element.hidden = event.matches;
    updateAnimationButton();
  });
  function syncBackgroundAudio(): void {
    session.update();
    const suspended = document.hidden && !preferences.backgroundAudio;
    if (backgroundSuspended === suspended) return;
    backgroundSuspended = suspended;
    stage.setSoundEnabled(soundEnabled && !suspended);
    if (suspended) { ++audioToken; audio.pause(); soundOn = false; updateSoundButton(); }
    else if (soundEnabled && current) void playAudio(current);
  }
  backgroundAudio.addEventListener('change', () => { preferences.backgroundAudio = backgroundAudio.checked; save('preferences', preferences); syncBackgroundAudio(); });
  document.addEventListener('visibilitychange', syncBackgroundAudio);
  durationSelect.addEventListener('change', () => {
    if (!completedPanel.hidden && Number(durationSelect.value) > 0) continueExperience();
    session.start(Number(durationSelect.value));
  });
  function continueExperience(): void {
    session.cancel();
    completedPanel.hidden = true;
    animationPaused = false;
    stage.setPaused(false);
    soundEnabled = preferences.soundEnabled;
    if (current) void playAudio(current);
    updateAnimationButton();
  }
  document.querySelector('#continue-session')!.addEventListener('click', continueExperience);
  settings.addEventListener('toggle', () => { if (settings.open) { mixer.hidden = true; mixerToggle.setAttribute('aria-expanded', 'false'); } });
  document.querySelector('#close-settings')!.addEventListener('click', () => { settings.open = false; settings.querySelector('summary')?.focus(); });
  function setControlsVisible(visible: boolean): void {
    document.querySelector('.viewer')!.classList.toggle('controls-hidden', !visible);
    showControls.hidden = visible;
    if (!visible) { settings.open = false; mixer.hidden = true; showControls.focus(); }
  }
  document.querySelector('#hide-controls')!.addEventListener('click', () => setControlsVisible(false));
  showControls.addEventListener('click', () => setControlsVisible(true));
  let pointerStart = { x: 0, y: 0 };
  canvas.addEventListener('pointerdown', (event) => { pointerStart = { x: event.clientX, y: event.clientY }; });
  canvas.addEventListener('pointerup', (event) => { if (Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) < 6) setControlsVisible(true); });
  window.addEventListener('stage-renderererror', () => { rendererFailed = true; showError('3D画面需要重新打开', '画面连接已中断，刷新后可恢复；收藏和偏好会保留。', () => location.reload(), '刷新重试'); });
  window.addEventListener('stage-sceneerror', () => { if (!rendererFailed && current) { stage.unmount(); showError('场景运行遇到问题', '可以重新加载当前场景，或返回索引选择其他场景。', () => void switchTo(current!.id)); } });
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) { audio.pause(); stage.setSoundEnabled(false); stage.stop(); }
    else { session.cancel(); audio.stop(); stage.dispose(); }
  });
  window.addEventListener('pageshow', (event) => { if (event.persisted) { stage.start(); session.update(); if (current && soundEnabled) void playAudio(current); } });

  /* ---------------- 启动 ---------------- */

  stage.start();
  const initialId = new URLSearchParams(location.search).get('id');
  void switchTo(initialId ?? SCENES[0].id);

}

try { startViewer(); } catch (error) {
  console.warn('[viewer] 初始化未完成', error);
  document.querySelector<HTMLElement>('#loading')!.hidden = true;
  document.querySelector<HTMLElement>('#viewer-error')!.hidden = false;
  document.querySelector('#scene-title')!.textContent = '场景暂不可用';
  document.querySelector('#viewer-error-title')!.textContent = '暂时无法显示场景';
  document.querySelector('#viewer-error-description')!.textContent = '当前浏览器未能开启3D画面。可以刷新重试，或返回索引浏览其他场景。';
  document.querySelector<HTMLButtonElement>('#retry-scene')!.onclick = () => location.reload();
}
