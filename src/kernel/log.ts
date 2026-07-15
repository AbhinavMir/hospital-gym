import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Minutes } from './engine.js';

/**
 * Structured episode logging.
 *
 * Every consequential thing that happens gets an event. The log is the audit
 * trail: given a run id you can reconstruct exactly what the agent saw, what it
 * did, what the world did back, and why the score came out the way it did.
 *
 * JSONL, one event per line, because it is greppable, streamable, and needs no
 * parser. Determinism means the same (scenario, seed, actions) reproduces the
 * same log byte-for-byte apart from wall-clock fields, which is what makes a
 * diff between two runs meaningful.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type EventKind =
  // lifecycle
  | 'episode.start'
  | 'episode.end'
  | 'step'
  // agent
  | 'action.ok'
  | 'action.refused'
  | 'action.invalid'
  // patients
  | 'patient.arrive'
  | 'patient.triage'
  | 'patient.room'
  | 'patient.provider'
  | 'patient.disposition'
  | 'patient.depart'
  | 'patient.deteriorate'
  | 'patient.death'
  | 'patient.lwbs'
  // orders
  | 'order.place'
  | 'order.result'
  | 'order.reject'
  | 'order.redraw'
  | 'order.critical'
  | 'order.critical.ack'
  | 'order.administered'
  // boundary
  | 'bed.request'
  | 'bed.offer'
  | 'bed.accept'
  | 'bed.cancel'
  // handoff
  | 'handoff.open'
  | 'handoff.attempt'
  | 'handoff.refused'
  | 'handoff.complete'
  | 'handoff.escalate'
  // supply
  | 'supply.request'
  | 'supply.accepted'
  | 'supply.declined'
  | 'supply.arrived'
  | 'supply.noshow'
  | 'supply.cancel'
  | 'supply.eta_revised'
  // attention
  | 'interrupt.raise'
  | 'interrupt.answer'
  | 'interrupt.defer'
  | 'interrupt.batch'
  | 'interrupt.missed'
  | 'interrupt.ringback'
  | 'taskswitch'
  // world
  | 'stress'
  | 'downtime.open'
  | 'downtime.close'
  | 'safety'
  | 'note';

export interface LogEvent {
  /** Sim minutes since episode start. The only clock that matters for replay. */
  t: number;
  /** Sim clock as HH:MM, for humans reading the tail. */
  clock: string;
  step: number;
  kind: EventKind;
  level: LogLevel;
  patient?: string | null;
  order?: string;
  msg?: string;
  data?: Record<string, unknown>;
}

