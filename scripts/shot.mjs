#!/usr/bin/env node
/**
 * 给单个场景拍一张大图，用于人工核对构图。
 * 用法：node scripts/shot.mjs <scene-id> [out.png] [waitMs] [width] [height] [预设名]
 * 带预设名时走 scene.html，切到该预设并展开分层混音面板。
 */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

const id = process.argv[2] ?? 'moonlight-garden';
const out = process.argv[3] ?? `/tmp/shot-${id}.png`;
const waitMs = Number(process.argv[4] ?? 3000);
const width = Number(process.argv[5] ?? 1280);
const height = Number(process.argv[6] ?? 800);
const mode = process.argv[7] ?? '';
const base = process.env.SHOT_BASE ?? 'http://localhost:5173';

const executablePath = CHROME_PATHS.find((p) => existsSync(p));
if (!executablePath) {
  console.error('找不到 Chrome');
  process.exit(2);
}

const browser = await chromium.launch({
  executablePath,
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width, height } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 400));
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`.slice(0, 400)));

// 有模式切换的场景走 scene.html（带推子与晴/雨夜按钮），其余走 lab.html
if (mode) {
  await page.goto(`${base}/scene.html?id=${encodeURIComponent(id)}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(waitMs);
  const button = page.locator('.mode-btn', { hasText: mode }).first();
  await button.click();
  await page.waitForTimeout(2600);
  // 顺便展开分层混音面板，方便核对推子
  await page.locator('#mixer-toggle').click();
  await page.waitForTimeout(500);
} else {
  await page.goto(`${base}/lab.html?scene=${encodeURIComponent(id)}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(waitMs);
}

await page.screenshot({ path: out });
console.log(`saved ${out}`);
if (errors.length) {
  console.log('控制台报错：');
  for (const e of errors) console.log('  ' + e);
} else {
  console.log('无控制台报错');
}
await browser.close();
