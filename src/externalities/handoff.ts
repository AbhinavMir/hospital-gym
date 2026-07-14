import type { Engine, Minutes } from '../kernel/engine.js';
import { hourOfDay } from '../kernel/engine.js';
import type { Rng } from '../kernel/rng.js';
import type { CareLevel, PatientId, StaffId } from '../domain/types.js';
import type { AmbientState } from './ambient.js';
import { StressResponse } from './ambient.js';
import type { AttentionModel } from './attention.js';

/**
 * THE REPORT HANDOFF RENDEZVOUS — "radio upstairs".
 *
 * A major, under-modelled boarding delay, and the highest-yield thing in this
 * module: it sits directly on the boarding path and is fully inside the ED's
 * control surface.
 *
 * The structural fact: a boarder cannot move even when a bed is clean and
 * assigned until report is given. The ED nurse and the receiving unit nurse
 * must be simultaneously free for a nurse-to-nurse handoff. The receiving nurse
 * is in a med pass, in an admission, at lunch, or on another handoff. So the
 * bed sits ready and the patient sits in the ED for another 30-60 minutes.
 *
 * This is NOT a queue and NOT a delay distribution. It is a rendezvous
 * requiring two specific role-instances free at the same time. Modelling it as
 * a plain service time removes exactly the decision the agent should be making.
 *
 * No single human role is currently accountable for this in most real EDs,
 * which is part of why it is worth putting in a benchmark.
 */

export type HandoffState =
  | { status: 'not-started' }
  | { status: 'attempting'; since: Minutes; attempts: number; lastRefusal: string | null }
  | { status: 'scheduled'; at: Minutes }
  | { status: 'in-progress'; startedAt: Minutes; endsAt: Minutes }
  | { status: 'complete'; at: Minutes; totalAttempts: number; waitedFrom: Minutes }
  | { status: 'abandoned'; at: Minutes; reason: string };

export interface HandoffRequest {
  id: string;
  patient: PatientId;
  /** ED nurse who must give report. A specific person, not a pool. */
  edNurse: StaffId;
  /** Receiving unit. Determines which nurse pool must supply the taker. */
  level: CareLevel;
  bed: string;
  state: HandoffState;
  createdAt: Minutes;
  /** Escalated to the house supervisor after unjustified refusals. */
  escalated: boolean;
}

export interface ReceivingNurse {
  id: StaffId;
  level: CareLevel;
  /** Busy until this time — med pass, admission, another handoff, lunch. */
  busyUntil: Minutes;
  /** Currently taking report for this handoff, if any. */
  handling: string | null;
}

export interface HandoffConfig {
  startHour: number;
  /** Receiving nurses per level. */
  nursesPerLevel: Record<CareLevel, number>;
  /** Base duration of a report, median minutes. */
  reportMedian: Minutes;
  reportSpread: number;
  /**
   * Shift-change windows (hour-of-day) where handoff throughput collapses.
   * Nobody takes report during change of shift.
   */
  shiftChangeHours: number[];
  /** Refusal probability outside shift change, at S=0 and S=1. */
  refusalAtZeroStress: number;
  refusalAtMaxStress: number;
}

export interface HandoffOutcome {
  patient: PatientId;
  /** Bed assigned -> report complete. The rendezvous delay, isolated. */
  bedToReportMinutes: Minutes;
  /** How many attempts it took. */
  attempts: number;
  refusalsReceived: number;
  escalated: boolean;
  duringShiftChange: boolean;
}

export class ReportHandoff {
  private requests = new Map<string, HandoffRequest>();
  private nurses: ReceivingNurse[] = [];
  private seq = 0;
  readonly outcomes: HandoffOutcome[] = [];
  private refusalCounts = new Map<string, number>();

