import type { BreathingPattern } from '../scenes/types.js';

/** 呼吸阶段的中文标签。 */
const PHASE_LABEL: Record<string, string> = {
  inhale: '吸气',
  hold: '屏息',
  exhale: '呼气',
  holdOut: '停留',
};

const MIN_SCALE = 0.74;
const MAX_SCALE = 1;

/**
 * 呼吸引导：一个极简的圆环，跟着呼吸节奏缓慢缩放，并提示当前阶段。
 * 只在冥想场景出现，不抢画面。
 */
export class BreathingGuide {
  readonly element: HTMLElement;

  private readonly ring: HTMLElement;
  private readonly label: HTMLElement;
  private readonly pattern: BreathingPattern;
  private readonly cycle: number;

  constructor(pattern: BreathingPattern) {
    this.pattern = pattern;
    this.cycle = pattern.inhale + pattern.hold + pattern.exhale + (pattern.holdOut ?? 0);

    this.element = document.createElement('div');
    this.element.className = 'breath';

    const halo = document.createElement('span');
    halo.className = 'breath__halo';

    this.ring = document.createElement('span');
    this.ring.className = 'breath__ring';

    this.label = document.createElement('span');
    this.label.className = 'breath__label';
    this.label.textContent = PHASE_LABEL.inhale;

    this.element.append(halo, this.ring, this.label);
  }

  /** 按共享时钟推进。 */
  update(elapsed: number): void {
    const t = elapsed % this.cycle;
    const { inhale, hold, exhale } = this.pattern;

    let scale = MAX_SCALE;
    let phase = 'inhale';

    if (t < inhale) {
      phase = 'inhale';
      const k = t / inhale;
      scale = MIN_SCALE + (MAX_SCALE - MIN_SCALE) * easeInOut(k);
    } else if (t < inhale + hold) {
      phase = 'hold';
      scale = MAX_SCALE;
    } else if (t < inhale + hold + exhale) {
      phase = 'exhale';
      const k = (t - inhale - hold) / exhale;
      scale = MAX_SCALE - (MAX_SCALE - MIN_SCALE) * easeInOut(k);
    } else {
      phase = 'holdOut';
      scale = MIN_SCALE;
    }

    this.ring.style.transform = `scale(${scale.toFixed(4)})`;
    this.ring.style.opacity = phase === 'hold' || phase === 'holdOut' ? '0.55' : '1';
    if (this.label.textContent !== PHASE_LABEL[phase]) {
      this.label.textContent = PHASE_LABEL[phase];
    }
  }

  dispose(): void {
    this.element.remove();
  }
}

/** 呼吸节奏使用平滑的缓入缓出，更接近真实呼吸。 */
function easeInOut(x: number): number {
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
}
