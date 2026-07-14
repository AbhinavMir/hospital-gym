import { Heap } from './heap.js';

/** Simulation time, in minutes since episode start. */
export type Minutes = number;

interface ScheduledEvent {
  at: Minutes;
  seq: number;
  cancelled: boolean;
  label: string;
  fn: () => void;
}

/** Handle returned by `schedule`; lets a caller cancel a pending event. */
export interface Timer {
  readonly at: Minutes;
  readonly label: string;
  cancel(): void;
  get cancelled(): boolean;
}

/**
 * Discrete-event engine.
 *
 * Ties in `at` are broken by insertion order (`seq`), which is what makes the
 * whole simulation reproducible: two events scheduled for the same instant
 * always fire in the order they were scheduled, never in heap-internal order.
 */
export class Engine {
  private queue = new Heap<ScheduledEvent>((a, b) => (a.at !== b.at ? a.at < b.at : a.seq < b.seq));
  private seq = 0;
  private clock: Minutes = 0;
  private running = false;

  get now(): Minutes {
    return this.clock;
  }

  get pending(): number {
    return this.queue.size;
  }

  /** Schedule `fn` to run `delay` minutes from now. Delay must be >= 0. */
  schedule(delay: Minutes, label: string, fn: () => void): Timer {
    if (!(delay >= 0) || !Number.isFinite(delay)) {
      throw new Error(`Engine.schedule: bad delay ${delay} for "${label}"`);
    }
    const ev: ScheduledEvent = { at: this.clock + delay, seq: this.seq++, cancelled: false, label, fn };
    this.queue.push(ev);
    return {
      at: ev.at,
      label,
      cancel: () => {
        ev.cancelled = true;
      },
      get cancelled() {
        return ev.cancelled;
      },
    };
  }

  scheduleAt(time: Minutes, label: string, fn: () => void): Timer {
    return this.schedule(Math.max(0, time - this.clock), label, fn);
  }

  /**
   * Advance the clock to `until`, firing every event scheduled at or before it.
   * Events fired during the advance may schedule further events; those inside
   * the window run too. The clock always ends exactly at `until`.
   */
  runUntil(until: Minutes): void {
    if (this.running) throw new Error('Engine.runUntil: re-entrant call');
    this.running = true;
    try {
      for (;;) {
        const next = this.queue.peek();
        if (!next || next.at > until) break;
        this.queue.pop();
        if (next.cancelled) continue;
        this.clock = next.at;
        next.fn();
      }
      this.clock = Math.max(this.clock, until);
    } finally {
      this.running = false;
    }
  }

  /** Drop all pending events. Used by scenario teardown/reset. */
  clear(): void {
    this.queue = new Heap<ScheduledEvent>((a, b) => (a.at !== b.at ? a.at < b.at : a.seq < b.seq));
  }
}

// --- time helpers -----------------------------------------------------------

export const MINUTE = 1;
export const HOUR = 60;
export const DAY = 24 * HOUR;

/** Hour-of-day (0-23) for a sim time, given the episode's start hour. */
export function hourOfDay(t: Minutes, startHour: number): number {
  return Math.floor(((t / HOUR + startHour) % 24 + 24) % 24);
}

export function formatClock(t: Minutes, startHour = 0): string {
  const total = Math.floor(t) + startHour * 60;
  const d = Math.floor(total / (24 * 60));
  const h = Math.floor((total % (24 * 60)) / 60);
  const m = total % 60;
  const hhmm = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  return d > 0 ? `D${d + 1} ${hhmm}` : hhmm;
}