  constructor(
    private readonly engine: Engine,
    private readonly rng: Rng,
    private readonly ambient: AmbientState,
    private readonly attention: AttentionModel,
    private readonly cfg: HandoffConfig,
  ) {
    for (const [level, n] of Object.entries(cfg.nursesPerLevel) as [CareLevel, number][]) {
      for (let i = 0; i < n; i++) {
        this.nurses.push({ id: `rn-${level}-${i}`, level, busyUntil: 0, handling: null });
      }
    }
    this.busyTick();
  }

  get all(): HandoffRequest[] {
    return [...this.requests.values()];
  }

  get(id: string): HandoffRequest | undefined {
    return this.requests.get(id);
  }

  byPatient(patient: PatientId): HandoffRequest | undefined {
    return this.all.find((r) => r.patient === patient);
  }

  /** Open a handoff once a bed is assigned. Does not attempt it — that's an action. */
  open(patient: PatientId, edNurse: StaffId, level: CareLevel, bed: string): HandoffRequest {
    const req: HandoffRequest = {
      id: `handoff-${++this.seq}`,
      patient,
      edNurse,
      level,
      bed,
      state: { status: 'not-started' },
      createdAt: this.engine.now,
      escalated: false,
    };
    this.requests.set(req.id, req);
    return req;
  }

  private inShiftChange(): boolean {
    const h = hourOfDay(this.engine.now, this.cfg.startHour);
    return this.cfg.shiftChangeHours.includes(h);
  }

  /**
   * Attempt report now. Requires the ED nurse to be free AND a receiving nurse
   * on the target unit to be free, simultaneously. Either being busy is a
   * failed attempt, not a queue position — the agent must try again.
   */
  attempt(id: string, edNurseFree: boolean): AttemptResult {
    const req = this.requests.get(id);
    if (!req) return { ok: false, reason: 'unknown-handoff' };
    if (req.state.status === 'complete') return { ok: false, reason: 'already-complete' };
    if (req.state.status === 'in-progress') return { ok: false, reason: 'already-in-progress' };

    const attempts = req.state.status === 'attempting' ? req.state.attempts + 1 : 1;

    // Side one of the rendezvous: the specific ED nurse must be free.
    if (!edNurseFree) {
      req.state = { status: 'attempting', since: this.engine.now, attempts, lastRefusal: 'ed-nurse-busy' };
      return { ok: false, reason: 'ed-nurse-busy', attempts };
    }

    // Shift-change blackout: throughput collapses. Refusals are near-certain.
    const shiftChange = this.inShiftChange();
    const s = this.ambient.stress;

    // A unit near shift change slow-walks report to delay an admission. This is
    // a real behaviour, so it is modelled as a refusal probability that spikes
    // at shift change rather than as an honest capacity constraint.
    const baseRefusal = StressResponse.probability(s, this.cfg.refusalAtZeroStress, this.cfg.refusalAtMaxStress);
    const refusalP = shiftChange ? Math.min(0.95, baseRefusal + 0.55) : baseRefusal;

    // Escalation to the house supervisor cuts through an unjustified refusal.
    const effectiveRefusal = req.escalated ? refusalP * 0.25 : refusalP;

    if (this.rng.bool(effectiveRefusal)) {
      const reason = shiftChange ? 'unit-refuses-shift-change' : 'unit-not-ready-to-take-report';
      req.state = { status: 'attempting', since: this.engine.now, attempts, lastRefusal: reason };
      this.refusalCounts.set(req.id, (this.refusalCounts.get(req.id) ?? 0) + 1);
      return { ok: false, reason, attempts, refusal: true };
    }

    // Side two: a receiving nurse on that unit must be free right now.
    const nurse = this.nurses.find((n) => n.level === req.level && n.busyUntil <= this.engine.now && !n.handling);
    if (!nurse) {
      req.state = { status: 'attempting', since: this.engine.now, attempts, lastRefusal: 'receiving-nurse-busy' };
      return { ok: false, reason: 'receiving-nurse-busy', attempts };
    }

    // Rendezvous achieved. Both parties are now locked for the report duration.
    const duration = this.rng.logSpread(this.cfg.reportMedian, this.cfg.reportSpread);
    const endsAt = this.engine.now + duration;
    nurse.busyUntil = endsAt;
    nurse.handling = req.id;
    req.state = { status: 'in-progress', startedAt: this.engine.now, endsAt };

    // Report is error-prone under interruption — this is one of the tasks where
    // a task-switch actually costs something clinical.
    this.attention.chargeTaskSwitch('bedside-nurse', 'report-handoff', req.patient, 2.5);

    this.engine.scheduleAt(endsAt, 'handoff:complete', () => {
      nurse.handling = null;
      const totalAttempts = attempts;
      req.state = { status: 'complete', at: this.engine.now, totalAttempts, waitedFrom: req.createdAt };
      this.outcomes.push({
        patient: req.patient,
        bedToReportMinutes: this.engine.now - req.createdAt,
        attempts: totalAttempts,
        refusalsReceived: this.refusalCounts.get(req.id) ?? 0,
        escalated: req.escalated,
        duringShiftChange: shiftChange,
      });
    });

    return { ok: true, reportEndsAt: endsAt, edNurseBusyUntil: endsAt };
  }

