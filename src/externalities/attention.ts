import type { Engine, Minutes } from '../kernel/engine.js';
import type { Rng } from '../kernel/rng.js';
import type { PatientId } from '../domain/types.js';

/**
 * ATTENTION — the finite resource most simulations omit, and the thing that
 * makes the operations job hard.
 *
 * Each human role is a server with finite attention. An interrupt occupies a
 * role for `resolutionCost` minutes, during which that role's clinical and
 * operational capacity is reduced. Interrupts queue, re-ring, and escalate.
 *
 * Without this, interrupts are free and the agent learns to answer everything.
 * With it, answering every interrupt at its *claimed* priority destroys
 * throughput, and ignoring by source destroys the one call that mattered.
 */

export type AttentionRole =
  | 'charge-nurse'
  | 'ed-attending'
  | 'house-supervisor'
  | 'unit-clerk'
  | 'registrar'
  | 'bedside-nurse'
  | 'security';

export type InterruptSource =
  | 'ems-radio'
  | 'report-handoff'
  | 'critical-callback'
  | 'billing'
  | 'legal-risk'
  | 'law-enforcement'
  | 'security'
  | 'family'
  | 'admin'
  | 'media';

/** Whether an interrupt may legally be deferred, and how far. */
export type Deferability = 'immediate' | 'deferrable' | 'schedulable';

export interface Interrupt {
  id: string;
  source: InterruptSource;
  channel: string;
  /** What the caller says the priority is. Every caller says urgent. */
  claimedPriority: number; // 1 (highest) .. 5
  /** What it actually is. Never exposed to the agent. Reward reads this. */
  truePriority: number;
  /** Only this role can resolve it. A clerk cannot absorb a critical callback. */
  roleRequired: AttentionRole;
  /** Roles this may legitimately be delegated to, if any. */
  delegableTo: AttentionRole[];
  /** Minutes of that role's attention consumed on resolution. */
  resolutionCost: Minutes;
  /** Wall-clock deadline; null when unbounded. Missing a hard one is a floor. */
  responseDeadline: Minutes | null;
  deferability: Deferability;
  /** Deferring this class past its deadline is a hard safety floor, not a cost. */
  hardFloorIfMissed: boolean;
  consequenceIfMissed: string;
  patient: PatientId | null;
  raisedAt: Minutes;
  /** Interrupts of the same source that can be resolved in one callback. */
  batchable: boolean;
  meta: Record<string, string | number | boolean>;
}

export type InterruptState =
  | { status: 'pending'; ringbacks: number }
  | { status: 'deferred'; until: Minutes; ringbacks: number }
  | { status: 'in-progress'; role: AttentionRole; until: Minutes }
  | { status: 'resolved'; at: Minutes; byRole: AttentionRole; latency: Minutes }
  | { status: 'missed'; at: Minutes; reason: string };

export interface RoleServer {
  role: AttentionRole;
  /** Number of humans in this role on duty. */
  headcount: number;
  /** Minutes of attention consumed by interrupts, cumulative. */
  attentionSpent: Minutes;
  /** Busy-until per person. Length === headcount. */
  busyUntil: Minutes[];
  /** What each person is currently handling, for observability. */
  handling: (string | null)[];
}

/**
 * Task-switch cost. An interrupted task takes longer to resume and carries an
 * elevated error probability. Interruption during medication preparation, order
 * entry, or handoff raises the error rate on that task specifically.
 */
export interface TaskSwitchEvent {
  at: Minutes;
  role: AttentionRole;
  interruptedTask: string;
  patient: PatientId | null;
  /** Extra minutes to resume. */
  resumePenalty: Minutes;
  /** Whether the interruption actually produced an error on the task. */
  causedError: boolean;
}

export class AttentionModel {
  private servers = new Map<AttentionRole, RoleServer>();
  private interrupts = new Map<string, { interrupt: Interrupt; state: InterruptState }>();
  private seq = 0;
  readonly taskSwitchEvents: TaskSwitchEvent[] = [];
  /** Interrupts that blew a hard deadline. Reported as safety floors. */
  readonly missedHardDeadlines: Interrupt[] = [];

  constructor(
    private readonly engine: Engine,
    private readonly rng: Rng,
    headcounts: Partial<Record<AttentionRole, number>>,
  ) {
    const roles: AttentionRole[] = [
      'charge-nurse',
      'ed-attending',
      'house-supervisor',
      'unit-clerk',
      'registrar',
      'bedside-nurse',
      'security',
    ];
    for (const role of roles) {
      const n = headcounts[role] ?? 1;
      this.servers.set(role, {
        role,
        headcount: n,
        attentionSpent: 0,
        busyUntil: new Array(n).fill(0),
        handling: new Array(n).fill(null),
      });
    }
    this.ringbackTick();
  }

  get all(): { interrupt: Interrupt; state: InterruptState }[] {
    return [...this.interrupts.values()];
  }

  pending(): { interrupt: Interrupt; state: InterruptState }[] {
    return this.all.filter((i) => i.state.status === 'pending' || i.state.status === 'deferred');
  }

  get(id: string): { interrupt: Interrupt; state: InterruptState } | undefined {
    return this.interrupts.get(id);
  }

