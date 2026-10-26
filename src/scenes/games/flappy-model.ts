/** 以米与秒计算；固定物理步长使 60 / 90 / 120 Hz 下的手感一致。 */
export const FLIGHT = {
  left: -1.8, right: 1.8, bottom: 0.55, top: 2.55,
  birdX: -0.85, radius: 0.095, pipeWidth: 0.34, spacing: 1.65,
  gravity: -3.6, impulse: 1.5, step: 1 / 120,
} as const;

export type FlightPhase = 'ready' | 'playing' | 'paused' | 'over';
export interface FlightPipe { x: number; center: number; gap: number; passed: boolean }

export class FlappyFlight {
  phase: FlightPhase = 'ready';
  y = 1.55;
  velocity = 0;
  score = 0;
  distance = 0;
  readonly pipes: FlightPipe[] = [];
  private accumulator = 0;
  private restartWait = 0;

  constructor(private readonly random: () => number = Math.random) { this.reset(); }

  reset(): void {
    this.phase = 'ready';
    this.y = 1.55;
    this.velocity = 0;
    this.score = 0;
    this.distance = 0;
    this.accumulator = 0;
    this.restartWait = 0;
    this.pipes.length = 0;
    for (let i = 0; i < 4; i++) {
      const previous = this.pipes.at(-1)?.center ?? 1.55;
      this.pipes.push({ x: 1.55 + i * FLIGHT.spacing, center: this.nextCenter(previous), gap: 0.9, passed: false });
    }
  }

  /** 返回是否接受本次操作；碰撞后留出短暂间隔，避免意外重开。 */
  action(): boolean {
    if (this.phase === 'over') {
      if (this.restartWait > 0) return false;
      this.reset();
    }
    this.phase = 'playing';
    this.velocity = FLIGHT.impulse;
    return true;
  }

  pause(): void {
    if (this.phase === 'playing') { this.phase = 'paused'; this.accumulator = 0; }
  }

  advance(delta: number): void {
    if (!Number.isFinite(delta) || delta <= 0) return;
    const elapsed = Math.min(delta, 0.1);
    if (this.phase === 'over') { this.restartWait = Math.max(0, this.restartWait - elapsed); return; }
    if (this.phase !== 'playing') return;
    this.accumulator += elapsed;
    while (this.accumulator + 1e-10 >= FLIGHT.step && this.phase === 'playing') {
      this.accumulator -= FLIGHT.step;
      this.tick();
    }
  }

  private nextCenter(previous: number): number {
    return Math.max(1.16, Math.min(1.94, previous + (this.random() - 0.5) * 0.65));
  }

  private tick(): void {
    const f = FLIGHT;
    this.velocity += f.gravity * f.step;
    this.y += this.velocity * f.step;
    const speed = 0.92 + Math.min(this.score, 24) * 0.012;
    this.distance += speed * f.step;
    for (const pipe of this.pipes) pipe.x -= speed * f.step;

    // 管口比管身稍宽，判定覆盖整个管口；碰撞优先于计分。
    const hitPipe = this.pipes.some((pipe) => {
      const dx = Math.max(Math.abs(pipe.x - f.birdX) - (f.pipeWidth + 0.07) / 2, 0);
      const gapBottom = pipe.center - pipe.gap / 2;
      const gapTop = pipe.center + pipe.gap / 2;
      const dy = this.y < gapBottom ? 0 : this.y > gapTop ? 0 : Math.min(this.y - gapBottom, gapTop - this.y);
      return dx * dx + dy * dy < f.radius * f.radius;
    });
    if (this.y - f.radius <= f.bottom || this.y + f.radius >= f.top || hitPipe) {
      this.y = Math.max(f.bottom + f.radius, Math.min(f.top - f.radius, this.y));
      this.phase = 'over';
      this.restartWait = 0.65;
      this.accumulator = 0;
      return;
    }
    for (const pipe of this.pipes) {
      if (!pipe.passed && pipe.x + (f.pipeWidth + 0.07) / 2 < f.birdX - f.radius) {
        pipe.passed = true;
        this.score++;
      }
    }
    for (const pipe of this.pipes) {
      if (pipe.x > f.left - 0.4) continue;
      const last = this.pipes.reduce((a, b) => a.x > b.x ? a : b);
      pipe.x = last.x + f.spacing;
      pipe.center = this.nextCenter(last.center);
      pipe.gap = Math.max(0.76, 0.9 - this.score * 0.003);
      pipe.passed = false;
    }
  }
}