  /**
   * Escalate to the house supervisor when a unit is refusing report without
   * cause. Costs house-supervisor attention and is not free to spam: escalating
   * a unit that is legitimately slammed just burns the supervisor.
   */
  escalate(id: string): AttemptResult {
    const req = this.requests.get(id);
    if (!req) return { ok: false, reason: 'unknown-handoff' };
    if (req.escalated) return { ok: false, reason: 'already-escalated' };

    const refusals = this.refusalCounts.get(req.id) ?? 0;
    const answer = this.attention.answer(
      this.attention.raise({
        source: 'admin',
        channel: 'house-supervisor-line',
        claimedPriority: 2,
        truePriority: refusals >= 2 ? 2 : 4,
        roleRequired: 'house-supervisor',
        delegableTo: [],
        resolutionCost: 6,
        responseDeadline: null,
        deferability: 'deferrable',
        hardFloorIfMissed: false,
        consequenceIfMissed: 'handoff stays blocked',
        patient: req.patient,
        batchable: false,
        meta: { handoff: req.id, refusals },
      }).id,
    );
    if (!answer.ok) return { ok: false, reason: `escalation failed: ${answer.reason}` };

    req.escalated = true;
    return { ok: true };
  }

  /** Receiving nurses drift in and out of med passes, admissions, and lunch. */
  private busyTick(): void {
    this.engine.schedule(5, 'handoff:unit-activity', () => {
      const s = this.ambient.stress;
      for (const n of this.nurses) {
        if (n.handling || n.busyUntil > this.engine.now) continue;
        // Busier units under stress: fewer windows where anyone can take report.
        const p = 0.22 * StressResponse.grows(s, 2.2);
        if (this.rng.bool(Math.min(0.9, p))) {
          n.busyUntil = this.engine.now + this.rng.logSpread(18, 1.7);
        }
      }
      this.busyTick();
    });
  }

  /** Noisy view of how many receiving nurses look free. For the observation. */
  peekReceivingAvailability(): { level: CareLevel; freeNurses: number; staleness: Minutes }[] {
    const byLevel = new Map<CareLevel, number>();
    for (const n of this.nurses) {
      const free = n.busyUntil <= this.engine.now && !n.handling ? 1 : 0;
      byLevel.set(n.level, (byLevel.get(n.level) ?? 0) + free);
    }
    return [...byLevel.entries()].map(([level, free]) => ({
      level,
      freeNurses: Math.max(0, free + Math.round(this.rng.normal(0, 0.6))),
      staleness: this.rng.uniform(2, 8),
    }));
  }
}

export type AttemptResult =
  | { ok: true; reportEndsAt?: Minutes; edNurseBusyUntil?: Minutes }
  | { ok: false; reason: string; attempts?: number; refusal?: boolean };
