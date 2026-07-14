import type { Engine, Minutes } from '../kernel/engine.js';
import type { Rng } from '../kernel/rng.js';
import type { Order, OrderId, Patient, PatientId, Priority } from '../domain/types.js';
import type { AmbientState } from '../externalities/ambient.js';
import { StressResponse } from '../externalities/ambient.js';
import type { AttentionModel } from '../externalities/attention.js';
import { claimPriority } from '../externalities/attention.js';

/**
 * Laboratory.
 *
 * Full pipeline, because the point of the benchmark is that the agent can see
 * and act on each stage separately: collection queue → POCT vs central →
 * transport → accessioning → analysis → verification, with a rejection loop and
 * a critical-value callback clock.
 *
 * A lab modelled as "order in, result out after N minutes" teaches nothing. The
 * decisions live in the stages.
 */

export interface LabTest {
  name: string;
  /** Analyser minutes at STAT, median. */
  analysisMedian: Minutes;
  /** Available as point-of-care. */
  poct: boolean;
  /** POCT turnaround, median minutes. Faster but less precise. */
  poctMedian: Minutes;
  /** Probability the specimen is rejected (haemolysis, clotted, QNS, mislabel). */
  rejectionRate: number;
  /** Probability a result lands in the critical range, given a sick patient. */
  criticalRate: number;
}

export const LAB_TESTS: Record<string, LabTest> = {
  cbc: { name: 'cbc', analysisMedian: 25, poct: false, poctMedian: 0, rejectionRate: 0.05, criticalRate: 0.12 },
  bmp: { name: 'bmp', analysisMedian: 30, poct: true, poctMedian: 8, rejectionRate: 0.07, criticalRate: 0.15 },
  troponin: { name: 'troponin', analysisMedian: 35, poct: true, poctMedian: 12, rejectionRate: 0.04, criticalRate: 0.3 },
  lactate: { name: 'lactate', analysisMedian: 20, poct: true, poctMedian: 5, rejectionRate: 0.09, criticalRate: 0.35 },
  'blood-culture': { name: 'blood-culture', analysisMedian: 120, poct: false, poctMedian: 0, rejectionRate: 0.06, criticalRate: 0.05 },
  coags: { name: 'coags', analysisMedian: 40, poct: false, poctMedian: 0, rejectionRate: 0.08, criticalRate: 0.14 },
  glucose: { name: 'glucose', analysisMedian: 15, poct: true, poctMedian: 2, rejectionRate: 0.02, criticalRate: 0.2 },
  abg: { name: 'abg', analysisMedian: 15, poct: true, poctMedian: 4, rejectionRate: 0.12, criticalRate: 0.3 },
  bnp: { name: 'bnp', analysisMedian: 35, poct: false, poctMedian: 0, rejectionRate: 0.05, criticalRate: 0.1 },
  lipase: { name: 'lipase', analysisMedian: 30, poct: false, poctMedian: 0, rejectionRate: 0.05, criticalRate: 0.08 },
  'tox-screen': { name: 'tox-screen', analysisMedian: 55, poct: false, poctMedian: 0, rejectionRate: 0.04, criticalRate: 0.06 },
  'type-and-screen': { name: 'type-and-screen', analysisMedian: 45, poct: false, poctMedian: 0, rejectionRate: 0.05, criticalRate: 0.02 },
};

export interface LabConfig {
  /** Phlebotomists available for collection. */
  collectors: number;
  /** Parallel analyser channels in central lab. */
  analyserChannels: number;
  /** Techs verifying results before release. */
  verifiers: number;
  /** Minutes to walk a specimen to central lab, median. */
  transportMedian: Minutes;
  /** Critical-value callback must be acknowledged within this window. */
  callbackDeadline: Minutes;
}

type Route = 'poct' | 'central';

interface Specimen {
  order: OrderId;
  patient: PatientId;
  route: Route;
  collectedAt: Minutes | null;
  /** Set at collection; a mislabelled specimen is a wrong-patient identity floor. */
  mislabelled: boolean;
  priorityRank: number;
}

export class Laboratory {
  private collectionQueue: Specimen[] = [];
  private analyserBusy: Minutes[] = [];
  private verifierBusy: Minutes[] = [];
  private rankSeq = 0;
  /** Orders whose specimen was rejected and which the agent has not yet redrawn. */
  readonly rejected = new Set<OrderId>();

  constructor(
    private readonly engine: Engine,
    private readonly rng: Rng,
    private readonly ambient: AmbientState,
    private readonly attention: AttentionModel,
    private readonly cfg: LabConfig,
    private readonly orders: Map<OrderId, Order>,
    private readonly patients: Map<PatientId, Patient>,
    private readonly onResult: (order: Order) => void,
    private readonly onSafety: (kind: 'wrong-patient-identity', patient: PatientId, detail: string) => void,
  ) {
    this.analyserBusy = new Array(cfg.analyserChannels).fill(0);
    this.verifierBusy = new Array(cfg.verifiers).fill(0);
    this.collectionTick();
    this.analysisTick();
  }

