/** 使用真实经过时间计时，后台恢复后立即对齐截止时间。 */
export class ViewingSession {
  private deadline = 0;
  private ticker: number | undefined;

  constructor(private readonly callbacks: {
    onTick(seconds: number): void;
    onGain(gain: number): void;
    onComplete(): void;
  }, private readonly now = () => Date.now()) {}

  start(minutes: number): void {
    this.cancel();
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    this.deadline = this.now() + Math.min(120, minutes) * 60_000;
    this.ticker = window.setInterval(() => this.update(), 250);
    this.update();
  }

  update(): void {
    if (!this.deadline) return;
    const remaining = Math.max(0, this.deadline - this.now());
    this.callbacks.onTick(Math.ceil(remaining / 1000));
    this.callbacks.onGain(Math.min(1, remaining / 10_000));
    if (remaining === 0) {
      window.clearInterval(this.ticker);
      this.deadline = 0;
      this.callbacks.onComplete();
    }
  }

  cancel(): void {
    window.clearInterval(this.ticker);
    this.deadline = 0;
    this.callbacks.onGain(1);
    this.callbacks.onTick(0);
  }
}