  server(role: AttentionRole): RoleServer {
    const s = this.servers.get(role);
    if (!s) throw new Error(`unknown role ${role}`);
    return s;
  }

  /** Fraction of a role's capacity currently consumed by interrupt handling. */
  roleLoad(role: AttentionRole): number {
    const s = this.server(role);
    const busy = s.busyUntil.filter((t) => t > this.engine.now).length;
    return s.headcount === 0 ? 1 : busy / s.headcount;
  }

  raise(spec: Omit<Interrupt, 'id' | 'raisedAt'>): Interrupt {
    const interrupt: Interrupt = { ...spec, id: `int-${++this.seq}`, raisedAt: this.engine.now };
    this.interrupts.set(interrupt.id, { interrupt, state: { status: 'pending', ringbacks: 0 } });
    return interrupt;
  }

  /**
   * Answer an interrupt now. Occupies the role for `resolutionCost` minutes and
   * charges a task-switch cost against whatever that role was doing.
   */
  answer(id: string, byRole?: AttentionRole): AnswerResult {
    const entry = this.interrupts.get(id);
    if (!entry) return { ok: false, reason: 'unknown-interrupt' };
    const { interrupt, state } = entry;
    if (state.status === 'resolved' || state.status === 'missed') {
      return { ok: false, reason: `already-${state.status}` };
    }

    const role = byRole ?? interrupt.roleRequired;
    // Role-locking: some interrupts can only be resolved by a specific role.
    if (role !== interrupt.roleRequired && !interrupt.delegableTo.includes(role)) {
      return { ok: false, reason: `role-locked: requires ${interrupt.roleRequired}` };
    }

    const slot = this.freeSlot(role);
    if (slot === null) return { ok: false, reason: `${role} has no free capacity` };

    const server = this.server(role);
    // A non-required delegate is slower: they have to look things up.
    const penalty = role === interrupt.roleRequired ? 1 : 1.35;
    const cost = interrupt.resolutionCost * penalty * this.rng.logSpread(1, 1.25);
    const until = this.engine.now + cost;

    server.busyUntil[slot] = until;
    server.handling[slot] = interrupt.id;
    server.attentionSpent += cost;

    entry.state = { status: 'in-progress', role, until };
    this.engine.scheduleAt(until, 'attention:resolve', () => {
      const s = this.servers.get(role)!;
      const idx = s.handling.indexOf(interrupt.id);
      if (idx >= 0) s.handling[idx] = null;
      entry.state = {
        status: 'resolved',
        at: this.engine.now,
        byRole: role,
        latency: this.engine.now - interrupt.raisedAt,
      };
    });

    return { ok: true, occupiesUntil: until, role };
  }

  /**
   * Defer an interrupt. Legal for some classes, illegal for others — an illegal
   * deferral is a hard floor, not a cost. A mandatory-reporting clock or a
   * critical-value callback cannot be deferred.
   */
  defer(id: string, minutes: Minutes): AnswerResult {
    const entry = this.interrupts.get(id);
    if (!entry) return { ok: false, reason: 'unknown-interrupt' };
    const { interrupt, state } = entry;
    if (state.status !== 'pending' && state.status !== 'deferred') {
      return { ok: false, reason: `cannot defer a ${state.status} interrupt` };
    }
    if (interrupt.deferability === 'immediate') {
      return { ok: false, reason: 'illegal-deferral', illegalDeferral: true };
    }
    const until = this.engine.now + minutes;
    const ringbacks = state.status === 'deferred' ? state.ringbacks : 0;
    entry.state = { status: 'deferred', until, ringbacks };
    return { ok: true, deferredUntil: until };
  }

  /**
   * Batch several interrupts of one source into a single callback. The whole
   * batch costs one setup plus a marginal cost each — this is the correct play
   * for billing, and the reason `batchable` exists.
   */
  batch(ids: string[], byRole?: AttentionRole): AnswerResult {
    const entries = ids.map((id) => this.interrupts.get(id)).filter(Boolean) as {
      interrupt: Interrupt;
      state: InterruptState;
    }[];
    if (entries.length === 0) return { ok: false, reason: 'no-such-interrupts' };
    if (!entries.every((e) => e.interrupt.batchable)) {
      return { ok: false, reason: 'batch contains a non-batchable interrupt' };
    }
    const source = entries[0]!.interrupt.source;
    if (!entries.every((e) => e.interrupt.source === source)) {
      return { ok: false, reason: 'batch spans multiple sources' };
    }

    const role = byRole ?? entries[0]!.interrupt.roleRequired;
    const slot = this.freeSlot(role);
    if (slot === null) return { ok: false, reason: `${role} has no free capacity` };

    // One setup, then a discounted marginal cost per item.
    const head = entries[0]!.interrupt.resolutionCost;
    const tail = entries.slice(1).reduce((sum, e) => sum + e.interrupt.resolutionCost * 0.35, 0);
    const cost = (head + tail) * this.rng.logSpread(1, 1.2);
    const until = this.engine.now + cost;

    const server = this.server(role);
    server.busyUntil[slot] = until;
    server.handling[slot] = entries.map((e) => e.interrupt.id).join('+');
    server.attentionSpent += cost;

    for (const e of entries) e.state = { status: 'in-progress', role, until };
    this.engine.scheduleAt(until, 'attention:resolve-batch', () => {
      const s = this.servers.get(role)!;
      const idx = s.handling.findIndex((h) => h?.includes(entries[0]!.interrupt.id));
      if (idx >= 0) s.handling[idx] = null;
      for (const e of entries) {
        e.state = {
          status: 'resolved',
          at: this.engine.now,
          byRole: role,
          latency: this.engine.now - e.interrupt.raisedAt,
        };
      }
    });

    return { ok: true, occupiesUntil: until, role, batched: entries.length };
  }