  /** Place a lab order. `route` is the agent's POCT-vs-central decision. */
  order(order: Order, route: Route): { ok: boolean; reason?: string } {
    const test = LAB_TESTS[order.name];
    if (!test) return { ok: false, reason: `unknown lab test ${order.name}` };
    if (route === 'poct' && !test.poct) return { ok: false, reason: `${order.name} has no POCT assay` };

    order.status = 'collecting';
    order.meta.route = route;
    this.collectionQueue.push({
      order: order.id,
      patient: order.patient,
      route,
      collectedAt: null,
      mislabelled: false,
      priorityRank: order.priority === 'stat' ? this.rankSeq++ : 10_000 + this.rankSeq++,
    });
    return { ok: true };
  }

  /** Agent action: re-rank the collection queue. */
  prioritiseCollection(orderIds: OrderId[]): void {
    let rank = -orderIds.length;
    for (const id of orderIds) {
      const spec = this.collectionQueue.find((s) => s.order === id);
      if (spec) spec.priorityRank = rank++;
    }
  }

  get pendingCollections(): { order: OrderId; patient: PatientId; route: Route; waitingSince: Minutes }[] {
    return this.collectionQueue.map((s) => {
      const o = this.orders.get(s.order);
      return { order: s.order, patient: s.patient, route: s.route, waitingSince: o?.placedAt ?? 0 };
    });
  }

  /**
   * Redraw a rejected specimen. The agent must first NOTICE the rejection —
   * nothing pushes it. Detection latency is a headline metric because an
   * undetected rejection is an order that silently never results.
   */
  redraw(orderId: OrderId): { ok: boolean; reason?: string; newOrder?: string } {
    const original = this.orders.get(orderId);
    if (!original) return { ok: false, reason: `unknown order ${orderId}` };
    if (!original.rejected) return { ok: false, reason: `order ${orderId} was not rejected` };
    if (!this.rejected.has(orderId)) return { ok: false, reason: 'redraw already triggered' };

    this.rejected.delete(orderId);
    const redrawId = `${orderId}-redraw`;
    const redraw: Order = {
      ...original,
      id: redrawId,
      status: 'collecting',
      rejected: false,
      redrawOf: orderId,
      placedAt: this.engine.now,
      completedAt: null,
      result: null,
      critical: false,
      criticalAt: null,
      criticalAckedAt: null,
      meta: { ...original.meta },
    };
    this.orders.set(redrawId, redraw);
    const p = this.patients.get(original.patient);
    if (p) p.orders.push(redrawId);
    this.collectionQueue.push({
      order: redrawId,
      patient: redraw.patient,
      route: (redraw.meta.route as Route) ?? 'central',
      collectedAt: null,
      mislabelled: false,
      priorityRank: -1, // redraws jump: the clock has already been running
    });
    return { ok: true, newOrder: redrawId };
  }

  /** Acknowledge a critical-value callback. Requires a licensed provider with read-back. */
  acknowledgeCritical(orderId: OrderId): { ok: boolean; reason?: string } {
    const o = this.orders.get(orderId);
    if (!o) return { ok: false, reason: `unknown order ${orderId}` };
    if (!o.critical || o.criticalAt === null) return { ok: false, reason: 'no critical value pending' };
    if (o.criticalAckedAt !== null) return { ok: false, reason: 'already acknowledged' };
    o.criticalAckedAt = this.engine.now;
    return { ok: true };
  }

  /** Criticals still open, with time remaining on the callback clock. */
  openCriticals(): { order: OrderId; patient: PatientId; raisedAt: Minutes; deadline: Minutes }[] {
    const out = [];
    for (const o of this.orders.values()) {
      if (o.kind !== 'lab' || !o.critical || o.criticalAt === null || o.criticalAckedAt !== null) continue;
      out.push({
        order: o.id,
        patient: o.patient,
        raisedAt: o.criticalAt,
        deadline: o.criticalAt + this.cfg.callbackDeadline,
      });
    }
    return out;
  }

  // --- pipeline stages ------------------------------------------------------

