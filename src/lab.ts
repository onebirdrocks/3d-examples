/**
 * 场景实验室：单个场景的独立调试页。
 * 通过 ?scene=<id> 加载对应场景，使用 import.meta.glob 动态发现场景模块，
 * 因此在部分场景文件尚未写完时也能单独验证其余场景。
 */
import * as THREE from 'three';
import { Stage } from './core/stage.js';
import type { SceneDefinition } from './scenes/types.js';

const modules = import.meta.glob<{ default?: SceneDefinition }>('./scenes/**/*.ts');

const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const meta = document.querySelector<HTMLElement>('#meta')!;
const err = document.querySelector<HTMLElement>('#err')!;
const errDetail = document.querySelector<HTMLElement>('#err-detail')!;

const params = new URLSearchParams(location.search);
const sceneId = params.get('scene') ?? '';
// 画质系数：回归检查会用 ?quality=0.5 降低成本（粒子数与细分密度都随它缩放），
// 人眼调试时保持默认的 1。
const quality = THREE.MathUtils.clamp(Number(params.get('quality') ?? 1) || 1, 0.25, 2);

function showError(error: unknown): void {
  err.style.display = 'grid';
  errDetail.textContent = error instanceof Error ? `${error.message}\n\n${error.stack ?? ''}` : String(error);
  meta.textContent = '加载失败';
}

async function resolveScene(id: string): Promise<SceneDefinition | null> {
  const entries = Object.entries(modules);
  const match =
    entries.find(([path]) => path.endsWith(`/${id}.ts`)) ??
    entries.find(([path]) => path.endsWith(`/${id}.ts`));
  if (!match) return null;
  const mod = await match[1]();
  const def = (mod.default ?? (mod as unknown as SceneDefinition)) as SceneDefinition;
  return def ?? null;
}

async function main(): Promise<void> {
  if (!sceneId) {
    meta.textContent = `可用场景：${Object.keys(modules)
      .map((p) => p.replace('./scenes/', '').replace(/\.ts$/, ''))
      .join(' · ')}`;
    return;
  }

  const def = await resolveScene(sceneId);
  if (!def) {
    showError(new Error(`找不到场景 "${sceneId}"`));
    return;
  }

  meta.innerHTML = `<b>${def.title}</b> · ${def.subtitle}<br /><span>${def.description}</span>`;

  const stage = new Stage({ canvas, quality });
  try {
    const instance = await def.create(stage.context);
    stage.mount(instance, def);
    stage.start();
  } catch (error) {
    showError(error);
  }
}

void main();
