import type { Engine, Minutes } from '../kernel/engine.js';
import type { Rng } from '../kernel/rng.js';
import type { AmbientState } from './ambient.js';
import { StressResponse } from './ambient.js';

/**
 * PRIMITIVE 1 — SupplyProcess. Solicited: the agent requests, the world answers.
 *
 * Every solicited externality in the system is one of these: rideshare, NEMT,
 * BLS/ALS/CCT, OR rooms, downstream beds, psych beds, consultants, EVS,
 * internal transport, blood products.
 *
 * The contract is uniform so that Modules 2-5 can replace a stochastic
 * responder with a real simulation without the agent's code changing.
 *
 * Every implementation MUST produce, at calibrated rates: latency, timeouts,
 * declines, revised ETAs, wrong ETAs, no-shows, cancellations, and correlated
 * degradation driven by S. An agent trained against a supply process that
 * always accepts and always arrives on time learns no retry logic, no fallback,
 * and no hedging.
 */
export interface SupplyProcess<Spec = unknown> {
  readonly name: string;
  request(spec: Spec): string;
  poll(id: string): SupplyStatus;
  cancel(id: string): CancelResult;
  /** Noisy, stale view of the pool. Never ground truth. */
  peek(): SupplyPeek;
}

export type SupplyStatus =
  | { status: 'accepted'; eta: Minutes; etaRevisions: number; unit?: string }
  | { status: 'queued'; position: number | null; eta: Minutes | null }
  | { status: 'declined'; reason: string }
  | { status: 'arrived'; at: Minutes; unit?: string }
  | { status: 'no-show'; reason: string }
  | { status: 'cancelled' }
  | { status: 'unknown' };

export type CancelResult = { ok: true } | { ok: false; reason: 'too-late'; cost: number };

export interface SupplyPeek {
  name: string;
  /** Noisy. */
  available: number;
  capacity: number;
  /** Noisy median ETA for a new request right now, or null if the pool is dry. */
  etaHint: Minutes | null;
  staleness: Minutes;
}

// --- generic stochastic responder -------------------------------------------

export interface StochasticSupplyConfig {
  name: string;
  /** Units in the pool at S=0. */
  capacity: number;
  /** Fraction of capacity actually available at S=0, before hour-of-day. */
  baseAvailability: number;
  /** Availability multiplier at S=1. <1 means the pool shrinks under stress. */
  availabilityAtMaxStress: number;
  /** Median service ETA in minutes at S=0. */
  baseEta: Minutes;
  /** ETA multiplier at S=1. */
  etaAtMaxStress: number;
  /** Geometric spread of the ETA draw. */
  etaSpread: number;
  /** Decline probability at S=0 and S=1. */
  declineAtZeroStress: number;
  declineAtMaxStress: number;
  /** Probability an accepted request never shows, at S=0 and S=1. */
  noShowAtZeroStress: number;
  noShowAtMaxStress: number;
  /** Probability the ETA is revised upward at least once. */
  etaRevisionProbability: number;
  /** Cost charged if cancelled after this many minutes from acceptance. */
  cancelGraceMinutes: Minutes;
  cancelCost: number;
  /** Optional hour-of-day availability curve; returns a multiplier. */
  hourCurve?: (hour: number) => number;
  /** Units are released back to the pool after this long. */
  holdMinutes: Minutes;
}

interface SupplyRequest {
  id: string;
  spec: unknown;
  state: SupplyStatus;
  acceptedAt: Minutes | null;
  holdsUnit: boolean;
}

/**
 * Default stochastic implementation. Parameterised entirely by S-response
 * curves, which is what makes scarcity correlate across processes for free:
 * every instance reads the same `AmbientState`.
 */
export class StochasticSupply<Spec = unknown> implements SupplyProcess<Spec> {
  readonly name: string;
  private requests = new Map<string, SupplyRequest>();
  private seq = 0;
  private inUse = 0;
  private peekCache: { peek: SupplyPeek; at: Minutes } | null = null;

  constructor(
    protected readonly engine: Engine,
    protected readonly rng: Rng,
    protected readonly ambient: AmbientState,
    protected readonly cfg: StochasticSupplyConfig,
  ) {
    this.name = cfg.name;
  }

  /** Units currently free, ground truth. Internal only. */
  protected availableUnits(): number {
    const s = this.ambient.stress;
    const hourMult = this.cfg.hourCurve ? this.cfg.hourCurve(this.ambient.hour) : 1;
    const effective =
      this.cfg.capacity *
      this.cfg.baseAvailability *
      StressResponse.shrinks(s, this.cfg.availabilityAtMaxStress) *
      hourMult;
    return Math.max(0, Math.floor(effective) - this.inUse);
  }

  protected currentEta(): Minutes {
    const s = this.ambient.stress;
    const median = this.cfg.baseEta * StressResponse.grows(s, this.cfg.etaAtMaxStress);
    return this.rng.logSpread(median, this.cfg.etaSpread);
  }