  private collectionTick(): void {
    this.engine.schedule(1, 'lab:collect', () => {
      this.collectionQueue.sort((a, b) => a.priorityRank - b.priorityRank);
      const s = this.ambient.stress;
      // Collectors are fewer under stress, like everything else.
      const capacity = Math.max(1, Math.floor(this.cfg.collectors * StressResponse.shrinks(s, 0.6)));

      let drawn = 0;
      for (const spec of [...this.collectionQueue]) {
        if (drawn >= capacity) break;
        const order = this.orders.get(spec.order);
        if (!order || order.status !== 'collecting') {
          this.collectionQueue = this.collectionQueue.filter((x) => x !== spec);
          continue;
        }
        const patient = this.patients.get(spec.patient);
        // Cannot draw on a patient who is not physically present and settled.
        if (!patient || patient.phase === 'waiting-registration' || patient.phase === 'departed') continue;

        drawn++;
        this.collectionQueue = this.collectionQueue.filter((x) => x !== spec);

        // Mislabelling: rises sharply when the drawer is interrupted. This is
        // the mechanism behind the wrong-patient identity floor — it is not a
        // random gremlin, it is caused by the attention model.
        const sw = this.attention.chargeTaskSwitch('bedside-nurse', 'specimen-collection', spec.patient, 3.0);
        spec.mislabelled = sw?.causedError ?? false;

        const drawTime = this.rng.logSpread(4, 1.5) + (sw?.resumePenalty ?? 0);
        this.engine.schedule(drawTime, 'lab:drawn', () => {
          spec.collectedAt = this.engine.now;
          if (spec.mislabelled) {
            this.onSafety('wrong-patient-identity', spec.patient, `mislabelled specimen for ${order.name}`);
          }
          if (spec.route === 'poct') {
            this.runPoct(order, spec);
          } else {
            order.status = 'in-transit';
            this.engine.schedule(this.rng.logSpread(this.cfg.transportMedian, 1.6), 'lab:arrive', () => {
              this.accession(order, spec);
            });
          }
        });
      }
      this.collectionTick();
    });
  }

  private runPoct(order: Order, spec: Specimen): void {
    const test = LAB_TESTS[order.name]!;
    order.status = 'analysing';
    this.engine.schedule(this.rng.logSpread(test.poctMedian, 1.4), 'lab:poct-done', () => {
      // POCT skips accessioning and central verification: faster, and it also
      // skips the rejection check, which is precisely the trade.
      this.release(order, spec, true);
    });
  }

  private accession(order: Order, spec: Specimen): void {
    order.status = 'accessioned';
    const test = LAB_TESTS[order.name]!;
    this.engine.schedule(this.rng.logSpread(5, 1.5), 'lab:accessioned', () => {
      // Rejection: haemolysed, clotted, QNS, or mislabelled. The order dies here
      // and NOTHING tells the agent — it has to notice the absence.
      const s = this.ambient.stress;
      const rejectP = Math.min(0.6, test.rejectionRate * StressResponse.grows(s, 1.8) + (spec.mislabelled ? 0.5 : 0));
      if (this.rng.bool(rejectP)) {
        order.status = 'rejected';
        order.rejected = true;
        order.meta.rejectionReason = this.rng.pick(['haemolysed', 'clotted', 'quantity-not-sufficient', 'label-mismatch']);
        order.meta.rejectedAt = this.engine.now;
        this.rejected.add(order.id);
        return;
      }
      order.status = 'analysing';
      this.enqueueAnalysis(order, spec);
    });
  }

  private enqueueAnalysis(order: Order, spec: Specimen): void {
    const test = LAB_TESTS[order.name]!;
    // STAT preempts routine on the analyser: pick the earliest-free channel, and
    // let routine wait behind it.
    const slot = this.earliestSlot(this.analyserBusy);
    const startAt = Math.max(this.engine.now, order.priority === 'stat' ? this.engine.now : this.analyserBusy[slot]!);
    const duration = this.rng.logSpread(test.analysisMedian * (order.priority === 'stat' ? 1 : 1.8), 1.4);
    this.analyserBusy[slot] = startAt + duration;
    this.engine.scheduleAt(startAt + duration, 'lab:analysed', () => this.verify(order, spec));
  }

  private verify(order: Order, spec: Specimen): void {
    order.status = 'awaiting-verification';
    const slot = this.earliestSlot(this.verifierBusy);
    const startAt = Math.max(this.engine.now, this.verifierBusy[slot]!);
    const duration = this.rng.logSpread(4, 1.5);
    this.verifierBusy[slot] = startAt + duration;
    this.engine.scheduleAt(startAt + duration, 'lab:verified', () => this.release(order, spec, false));
  }

