import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { SceneContext, SceneDefinition, SceneInstance } from '../types.js';
import { disposeObject } from '../../core/loader.js';
import { readSaved, save } from '../../core/library.js';
import { FLIGHT, FlappyFlight } from './flappy-model.js';
import { FlightCorridor, FLIGHT_SPACE } from './flappy-first-person.js';
import { FlightAltimeter, flightGuidance } from './flappy-guidance.js';
import '../../styles/flappy.css';

const BEST_KEY = 'flappy-bird:best';
const VIEW_KEY = 'flappy-bird:view';
const FONT = 'system-ui, -apple-system, "PingFang SC", sans-serif';
type FlightView = 'side' | 'first-person';

function isAR(ctx: SceneContext): boolean {
  const blend = ctx.isXR && ctx.renderer.xr.getSession()?.environmentBlendMode;
  return blend === 'alpha-blend' || blend === 'additive';
}

function canvasSurface(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d')!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return { canvas, context, texture };
}

function create(ctx: SceneContext): SceneInstance {
  const root = new THREE.Group();
  const camera = new THREE.PerspectiveCamera(40, ctx.width / ctx.height, 0.05, 100);
  root.add(camera);
  const side = new THREE.Group(); side.name = 'flappy-side-view'; root.add(side);
  const flight = new FlappyFlight();
  let view: FlightView = !ctx.isPreview && !isAR(ctx) && readSaved<unknown>(VIEW_KEY, 'side') === 'first-person' ? 'first-person' : 'side';
  const saved = ctx.isPreview ? 0 : readSaved<unknown>(BEST_KEY, 0);
  let best = typeof saved === 'number' && Number.isSafeInteger(saved) && saved >= 0 ? saved : 0;
  let context = ctx;
  let suspended = false;
  let disposed = false;
  let hudKey = '';
  let wingTime = 0;
  const eyeOrigin = new THREE.Vector3(0, 1.6, 0);
  let eyeOriginCaptured = false;
  const controlRaycaster = new THREE.Raycaster();
  const textures: THREE.Texture[] = [];

  const material = (color: number, metalness = 0.05) => new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness });
  const shellMaterial = material(0x173f40, 0.35);
  const mint = material(0x54b99e, 0.15);
  const paleMint = material(0x9ee5bb, 0.1);
  const gold = material(0xffcf58, 0.15);
  const cream = material(0xfff1c6);
  const orange = material(0xe99039);
  const black = material(0x163f43);
  root.add(new THREE.HemisphereLight(0xe9fff2, 0x213d4b, 2.2));
  const light = new THREE.DirectionalLight(0xffeccb, 3);
  light.position.set(-2, 5, 5); root.add(light);

  function box(width: number, height: number, depth: number, mat: THREE.Material, x: number, y: number, z: number) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), mat);
    mesh.position.set(x, y, z); side.add(mesh); return mesh;
  }
  const shell = new THREE.Mesh(new RoundedBoxGeometry(4.18, 2.98, 0.22, 3, 0.12), shellMaterial);
  shell.position.set(0, 1.55, -0.24); side.add(shell);
  box(3.72, 0.045, 0.13, paleMint, 0, 2.59, 0.05);
  box(3.72, 0.14, 0.38, mint, 0, 0.48, 0.04);
  box(0.045, 2.14, 0.13, paleMint, -1.84, 1.55, 0.04);
  box(0.045, 2.14, 0.13, paleMint, 1.84, 1.55, 0.04);

  // 远景完全静止：只有鸟和障碍运动，不移动头显视点。
  const sky = canvasSurface(1024, 640); textures.push(sky.texture);
  const s = sky.context;
  const gradient = s.createLinearGradient(0, 0, 0, 640);
  gradient.addColorStop(0, '#173f56'); gradient.addColorStop(0.6, '#438e95'); gradient.addColorStop(1, '#b4cfa8');
  s.fillStyle = gradient; s.fillRect(0, 0, 1024, 640);
  s.fillStyle = '#f6d99a'; s.beginPath(); s.arc(730, 180, 67, 0, Math.PI * 2); s.fill();
  for (let layer = 0; layer < 3; layer++) {
    s.fillStyle = ['#4f9396', '#438d86', '#31796e'][layer];
    s.beginPath(); s.moveTo(0, 640);
    for (let x = 0; x <= 1024; x += 8) s.lineTo(x, 400 + layer * 62 + Math.sin(x / (140 - layer * 25) + layer * 2) * 48 + Math.sin(x / 57) * 12);
    s.lineTo(1024, 640); s.closePath(); s.fill();
  }
  s.fillStyle = 'rgba(233,255,235,.15)';
  for (const [x, y, w] of [[190, 140, 76], [400, 230, 55], [870, 290, 85]]) {
    s.beginPath(); s.ellipse(x, y, w, 10, 0, 0, Math.PI * 2); s.fill();
  }
  sky.texture.needsUpdate = true;
  const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 2), new THREE.MeshBasicMaterial({ map: sky.texture, toneMapped: false }));
  backdrop.position.set(0, 1.55, -0.1); side.add(backdrop);

  // 圆润的原创小鸟，面向右侧；轮廓与判定半径接近。
  const bird = new THREE.Group(); side.add(bird);
  function ellipsoid(parent: THREE.Group, mat: THREE.Material, scale: number[], position: number[]) {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), mat);
    mesh.scale.set(scale[0], scale[1], scale[2]); mesh.position.set(position[0], position[1], position[2]); parent.add(mesh); return mesh;
  }
  ellipsoid(bird, gold, [0.112, 0.101, 0.09], [0, 0, 0]);
  ellipsoid(bird, cream, [0.075, 0.062, 0.035], [0.035, -0.035, 0.073]);
  ellipsoid(bird, cream, [0.043, 0.047, 0.027], [0.055, 0.04, 0.072]);
  ellipsoid(bird, black, [0.015, 0.021, 0.01], [0.068, 0.046, 0.096]);
  ellipsoid(bird, cream, [0.005, 0.006, 0.004], [0.072, 0.055, 0.105]);
  ellipsoid(bird, orange, [0.055, 0.025, 0.035], [0.115, -0.005, 0.015]);
  const wing = ellipsoid(bird, orange, [0.067, 0.035, 0.026], [-0.038, -0.008, 0.094]);
  ellipsoid(bird, gold, [0.065, 0.028, 0.027], [-0.105, -0.018, -0.005]);

  // 管子复用固定数量的网格；边缘裁切在局部坐标完成，也兼容 XR 放置。
  const pipes = flight.pipes.map(() => [
    box(1, 1, 0.17, mint, 0, 0, 0.035), box(1, 1, 0.17, mint, 0, 0, 0.035),
    box(1, 0.09, 0.23, paleMint, 0, 0, 0.055), box(1, 0.09, 0.23, paleMint, 0, 0, 0.055),
  ]);
  function clipPipe(mesh: THREE.Mesh, x: number, width: number, y: number, height: number) {
    const left = Math.max(FLIGHT.left, x - width / 2);
    const right = Math.min(FLIGHT.right, x + width / 2);
    mesh.visible = right > left && height > 0;
    mesh.position.x = (left + right) / 2; mesh.position.y = y;
    mesh.scale.x = Math.max(0.001, right - left); mesh.scale.y = height;
  }

  const header = canvasSurface(1536, 160); textures.push(header.texture);
  const headerMesh = new THREE.Mesh(new THREE.PlaneGeometry(3.7, 0.385), new THREE.MeshBasicMaterial({ map: header.texture, transparent: true, toneMapped: false }));
  headerMesh.position.set(0, 2.81, -0.08); side.add(headerMesh);
  const message = canvasSurface(1024, 360); textures.push(message.texture);
  const messageMesh = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 0.985), new THREE.MeshBasicMaterial({ map: message.texture, transparent: true, toneMapped: false, depthTest: false }));
  messageMesh.position.set(0, 1.6, 0.3); messageMesh.renderOrder = 5; side.add(messageMesh);
  const footer = canvasSurface(1536, 110); textures.push(footer.texture);
  const footerMesh = new THREE.Mesh(new THREE.PlaneGeometry(3.7, 0.265), new THREE.MeshBasicMaterial({ map: footer.texture, transparent: true, toneMapped: false }));
  footerMesh.position.set(0, 0.25, -0.07); side.add(footerMesh);

  const corridor = new FlightCorridor(mint, paleMint, gold); root.add(corridor.root);
  const firstHUD = new THREE.Group(); firstHUD.name = 'flappy-first-person-hud'; camera.add(firstHUD);
  function hudCopy(source: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>, y: number) {
    const mesh = source.clone(); mesh.material = source.material.clone(); mesh.material.depthTest = false;
    mesh.position.set(0, y, -2.8); mesh.renderOrder = 8; firstHUD.add(mesh); return mesh;
  }
  const firstHeader = hudCopy(headerMesh, 0.72);
  const firstMessage = hudCopy(messageMesh, 0);
  const firstFooter = hudCopy(footerMesh, -0.65);
  const altimeter = new FlightAltimeter(); firstHUD.add(altimeter.root);

  const viewSurface = canvasSurface(768, 160), pauseSurface = canvasSurface(768, 160);
  textures.push(viewSurface.texture, pauseSurface.texture);
  function xrControl(kind: 'view' | 'pause', parent: THREE.Group, x: number, y: number, z: number) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.05, 0.22), new THREE.MeshBasicMaterial({
      map: kind === 'view' ? viewSurface.texture : pauseSurface.texture, transparent: true, depthTest: false, toneMapped: false,
    }));
    mesh.name = `flappy-${kind}-${parent === side ? 'side' : 'first-person'}`;
    mesh.userData.flappyControl = kind; mesh.position.set(x, y, z); mesh.renderOrder = 9;
    parent.add(mesh); return mesh;
  }
  const sideControls = [xrControl('view', side, -0.65, -0.18, 0.1), xrControl('pause', side, 0.65, -0.18, 0.1)];
  const firstControls = [xrControl('view', firstHUD, -0.58, -0.97, -2.8), xrControl('pause', firstHUD, 0.58, -0.97, -2.8)];

  const panel = document.createElement('section');
  panel.className = 'flappy-controls'; panel.setAttribute('aria-label', '飞鸟游戏操作');
  const status = document.createElement('p');
  status.className = 'flappy-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-atomic', 'true');
  const actions = document.createElement('div'); actions.className = 'flappy-actions';
  const flapButton = document.createElement('button'); flapButton.type = 'button'; flapButton.className = 'flappy-action';
  const pauseButton = document.createElement('button'); pauseButton.type = 'button'; pauseButton.className = 'flappy-pause';
  const viewButton = document.createElement('button'); viewButton.type = 'button'; viewButton.className = 'flappy-view';
  viewButton.setAttribute('aria-label', '第一人称视角');
  actions.append(flapButton, pauseButton, viewButton); panel.append(status, actions);
  if (!ctx.isPreview) ctx.renderer.domElement.parentElement?.append(panel);

  function refreshHUD() {
    if (!ctx.isPreview && flight.score > best) { best = flight.score; save(BEST_KEY, best); }
    const key = `${flight.phase}:${flight.score}:${best}:${context.isXR}:${suspended}:${view}:${isAR(context)}`;
    if (key === hudKey) return;
    hudKey = key;
    const h = header.context;
    h.clearRect(0, 0, 1536, 160);
    const inset = view === 'first-person' ? 34 : 0;
    if (view === 'first-person') {
      h.fillStyle = 'rgba(9,34,41,.9)'; h.beginPath(); h.roundRect(0, 0, 610, 160, 32); h.fill();
      h.beginPath(); h.roundRect(1210, 0, 326, 160, 32); h.fill();
    }
    h.textAlign = 'left'; h.fillStyle = '#dff9df'; h.font = `700 57px ${FONT}`; h.fillText('FLAPPY BIRD', inset, 76);
    h.fillStyle = '#9bbfb3'; h.font = `26px ${FONT}`; h.fillText(view === 'first-person' ? '第一人称 · 迎风飞行' : '云间飞鸟 · 侧视', inset + 2, 126);
    h.textAlign = 'right'; h.fillStyle = '#ffdb83'; h.font = `700 73px ${FONT}`; h.fillText(String(flight.score).padStart(2, '0'), 1534 - inset, 83);
    h.fillStyle = '#b2d3c4'; h.font = `25px ${FONT}`; h.fillText(`最高 ${best}`, 1534 - inset, 128);
    header.texture.needsUpdate = true;
    const f = footer.context;
    f.clearRect(0, 0, 1536, 110);
    if (view === 'first-person') { f.fillStyle = 'rgba(9,34,41,.9)'; f.beginPath(); f.roundRect(0, 0, 1536, 110, 32); f.fill(); }
    f.fillStyle = '#d4eadb'; f.font = `38px ${FONT}`; f.textAlign = 'center';
    f.fillText(view === 'first-person' ? '金色标记是你的高度 · 对准亮框 · 偏低时扇翅上升' : context.isXR ? '捏合扇翅 · 看向下方按钮可切换视角或暂停' : '轻点画面 / 空格扇翅 · P 暂停 · V 切换视角', 768, 66);
    footer.texture.needsUpdate = true;
    const titles = { ready: '轻轻一捏，向上飞', playing: '', paused: '歇一会儿', over: '再飞一次？' };
    const subtitles = { ready: context.isXR ? '捏合开始 · 每穿过一对绿管得 1 分' : '轻点画面或按空格开始', playing: '', paused: context.isXR ? '捏合继续飞行' : '轻点 / 空格继续', over: `本次 ${flight.score} 分 · 最高 ${best} 分` };
    const m = message.context;
    m.clearRect(0, 0, 1024, 360);
    messageMesh.visible = flight.phase !== 'playing' && !ctx.isPreview;
    firstMessage.visible = messageMesh.visible;
    firstFooter.visible = flight.phase !== 'playing';
    altimeter.root.visible = view === 'first-person' && flight.phase === 'playing';
    if (messageMesh.visible) {
      m.fillStyle = 'rgba(10,39,43,.92)'; m.beginPath(); m.roundRect(18, 36, 988, 288, 42); m.fill();
      m.strokeStyle = 'rgba(188,242,206,.35)'; m.lineWidth = 2; m.stroke();
      m.textAlign = 'center'; m.fillStyle = '#f5efd5'; m.font = `600 64px ${FONT}`; m.fillText(titles[flight.phase], 512, 143);
      m.fillStyle = '#b7d7c4'; m.font = `34px ${FONT}`; m.fillText(subtitles[flight.phase], 512, 213);
      if (flight.phase === 'over') { m.fillStyle = '#f8d481'; m.font = `30px ${FONT}`; m.fillText(context.isXR ? '稍作停顿后捏合重开' : '稍作停顿后轻点 / 空格重开', 512, 269); }
    }
    message.texture.needsUpdate = true;
    panel.hidden = context.isXR;
    panel.dataset.phase = flight.phase;
    panel.dataset.view = view;
    status.textContent = `${view === 'first-person' ? '第一人称' : '侧视'} · ${({ ready: '准备起飞', playing: '飞行中', paused: '已暂停', over: '本局结束' })[flight.phase]} · ${flight.score} 分 · 最高 ${best}`;
    if (suspended) status.textContent = '画面已暂停，请在体验设置中继续画面';
    flapButton.textContent = ({ ready: '开始飞行', playing: '扇动翅膀', paused: '继续飞行', over: '再玩一次' })[flight.phase];
    flapButton.disabled = suspended;
    pauseButton.textContent = flight.phase === 'paused' ? '继续' : '暂停';
    pauseButton.disabled = suspended || flight.phase === 'ready' || flight.phase === 'over';
    pauseButton.setAttribute('aria-pressed', String(flight.phase === 'paused'));
    viewButton.textContent = view === 'first-person' ? '切回侧视' : '第一人称';
    viewButton.setAttribute('aria-pressed', String(view === 'first-person'));
    viewButton.title = '切换时先暂停，继续后沿用当前分数';
    viewButton.disabled = suspended || isAR(context);
    for (const [surface, label, enabled] of [
      [viewSurface, isAR(context) ? '第一人称需沉浸模式' : viewButton.textContent, !viewButton.disabled],
      [pauseSurface, pauseButton.textContent, !pauseButton.disabled],
    ] as const) {
      const c = surface.context; c.clearRect(0, 0, 768, 160);
      c.fillStyle = enabled ? '#173e40' : '#263d3b'; c.beginPath(); c.roundRect(4, 4, 760, 152, 68); c.fill();
      c.strokeStyle = enabled ? '#a3d8b9' : '#54766a'; c.lineWidth = 4; c.stroke();
      c.textAlign = 'center'; c.fillStyle = enabled ? '#e3efda' : '#8ea99d'; c.font = `48px ${FONT}`; c.fillText(label, 384, 99);
      surface.texture.needsUpdate = true;
    }
  }

  function act() {
    if (disposed || suspended || document.hidden || ctx.isPreview) return;
    if (flight.action()) { wingTime = 0; refreshHUD(); }
  }
  function togglePause() {
    if (suspended) return;
    if (flight.phase === 'paused') act(); else flight.pause();
    refreshHUD();
  }
  function toggleView() {
    if (disposed || suspended || ctx.isPreview || isAR(context)) return;
    flight.pause();
    view = view === 'side' ? 'first-person' : 'side';
    save(VIEW_KEY, view); eyeOriginCaptured = false;
    instance.update(0, 0, context);
  }
  function xrAction(ray?: THREE.Ray) {
    if (disposed || suspended || document.hidden) return;
    if (ray && context.isXR) {
      root.updateWorldMatrix(true, true);
      controlRaycaster.ray.copy(ray); controlRaycaster.far = 12;
      const hit = controlRaycaster.intersectObjects(view === 'first-person' ? firstControls : sideControls, false)[0];
      if (hit) {
        if (hit.object.userData.flappyControl === 'view') toggleView(); else togglePause();
        return;
      }
    }
    act();
  }
  const pointer = (event: PointerEvent) => {
    if (context.isXR || !event.isPrimary || event.button !== 0) return;
    event.preventDefault(); act();
  };
  const keydown = (event: KeyboardEvent) => {
    if (context.isXR || event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey ||
        event.composedPath().some((target) => target instanceof HTMLElement && (target.matches('input, textarea, select, button, a, summary') || target.isContentEditable))) return;
    if (event.code === 'Space') { event.preventDefault(); act(); }
    if (event.code === 'KeyP') { event.preventDefault(); togglePause(); }
    if (event.code === 'KeyV') { event.preventDefault(); toggleView(); }
  };
  const blur = () => { flight.pause(); refreshHUD(); };
  if (!ctx.isPreview) {
    ctx.renderer.domElement.addEventListener('pointerdown', pointer);
    window.addEventListener('keydown', keydown);
    window.addEventListener('blur', blur);
    flapButton.addEventListener('click', act);
    pauseButton.addEventListener('click', togglePause);
    viewButton.addEventListener('click', toggleView);
  }

  const instance: SceneInstance = {
    root, camera, ownsCamera: true, interactive: true, immersive: true,
    onAction: xrAction,
    onSuspend() { suspended = true; flight.pause(); refreshHUD(); },
    update(_time, delta, next) {
      context = next;
      const visibility = next.renderer.xr.getSession()?.visibilityState;
      if (next.isXR && visibility && visibility !== 'visible') instance.onSuspend!();
      else if (delta > 0) suspended = false;
      if (!suspended) flight.advance(delta);
      const ar = isAR(next);
      if (ar && view === 'first-person') { view = 'side'; flight.pause(); }
      camera.far = view === 'first-person' ? 160 : 100;
      if (ar) camera.removeFromParent(); else if (camera.parent !== root) root.add(camera);
      side.visible = view === 'side';
      side.position.z = next.isXR && !ar ? -3.5 : 0;
      corridor.root.visible = view === 'first-person'; firstHUD.visible = view === 'first-person';
      for (const control of [...sideControls, ...firstControls]) control.visible = next.isXR;
      const animate = !next.reducedMotion && !suspended && flight.phase !== 'paused' && flight.phase !== 'over';
      if (animate) wingTime += delta;
      bird.position.set(FLIGHT.birdX, flight.y + (flight.phase === 'ready' && animate ? Math.sin(wingTime * 3) * 0.035 : 0), 0.13);
      bird.rotation.z = flight.phase === 'ready' ? 0 : THREE.MathUtils.clamp(flight.velocity * 0.2, -0.7, 0.35);
      wing.rotation.z = animate ? Math.sin(wingTime * 23) * 0.5 : 0;
      flight.pipes.forEach((pipe, i) => {
        const bottom = pipe.center - pipe.gap / 2, top = pipe.center + pipe.gap / 2;
        clipPipe(pipes[i][0], pipe.x, FLIGHT.pipeWidth, (FLIGHT.bottom + bottom) / 2, bottom - FLIGHT.bottom);
        clipPipe(pipes[i][1], pipe.x, FLIGHT.pipeWidth, (FLIGHT.top + top) / 2, FLIGHT.top - top);
        clipPipe(pipes[i][2], pipe.x, FLIGHT.pipeWidth + 0.07, bottom - 0.045, 1);
        clipPipe(pipes[i][3], pipe.x, FLIGHT.pipeWidth + 0.07, top + 0.045, 1);
      });
      if (view === 'first-person') {
        const guidance = flightGuidance(flight);
        corridor.update(flight, !!next.reducedMotion, guidance);
        altimeter.update(guidance, flight.phase, delta);
        altimeter.root.visible = flight.phase === 'playing';
        firstHeader.position.y = next.isXR ? 1.05 : next.height < 500 ? 0.72 : next.width < 720 ? 0.85 : 1.1;
        if (next.isXR) {
          const xrCamera = next.renderer.xr.getCamera();
          if (!eyeOriginCaptured && xrCamera.cameras.length) { xrCamera.getWorldPosition(eyeOrigin); eyeOriginCaptured = true; }
          // 移动世界表达虚拟升降，头显仍完全掌握相机的真实位置与朝向。
          corridor.root.position.copy(eyeOrigin); corridor.root.position.y -= flight.y * FLIGHT_SPACE.height;
          firstHeader.scale.setScalar(0.72); firstFooter.scale.setScalar(0.72); firstMessage.scale.setScalar(0.85);
          altimeter.layout(0, true);
        } else {
          camera.fov = 70; camera.far = 160; camera.aspect = next.width / next.height;
          camera.position.set(0, flight.y * FLIGHT_SPACE.height, 0); camera.rotation.set(0, 0, 0); camera.updateProjectionMatrix();
          corridor.root.position.set(0, 0, 0);
          const width = 2 * 2.8 * Math.tan(35 * Math.PI / 180) * camera.aspect * 0.9;
          firstHeader.scale.setScalar(Math.min(0.72, width / 3.7)); firstFooter.scale.copy(firstHeader.scale);
          firstMessage.scale.setScalar(Math.min(0.85, width / 2.8));
          altimeter.layout(width / 0.9, false);
        }
      } else if (!next.isXR) {
        camera.fov = 40; camera.far = 100;
        const aspect = next.width / next.height;
        const available = ctx.isPreview ? 0.94 : Math.max(0.32, (next.height - 320) / next.height);
        const distance = Math.max(1.58 / (Math.tan(Math.PI / 9) * available), 2.2 / (Math.tan(Math.PI / 9) * aspect * 0.92));
        camera.aspect = aspect; camera.position.set(0, 1.55, distance); camera.lookAt(0, 1.55, 0); camera.updateProjectionMatrix();
      }
      refreshHUD();
    },
    dispose() {
      disposed = true;
      ctx.renderer.domElement.removeEventListener('pointerdown', pointer);
      window.removeEventListener('keydown', keydown); window.removeEventListener('blur', blur);
      flapButton.removeEventListener('click', act); pauseButton.removeEventListener('click', togglePause);
      viewButton.removeEventListener('click', toggleView);
      panel.remove(); textures.forEach((texture) => texture.dispose()); altimeter.dispose(); camera.removeFromParent(); disposeObject(camera); disposeObject(root);
    },
  };
  instance.update(0, 0, ctx);
  return instance;
}

export default {
  id: 'flappy-bird', title: '云间飞鸟', subtitle: 'Flappy Bird', category: 'game',
  description: '捏合扇翅，穿过绿管。可切换侧视与第一人称，迎面穿越立体障碍，挑战自己的最高分。也支持轻点或空格。',
  tags: ['小游戏', 'Vision Pro', '第一人称', '捏合交互', 'Flappy Bird'],
  accent: '#9edcb4', gradient: ['#143c4c', '#6cb99c'], lighting: { exposure: 1 }, create,
} satisfies SceneDefinition;
