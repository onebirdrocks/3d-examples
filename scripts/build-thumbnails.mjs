#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = await readFile(resolve(root, 'src/scenes/index.ts'), 'utf8');
const ids = [...source.matchAll(/from '\.\/(?:procedural|models|meditation|sleep|environment|simulation)\/([a-z0-9-]+)\.js'/g)].map((match) => match[1]);
const output = resolve(root, 'public/thumbnails');
if (process.argv.includes('--check')) {
  for (const id of ids) assert.ok((await stat(resolve(output, `${id}.webp`))).size > 100, `${id} 缺少预览图`);
  console.log(`✓ ${ids.length} 张静态预览完整`);
} else {
  const executablePath = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
  assert.ok(executablePath, '需要已有 Chrome / Chromium，不自动下载');
  const server = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
  let browser;
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ executablePath, args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
    const page = await browser.newPage();
    await page.route(`${base}/__bake`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Thumbnail generation</title>' }));
    await page.goto(`${base}/__bake`);
    await page.evaluate(async () => {
      const { ThumbnailBaker } = await import('/src/core/preview.ts');
      const { SCENES } = await import('/src/scenes/index.ts');
      window.baker = new ThumbnailBaker({ width: 560, quality: 0.6, warmupFrames: 2 });
      window.scenes = SCENES;
    });
    await mkdir(output, { recursive: true });
    for (const id of ids) {
      const url = await page.evaluate((id) => window.baker.bake(window.scenes.find((scene) => scene.id === id), { mimeType: 'image/webp' }), id);
      assert.ok(url.startsWith('data:image/webp;base64,'), `${id} 编码失败`);
      await writeFile(resolve(output, `${id}.webp`), Buffer.from(url.split(',')[1], 'base64'));
      console.log(`✓ ${id}`);
    }
    await page.evaluate(() => window.baker.dispose());
  } finally { await browser?.close(); await server.close(); }
}
