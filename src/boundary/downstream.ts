import type { Engine, Minutes } from '../kernel/engine.js';
import { hourOfDay } from '../kernel/engine.js';
import type { Rng } from '../kernel/rng.js';
import { CARE_LEVELS, type CareLevel, type Isolation, type PatientId, type RequestId } from '../domain/types.js';

/**
 * THE BOUNDARY.
 *
 * Everything past the ED exit sits behind this interface. In Module 1 it is
 * backed by `StochasticDownstream` — an exogenous bed-release process the agent
 * cannot influence. In Module 2 the same interface is backed by a live ward
 * simulation the agent *can* act on.
 *
 * The contract is what makes that swap additive rather than a rewrite, so the
 * rules below are load-bearing:
 *
 *  1. `peekCapacity` is ALWAYS noisy and stale, in every implementation. A
 *     policy trained against v1 must not learn to trust a clean signal that
 *     later becomes real-but-still-noisy.
 *  2. New downstream abilities (expediteDischarge, pushEvs) arrive as OPTIONAL
 *     methods. v1 omits them; the action mask hides them. ED code never
 *     branches on which implementation is installed.
 *  3. The ED never reaches past this interface. No ward state, ever.
 */
export interface DownstreamBeds {
  readonly kind: string;

  requestBed(req: BedRequestSpec): RequestId;
  poll(id: RequestId): BedRequestState;
  /** Take an offer. Returns the time the patient can physically move. */
  accept(id: RequestId): { readyAt: Minutes };
  cancel(id: RequestId): void;
  /** Noisy, stale view of downstream capacity. Never ground truth. */
  peekCapacity(): CapacityPeek[];

  // --- Module 2+ only. Absent in v1; gated out of the action mask. ---
  expediteDischarge?(bedHint: string): void;
  pushEvs?(bed: string): void;
}

export interface BedRequestSpec {
  patient: PatientId;
  level: CareLevel;
  isolation: Isolation;
  /** e.g. sex-cohorting or service-line constraints on a shared room. */
  cohort?: string;
  requestedAt: Minutes;
}

export type BedRequestState =
  | { status: 'queued'; positionHint: number | null }
  | { status: 'offered'; bed: string; readyAt: Minutes; expiresAt: Minutes }
  | { status: 'accepted'; bed: string; readyAt: Minutes }
  | { status: 'declined'; reason: string }
  | { status: 'cancelled' }
  | { status: 'unknown' };

export interface CapacityPeek {
  level: CareLevel;
  /** Noisy. Do not treat as ground truth. */
  occupied: number;
  capacity: number;
  /** Noisy count of beds expected to free within the horizon. */
  expectedReleases: number;
  horizonMinutes: number;
  /** How stale this reading is, in minutes. Always > 0. */
  staleness: number;
}

// --- v1: exogenous stochastic implementation --------------------------------

export interface StochasticDownstreamConfig {
  capacity: Record<CareLevel, number>;
  /** Occupancy at episode start, as a fraction of capacity. */
  initialOccupancy: Record<CareLevel, number>;
  /**
   * Multiplier on the base release rate. `boarding-crisis` throttles this hard.
   * 1.0 = a normally-functioning hospital.
   */
  releaseRateMultiplier: number;
  /** Probability a request for a given level is declined outright. */
  declineProbability: Partial<Record<CareLevel, number>>;
  /** Minutes an offer stays open before it is withdrawn and re-queued. */
  offerTtl: Minutes;
  startHour: number;
}

interface PendingRequest {
  id: RequestId;
  spec: BedRequestSpec;
  state: BedRequestState;
  /** Rank within its level queue, set at request time and never re-sorted:
   *  downstream is FIFO by request time. Requesting early is the ED's lever. */
  queuedAt: Minutes;
}

/**
 * Module 1 downstream: beds free on a fitted exogenous schedule.
 *
 * The release process reproduces the real morning-discharge lag. Inpatient
 * discharge orders are written on rounds but the bed does not actually free
 * until transport, paperwork, and EVS have run — so releases cluster in the
 * late afternoon, several hours after the ED's own arrival peak. That offset is
 * precisely why boarding peaks when it does, and it is the thing the ED cannot
 * fix from its side. Module 2 replaces this function with the ward simulation
 * that causes it.
 */