export interface LoggerOptions {
  /** Directory for run logs. Created if absent. */
  dir?: string;
  /** Run identifier. Becomes the filename stem. */
  runId: string;
  /** Drop events below this level. */
  level?: LogLevel;
  /** Write to disk. Off for tests/benchmarks that only want the in-memory ring. */
  toFile?: boolean;
  /** Mirror to stderr. Never stdout — that may be an MCP transport. */
  toStderr?: boolean;
  /** Keep at most this many events in memory. 0 disables the ring. */
  ringSize?: number;
  /** Kinds to drop entirely. `step` is noisy; scenarios can mute it. */
  mute?: EventKind[];
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export class Logger {
  readonly runId: string;
  readonly path: string | null;
  private readonly minLevel: number;
  private readonly muted: Set<EventKind>;
  private readonly ring: LogEvent[] = [];
  private readonly ringSize: number;
  private readonly toStderr: boolean;
  private buffer: string[] = [];
  private counts = new Map<EventKind, number>();
  private closed = false;

  constructor(private readonly opts: LoggerOptions) {
    this.runId = opts.runId;
    this.minLevel = LEVEL_ORDER[opts.level ?? 'info'];
    this.muted = new Set(opts.mute ?? []);
    this.ringSize = opts.ringSize ?? 2000;
    this.toStderr = opts.toStderr ?? false;

    if (opts.toFile) {
      const dir = opts.dir ?? 'logs';
      mkdirSync(dir, { recursive: true });
      this.path = join(dir, `${opts.runId}.jsonl`);
      writeFileSync(this.path, '');
    } else {
      this.path = null;
    }
  }

  /** Events held in memory, oldest first. */
  get events(): readonly LogEvent[] {
    return this.ring;
  }

  /** Count per event kind. Cheap episode-shape summary. */
  get tally(): Record<string, number> {
    return Object.fromEntries([...this.counts.entries()].sort((a, b) => b[1] - a[1]));
  }

  emit(ev: LogEvent): void {
    if (this.closed) return;
    if (this.muted.has(ev.kind)) return;
    if (LEVEL_ORDER[ev.level] < this.minLevel) return;

    this.counts.set(ev.kind, (this.counts.get(ev.kind) ?? 0) + 1);

    if (this.ringSize > 0) {
      this.ring.push(ev);
      if (this.ring.length > this.ringSize) this.ring.shift();
    }

    if (this.path) {
      // Buffered: an ED episode emits tens of thousands of events and a
      // per-event write would dominate the runtime of the simulation itself.
      this.buffer.push(JSON.stringify(ev));
      if (this.buffer.length >= 256) this.flush();
    }

    if (this.toStderr) {
      const p = ev.patient ? ` ${ev.patient}` : '';
      process.stderr.write(`[${ev.clock}] ${ev.kind}${p}${ev.msg ? ' — ' + ev.msg : ''}\n`);
    }
  }

  flush(): void {
    if (!this.path || this.buffer.length === 0) return;
    appendFileSync(this.path, this.buffer.join('\n') + '\n');
    this.buffer = [];
  }

  /** Write the run summary next to the event log and stop accepting events. */
  close(summary: Record<string, unknown>): string | null {
    this.flush();
    this.closed = true;
    if (!this.path) return null;
    const p = this.path.replace(/\.jsonl$/, '.summary.json');
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ runId: this.runId, eventCounts: this.tally, ...summary }, null, 2));
    return p;
  }

  /** Filter the in-memory ring. For tests and the `logs` CLI. */
  where(pred: (e: LogEvent) => boolean): LogEvent[] {
    return this.ring.filter(pred);
  }
}

/**
 * A logger that costs nothing, so call sites never branch on whether logging is
 * on. Named rather than anonymous: an exported anonymous subclass cannot have a
 * declaration emitted for it.
 */
export class NullLogger extends Logger {
  constructor() {
    super({ runId: 'null', toFile: false, ringSize: 0 });
  }
  override emit(): void {}
  override flush(): void {}
  override close(): null {
    return null;
  }
}

export const NULL_LOGGER: Logger = new NullLogger();

/** Bind a logger to a clock so call sites do not repeat t/clock/step every time. */
export interface Emitter {
  (kind: EventKind, msg?: string, data?: Record<string, unknown>, opts?: Partial<LogEvent>): void;
}

export function makeEmitter(
  log: Logger,
  now: () => Minutes,
  clock: () => string,
  step: () => number,
): Emitter {
  return (kind, msg, data, opts) => {
    log.emit({
      t: Math.round(now() * 100) / 100,
      clock: clock(),
      step: step(),
      kind,
      level: opts?.level ?? defaultLevel(kind),
      ...(opts?.patient !== undefined ? { patient: opts.patient } : {}),
      ...(opts?.order !== undefined ? { order: opts.order } : {}),
      ...(msg !== undefined ? { msg } : {}),
      ...(data !== undefined ? { data } : {}),
    });
  };
}

function defaultLevel(kind: EventKind): LogLevel {
  if (kind === 'safety' || kind === 'patient.death') return 'error';
  if (
    kind === 'action.refused' ||
    kind === 'action.invalid' ||
    kind === 'order.reject' ||
    kind === 'patient.deteriorate' ||
    kind === 'patient.lwbs' ||
    kind === 'interrupt.missed' ||
    kind === 'supply.noshow' ||
    kind === 'supply.declined' ||
    kind === 'handoff.refused' ||
    kind === 'downtime.open'
  ) {
    return 'warn';
  }
  if (kind === 'step' || kind === 'stress' || kind === 'interrupt.ringback' || kind === 'taskswitch') return 'debug';
  return 'info';
}
