#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const executablePath = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
assert.ok(executablePath, '需要已有 Chrome / Chromium，不自动下载');
const server = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
const screenshots = process.env.FLAPPY_SCREENSHOTS;
let browser;
try {
  await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ executablePath, args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  if (screenshots) await mkdir(screenshots, { recursive: true });

  await page.goto(`${base}/scene.html?id=flappy-bird`, { waitUntil: 'networkidle' });
  await page.locator('#loading').waitFor({ state: 'hidden' });
  if (screenshots) await page.screenshot({ path: resolve(screenshots, 'flappy-ready.png') });
  const physics = await page.evaluate(async () => {
    const { FlappyFlight, FLIGHT } = await import('/src/scenes/games/flappy-model.ts');
    const results = {};
    const frames = [60, 90, 120].map((hz) => {
      const model = new FlappyFlight(() => 0.5); model.action();
      for (let i = 0; i < hz / 2; i++) model.advance(1 / hz);
      return [model.y, model.velocity, model.pipes[0].x, model.distance];
    });
    results.refreshRates = frames.every((values) => values.every((value, i) => Math.abs(value - frames[0][i]) < 1e-9));
    const paused = new FlappyFlight(() => 0.5); paused.action(); paused.advance(0.1); paused.pause();
    const before = JSON.stringify([paused.y, paused.velocity, paused.pipes, paused.distance]);
    paused.advance(30);
    results.pauseFreezes = paused.phase === 'paused' && before === JSON.stringify([paused.y, paused.velocity, paused.pipes, paused.distance]);
    paused.action(); results.resume = paused.phase === 'playing' && paused.velocity === FLIGHT.impulse;
    const scoring = new FlappyFlight(() => 0.5); scoring.action(); scoring.pipes[0].x = -1.2;
    scoring.advance(1 / 60); scoring.advance(1 / 60);
    results.singleScore = scoring.score === 1;
    const collision = new FlappyFlight(() => 0.5); collision.action(); collision.pipes[0].x = FLIGHT.birdX; collision.pipes[0].center = 0.9;
    collision.advance(1 / 60);
    results.pipeCollision = collision.phase === 'over' && collision.score === 0;
    results.restartGuard = !collision.action();
    for (let i = 0; i < 7; i++) collision.advance(0.1);
    results.restart = collision.action() && collision.phase === 'playing' && collision.score === 0 && collision.pipes[0].x === 1.55;
    const falling = new FlappyFlight(() => 0.5); falling.action();
    for (let i = 0; i < 180; i++) falling.advance(1 / 60);
    results.floorCollision = falling.phase === 'over' && falling.y >= FLIGHT.bottom + FLIGHT.radius;
    const ceiling = new FlappyFlight(() => 0.5); ceiling.action(); ceiling.y = FLIGHT.top - FLIGHT.radius - 0.001; ceiling.advance(1 / 60);
    results.ceilingCollision = ceiling.phase === 'over';
    const recycling = new FlappyFlight(() => 1); recycling.action();
    recycling.pipes[0].x = -3; recycling.pipes[0].passed = true;
    recycling.advance(1 / 60);
    results.boundedPool = recycling.pipes.length === 4 && recycling.pipes[0].x > recycling.pipes[3].x && recycling.pipes.every((pipe) => pipe.center >= 1.16 && pipe.center <= 1.94);
    return results;
  });
  assert.ok(Object.values(physics).every(Boolean), JSON.stringify(physics));
  console.log('✓ 固定步长、暂停恢复、单次计分、管道/天地碰撞、重开保护与障碍复用');

  const hud = page.locator('.flappy-controls');
  await page.getByRole('button', { name: '开始飞行', exact: true }).click();
  if (screenshots) await page.screenshot({ path: resolve(screenshots, 'flappy-playing.png') });
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  assert.equal(await hud.getAttribute('data-phase'), 'paused');
  await page.waitForTimeout(700);
  assert.equal(await hud.getAttribute('data-phase'), 'paused');
  await page.getByRole('button', { name: '继续飞行', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.flappy-controls').dataset.phase === 'over');
  await page.waitForTimeout(750);
  await page.locator('#scene-canvas').click({ position: { x: 500, y: 350 } });
  assert.equal(await hud.getAttribute('data-phase'), 'playing');
  await page.locator('#scene-title').click();
  await page.keyboard.press('KeyP');
  assert.equal(await hud.getAttribute('data-phase'), 'paused');
  await page.keyboard.press('Space');
  assert.equal(await hud.getAttribute('data-phase'), 'playing');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  assert.equal(await hud.getAttribute('data-phase'), 'paused');
  console.log('✓ 按钮、轻点、空格、P 暂停、失败重开与失焦暂停');

  for (const [width, height] of [[320, 740], [390, 844], [768, 1024], [844, 390], [1280, 900]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(100);
    const fits = await page.evaluate(() => {
      const panel = document.querySelector('.flappy-controls').getBoundingClientRect();
      const nav = document.querySelector('.viewer__nav').getBoundingClientRect();
      return panel.left >= 0 && panel.right <= innerWidth && panel.top >= 0 && panel.bottom <= nav.top && panel.bottom <= innerHeight;
    });
    assert.ok(fits, `${width}×${height} 游戏操作不溢出或覆盖导航`);
    if (screenshots) await page.screenshot({ path: resolve(screenshots, `flappy-${width}.png`) });
  }
  await page.locator('#next-scene').click();
  await page.locator('#loading').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.flappy-controls').count(), 0);
  await page.goto(`${base}/scene.html?id=flappy-bird`, { waitUntil: 'networkidle' });
  assert.equal(await hud.count(), 1);
  assert.equal(await hud.getAttribute('data-phase'), 'ready');
  console.log('✓ 五种屏幕尺寸、切换场景时清理与重入');

  const viewToggle = page.getByRole('button', { name: '第一人称视角', exact: true });
  await page.getByRole('button', { name: '开始飞行', exact: true }).click();
  await viewToggle.click();
  assert.equal(await hud.getAttribute('data-view'), 'first-person');
  assert.equal(await hud.getAttribute('data-phase'), 'paused');
  assert.equal(await viewToggle.getAttribute('aria-pressed'), 'true');
  for (const [width, height] of [[320, 740], [390, 844], [844, 390], [1280, 900]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(100);
    assert.ok(await page.evaluate(() => {
      const box = document.querySelector('.flappy-controls').getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth;
    }), `第一人称 ${width}×${height} 操作布局`);
    if (screenshots) await page.screenshot({ path: resolve(screenshots, `flappy-first-person-${width}.png`) });
  }
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await hud.getAttribute('data-view'), 'first-person');
  await page.getByRole('button', { name: '开始飞行', exact: true }).click();
  if (screenshots) await page.screenshot({ path: resolve(screenshots, 'flappy-first-person-playing.png') });
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.locator('#scene-title').click(); await page.keyboard.press('KeyV');
  assert.equal(await hud.getAttribute('data-view'), 'side');
  assert.equal(await hud.getAttribute('data-phase'), 'paused');
  await page.reload({ waitUntil: 'networkidle' });
  console.log('✓ 第一人称/侧视切换先暂停、视角持久化、V 快捷键和两种视角布局');

  await page.locator('#experience-settings summary').click();
  await page.locator('#animation-toggle').click();
  assert.equal(await page.getByRole('button', { name: '开始飞行', exact: true }).isEnabled(), false);
  await page.locator('#animation-toggle').click();
  await page.waitForFunction(() => !document.querySelector('.flappy-action').disabled);
  await page.locator('#reduced-motion').check();
  await page.locator('#close-settings').click();
  await page.getByRole('button', { name: '开始飞行', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.flappy-controls').dataset.phase === 'over');
  await page.evaluate(() => localStorage.setItem('lumen-atlas:flappy-bird:best', '"invalid"'));
  await page.reload({ waitUntil: 'networkidle' });
  assert.ok((await page.locator('.flappy-status').innerText()).endsWith('最高 0'));
  await page.evaluate(() => localStorage.setItem('lumen-atlas:flappy-bird:best', '12'));
  await page.reload({ waitUntil: 'networkidle' });
  assert.ok((await page.locator('.flappy-status').innerText()).endsWith('最高 12'));
  console.log('✓ 减少动态仍可游玩，最高分读取与无效数据恢复');

  const earnedBest = await page.evaluate(async () => {
    const { Stage } = await import('/src/core/stage.ts');
    const definition = (await import('/src/scenes/games/flappy-bird.ts')).default;
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 400;
    const previousRandom = Math.random;
    const previousView = localStorage.getItem('lumen-atlas:flappy-bird:view');
    let stage;
    try {
      localStorage.removeItem('lumen-atlas:flappy-bird:best');
      localStorage.setItem('lumen-atlas:flappy-bird:view', JSON.stringify('first-person'));
      Math.random = () => 0.5;
      stage = new Stage({ canvas });
      const instance = await definition.create(stage.context); stage.mount(instance, definition);
      const firstGate = instance.root.getObjectByName('flappy-flight-gate-0');
      const initialDepth = firstGate.position.z;
      let forwardMotion = false;
      instance.onAction();
      for (let i = 0; i < 600; i++) {
        instance.update(i / 120, 1 / 120, stage.context);
        if ((i + 1) % 100 === 0) instance.onAction();
        if (i === 99) forwardMotion = firstGate.position.z > initialDepth;
      }
      return { best: Number(localStorage.getItem('lumen-atlas:flappy-bird:best')), forwardMotion,
        levelCamera: instance.camera.quaternion.equals(new (await import('/node_modules/.vite/deps/three.js')).Quaternion()) };
    } finally {
      Math.random = previousRandom; stage?.dispose();
      if (previousView === null) localStorage.removeItem('lumen-atlas:flappy-bird:view'); else localStorage.setItem('lumen-atlas:flappy-bird:view', previousView);
    }
  });
  assert.ok(earnedBest.best >= 2 && earnedBest.forwardMotion && earnedBest.levelCamera, `第一人称实际飞行和计分 ${JSON.stringify(earnedBest)}`);
  await page.reload({ waitUntil: 'networkidle' });
  assert.ok((await page.locator('.flappy-status').innerText()).endsWith(`最高 ${earnedBest.best}`));
  console.log('✓ 第一人称障碍迎面靠近、保持镜头水平、飞过两对管道后刷新保留最高分');

  const firstPerson = await page.evaluate(async () => {
    const definition = (await import('/src/scenes/games/flappy-bird.ts')).default;
    const THREE = await import('/node_modules/.vite/deps/three.js');
    const previousView = localStorage.getItem('lumen-atlas:flappy-bird:view');
    localStorage.setItem('lumen-atlas:flappy-bird:view', JSON.stringify('first-person'));
    const tracked = new THREE.ArrayCamera([new THREE.PerspectiveCamera()]);
    tracked.position.set(0.1, 1.72, 0.2); tracked.updateMatrixWorld(true);
    const canvas = document.createElement('canvas');
    const context = { isXR: true, width: 1280, height: 900,
      renderer: { domElement: canvas, xr: { getSession: () => ({ environmentBlendMode: 'opaque', visibilityState: 'visible' }), getCamera: () => tracked } } };
    const instance = await definition.create(context);
    const corridor = instance.root.getObjectByName('flappy-first-person-world');
    const side = instance.root.getObjectByName('flappy-side-view');
    const gate = instance.root.getObjectByName('flappy-flight-gate-0');
    const results = { immersiveOrigin: instance.immersive && instance.root.position.length() === 0,
      forwardDepth: corridor.visible && !side.visible && gate.position.z < -10,
      eyeHeight: Math.abs(corridor.position.y + 1.55 * 3 - tracked.position.y) < 1e-8 };
    const position = new THREE.Vector3(0.2, 1.8, 0.3), rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.12, 0.3, 0.17));
    instance.camera.position.copy(position); instance.camera.quaternion.copy(rotation);
    instance.update(0, 0, context);
    results.naturalTracking = instance.camera.position.equals(position) && instance.camera.quaternion.equals(rotation);
    function selectControl(name) {
      instance.root.updateWorldMatrix(true, true);
      const target = instance.root.getObjectByName(name).getWorldPosition(new THREE.Vector3());
      const origin = instance.camera.getWorldPosition(new THREE.Vector3());
      instance.onAction(new THREE.Ray(origin, target.sub(origin).normalize()));
    }
    selectControl('flappy-view-first-person');
    results.xrViewSwitch = side.visible && !corridor.visible;
    selectControl('flappy-view-side');
    results.xrSwitchBack = corridor.visible && !side.visible;
    const hud = instance.camera.getObjectByName('flappy-first-person-hud');
    const message = hud.children.find((mesh) => mesh.geometry?.parameters.width === 2.8);
    results.switchDoesNotFlap = message.visible;
    instance.onAction(); selectControl('flappy-pause-first-person');
    results.xrPause = message.visible;
    instance.onAction();
    results.xrResume = !message.visible;
    instance.dispose();
    instance.onAction();
    const arContext = { ...context, renderer: { domElement: canvas, xr: { ...context.renderer.xr, getSession: () => ({ environmentBlendMode: 'alpha-blend', visibilityState: 'visible' }) } } };
    const ar = await definition.create(arContext);
    results.arKeepsBoard = ar.root.getObjectByName('flappy-side-view').visible && ar.camera.parent === null;
    ar.dispose();
    if (previousView === null) localStorage.removeItem('lumen-atlas:flappy-bird:view'); else localStorage.setItem('lumen-atlas:flappy-bird:view', previousView);
    return results;
  });
  assert.ok(Object.values(firstPerson).every(Boolean), JSON.stringify(firstPerson));
  console.log('✓ 第一人称纵深和眼高、保留头部姿态、空间按钮切换/暂停/恢复与 AR 侧视回退');

  const xrResults = await page.evaluate(async () => {
    const { XrExplorer } = await import('/src/xr/explorer.ts');
    const THREE = await import('/node_modules/.vite/deps/three.js');
    let listener, session, actions = 0, lastActionRay;
    const hands = [new THREE.Group(), new THREE.Group()];
    const identity = new THREE.Matrix4().toArray();
    let ray = identity;
    const frame = { getPose: () => ({ transform: { matrix: ray } }) };
    const xr = { isPresenting: false, setReferenceSpaceType() {}, async setSession() { this.isPresenting = true; }, getHand: (i) => hands[i], getFrame: () => frame, getReferenceSpace: () => ({}) };
    const hostScene = new THREE.Scene();
    const stage = { renderer: { xr }, hostScene, context: {}, current: null, currentMode: null,
      audio: { setFallback() {} }, addFrameListener(fn) { listener = fn; }, setXRActive() {}, setManualPlacement() {}, setMode() {}, start() {},
      mount(instance) { this.unmount(); this.current = instance; hostScene.add(instance.root); },
      unmount() { this.current?.root.removeFromParent(); this.current?.dispose(); this.current = null; } };
    Object.defineProperty(navigator, 'xr', { configurable: true, value: { async requestSession() {
      session = Object.assign(new EventTarget(), { enabledFeatures: [], visibilityState: 'visible', async end() { xr.isPresenting = false; this.dispatchEvent(new Event('end')); } }); return session;
    } } });
    const definition = { id: 'game-fixture', title: 'Game', create() { return { root: new THREE.Group(), camera: new THREE.PerspectiveCamera(), update() {}, dispose() {}, onAction(ray) { actions++; lastActionRay = ray?.clone(); } }; } };
    const explorer = new XrExplorer({ stage, scenes: [], thumbnails: new Map() });
    await explorer.enter(definition); listener(0, 0.5); await new Promise((r) => setTimeout(r, 0));
    const inputSource = { targetRaySpace: {}, targetRayMode: 'transient-pointer' }; // 无 hand / gamepad
    const emit = (name) => session.dispatchEvent(Object.assign(new Event(name), { inputSource, frame }));
    emit('selectstart'); const immediate = actions === 1;
    const inputRay = lastActionRay?.origin.length() === 0 && lastActionRay.direction.equals(new THREE.Vector3(0, 0, -1));
    emit('select'); emit('selectend');
    hands[0].dispatchEvent({ type: 'pinchstart' }); hands[0].dispatchEvent({ type: 'pinchend' });
    const noDuplicate = actions === 1;
    session.visibilityState = 'visible-blurred'; emit('selectstart');
    const hiddenIgnored = actions === 1; session.visibilityState = 'visible';
    hostScene.updateMatrixWorld(true);
    const back = hostScene.children.find((child) => child.userData.isBackPanel);
    const camera = new THREE.PerspectiveCamera(); camera.lookAt(back.position); camera.updateMatrixWorld(true); ray = camera.matrixWorld.toArray();
    emit('selectstart'); const backDoesNotFlap = actions === 1;
    await explorer.exit(); emit('selectstart');
    return { immediate, inputRay, noDuplicate, hiddenIgnored, backDoesNotFlap, cleaned: actions === 1 && hostScene.children.length === 0 };
  });
  assert.ok(Object.values(xrResults).every(Boolean), JSON.stringify(xrResults));
  assert.deepEqual(errors, []);
  console.log('✓ 模拟 XR：无完整手追踪的捏合、即时扇翅、不重复触发、返回面板与会话清理');
  console.log('Flappy Bird 检查通过（未使用或新增 iOS / visionOS 模拟器，头显真机仍需验证）');
} finally { await browser?.close(); await server.close(); }