export class StochasticDownstream implements DownstreamBeds {
  readonly kind = 'stochastic-v1';

  private requests = new Map<RequestId, PendingRequest>();
  private occupied: Record<CareLevel, number>;
  private seq = 0;
  /** Cached noisy peek per level, refreshed on a lag to create staleness. */
  private peekCache = new Map<CareLevel, { peek: CapacityPeek; takenAt: Minutes }>();

  constructor(
    private readonly engine: Engine,
    private readonly rng: Rng,
    private readonly cfg: StochasticDownstreamConfig,
  ) {
    this.occupied = { ...cfg.initialOccupancy } as Record<CareLevel, number>;
    for (const level of CARE_LEVELS) {
      this.occupied[level] = Math.round(cfg.capacity[level] * cfg.initialOccupancy[level]);
    }
    this.scheduleNextRelease();
    this.scheduleAdmissionPressure();
  }

  requestBed(spec: BedRequestSpec): RequestId {
    const id = `bedreq-${++this.seq}`;
    const declineP = this.cfg.declineProbability[spec.level] ?? 0;
    // An ICU request for a patient who does not need ICU is where declines
    // concentrate: over-requesting burns scarce capacity and gets refused.
    const state: BedRequestState = this.rng.bool(declineP)
      ? { status: 'declined', reason: `no ${spec.level} capacity accepting at this time` }
      : { status: 'queued', positionHint: this.queueDepth(spec.level) };
    this.requests.set(id, { id, spec, state, queuedAt: spec.requestedAt });
    return id;
  }

  poll(id: RequestId): BedRequestState {
    const req = this.requests.get(id);
    if (!req) return { status: 'unknown' };
    // Expire stale offers: an unaccepted bed is withdrawn and goes to whoever
    // is next in line. Sitting on an offer costs you the bed.
    if (req.state.status === 'offered' && this.engine.now >= req.state.expiresAt) {
      req.state = { status: 'queued', positionHint: this.queueDepth(req.spec.level) };
      this.offerToNextInQueue(req.spec.level);
    }
    return req.state;
  }

  accept(id: RequestId): { readyAt: Minutes } {
    const req = this.requests.get(id);
    if (!req) throw new Error(`accept: unknown request ${id}`);
    if (req.state.status !== 'offered') {
      throw new Error(`accept: request ${id} is ${req.state.status}, not offered`);
    }
    const { bed, readyAt } = req.state;
    req.state = { status: 'accepted', bed, readyAt };
    this.occupied[req.spec.level] += 1;
    return { readyAt };
  }

  cancel(id: RequestId): void {
    const req = this.requests.get(id);
    if (!req) return;
    if (req.state.status === 'accepted') {
      this.occupied[req.spec.level] = Math.max(0, this.occupied[req.spec.level] - 1);
    }
    req.state = { status: 'cancelled' };
  }

  peekCapacity(): CapacityPeek[] {
    const horizon = 120;
    return CARE_LEVELS.map((level) => {
      const cached = this.peekCache.get(level);
      // Readings refresh every ~10 min, so the agent always sees a stale number.
      if (cached && this.engine.now - cached.takenAt < 10) {
        return { ...cached.peek, staleness: this.engine.now - cached.takenAt };
      }
      const trueOcc = this.occupied[level];
      const noise = Math.round(this.rng.normal(0, Math.max(1, this.cfg.capacity[level] * 0.06)));
      const peek: CapacityPeek = {
        level,
        occupied: Math.max(0, Math.min(this.cfg.capacity[level], trueOcc + noise)),
        capacity: this.cfg.capacity[level],
        expectedReleases: Math.max(0, Math.round(this.expectedReleases(level, horizon) + this.rng.normal(0, 1.2))),
        horizonMinutes: horizon,
        staleness: 0,
      };
      this.peekCache.set(level, { peek, takenAt: this.engine.now });
      return { ...peek, staleness: 0 };
    });
  }

