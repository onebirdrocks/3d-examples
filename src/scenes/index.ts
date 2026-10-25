import type { SceneDefinition } from './types.js';

import volumetricScene from './procedural/volumetric.js';
import galaxyScene from './procedural/galaxy.js';
import fluidScene from './procedural/fluid.js';
import tunnelScene from './procedural/tunnel.js';
import auroraScene from './procedural/aurora.js';
import terrainScene from './procedural/terrain.js';
import stainedglassScene from './procedural/stainedglass.js';
import firefliesScene from './procedural/fireflies.js';

import materialLabScene from './models/material-lab.js';
import cityScene from './models/city.js';
import robotScene from './models/robot.js';
import helmetScene from './models/helmet.js';
import celadonScene from './models/celadon.js';
import terrariumScene from './models/terrarium.js';

import breathingScene from './meditation/breathing.js';
import rainwindowScene from './meditation/raindow.js';
import zenstonesScene from './meditation/zenstones.js';
import candleScene from './meditation/candle.js';
import tidesScene from './meditation/tides.js';
import mandalaScene from './meditation/mandala.js';

import voidDriftScene from './sleep/void-drift.js';
import snowfallScene from './sleep/snowfall.js';
import emberHearthScene from './sleep/ember-hearth.js';
import fogLighthouseScene from './sleep/fog-lighthouse.js';
import bambooWindScene from './sleep/bamboo-wind.js';
import tideCaveScene from './sleep/tide-cave.js';

import rainyStreetScene from './environment/rainy-street.js';
import forestStreamScene from './environment/forest-stream.js';
import seaCliffScene from './environment/sea-cliff.js';
import snowfieldScene from './environment/snowfield.js';
import desertNightScene from './environment/desert-night.js';

/** 全部场景，按画廊展示顺序排列。 */
export const SCENES: readonly SceneDefinition[] = [
  volumetricScene,
  galaxyScene,
  fluidScene,
  tunnelScene,
  auroraScene,
  terrainScene,
  stainedglassScene,
  firefliesScene,
  materialLabScene,
  cityScene,
  robotScene,
  helmetScene,
  celadonScene,
  terrariumScene,
  breathingScene,
  rainwindowScene,
  zenstonesScene,
  candleScene,
  tidesScene,
  mandalaScene,
  voidDriftScene,
  snowfallScene,
  emberHearthScene,
  fogLighthouseScene,
  bambooWindScene,
  tideCaveScene,
  rainyStreetScene,
  forestStreamScene,
  seaCliffScene,
  snowfieldScene,
  desertNightScene,
];

export const SCENE_CATEGORIES = [
  { id: 'all', label: '全部' },
  { id: 'procedural', label: '程序化效果' },
  { id: 'model', label: '模型 · 材质' },
  { id: 'meditation', label: '冥想' },
  { id: 'sleep', label: '助眠' },
  { id: 'environment', label: '真实环境' },
] as const;

export function getSceneById(id: string): SceneDefinition | undefined {
  return SCENES.find((scene) => scene.id === id);
}

export function getSceneIndex(id: string): number {
  return SCENES.findIndex((scene) => scene.id === id);
}

export function getAdjacentScene(id: string, direction: 1 | -1): SceneDefinition {
  const index = Math.max(0, getSceneIndex(id));
  const next = (index + direction + SCENES.length) % SCENES.length;
  return SCENES[next];
}
