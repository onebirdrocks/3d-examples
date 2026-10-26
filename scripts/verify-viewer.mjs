#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const executablePath = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(existsSync);
assert.ok(executablePath, '需要已有的 Chrome / Chromium，不自动下载浏览器');

// 小型可解码音频，验证播放状态和循环行为，无需下载实际配乐。
const wav = Buffer.alloc(44 + 16000 * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8);
wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
wav.writeUInt32LE(wav.length - 44, 40);

const server = await createServer({
  root, logLevel: 'error', server: { host: '127.0.0.1', port: 0, open: false },
});
let browser;
try {
  await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ executablePath, args: [
    '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
  ] });
  const errors = [];

  async function openScene(supported, id = 'breathing') {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('**/audio/**', (route) => route.fulfill({ contentType: 'audio/wav', body: wav }));
    await page.addInitScript((support) => {
      Object.defineProperty(navigator, 'xr', { configurable: true, value: {
        isSessionSupported: async (mode) => support[mode],
        requestSession: async () => { throw new DOMException('Permission denied', 'NotAllowedError'); },
      } });
    }, supported);
    await page.goto(`${base}/scene.html?id=${id}`, { waitUntil: 'networkidle' });
    await page.locator('#loading').waitFor({ state: 'hidden' });
    return page;
  }

  for (const [vr, ar] of [[false, false], [true, false], [false, true], [true, true]]) {
    const page = await openScene({ 'immersive-vr': vr, 'immersive-ar': ar });
    assert.equal(await page.locator('#enter-xr').isEnabled(), vr);
    assert.equal(await page.locator('#enter-ar').isEnabled(), ar);
    assert.ok((await page.locator('#xr-status').innerText()).length);
    await page.close();
  }
  console.log('✓ 四种设备能力组合与按钮状态');

  const page = await openScene({ 'immersive-vr': true, 'immersive-ar': true });
  await page.locator('#enter-xr').click();
  await page.waitForFunction(() => document.querySelector('#xr-banner').textContent.includes('未获得权限'));
  assert.equal(await page.locator('#enter-xr').isEnabled(), true);
  assert.equal(await page.locator('#enter-ar').isEnabled(), true);
  await page.evaluate(() => {
    navigator.xr.requestSession = async () => { throw new DOMException('Unsupported', 'NotSupportedError'); };
  });
  await page.locator('#enter-ar').click();
  await page.waitForFunction(() => document.querySelector('#enter-ar').disabled);
  assert.equal(await page.locator('#enter-xr').isEnabled(), true);
  console.log('✓ 权限拒绝后可重试；不支持 AR 时仍可进入 VR');

  await page.locator('#volume').focus();
  await page.locator('#volume').press('ArrowLeft');
  assert.equal(new URL(page.url()).searchParams.get('id'), 'breathing');
  assert.equal(await page.locator('#volume').inputValue(), '54');
  await page.locator('#scene-select').focus();
  assert.equal(await page.locator('#scene-select').evaluate((element) => {
    const event = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  }), false);
  assert.equal(new URL(page.url()).searchParams.get('id'), 'breathing');
  await page.locator('#scene-title').click();
  await page.keyboard.press('ArrowRight');
  assert.notEqual(new URL(page.url()).searchParams.get('id'), 'breathing');
  await page.locator('#loading').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#mixer-toggle').isVisible(), false);
  console.log('✓ 控件保留原生方向键操作；场景快捷键与隐藏混音入口');

  const screenshotDir = process.env.VIEWER_SCREENSHOTS;
  if (screenshotDir) await mkdir(resolve(screenshotDir), { recursive: true });
  for (const [width, height] of [[320, 740], [390, 844], [768, 1024], [844, 390], [1280, 800]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(200);
    const overflow = await page.evaluate(() => {
      const selectors = ['.back-link', '#scene-title', '.viewer__heading', '#enter-xr', '#enter-ar', '#xr-status', '.viewer__nav'];
      return selectors.filter((selector) => {
        const box = document.querySelector(selector).getBoundingClientRect();
        return box.left < -1 || box.right > innerWidth + 1 || box.bottom > innerHeight + 1;
      });
    });
    assert.deepEqual(overflow, [], `${width}×${height} 不应有控件溢出`);
    if (screenshotDir && [390, 1280].includes(width)) {
      await page.screenshot({ path: resolve(screenshotDir, `viewer-${width}.png`) });
    }
  }
  await page.close();
  console.log('✓ 五种桌面、平板、手机横竖屏尺寸');

  const garden = await openScene({ 'immersive-vr': false, 'immersive-ar': false }, 'moonlight-garden');
  await garden.waitForFunction(() => document.querySelector('#sound-toggle').getAttribute('aria-pressed') === 'true');
  await garden.locator('#mixer-toggle').click();
  await garden.locator('#mixer-rows input').first().fill('23');
  await garden.locator('#mixer-rows input').first().dispatchEvent('input');
  await garden.getByRole('button', { name: '雨夜', exact: true }).click();
  await garden.locator('#sound-toggle').click();
  assert.equal(await garden.locator('#sound-toggle').getAttribute('aria-pressed'), 'false');
  await garden.waitForTimeout(2200);
  assert.equal(await garden.locator('#sound-toggle').getAttribute('aria-pressed'), 'false');
  await garden.evaluate(() => window.dispatchEvent(new Event('xr-sessionended')));
  await garden.locator('#loading').waitFor({ state: 'hidden' });
  assert.equal(await garden.locator('#sound-toggle').getAttribute('aria-pressed'), 'false');
  assert.equal(await garden.getByRole('button', { name: '雨夜', exact: true }).getAttribute('aria-pressed'), 'true');
  await garden.locator('#sound-toggle').click();
  await garden.waitForFunction(() => document.querySelector('#sound-toggle').getAttribute('aria-pressed') === 'true');
  assert.equal(await garden.locator('#mixer-rows input').first().inputValue(), '23');
  assert.equal(await garden.getByRole('button', { name: '雨夜', exact: true }).getAttribute('aria-pressed'), 'true');
  await garden.locator('#mixer-toggle').click();
  if (screenshotDir) {
    await garden.setViewportSize({ width: 390, height: 844 });
    await garden.screenshot({ path: resolve(screenshotDir, 'garden-mobile.png') });
  }
  await garden.close();
  console.log('✓ 月夜庭院分层音轨暂停、恢复、推子与天气状态');

  const probe = await browser.newPage();
  probe.on('pageerror', (error) => errors.push(error.message));
  await probe.route(`${base}/__viewer-probe`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Viewer regression</title>' }));
  await probe.route('**/audio/**', (route) => route.fulfill({ contentType: 'audio/wav', body: wav }));
  await probe.goto(`${base}/__viewer-probe`);
  const audioResults = await probe.evaluate(async () => {
    const { AmbientAudio } = await import('/src/core/audio.ts');
    const audio = new AmbientAudio({ crossfade: 0.1, fadeIn: 0.1 });
    const def = { audioLayers: [{ id: 'wind', label: '风', urls: ['fixture.mp3'], volume: 0.4 }] };
    await audio.playScene(def);
    const initial = audio.isPlaying;
    audio.setLayerVolume('wind', 0.23);
    audio.pause();
    await new Promise((r) => setTimeout(r, 2200));
    const paused = !audio.isPlaying;
    await audio.playScene(def);
    const resumed = audio.isPlaying && audio.getLayerVolumes().wind === 0.23;
    await audio.playScene({ audio: 'single.mp3' });
    audio.pause();
    await audio.playScene({ audio: 'single.mp3' });
    const singleResumed = audio.isPlaying;
    audio.stop();
    return { initial, paused, resumed, singleResumed, stopped: !audio.isPlaying };
  });
  assert.ok(Object.values(audioResults).every(Boolean), JSON.stringify(audioResults));
  console.log('✓ 音频实际解码、循环暂停、单曲恢复与停止');

  let delayedRoute;
  let notifyRequest;
  const delayedRequest = new Promise((resolveRequest) => { notifyRequest = resolveRequest; });
  await probe.route('**/audio/delayed.mp3', (route) => { delayedRoute = route; notifyRequest(); });
  await probe.evaluate(async () => {
    const { AmbientAudio } = await import('/src/core/audio.ts');
    window.delayedAudio = new AmbientAudio();
    window.delayedPlayback = window.delayedAudio.playScene({ audio: 'delayed.mp3' });
  });
  await delayedRequest;
  await probe.evaluate(() => window.delayedAudio.stop());
  await delayedRoute.fulfill({ contentType: 'audio/wav', body: wav });
  assert.equal(await probe.evaluate(async () => {
    await window.delayedPlayback;
    return !window.delayedAudio.isPlaying && Object.keys(window.delayedAudio.getLayerVolumes()).length === 0;
  }), true);
  console.log('✓ 停止后迟到的音频加载不会重新播放');

  const xrResults = await probe.evaluate(async () => {
    const { XrExplorer } = await import('/src/xr/explorer.ts');
    const THREE = await import('/node_modules/.vite/deps/three.js');
    const results = {};
    let listener, session, cancelCount = 0, disposeCount = 0;
    const hands = [new THREE.Group(), new THREE.Group()];
    const matrix = new THREE.Matrix4().makeTranslation(1, 0.5, -2).toArray();
    const frame = { getHitTestResults: () => [{ getPose: () => ({ transform: { matrix } }) }] };
    const xr = Object.assign(new THREE.EventDispatcher(), {
      isPresenting: false, setReferenceSpaceType() {},
      async setSession() { this.isPresenting = true; },
      getHand: (index) => hands[index], getFrame: () => frame, getReferenceSpace: () => ({}),
    });
    const hostScene = new THREE.Scene();
    const stage = {
      renderer: { xr }, hostScene, current: null, context: {}, currentMode: null,
      audio: { setFallback() {} }, addFrameListener(fn) { listener = fn; },
      setXRActive() {}, setManualPlacement() {}, setMode(mode) { this.currentMode = mode; }, start() {},
      mount(instance) { this.unmount(); this.current = instance; hostScene.add(instance.root); },
      unmount() { this.current?.root.removeFromParent(); this.current?.dispose(); this.current = null; },
    };
    function makeSession() {
      const value = Object.assign(new EventTarget(), {
        enabledFeatures: [], requestReferenceSpace: async () => ({}),
        requestHitTestSource: async () => ({ cancel() { cancelCount++; } }),
        async end() { xr.isPresenting = false; this.dispatchEvent(new Event('end')); },
      });
      return value;
    }
    Object.defineProperty(navigator, 'xr', { configurable: true, value: {
      async requestSession() { session = makeSession(); return session; },
    } });
    const def = { id: 'fixture', title: 'Fixture', async create() { return {
      root: new THREE.Group(), camera: new THREE.PerspectiveCamera(), update() {},
      dispose() { disposeCount++; },
    }; } };
    const modes = [];
    const audioCalls = [];
    const explorer = new XrExplorer({ stage, scenes: [], thumbnails: new Map(),
      onModeChange: (mode) => modes.push(mode),
      audio: { stop() {}, async playScene(scene) { audioCalls.push(scene.id); } },
    });
    await explorer.enterAr(def);
    listener(0, 0.5);
    await new Promise((r) => setTimeout(r, 0));
    results.arMode = modes.at(-1) === 'ar';
    results.hiddenBeforePlacement = stage.current?.root.visible === false;
    session.dispatchEvent(new Event('select'));
    results.placed = stage.current?.root.visible && stage.current.root.position.equals(new THREE.Vector3(1, 0.5, -2));
    results.audio = audioCalls.includes('fixture');
    await explorer.exit();
    results.cleaned = hostScene.children.length === 0 && hands.every((hand) => hand.children.length === 0) && cancelCount === 1 && disposeCount === 1;

    const pending = { ...def, create: () => new Promise((resolve) => { window.finishScene = resolve; }) };
    await explorer.enterAr(pending);
    listener(0, 0.5);
    await explorer.exit();
    window.finishScene(await def.create());
    await new Promise((r) => setTimeout(r, 0));
    results.lateSceneDisposed = stage.current === null && disposeCount === 2 && hostScene.children.length === 0;

    navigator.xr.requestSession = async () => {
      session = makeSession();
      session.requestHitTestSource = async () => { throw new DOMException('Unavailable', 'NotSupportedError'); };
      return session;
    };
    try { await explorer.enterAr(def); } catch (error) { results.setupFailure = error.name === 'NotSupportedError'; }
    results.failureCleaned = !xr.isPresenting && hostScene.children.length === 0 && hands.every((hand) => hand.children.length === 0);
    navigator.xr.requestSession = async () => { session = makeSession(); return session; };
    await explorer.enter(def);
    listener(0, 0.5);
    await new Promise((r) => setTimeout(r, 0));
    results.vrMode = modes.at(-1) === 'scene' && stage.current !== null;
    await explorer.exit();
    let muted = false;
    const mutedExplorer = new XrExplorer({ stage, scenes: [], thumbnails: new Map(),
      audioEnabled: () => false,
      audio: { pause() { muted = true; }, playScene() { throw new Error('不应启动已静音的音频'); } },
    });
    await mutedExplorer.playSceneAudio(def);
    results.mutePreserved = muted;
    return results;
  });
  assert.ok(Object.values(xrResults).every(Boolean), JSON.stringify(xrResults));
  assert.equal(Object.keys(xrResults).length, 10);
  await probe.close();
  assert.deepEqual(errors, []);
  console.log('✓ 模拟 XR 的 AR 放置、分层音频调用、重复会话与失败/延迟加载清理');
  console.log('全部交互回归检查通过（XR 为模拟接口，不代表头显实测）');
} finally {
  await browser?.close();
  await server.close();
}