  // --- internals ------------------------------------------------------------

  private queueDepth(level: CareLevel): number {
    let n = 0;
    for (const r of this.requests.values()) {
      if (r.spec.level === level && r.state.status === 'queued') n++;
    }
    return n;
  }

  /**
   * Hour-of-day release intensity. Peaks 14:00-18:00 — the discharge lag.
   * Returns a relative weight, not a rate.
   */
  private releaseIntensity(hour: number): number {
    // Bimodal-ish, heavily weighted to late afternoon, near-zero overnight.
    const afternoon = Math.exp(-Math.pow(hour - 16, 2) / 8);
    const latemorning = 0.35 * Math.exp(-Math.pow(hour - 11, 2) / 6);
    const overnight = 0.05;
    return afternoon + latemorning + overnight;
  }

  private expectedReleases(level: CareLevel, horizon: Minutes): number {
    const hour = hourOfDay(this.engine.now, this.cfg.startHour);
    const rate = this.baseReleaseRate(level) * this.releaseIntensity(hour) * this.cfg.releaseRateMultiplier;
    return rate * (horizon / 60);
  }

  /** Beds per hour at peak intensity, by level. Scales with unit size. */
  private baseReleaseRate(level: CareLevel): number {
    const perBedPerDay: Record<CareLevel, number> = {
      icu: 0.18,
      stepdown: 0.3,
      telemetry: 0.35,
      medsurg: 0.4,
      observation: 0.9,
    };
    return (this.cfg.capacity[level] * perBedPerDay[level]) / 8; // concentrated into ~8 effective hours
  }

  /** Poll the release process every 5 minutes of sim time. */
  private scheduleNextRelease(): void {
    this.engine.schedule(5, 'downstream:release-tick', () => {
      const hour = hourOfDay(this.engine.now, this.cfg.startHour);
      for (const level of CARE_LEVELS) {
        const rate =
          this.baseReleaseRate(level) * this.releaseIntensity(hour) * this.cfg.releaseRateMultiplier;
        const expected = rate * (5 / 60);
        const releases = this.rng.poisson(expected);
        for (let i = 0; i < releases; i++) this.releaseBed(level);
      }
      this.scheduleNextRelease();
    });
  }

  /**
   * The ED is not the only source of admissions. Direct admits, OR cases, and
   * transfers in also consume beds — otherwise the ED would face an unrealistic
   * open field and boarding would resolve itself.
   */
  private scheduleAdmissionPressure(): void {
    this.engine.schedule(15, 'downstream:external-admits', () => {
      for (const level of CARE_LEVELS) {
        const competing = this.rng.poisson(this.baseReleaseRate(level) * 0.45 * (15 / 60));
        this.occupied[level] = Math.min(this.cfg.capacity[level], this.occupied[level] + competing);
      }
      this.scheduleAdmissionPressure();
    });
  }

  private releaseBed(level: CareLevel): void {
    if (this.occupied[level] <= 0) return;
    this.occupied[level] -= 1;
    this.offerToNextInQueue(level);
  }

  /**
   * FIFO by request time within a level, with isolation feasibility applied.
   * The ED's lever is *when* it submits, not who it argues for after the fact —
   * which is why bed-request lead time is a headline metric.
   */
  private offerToNextInQueue(level: CareLevel): void {
    let best: PendingRequest | null = null;
    for (const r of this.requests.values()) {
      if (r.state.status !== 'queued' || r.spec.level !== level) continue;
      if (!best || r.queuedAt < best.queuedAt) best = r;
    }
    if (!best) return;

    // Isolation needs a private room; those take longer to materialise.
    const isoDelay = best.spec.isolation === 'none' ? 0 : this.rng.logSpread(35, 1.5);
    const transportPrep = this.rng.logSpread(18, 1.6);
    const readyAt = this.engine.now + isoDelay + transportPrep;

    best.state = {
      status: 'offered',
      bed: `${level}-${this.rng.int(1, this.cfg.capacity[level])}`,
      readyAt,
      expiresAt: this.engine.now + this.cfg.offerTtl,
    };
  }
}