  private release(order: Order, spec: Specimen, poct: boolean): void {
    order.status = 'resulted';
    order.completedAt = this.engine.now;
    const test = LAB_TESTS[order.name]!;
    const patient = this.patients.get(order.patient);

    // Critical values track true severity: a sick patient produces sick numbers.
    const severity = patient?.latent.severity ?? 0;
    const criticalP = test.criticalRate * (0.3 + 1.4 * severity);
    order.critical = this.rng.bool(Math.min(0.9, criticalP));
    order.result = order.critical ? `${order.name}: CRITICAL` : `${order.name}: within expected range`;
    order.meta.poct = poct;

    if (order.critical) {
      order.criticalAt = this.engine.now;
      // The callback is an interrupt with a hard clock. It cannot be deferred
      // and it cannot be absorbed by a clerk: it needs a licensed provider with
      // read-back. This is the one interrupt where discounting by source kills.
      this.attention.raise({
        source: 'critical-callback',
        channel: 'lab-callback-line',
        claimedPriority: 1,
        truePriority: 1,
        roleRequired: 'ed-attending',
        delegableTo: [],
        resolutionCost: this.rng.logSpread(4, 1.3),
        responseDeadline: this.engine.now + this.cfg.callbackDeadline,
        deferability: 'immediate',
        hardFloorIfMissed: true,
        consequenceIfMissed: 'critical value never communicated',
        patient: order.patient,
        batchable: false,
        meta: { order: order.id, test: order.name },
      });
    }

    this.onResult(order);
  }

  private analysisTick(): void {
    // Keeps analyser slots from drifting into the past during idle stretches.
    this.engine.schedule(30, 'lab:analyser-maint', () => {
      for (let i = 0; i < this.analyserBusy.length; i++) {
        this.analyserBusy[i] = Math.max(this.analyserBusy[i]!, this.engine.now);
      }
      for (let i = 0; i < this.verifierBusy.length; i++) {
        this.verifierBusy[i] = Math.max(this.verifierBusy[i]!, this.engine.now);
      }
      this.analysisTick();
    });
  }

  private earliestSlot(busy: Minutes[]): number {
    let best = 0;
    for (let i = 1; i < busy.length; i++) if (busy[i]! < busy[best]!) best = i;
    return best;
  }
}

// --- blood bank -------------------------------------------------------------

export type BloodProduct = 'o-neg-emergency' | 'type-specific' | 'crossmatched' | 'mtp-pack';

/**
 * Blood bank, with the emergency ladder.
 *
 * The ladder exists because the fast product is the scarce one: uncrossmatched
 * O-neg is instant and rationed, type-specific needs a type-and-screen back,
 * crossmatched needs the full workup. Reaching for O-neg when there was time to
 * crossmatch wastes a genuinely scarce resource.
 */
export class BloodBank {
  private oNegUnits: number;
  private mtpActive = new Set<PatientId>();

  constructor(
    private readonly engine: Engine,
    private readonly rng: Rng,
    private readonly ambient: AmbientState,
    oNegStock: number,
  ) {
    this.oNegUnits = oNegStock;
  }

  get oNegAvailable(): number {
    return this.oNegUnits;
  }

  /** Pre-stage against a trauma pre-alert: warm the bank before arrival. */
  warm(patient: PatientId): { ok: boolean; readyAt: Minutes } {
    return { ok: true, readyAt: this.engine.now + this.rng.logSpread(6, 1.3) };
  }

  request(
    patient: PatientId,
    product: BloodProduct,
    units: number,
    hasTypeAndScreen: boolean,
  ): { ok: true; readyAt: Minutes } | { ok: false; reason: string } {
    switch (product) {
      case 'o-neg-emergency': {
        if (this.oNegUnits < units) return { ok: false, reason: `only ${this.oNegUnits} O-neg units in stock` };
        this.oNegUnits -= units;
        return { ok: true, readyAt: this.engine.now + this.rng.logSpread(3, 1.2) };
      }
      case 'type-specific': {
        if (!hasTypeAndScreen) return { ok: false, reason: 'type-specific requires a resulted type-and-screen' };
        return { ok: true, readyAt: this.engine.now + this.rng.logSpread(12, 1.4) };
      }
      case 'crossmatched': {
        if (!hasTypeAndScreen) return { ok: false, reason: 'crossmatch requires a resulted type-and-screen' };
        return { ok: true, readyAt: this.engine.now + this.rng.logSpread(35, 1.4) };
      }
      case 'mtp-pack': {
        this.mtpActive.add(patient);
        const s = this.ambient.stress;
        // MTP packs come in cycles; the bank slows under regional stress.
        const delay = this.rng.logSpread(10, 1.3) * StressResponse.grows(s, 1.8);
        this.oNegUnits = Math.max(0, this.oNegUnits - 4);
        return { ok: true, readyAt: this.engine.now + delay };
      }
    }
  }

  isMtpActive(patient: PatientId): boolean {
    return this.mtpActive.has(patient);
  }

  stopMtp(patient: PatientId): void {
    this.mtpActive.delete(patient);
  }
}
