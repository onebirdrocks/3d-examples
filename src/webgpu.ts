/**
 * WebGPU / TSL 独立场景页
 *
 * 这个场景**不注册进 src/scenes/index.ts**：画廊其它场景跑在共享的 `Stage`
 * （内部是 `THREE.WebGLRenderer`）上，而 `WebGPURenderer` 是另一套渲染器，
 * 两者不能混用同一个 Stage，所以这里做成一个单独的页面。
 *
 * 页面内容：
 * - 一颗用 `MeshStandardNodeMaterial` 驱动的流光球体（TSL 节点式材质）；
 * - 一个环绕的发光绳结 + 一块径向渐变的地面；
 * - 顶点位移、菲涅尔辉光、流速都挂在同一个 `uniform()` 上，由页面上的滑块实时调节；
 * - 最后叠一层 bloom（`PostProcessing` + `three/addons/tsl/display/BloomNode.js`）。
 *
 * 降级策略：`navigator.gpu` 不存在时改用 WebGL 2 后端渲染，
 * 并在页面上给出明确的中文提示；初始化失败时展示错误信息，绝不白屏。
 */

import * as THREE from 'three/webgpu';
import {
  Fn,
  cameraPosition,
  clamp,
  cos,
  dot,
  float,
  fract,
  length,
  mix,
  normalize,
  normalLocal,
  normalWorld,
  oneMinus,
  pass,
  positionLocal,
  positionWorld,
  pow,
  sin,
  smoothstep,
  time,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

/** 带 WebGPU 能力的 navigator（TS 的 lib.dom 里还没有 `navigator.gpu`）。 */
interface GpuCapableNavigator extends Navigator {
  gpu?: unknown;
}

const stageEl = document.querySelector<HTMLElement>('#stage')!;
const statusEl = document.querySelector<HTMLElement>('#status')!;
const noticeEl = document.querySelector<HTMLElement>('#notice')!;
const noticeTitleEl = document.querySelector<HTMLElement>('#notice-title')!;
const noticeBodyEl = document.querySelector<HTMLElement>('#notice-body')!;
const noticeDetailEl = document.querySelector<HTMLElement>('#notice-detail')!;
const sliderEl = document.querySelector<HTMLInputElement>('#intensity')!;
const sliderValueEl = document.querySelector<HTMLElement>('#intensity-value')!;

/** TSL uniform：页面上的「强度」滑块直接写进它。 */
const uIntensity = uniform(1.0);

/**
 * 流动场：位置 + 时间驱动的程序化波纹，返回 0~1 的标量节点。
 * `Fn` 不带参数时按零参函数调用，内部直接引用全局节点。
 */
const flowField = Fn(() => {
  const p = positionLocal;
  const t = time.mul(uIntensity);
  const wave = sin(p.y.mul(4.2).add(t.mul(0.9)))
    .mul(cos(p.x.mul(3.1).sub(t.mul(0.6))))
    .mul(0.5)
    .add(0.5);
  const band = fract(p.y.mul(1.4).sub(t.mul(0.16))).oneMinus();
  return wave.mul(0.72).add(band.mul(0.28));
});

/** 菲涅尔：视线越平行于表面越亮，用来做边缘辉光。 */
const fresnel = Fn(() => {
  const viewDir = normalize(cameraPosition.sub(positionWorld));
  const ndv = clamp(dot(normalWorld, viewDir), 0.0, 1.0);
  return pow(oneMinus(ndv), 2.2);
});

function buildScene(renderer: THREE.WebGPURenderer): {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  dispose: () => void;
} {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05070f);

  const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 100);
  camera.position.set(0, 1.1, 5.4);

  // ── 灯光 ────────────────────────────────────────────────────────────────
  scene.add(new THREE.AmbientLight(0x5a6b90, 0.32));

  const key = new THREE.DirectionalLight(0xfff0e0, 1.7);
  key.position.set(4, 6, 5);
  scene.add(key);

  const rim = new THREE.PointLight(0x66d9ff, 20, 26, 2);
  rim.position.set(-4.2, 2.4, -2.6);
  scene.add(rim);

  const warm = new THREE.PointLight(0xff7ac6, 14, 22, 2);
  warm.position.set(3.6, -1.2, 2.8);
  scene.add(warm);

  // ── 流光球体 ────────────────────────────────────────────────────────────
  const flow = flowField();
  const rimFactor = fresnel();

  const lowColor = vec3(0.05, 0.11, 0.34);
  const midColor = vec3(0.85, 0.3, 0.72);
  const highColor = vec3(0.22, 0.93, 0.85);
  const baseColor = mix(lowColor, midColor, smoothstep(0.0, 1.0, flow));
  const surfaceColor = mix(baseColor, highColor, smoothstep(0.58, 1.0, flow));

  const orbMaterial = new THREE.MeshStandardNodeMaterial({
    color: 0xffffff,
    roughness: 0.32,
    metalness: 0.25,
  });
  orbMaterial.colorNode = surfaceColor;
  orbMaterial.emissiveNode = surfaceColor.mul(rimFactor).mul(uIntensity.mul(0.5));
  orbMaterial.roughnessNode = mix(float(0.12), float(0.55), flow);
  // 顶点起伏：位置 + 时间 + 强度
  orbMaterial.positionNode = positionLocal.add(
    normalLocal
      .mul(sin(positionLocal.y.mul(2.6).add(time.mul(uIntensity.mul(1.1)))))
      .mul(0.055)
      .mul(uIntensity),
  );

  const orb = new THREE.Mesh(new THREE.SphereGeometry(1.32, 160, 110), orbMaterial);
  orb.name = 'tsl-orb';
  scene.add(orb);

  // ── 发光绳结 ────────────────────────────────────────────────────────────
  const knotFlow = flowField();
  const knotMaterial = new THREE.MeshStandardNodeMaterial({
    color: 0x1b2740,
    roughness: 0.22,
    metalness: 0.7,
  });
  knotMaterial.colorNode = mix(vec3(0.04, 0.09, 0.18), vec3(0.18, 0.46, 0.66), knotFlow);
  knotMaterial.emissiveNode = mix(vec3(0.16, 0.5, 0.95), vec3(0.95, 0.35, 0.75), knotFlow).mul(
    uIntensity.mul(0.45),
  );

  const knot = new THREE.Mesh(new THREE.TorusKnotGeometry(0.42, 0.125, 220, 28, 2, 3), knotMaterial);
  knot.name = 'tsl-knot';
  knot.position.set(-0.15, 0.2, 2.25);
  scene.add(knot);

  // ── 地面：径向渐变 ──────────────────────────────────────────────────────
  const groundMaterial = new THREE.MeshStandardNodeMaterial({
    color: 0xffffff,
    roughness: 0.55,
    metalness: 0.35,
  });
  const radial = length(uv().sub(vec2(0.5, 0.5))).mul(2.0);
  groundMaterial.colorNode = mix(vec3(0.05, 0.07, 0.12), vec3(0.16, 0.08, 0.24), smoothstep(0.0, 1.0, radial));
  groundMaterial.roughnessNode = mix(float(0.25), float(0.8), radial);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(26, 26, 1, 1), groundMaterial);
  ground.name = 'tsl-ground';
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -2.1;
  scene.add(ground);

  // ── 环状装饰：强度越高越亮 ──────────────────────────────────────────────
  const haloMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  haloMaterial.colorNode = mix(vec3(0.25, 0.8, 0.95), vec3(0.95, 0.45, 0.85), knotFlow).mul(
    uIntensity.mul(0.9),
  );
  haloMaterial.opacityNode = oneMinus(radial).clamp(0.0, 1.0).mul(0.55);

  const halo = new THREE.Mesh(new THREE.PlaneGeometry(9, 9, 1, 1), haloMaterial);
  halo.name = 'tsl-halo';
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = -2.05;
  scene.add(halo);

  const disposables: Array<{ dispose: () => void }> = [orbMaterial, knotMaterial, groundMaterial, haloMaterial];

  return {
    scene,
    camera,
    dispose: () => {
      for (const item of disposables) item.dispose();
      scene.traverse((child) => {
        if (child instanceof THREE.Mesh) child.geometry.dispose();
      });
      renderer.dispose();
    },
  };
}

