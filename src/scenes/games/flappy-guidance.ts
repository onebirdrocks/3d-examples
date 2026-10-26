import * as THREE from 'three';
import { FLIGHT, type FlappyFlight, type FlightPipe, type FlightPhase } from './flappy-model.js';

export interface FlightGuidance {
  target: FlightPipe | null;
  height: number;
  safeLow: number;
  safeHigh: number;
  alignment: 'low' | 'high' | 'aligned';
  motion: 'rising' | 'falling' | 'steady';
  crossing: boolean;
}

/** 依据当前鸟身的碰撞半径计算参考高度，不预测到达时刻或替玩家操作。 */
export function flightGuidance(flight: FlappyFlight): FlightGuidance {
  const low = FLIGHT.bottom + FLIGHT.radius, high = FLIGHT.top - FLIGHT.radius;
  const ratio = (value: number) => THREE.MathUtils.clamp((value - low) / (high - low), 0, 1);
  const halfWidth = (FLIGHT.pipeWidth + 0.07) / 2;
  let target: FlightPipe | null = null;
  for (const pipe of flight.pipes) {
    if (pipe.passed || pipe.x + halfWidth < FLIGHT.birdX - FLIGHT.radius) continue;
    if (!target || pipe.x < target.x) target = pipe;
  }
  const safeLow = target ? target.center - target.gap / 2 + FLIGHT.radius : low;
  const safeHigh = target ? target.center + target.gap / 2 - FLIGHT.radius : high;
  return {
    target, height: ratio(flight.y), safeLow: ratio(safeLow), safeHigh: ratio(safeHigh),
    alignment: flight.y < safeLow ? 'low' : flight.y > safeHigh ? 'high' : 'aligned',
    motion: flight.phase !== 'playing' ? 'steady' : flight.velocity > 0.12 ? 'rising' : flight.velocity < -0.12 ? 'falling' : 'steady',
    crossing: !!target && target.x - halfWidth <= FLIGHT.birdX + FLIGHT.radius,
  };
}

/** 20 Hz 更新的小型高度尺；世界中的飞行标记每帧更新。 */
export class FlightAltimeter {
  readonly root: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly canvas = document.createElement('canvas');
  private readonly context: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private elapsed = 0;
  private lastKey = '';

  constructor() {
    this.canvas.width = 512; this.canvas.height = 384;
    this.context = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas); this.texture.colorSpace = THREE.SRGBColorSpace;
    this.root = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.9), new THREE.MeshBasicMaterial({
      map: this.texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
    }));
    this.root.name = 'flappy-altimeter'; this.root.renderOrder = 8;
  }

  layout(visibleWidth: number, isXR: boolean): void {
    const scale = isXR ? 0.9 : Math.min(1, visibleWidth / 3.7);
    this.root.scale.setScalar(scale);
    this.root.position.set(isXR ? -1.55 : -Math.min(2.2, visibleWidth / 2 - 0.05) + 0.6 * scale, -0.08, -2.8);
  }

  update(sample: FlightGuidance, phase: FlightPhase, delta: number): void {
    this.elapsed += delta;
    const percent = Math.round(sample.height * 100);
    const key = `${percent}:${sample.safeLow.toFixed(3)}:${sample.safeHigh.toFixed(3)}:${sample.alignment}:${sample.motion}:${phase}:${sample.crossing}`;
    if (key === this.lastKey || (this.lastKey && delta > 0 && this.elapsed < 0.05)) return;
    this.lastKey = key; this.elapsed = 0;
    this.root.userData.height = sample.height; this.root.userData.alignment = sample.alignment;
    const c = this.context, font = 'system-ui, -apple-system, "PingFang SC", sans-serif';
    const accent = sample.alignment === 'aligned' ? '#a4f3d6' : '#ffcf7d';
    c.clearRect(0, 0, 512, 384);
    c.fillStyle = 'rgba(8,30,39,.94)'; c.beginPath(); c.roundRect(2, 2, 508, 380, 30); c.fill();
    c.strokeStyle = 'rgba(181,227,215,.3)'; c.lineWidth = 2; c.stroke();
    c.textAlign = 'left'; c.fillStyle = '#d7e9de'; c.font = `40px ${font}`; c.fillText('飞行高度', 30, 50);
    const y = (value: number) => 330 - value * 240;
    c.fillStyle = '#274650'; c.fillRect(44, 90, 50, 240);
    c.fillStyle = 'rgba(122,233,184,.46)'; c.fillRect(44, y(sample.safeHigh), 50, Math.max(2, (sample.safeHigh - sample.safeLow) * 240));
    c.strokeStyle = '#91b7b2'; c.lineWidth = 2;
    for (let i = 0; i <= 4; i++) { c.beginPath(); c.moveTo(32, y(i / 4)); c.lineTo(44, y(i / 4)); c.stroke(); }
    c.fillStyle = '#ffdc94'; c.beginPath(); c.moveTo(22, y(sample.height)); c.lineTo(39, y(sample.height) - 10); c.lineTo(39, y(sample.height) + 10); c.closePath(); c.fill();
    c.strokeStyle = '#ffdc94'; c.lineWidth = 5; c.beginPath(); c.moveTo(43, y(sample.height)); c.lineTo(100, y(sample.height)); c.stroke();
    c.fillStyle = '#f5ecd4'; c.font = `700 76px ${font}`; c.fillText(`${percent}%`, 133, 140);
    c.fillStyle = accent; c.font = `600 56px ${font}`;
    c.fillText(phase === 'over' ? '本局结束' : sample.alignment === 'low' ? '偏低 ↑' : sample.alignment === 'high' ? '偏高 ↓' : '高度对齐', 133, 203);
    c.fillStyle = '#d1e3d9'; c.font = `38px ${font}`;
    const motion = phase === 'paused' ? '已暂停' : sample.motion === 'rising' ? '↑ 正在上升' : sample.motion === 'falling' ? '↓ 正在下落' : '高度平稳';
    c.fillText(motion, 133, 254);
    c.fillStyle = '#a5c8bc'; c.font = `36px ${font}`; c.fillText(!sample.target ? '前方无障碍' : sample.crossing ? '绿带：正在穿越' : '绿带：下一缺口', 133, 313);
    const hint = sample.alignment === 'low'
      ? sample.motion === 'rising' ? '上升中，留意绿带' : '捏合 / 空格上升'
      : sample.alignment === 'high'
        ? sample.motion === 'falling' ? '回落中，留意绿带' : '稍等，自然下落'
        : sample.motion === 'rising' ? '留意绿带上沿' : sample.motion === 'falling' ? '留意绿带下沿' : '继续对准绿带';
    c.font = `28px ${font}`; c.fillText(hint, 133, 351);
    this.texture.needsUpdate = true;
  }

  dispose(): void { this.texture.dispose(); }
}