  /**
   * Charge a task-switch against a role that is mid-task. Called by ED modules
   * when they start a task while the role is handling an interrupt: the task
   * takes longer to resume and may carry an error.
   *
   * `errorProneness` is the task's sensitivity: med prep, order entry, and
   * handoff are high; routine work is low.
   */
  chargeTaskSwitch(
    role: AttentionRole,
    task: string,
    patient: PatientId | null,
    errorProneness: number,
  ): TaskSwitchEvent | null {
    const load = this.roleLoad(role);
    if (load <= 0) return null;
    const resumePenalty = this.rng.logSpread(1.5, 1.8) * load;
    const errorP = Math.min(0.4, 0.06 * errorProneness * (0.5 + load));
    const ev: TaskSwitchEvent = {
      at: this.engine.now,
      role,
      interruptedTask: task,
      patient,
      resumePenalty,
      causedError: this.rng.bool(errorP),
    };
    this.taskSwitchEvents.push(ev);
    return ev;
  }

  private freeSlot(role: AttentionRole): number | null {
    const s = this.server(role);
    for (let i = 0; i < s.headcount; i++) {
      if ((s.busyUntil[i] ?? 0) <= this.engine.now) return i;
    }
    return null;
  }

  /**
   * An unanswered phone rings back. An unacknowledged page re-pages with
   * escalation, and deadlines eventually blow. This is what makes ignoring an
   * interrupt an active choice with a cost rather than a free no-op.
   */
  private ringbackTick(): void {
    this.engine.schedule(5, 'attention:ringback', () => {
      for (const entry of this.interrupts.values()) {
        const { interrupt, state } = entry;

        if (state.status === 'deferred' && this.engine.now >= state.until) {
          entry.state = { status: 'pending', ringbacks: state.ringbacks };
        }

        if (entry.state.status === 'pending') {
          const waited = this.engine.now - interrupt.raisedAt;
          // Ring back roughly every 6 minutes; each ringback escalates.
          const expected = Math.floor(waited / 6);
          if (expected > entry.state.ringbacks) {
            entry.state = { status: 'pending', ringbacks: expected };
          }
        }

        // Deadline enforcement.
        const active = entry.state.status === 'pending' || entry.state.status === 'deferred';
        if (active && interrupt.responseDeadline !== null && this.engine.now > interrupt.responseDeadline) {
          entry.state = {
            status: 'missed',
            at: this.engine.now,
            reason: interrupt.consequenceIfMissed,
          };
          if (interrupt.hardFloorIfMissed) this.missedHardDeadlines.push(interrupt);
        }
      }
      this.ringbackTick();
    });
  }
}

export type AnswerResult =
  | { ok: true; occupiesUntil?: Minutes; role?: AttentionRole; deferredUntil?: Minutes; batched?: number }
  | { ok: false; reason: string; illegalDeferral?: boolean };

/**
 * Source-specific base rates for false urgency.
 *
 * Every caller claims urgency; the agent must learn the per-source discount
 * rather than take claims at face value. These generate `claimedPriority` from
 * `truePriority`. Billing claims high and is almost never high. Legal claims
 * high and sometimes is. A critical callback claims high and always is — which
 * is exactly why a policy that discounts uniformly by source gets people killed.
 */
export const FALSE_URGENCY: Record<InterruptSource, { inflate: number; maxInflation: number }> = {
  'ems-radio': { inflate: 0.25, maxInflation: 1 },
  'report-handoff': { inflate: 0.15, maxInflation: 1 },
  'critical-callback': { inflate: 0, maxInflation: 0 },
  billing: { inflate: 0.85, maxInflation: 3 },
  'legal-risk': { inflate: 0.3, maxInflation: 1 },
  'law-enforcement': { inflate: 0.6, maxInflation: 2 },
  security: { inflate: 0.2, maxInflation: 1 },
  family: { inflate: 0.7, maxInflation: 2 },
  admin: { inflate: 0.8, maxInflation: 3 },
  media: { inflate: 0.75, maxInflation: 3 },
};

/** Derive a claimed priority from a true one, per source base rate. */
export function claimPriority(source: InterruptSource, truePriority: number, rng: Rng): number {
  const { inflate, maxInflation } = FALSE_URGENCY[source];
  if (!rng.bool(inflate)) return truePriority;
  const bump = rng.int(1, Math.max(1, maxInflation));
  return Math.max(1, truePriority - bump);
}