/** 页面上的提示条。 */
function showNotice(title: string, body: string, detail = ''): void {
  noticeTitleEl.textContent = title;
  noticeBodyEl.textContent = body;
  noticeDetailEl.textContent = detail;
  noticeEl.hidden = false;
}

async function main(): Promise<void> {
  const hasWebGPU = typeof (navigator as GpuCapableNavigator).gpu !== 'undefined';

  let renderer: THREE.WebGPURenderer;
  try {
    renderer = new THREE.WebGPURenderer({
      antialias: true,
      alpha: false,
      // 没有 WebGPU 时退回 WebGL 2 后端，页面仍然有画面
      forceWebGL: !hasWebGPU,
    });
    await renderer.init();
  } catch (error) {
    statusEl.textContent = '渲染器初始化失败';
    statusEl.className = 'error';
    showNotice(
      '无法启动渲染器',
      'WebGPU / WebGL 2 后端都没有成功初始化，请更换浏览器或开启硬件加速后重试。',
      error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
    );
    return;
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const canvas = renderer.domElement;
  stageEl.appendChild(canvas);

  const resize = (): void => {
    const width = Math.max(1, stageEl.clientWidth || window.innerWidth);
    const height = Math.max(1, stageEl.clientHeight || window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
  };
  resize();
  window.addEventListener('resize', resize);

  const { scene, camera } = buildScene(renderer);
  camera.aspect = (stageEl.clientWidth || window.innerWidth) / Math.max(1, stageEl.clientHeight || window.innerHeight);
  camera.updateProjectionMatrix();

  // ── 后处理（bloom）──────────────────────────────────────────────────────
  let pipeline: THREE.RenderPipeline | null = null;
  let bloomPass: ReturnType<typeof bloom> | null = null;
  try {
    pipeline = new THREE.RenderPipeline(renderer);
    const scenePass = pass(scene, camera);
    const scenePassColor = scenePass.getTextureNode('output');
    bloomPass = bloom(scenePassColor, 0.55, 0.7, 0.62);
    pipeline.outputNode = scenePassColor.add(bloomPass);
  } catch (error) {
    pipeline = null;
    bloomPass = null;
    console.warn('[webgpu] 后处理不可用，改为直接渲染', error);
  }

  // ── 相机轨道 ────────────────────────────────────────────────────────────
  let azimuth = 0.7;
  let elevation = 0.16;
  const radius = 6.3;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  canvas.addEventListener('pointerdown', (event) => {
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointerup', (event) => {
    dragging = false;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    azimuth -= (event.clientX - lastX) * 0.006;
    elevation = THREE.MathUtils.clamp(elevation + (event.clientY - lastY) * 0.004, -0.5, 0.9);
    lastX = event.clientX;
    lastY = event.clientY;
  });

  // ── 强度滑块 ────────────────────────────────────────────────────────────
  const applyIntensity = (): void => {
    const value = Number.parseFloat(sliderEl.value);
    uIntensity.value = value;
    sliderValueEl.textContent = value.toFixed(2);
  };
  sliderEl.addEventListener('input', applyIntensity);
  applyIntensity();

  // ── 状态提示 ────────────────────────────────────────────────────────────
  if (hasWebGPU) {
    statusEl.textContent = 'WebGPU 渲染正常';
    statusEl.className = '';
  } else {
    statusEl.textContent = 'WebGPU 不可用，已降级到 WebGL 2';
    statusEl.className = 'warn';
    showNotice(
      '当前浏览器不支持 WebGPU',
      '请使用 Safari 18+ 或 Chrome 113+ 打开本页以获得完整的 WebGPU 效果。当前已自动改用 WebGL 2 后备渲染，画面与交互仍然可用。',
    );
  }

  const timer = new THREE.Timer();

  renderer.setAnimationLoop(() => {
    timer.update();
    const delta = Math.min(timer.getDelta(), 0.05);
    if (!dragging) azimuth += delta * 0.07;

    camera.position.set(
      Math.cos(azimuth) * Math.cos(elevation) * radius,
      Math.sin(elevation) * radius + 0.35,
      Math.sin(azimuth) * Math.cos(elevation) * radius,
    );
    camera.lookAt(0, 0.1, 0);

    if (bloomPass) bloomPass.strength.value = 0.22 + uIntensity.value * 0.32;

    if (pipeline) {
      pipeline.render();
    } else {
      renderer.render(scene, camera);
    }
  });
}

void main();
