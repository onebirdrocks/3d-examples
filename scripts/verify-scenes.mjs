#!/usr/bin/env node
/**
 * 场景回归检查
 * ---------------------------------------------------------------
 * 逐个打开全部场景，检查三件事：
 *   1. 控制台没有报错（着色器编译失败、资源 404、未捕获异常都会暴露出来）
 *   2. 画面不是全黑（有内容但极暗的场景按阈值放行）
 *   3. 页面没有出现「场景加载失败」的错误面板
 *
 * 用系统已装的 Chrome（不额外下载浏览器），跑的是 vite dev server。
 * 用法：npm run verify
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.VERIFY_PORT ?? 5199);
const BASE = `http://localhost:${PORT}`;

/** 允许的最低平均亮度（0~1）。极暗的助眠场景会接近这个值。 */
const MIN_LUMA = 0.004;

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

function findChrome() {
  return CHROME_PATHS.find((p) => existsSync(p));
}

/** 从注册表里读出全部场景 id。 */
async function readSceneIds() {
  const source = await import('node:fs/promises').then((fs) =>
    fs.readFile(resolve(ROOT, 'src/scenes/index.ts'), 'utf8'),
  );
  const ids = new Set();
  const moduleRe = /from '\.\/(?:procedural|models|meditation|sleep|environment|simulation)\/([a-z0-9-]+)\.js'/g;
  let match;
  while ((match = moduleRe.exec(source)) !== null) ids.add(match[1]);
  return [...ids].sort();
}

function startServer() {
  const child = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const onData = (chunk) => {
      if (settled) return;
      const text = String(chunk);
      if (text.includes('ready in') || text.includes('Local:')) {
        settled = true;
        resolvePromise(child);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      if (!settled) reject(new Error(`dev server 启动失败 (exit ${code})`));
    });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        resolvePromise(child);
      }
    }, 15000);
  });
}

/** 截图并计算平均亮度（用页面里的 2D canvas 解码截图）。 */
async function measureLuma(page) {
  const buffer = await page.locator('#view').screenshot();
  const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
  return page.evaluate(async (url) => {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 40;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0, 64, 40);
    const data = ctx.getImageData(0, 0, 64, 40).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    }
    return sum / (data.length / 4) / 255;
  }, dataUrl);
}

async function main() {
  const executablePath = findChrome();
  if (!executablePath) {
    console.error('找不到 Chrome / Chromium，请安装后重试。');
    process.exit(2);
  }

  const ids = await readSceneIds();
  console.log(`检查 ${ids.length} 个场景…\n`);

  const server = await startServer();
  const browser = await chromium.launch({ executablePath });
  const failures = [];

  try {
    for (const id of ids) {
      const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
      const errors = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(msg.text().slice(0, 300));
      });
      page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`.slice(0, 300)));

      await page.goto(`${BASE}/lab.html?scene=${encodeURIComponent(id)}`, {
        waitUntil: 'networkidle',
      });
      // 等场景挂载并渲染几帧
      await page.waitForTimeout(2200);

      const failed = await page.evaluate(() => {
        const el = document.querySelector('#err');
        return el ? getComputedStyle(el).display !== 'none' : false;
      });
      const luma = await measureLuma(page);

      const problems = [];
      if (failed) problems.push('显示「场景加载失败」面板');
      if (errors.length) problems.push(`控制台报错 ${errors.length} 条：${errors[0]}`);
      if (luma < MIN_LUMA) problems.push(`画面几乎全黑（平均亮度 ${luma.toFixed(4)}）`);

      if (problems.length) {
        failures.push({ id, problems });
        console.log(`  ✗ ${id.padEnd(16)} ${problems.join('；')}`);
      } else {
        console.log(`  ✓ ${id.padEnd(16)} 亮度 ${luma.toFixed(4)}`);
      }
      await page.close();
    }
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }

  console.log('');
  if (failures.length) {
    console.log(`✗ ${failures.length}/${ids.length} 个场景有问题`);
    process.exit(1);
  }
  console.log(`✓ 全部 ${ids.length} 个场景通过`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
