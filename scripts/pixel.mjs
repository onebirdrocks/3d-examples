#!/usr/bin/env node
/**
 * 临时工具：采样截图里若干点的颜色，用来客观比较亮度。
 * 用法：node scripts/pixel.mjs <png> <x,y> [<x,y> ...]   （坐标按 1280x800 的参考图换算）
 */
import { chromium } from 'playwright-core';
import { existsSync, readFileSync } from 'node:fs';

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
];
const executablePath = CHROME_PATHS.find((p) => existsSync(p));
if (!executablePath) process.exit(2);

const file = process.argv[2];
const points = process.argv.slice(3).map((s) => s.split(',').map(Number));
const b64 = readFileSync(file).toString('base64');

const browser = await chromium.launch({ executablePath });
const page = await browser.newPage();
await page.goto('about:blank');
const result = await page.evaluate(
  async ([url, pts]) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return {
      size: [img.width, img.height],
      samples: pts.map(([x, y]) => {
        const d = ctx.getImageData(x, y, 1, 1).data;
        return { x, y, rgb: [d[0], d[1], d[2]], luma: +(0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2]).toFixed(1) };
      }),
    };
  },
  [`data:image/png;base64,${b64}`, points],
);
console.log(`size ${result.size[0]}x${result.size[1]}`);
for (const s of result.samples) {
  console.log(`(${s.x},${s.y}) rgb(${s.rgb.join(',')}) luma=${s.luma}`);
}
await browser.close();
