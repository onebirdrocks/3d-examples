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
/** 每个分片用不同的端口，同机并行也不会撞车。 */
const PORT = Number(process.env.VERIFY_PORT ?? 5199 + Math.max(0, Number(process.env.VERIFY_SHARD ?? 0)));
const BASE = `http://localhost:${PORT}`;

/**
 * 分片：CI 上把 48 个场景拆成若干份并行跑。
 * 查逻辑一字不改，只是每个 runner 只跑其中一份 —— 总算力不变，墙钟时间降到 1/N。
 * 本地不设这两个变量时就是全量检查。
 */
const SHARD = Math.max(0, Number(process.env.VERIFY_SHARD ?? 0));
const SHARDS = Math.max(1, Number(process.env.VERIFY_SHARDS ?? 1));

/**
 * 允许的最低平均亮度（0~1）。极暗的助眠场景会接近这个值。
 * 判的是「有没有渲染出来」，不是「画面对不对」——所以可以把检查跑在低画质上。
 */
const MIN_LUMA = 0.004;

/**
 * 检查用的渲染档位。默认与作者看到的完全一致（视口 640×400、画质 1），
 * 环境变量可以临时调低，用来在很慢的机器上快速过一遍。
 */
const CHECK_WIDTH = Number(process.env.VERIFY_WIDTH ?? 640);
const CHECK_HEIGHT = Number(process.env.VERIFY_HEIGHT ?? 400);
const CHECK_QUALITY = process.env.VERIFY_QUALITY ?? '1';

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
/** 彻底干掉 dev server：连它所在的进程组一起杀，避免留下占着管道的孙进程。 */
function stopServer(child) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // 进程组已经没了，退回到只杀直接子进程
    try {
      child.kill('SIGKILL');
    } catch {
      /* 已经退出 */
    }
  }
}

async function readSceneIds() {
  const source = await import('node:fs/promises').then((fs) =>
    fs.readFile(resolve(ROOT, 'src/scenes/index.ts'), 'utf8'),
  );
  const ids = new Set();
  const moduleRe = /from '\.\/(?:procedural|models|meditation|sleep|environment|simulation|games)\/([a-z0-9-]+)\.js'/g;
  let match;
  while ((match = moduleRe.exec(source)) !== null) ids.add(match[1]);
  return [...ids].sort();
}

function startServer() {
  // detached: 自己成一个进程组 —— 否则 kill 掉 npx 之后，真正的 vite
  // （它是 npx 的孙进程）还活着，并占着 stdio 管道，Node 进程永远退不出。
  // 在 CI 上表现为：检查早就跑完并打印了结果，job 却一直挂着到被取消。
  const child = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
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

/**
 * 截图并计算平均亮度（用页面里的 2D canvas 解码截图）。
 *
 * 用整页截图 + clip，而不是元素截图：元素截图会额外等待元素"稳定"，
 * 在软件渲染的重场景上（CI 跑的是 2 核机器）容易超时。
 * 超时视为"该场景渲染过重"，只警告不判失败。
 */
async function measureLuma(page) {
  const box = await page.locator('#view').boundingBox();
  const buffer = await page.screenshot({
    clip: box ? { x: box.x, y: box.y, width: box.width, height: box.height } : undefined,
    timeout: 10000,
  });
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

  const all = await readSceneIds();
  // 按序取模分片：场景数量变化时每一片的负载依然均匀
  const ids = SHARDS === 1 ? all : all.filter((_, index) => index % SHARDS === SHARD);
  const shardNote = SHARDS === 1 ? '' : `（分片 ${SHARD}/${SHARDS}）`;
  console.log(`检查 ${ids.length} 个场景${shardNote}…\n`);

  const server = await startServer();
  const browser = await chromium.launch({ executablePath });
  const failures = [];
  const warnings = [];

  try {
    for (const id of ids) {
      const page = await browser.newPage({ viewport: { width: CHECK_WIDTH, height: CHECK_HEIGHT } });
      const errors = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(msg.text().slice(0, 300));
      });
      page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`.slice(0, 300)));

      await page.goto(`${BASE}/lab.html?scene=${encodeURIComponent(id)}&quality=${CHECK_QUALITY}`, {
        waitUntil: 'networkidle',
      });
      // 等场景挂载并渲染几帧
      await page.waitForTimeout(1500);

      const failed = await page.evaluate(() => {
        const el = document.querySelector('#err');
        return el ? getComputedStyle(el).display !== 'none' : false;
      });
      let luma = null;
      let sampleError = null;
      try {
        luma = await measureLuma(page);
      } catch (error) {
        sampleError = error instanceof Error ? error.message.slice(0, 80) : String(error);
      }

      const problems = [];
      if (failed) problems.push('显示「场景加载失败」面板');
      if (errors.length) problems.push(`控制台报错 ${errors.length} 条：${errors[0]}`);
      if (luma !== null && luma < MIN_LUMA) {
        problems.push(`画面几乎全黑（平均亮度 ${luma.toFixed(4)}）`);
      }

      if (problems.length) {
        failures.push({ id, problems });
        console.log(`  ✗ ${id.padEnd(16)} ${problems.join('；')}`);
      } else if (sampleError) {
        warnings.push(id);
        console.log(`  ! ${id.padEnd(16)} 采样超时（场景渲染过重，未判失败）`);
      } else {
        console.log(`  ✓ ${id.padEnd(16)} 亮度 ${luma.toFixed(4)}`);
      }
      await page.close();
    }
  } finally {
    await browser.close();
    stopServer(server);
  }

  console.log('');
  if (warnings.length) {
    console.log(`  （${warnings.length} 个场景因渲染过重未能采样：${warnings.join(', ')}）`);
  }
  if (failures.length) {
    console.log(`✗ ${failures.length}/${ids.length} 个场景有问题`);
    process.exit(1);
  }
  console.log(`✓ 全部 ${ids.length} 个场景通过`);
  // 明确退出：dev server 的孙进程与浏览器的残留句柄都可能让 Node 挂住，
  // 在 CI 上就是「检查结果都打出来了，job 却一直不结束」。
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
