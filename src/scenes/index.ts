import type { SceneDefinition } from './types.js';

import volumetricScene from './procedural/volumetric.js';
import galaxyScene from './procedural/galaxy.js';
import fluidScene from './procedural/fluid.js';
import tunnelScene from './procedural/tunnel.js';
import auroraScene from './procedural/aurora.js';
import terrainScene from './procedural/terrain.js';
import stainedglassScene from './procedural/stainedglass.js';
import firefliesScene from './procedural/fireflies.js';
import gpuTideScene from './procedural/gpu-tide.js';
import metaballScene from './procedural/metaball.js';
import neonPipelineScene from './procedural/neon-pipeline.js';
import crystalCaveScene from './procedural/crystal-cave.js';

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
import breathingUniverseScene from './meditation/breathing-universe.js';

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
import teaRoomScene from './environment/tea-room.js';
import planetariumScene from './environment/planetarium.js';

import silkDrapeScene from './simulation/silk-drape.js';
import pianoRuinsScene from './simulation/piano-ruins.js';

import deepVoidScene from './sleep/deep-void.js';
import moonWellScene from './sleep/moon-well.js';
import paperLanternsScene from './sleep/paper-lanterns.js';
import sandFallScene from './sleep/sand-fall.js';

import mistyPinesScene from './environment/misty-pines.js';
import harborDuskScene from './environment/harbor-dusk.js';
import riceTerraceScene from './environment/rice-terrace.js';
import moonlightGardenScene from './environment/moonlight-garden.js';
import flappyBirdScene from './games/flappy-bird.js';

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
  gpuTideScene,
  metaballScene,
  neonPipelineScene,
  crystalCaveScene,
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
  breathingUniverseScene,
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
  teaRoomScene,
  planetariumScene,
  silkDrapeScene,
  pianoRuinsScene,
  deepVoidScene,
  moonWellScene,
  paperLanternsScene,
  sandFallScene,
  mistyPinesScene,
  harborDuskScene,
  riceTerraceScene,
  moonlightGardenScene,
  flappyBirdScene,
];

export const SCENE_CATEGORIES = [
  { id: 'all', label: '全部' },
  { id: 'procedural', label: '程序化效果' },
  { id: 'model', label: '模型 · 材质' },
  { id: 'meditation', label: '冥想' },
  { id: 'sleep', label: '助眠' },
  { id: 'environment', label: '真实环境' },
  { id: 'simulation', label: '模拟' },
  { id: 'game', label: '小游戏' },
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