  request(spec: Spec): string {
    const id = `${this.cfg.name}-${++this.seq}`;
    const s = this.ambient.stress;
    const declineP = StressResponse.probability(s, this.cfg.declineAtZeroStress, this.cfg.declineAtMaxStress);

    let state: SupplyStatus;
    if (this.rng.bool(declineP)) {
      state = { status: 'declined', reason: `${this.cfg.name}: no units accepting` };
    } else if (this.availableUnits() <= 0) {
      state = { status: 'queued', position: this.queueDepth() + 1, eta: null };
    } else {
      state = { status: 'accepted', eta: this.engine.now + this.currentEta(), etaRevisions: 0 };
    }

    const req: SupplyRequest = { id, spec, state, acceptedAt: null, holdsUnit: false };
    this.requests.set(id, req);
    if (state.status === 'accepted') this.onAccepted(req);
    return id;
  }

  poll(id: string): SupplyStatus {
    const req = this.requests.get(id);
    if (!req) return { status: 'unknown' };
    // Promote a queued request if a unit has since freed.
    if (req.state.status === 'queued' && this.availableUnits() > 0 && this.isNextInQueue(req)) {
      req.state = { status: 'accepted', eta: this.engine.now + this.currentEta(), etaRevisions: 0 };
      this.onAccepted(req);
    }
    return req.state;
  }

  cancel(id: string): CancelResult {
    const req = this.requests.get(id);
    if (!req) return { ok: true };
    const late =
      req.acceptedAt !== null && this.engine.now - req.acceptedAt > this.cfg.cancelGraceMinutes;
    this.release(req);
    req.state = { status: 'cancelled' };
    return late ? { ok: false, reason: 'too-late', cost: this.cfg.cancelCost } : { ok: true };
  }

  peek(): SupplyPeek {
    if (this.peekCache && this.engine.now - this.peekCache.at < 10) {
      return { ...this.peekCache.peek, staleness: this.engine.now - this.peekCache.at };
    }
    const trueAvail = this.availableUnits();
    const noise = Math.round(this.rng.normal(0, Math.max(0.8, this.cfg.capacity * 0.08)));
    const peek: SupplyPeek = {
      name: this.cfg.name,
      available: Math.max(0, Math.min(this.cfg.capacity, trueAvail + noise)),
      capacity: this.cfg.capacity,
      etaHint: trueAvail > 0 ? Math.round(this.currentEta()) : null,
      staleness: 0,
    };
    this.peekCache = { peek, at: this.engine.now };
    return { ...peek, staleness: 0 };
  }

  // --- internals ------------------------------------------------------------

  private queueDepth(): number {
    let n = 0;
    for (const r of this.requests.values()) if (r.state.status === 'queued') n++;
    return n;
  }

  private isNextInQueue(req: SupplyRequest): boolean {
    for (const r of this.requests.values()) {
      if (r.state.status === 'queued' && r.id !== req.id && r.id < req.id) return false;
    }
    return true;
  }

  private onAccepted(req: SupplyRequest): void {
    req.acceptedAt = this.engine.now;
    req.holdsUnit = true;
    this.inUse++;

    const s = this.ambient.stress;

    // ETA revision: the promised time was optimistic and gets walked back.
    if (this.rng.bool(this.cfg.etaRevisionProbability * StressResponse.grows(s, 2.0))) {
      const delay = this.rng.logSpread(this.cfg.baseEta * 0.5, 1.8);
      this.engine.schedule(this.rng.uniform(3, 12), `${this.cfg.name}:eta-revision`, () => {
        if (req.state.status !== 'accepted') return;
        req.state = {
          status: 'accepted',
          eta: req.state.eta + delay,
          etaRevisions: req.state.etaRevisions + 1,
        };
      });
    }

    // No-show: the unit was accepted and simply never arrives. The agent must
    // notice the ETA has passed; nothing tells it.
    const noShowP = StressResponse.probability(s, this.cfg.noShowAtZeroStress, this.cfg.noShowAtMaxStress);
    const willNoShow = this.rng.bool(noShowP);

    const settle = () => {
      if (req.state.status !== 'accepted') return;
      if (willNoShow) {
        req.state = { status: 'no-show', reason: `${this.cfg.name}: unit never arrived` };
        this.release(req);
      } else {
        req.state = { status: 'arrived', at: this.engine.now };
        this.engine.schedule(this.cfg.holdMinutes, `${this.cfg.name}:release`, () => this.release(req));
      }
    };

    const eta = req.state.status === 'accepted' ? req.state.eta : this.engine.now;
    this.engine.scheduleAt(eta, `${this.cfg.name}:settle`, () => {
      // Re-read in case the ETA was revised after this was scheduled.
      if (req.state.status === 'accepted' && this.engine.now < req.state.eta) {
        this.engine.scheduleAt(req.state.eta, `${this.cfg.name}:settle-revised`, settle);
        return;
      }
      settle();
    });
  }

  private release(req: SupplyRequest): void {
    if (req.holdsUnit) {
      req.holdsUnit = false;
      this.inUse = Math.max(0, this.inUse - 1);
    }
  }
}
