/**
 * 四个新场景共用的程序化素材工具。
 *
 * 全部贴图都由 Canvas 现场生成，不依赖任何外部素材；
 * 噪声函数只做 CPU 端的形状扰动（石面、苔藓起伏、贴图斑驳）。
 */
import * as THREE from 'three';

/* ------------------------------------------------------------------ *
 * CPU 噪声
 * ------------------------------------------------------------------ */

function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

/** 2D 值噪声，返回 0~1。 */
export function valueNoise2(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  const top = a + (b - a) * ux;
  const bottom = c + (d - c) * ux;
  return top + (bottom - top) * uy;
}

/** 2D 分形噪声，返回 0~1。 */
export function fbm2(x: number, y: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let freq = 1;
  for (let i = 0; i < octaves; i += 1) {
    sum += amp * valueNoise2(x * freq, y * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

/* ------------------------------------------------------------------ *
 * Canvas 贴图
 * ------------------------------------------------------------------ */

function createCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');
  return { canvas, ctx };
}

/** 云絮状贴图：白色 RGB + 噪声 Alpha，用来打散光斑与雾的边界。 */
export function createCloudTexture(size = 256): THREE.CanvasTexture {
  const { canvas, ctx } = createCanvas(size);
  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const n = fbm2((x / size) * 5, (y / size) * 5, 4);
      const fine = fbm2((x / size) * 17 + 9.1, (y / size) * 17 + 4.3, 3);
      const alpha = THREE.MathUtils.clamp(0.28 + n * 0.95 + fine * 0.22, 0, 1);
      const i = (y * size + x) * 4;
      image.data[i] = 255;
      image.data[i + 1] = 255;
      image.data[i + 2] = 255;
      image.data[i + 3] = Math.round(alpha * 255);
    }
  }
  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'cloud';
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** 柔和的径向光斑（中心实、边缘归零）。 */
export function createRadialTexture(size = 128, falloff = 2.2): THREE.CanvasTexture {
  const { canvas, ctx } = createCanvas(size);
  const image = ctx.createImageData(size, size);
  const half = size / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x + 0.5 - half) / half;
      const dy = (y + 0.5 - half) / half;
      const d = Math.min(1, Math.hypot(dx, dy));
      const alpha = Math.pow(1 - d, falloff);
      const i = (y * size + x) * 4;
      image.data[i] = 255;
      image.data[i + 1] = 255;
      image.data[i + 2] = 255;
      image.data[i + 3] = Math.round(alpha * 255);
    }
  }
  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'radial';
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/* ------------------------------------------------------------------ *
 * 釉面开片
 * ------------------------------------------------------------------ */

interface CrackleLine {
  points: [number, number][];
}

/** 生成一片游走的裂纹（釉面开片的形状）。 */
function generateCrackleLines(count: number, size: number, seed: number): CrackleLine[] {
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };

  const lines: CrackleLine[] = [];
  for (let i = 0; i < count; i += 1) {
    let x = random() * size;
    let y = random() * size;
    let angle = random() * Math.PI * 2;
    const points: [number, number][] = [[x, y]];
    const steps = 5 + Math.floor(random() * 9);
    const length = size * (0.025 + random() * 0.055);
    for (let s = 0; s < steps; s += 1) {
      angle += (random() - 0.5) * 1.2;
      x += Math.cos(angle) * length;
      y += Math.sin(angle) * length;
      points.push([x, y]);
    }
    lines.push({ points });
  }
  return lines;
}

/**
 * 青瓷釉面：一对贴图。
 * - colorMap：近白的釉色 + 斑驳起伏 + 淡淡的裂纹；
 * - roughnessMap：釉面本身很滑（暗），裂纹处变粗糙（亮）。
 */
export function createGlazeTextures(
  size = 512,
  seed = 20240912,
): { colorMap: THREE.CanvasTexture; roughnessMap: THREE.CanvasTexture } {
  const { canvas: colorCanvas, ctx: colorCtx } = createCanvas(size);
  const { canvas: roughCanvas, ctx: roughCtx } = createCanvas(size);

  // 釉色底：近白，带轻微冷暖斑驳
  const colorImage = colorCtx.createImageData(size, size);
  const roughImage = roughCtx.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      const mottle = fbm2(u * 4.5 + 3.3, v * 4.5 + 7.7, 4);
      const pool = fbm2(u * 1.6 + 21.3, v * 1.6 + 5.1, 3);
      const shade = 0.84 + mottle * 0.16 - pool * 0.08;
      const i = (y * size + x) * 4;
      colorImage.data[i] = Math.round(255 * shade);
      colorImage.data[i + 1] = Math.round(255 * shade * (0.995 + mottle * 0.01));
      colorImage.data[i + 2] = Math.round(255 * shade * (0.985 + pool * 0.02));
      colorImage.data[i + 3] = 255;

      // 粗糙度：釉面本身很滑（0.22），开片处变粗（0.85）
      const g = Math.round(56 + mottle * 26);
      roughImage.data[i] = g;
      roughImage.data[i + 1] = g;
      roughImage.data[i + 2] = g;
      roughImage.data[i + 3] = 255;
    }
  }
  colorCtx.putImageData(colorImage, 0, 0);
  roughCtx.putImageData(roughImage, 0, 0);

  const lines = generateCrackleLines(34, size, seed);
  for (const line of lines) {
    colorCtx.strokeStyle = 'rgba(120, 132, 126, 0.22)';
    colorCtx.lineWidth = 1.2;
    colorCtx.beginPath();
    colorCtx.moveTo(line.points[0][0], line.points[0][1]);
    for (let i = 1; i < line.points.length; i += 1) {
      colorCtx.lineTo(line.points[i][0], line.points[i][1]);
    }
    colorCtx.stroke();

    roughCtx.strokeStyle = 'rgba(170, 170, 170, 0.8)';
    roughCtx.lineWidth = 1.6;
    roughCtx.beginPath();
    roughCtx.moveTo(line.points[0][0], line.points[0][1]);
    for (let i = 1; i < line.points.length; i += 1) {
      roughCtx.lineTo(line.points[i][0], line.points[i][1]);
    }
    roughCtx.stroke();
  }

  const colorMap = new THREE.CanvasTexture(colorCanvas);
  colorMap.name = 'glaze-color';
  colorMap.wrapS = THREE.RepeatWrapping;
  colorMap.wrapT = THREE.RepeatWrapping;
  colorMap.colorSpace = THREE.SRGBColorSpace;
  colorMap.anisotropy = 4;
  colorMap.needsUpdate = true;

  const roughnessMap = new THREE.CanvasTexture(roughCanvas);
  roughnessMap.name = 'glaze-roughness';
  roughnessMap.wrapS = THREE.RepeatWrapping;
  roughnessMap.wrapT = THREE.RepeatWrapping;
  roughnessMap.anisotropy = 4;
  roughnessMap.needsUpdate = true;

  return { colorMap, roughnessMap };
}
