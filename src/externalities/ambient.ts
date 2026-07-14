import type { Engine, Minutes } from '../kernel/engine.js';
import { hourOfDay } from '../kernel/engine.js';
import type { Rng } from '../kernel/rng.js';

/**
 * AMBIENT STATE — global modifiers. No request, no interrupt; these shift the
 * parameters of everything else.
 *
 * The centrepiece is `S(t)`, the shared latent system-stress factor.
 *
 * Why it exists: independent externalities make the environment far too easy.
 * The failure mode that actually breaks hospitals is that *everything degrades
 * at once*. A regional respiratory surge means more patients, fewer downstream
 * beds, fewer ambulances, and slower consultants — simultaneously, because they
 * share a cause. An agent that hedges against each scarcity independently will
 * be fine in a simulation with independent draws and will fail here.
 *
 * S is NOT directly observable. The agent sees noisy proxies (arrival rate,
 * decline rates, ETA drift, call-out reports) and must infer stress to act
 * ahead of it. Inferring rising S and pre-emptively hoarding capacity —
 * requesting beds earlier, starting placement earlier, calling staff in before
 * the crunch — is a graded anticipatory behaviour, not a freebie.
 */

export interface AmbientConfig {
  startHour: number;
  /** Long-run mean of S, in [0,1]. Seasonal baseline. */
  baselineStress: number;
  /** Mean-reversion speed per hour. Lower = stress persists longer. */
  reversion: number;
  /** Volatility of the stochastic component per sqrt(hour). */
  volatility: number;
  /** Scheduled stress injections, e.g. a mass-casualty event or a storm. */
  events: StressEvent[];
  /** IT/EHR downtime windows. */
  downtime: DowntimeWindow[];
  holiday: boolean;
}

export interface StressEvent {
  label: string;
  startsAt: Minutes;
  /** Minutes to ramp to full magnitude. */
  rampMinutes: Minutes;
  durationMinutes: Minutes;
  /** Added to S at peak, before clamping. */
  magnitude: number;
}

export interface DowntimeWindow {
  startsAt: Minutes;
  durationMinutes: Minutes;
  /** 'full' kills the read surface; 'partial' degrades it (stale, silent feeds). */
  severity: 'partial' | 'full';
  /**
   * If true, feeds go silent WITHOUT erroring. Distinguishing "the feed is dead"
   * from "the feed has nothing to report" is itself a graded capability.
   */
  silent: boolean;
}

export class AmbientState {
  /** Current latent stress, [0,1]. Never exposed to the agent. */
  private s: number;
  private lastUpdate: Minutes = 0;

  constructor(
    private readonly engine: Engine,
    private readonly rng: Rng,
    private readonly cfg: AmbientConfig,
  ) {
    this.s = cfg.baselineStress;
    this.tick();
  }

  /** Ground-truth stress. Simulation-internal only — never put this in an observation. */
  get stress(): number {
    return clamp01(this.s + this.eventContribution());
  }

  get holiday(): boolean {
    return this.cfg.holiday;
  }

  get hour(): number {
    return hourOfDay(this.engine.now, this.cfg.startHour);
  }

  /** Active downtime window, if any. */
  downtime(): DowntimeWindow | null {
    const t = this.engine.now;
    for (const w of this.cfg.downtime) {
      if (t >= w.startsAt && t < w.startsAt + w.durationMinutes) return w;
    }
    return null;
  }

  /** Labels of stress events currently active. Used for episode diagnostics. */
  activeEvents(): string[] {
    const t = this.engine.now;
    return this.cfg.events
      .filter((e) => t >= e.startsAt && t < e.startsAt + e.durationMinutes + e.rampMinutes)
      .map((e) => e.label);
  }

  /**
   * Noisy proxy of stress for the observation. This is the ONLY stress-ish
   * quantity the agent may see, and it is deliberately bad: heavy noise plus a
   * lag, so it confirms a surge roughly when the surge is already visible in
   * the board. Real anticipation has to come from the proxies the agent
   * assembles itself (decline rates, ETA drift, call-outs), not from this.
   */
  observedStressProxy(): number {
    const lagged = this.laggedStress();
    return clamp01(lagged + this.rng.normal(0, 0.12));
  }

  private laggedStress(): number {
    // A 45-minute lag, approximated by pulling toward the baseline.
    return 0.65 * this.s + 0.35 * this.cfg.baselineStress;
  }

  private eventContribution(): number {
    const t = this.engine.now;
    let total = 0;
    for (const e of this.cfg.events) {
      const dt = t - e.startsAt;
      if (dt < 0) continue;
      if (dt < e.rampMinutes) {
        total += e.magnitude * (dt / Math.max(1, e.rampMinutes));
      } else if (dt < e.rampMinutes + e.durationMinutes) {
        total += e.magnitude;
      } else {
        // Decay after the event, over one ramp-length.
        const since = dt - e.rampMinutes - e.durationMinutes;
        const decay = 1 - since / Math.max(1, e.rampMinutes);
        if (decay > 0) total += e.magnitude * decay;
      }
    }
    return total;
  }

  /**
   * Ornstein-Uhlenbeck step on the stochastic component, plus a diurnal and
   * weekly seasonal push. Stress is slow-moving and persistent by construction:
   * a bad afternoon stays bad, which is what forces anticipation to pay off.
   */
  private tick(): void {
    this.engine.schedule(10, 'ambient:stress-tick', () => {
      const dtHours = (this.engine.now - this.lastUpdate) / 60;
      this.lastUpdate = this.engine.now;

      const seasonal = this.seasonalPush();
      const target = clamp01(this.cfg.baselineStress + seasonal);
      const drift = this.cfg.reversion * (target - this.s) * dtHours;
      const shock = this.cfg.volatility * Math.sqrt(Math.max(dtHours, 1e-6)) * this.rng.normal();
      this.s = clamp01(this.s + drift + shock);

      this.tick();
    });
  }

  /** Diurnal load curve: ED stress builds through the day, peaks late afternoon. */
  private seasonalPush(): number {
    const h = this.hour;
    const diurnal = 0.18 * Math.exp(-Math.pow(h - 17, 2) / 18) - 0.08 * Math.exp(-Math.pow(h - 5, 2) / 10);
    return diurnal + (this.cfg.holiday ? 0.08 : 0);
  }
}

/**
 * Standard S-response curves. Externalities import these rather than
 * hand-rolling their own, so that "degrades with stress" means the same thing
 * everywhere and the correlation across processes is real rather than nominal.
 */
export const StressResponse = {
  /** Multiplier that grows with S. `atMax` is the value at S=1. */
  grows(s: number, atMax: number): number {
    return 1 + (atMax - 1) * s;
  },
  /** Multiplier that shrinks with S. `atMax` is the value at S=1, in (0,1]. */
  shrinks(s: number, atMax: number): number {
    return 1 - (1 - atMax) * s;
  },
  /**
   * Probability that rises convexly with S. Used for declines, call-outs, and
   * no-shows — these stay rare until stress is genuinely high, then bite hard.
   */
  probability(s: number, atZero: number, atMax: number): number {
    return clamp01(atZero + (atMax - atZero) * Math.pow(s, 1.7));
  },
};

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}
