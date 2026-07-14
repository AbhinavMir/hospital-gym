import type { Engine, Minutes } from '../kernel/engine.js';
import type { Rng } from '../kernel/rng.js';
import type { Order, OrderId, Patient, PatientId } from '../domain/types.js';
import type { AmbientState } from '../externalities/ambient.js';
import { StressResponse } from '../externalities/ambient.js';
import type { SupplyProcess } from '../externalities/supply.js';

/**
 * Imaging.
 *
 * The structural facts that make this a scheduling problem rather than a delay:
 *  - modality servers are separate and contended
 *  - the patient must physically travel to the scanner, which costs an escort
 *    and removes the patient from the ED
 *  - the READ queue is separate from acquisition, so a fast scan can still sit
 *    unread for an hour
 *  - contrast is gated on renal clearance, and that gate is a hard floor
 */

export type Modality = 'ct' | 'us' | 'plain-film' | 'mri';

export interface ImagingStudy {
  name: string;
  modality: Modality;
  /** Median acquisition minutes. */
  acquisitionMedian: Minutes;
  /** Requires IV contrast → renal gate applies. */
  contrast: boolean;
  /** Time-critical protocols preempt the queue (stroke CT, pan-scan). */
  timeCritical: boolean;
  /** Portable studies come to the patient: no transport, no escort. */
  portable: boolean;
}

export const IMAGING_STUDIES: Record<string, ImagingStudy> = {
  'ct-head': { name: 'ct-head', modality: 'ct', acquisitionMedian: 10, contrast: false, timeCritical: true, portable: false },
  'cta-head-neck': { name: 'cta-head-neck', modality: 'ct', acquisitionMedian: 15, contrast: true, timeCritical: true, portable: false },
  'ct-abdomen': { name: 'ct-abdomen', modality: 'ct', acquisitionMedian: 18, contrast: true, timeCritical: false, portable: false },
  'ct-pan-scan': { name: 'ct-pan-scan', modality: 'ct', acquisitionMedian: 22, contrast: true, timeCritical: true, portable: false },
  cxr: { name: 'cxr', modality: 'plain-film', acquisitionMedian: 8, contrast: false, timeCritical: false, portable: true },
  'plain-film': { name: 'plain-film', modality: 'plain-film', acquisitionMedian: 9, contrast: false, timeCritical: false, portable: true },
  'fast-us': { name: 'fast-us', modality: 'us', acquisitionMedian: 6, contrast: false, timeCritical: true, portable: true },
  'us-abdomen': { name: 'us-abdomen', modality: 'us', acquisitionMedian: 22, contrast: false, timeCritical: false, portable: true },
  'mri-brain': { name: 'mri-brain', modality: 'mri', acquisitionMedian: 40, contrast: false, timeCritical: false, portable: false },
};

export interface ImagingConfig {
  scanners: Record<Modality, number>;
  /** Radiologists reading. Shared across modalities. */
  readers: number;
  /** Median minutes to protocol a study before it can be scheduled. */
  protocolMedian: Minutes;
}

interface Queued {
  order: OrderId;
  patient: PatientId;
  study: ImagingStudy;
  rank: number;
  queuedAt: Minutes;
}

export class Imaging {
  private queues = new Map<Modality, Queued[]>();
  private scannerBusy = new Map<Modality, Minutes[]>();
  private readerBusy: Minutes[];
  private rankSeq = 0;
  private transportRequests = new Map<OrderId, string>();

  constructor(
    private readonly engine: Engine,
    private readonly rng: Rng,
    private readonly ambient: AmbientState,
    private readonly transport: SupplyProcess<{ patient: PatientId; to: string; escort: boolean }>,
    private readonly cfg: ImagingConfig,
    private readonly orders: Map<OrderId, Order>,
    private readonly patients: Map<PatientId, Patient>,
    private readonly onResult: (order: Order) => void,
    private readonly onSafety: (
      kind: 'contrast-without-renal-clearance' | 'non-transportable-to-fixed-scanner',
      patient: PatientId,
      detail: string,
    ) => void,
  ) {
    for (const m of ['ct', 'us', 'plain-film', 'mri'] as Modality[]) {
      this.queues.set(m, []);
      this.scannerBusy.set(m, new Array(cfg.scanners[m] ?? 1).fill(0));
    }
    this.readerBusy = new Array(cfg.readers).fill(0);
    this.dispatchTick();
  }

  /**
   * Order a study. This is where the two hard floors bite:
   *  - contrast without renal clearance
   *  - sending a non-transportable patient to a fixed scanner
   * Both are checked here and refused, AND recorded — a refused unsafe action
   * still tells us the policy tried it.
   */
  order(order: Order, escort: boolean): { ok: boolean; reason?: string } {
    const study = IMAGING_STUDIES[order.name];
    if (!study) return { ok: false, reason: `unknown study ${order.name}` };
    const patient = this.patients.get(order.patient);
    if (!patient) return { ok: false, reason: 'unknown patient' };

    if (study.contrast && patient.renalCleared !== true) {
      this.onSafety(
        'contrast-without-renal-clearance',
        patient.id,
        `${order.name} requires contrast; renal clearance is ${patient.renalCleared === null ? 'unknown' : 'failed'}`,
      );
      return { ok: false, reason: 'contrast requires renal clearance (resulted creatinine)' };
    }

    if (!study.portable && !patient.transportable) {
      this.onSafety(
        'non-transportable-to-fixed-scanner',
        patient.id,
        `${order.name} is a fixed-scanner study; patient is not transportable`,
      );
      return { ok: false, reason: 'patient is not transportable to a fixed scanner' };
    }

    order.status = 'ordered';
    order.meta.modality = study.modality;
    order.meta.escort = escort;

    // Protocolling happens before the study can be scheduled.
    this.engine.schedule(this.rng.logSpread(this.cfg.protocolMedian, 1.5), 'imaging:protocolled', () => {
      order.status = 'scheduled';
      const q = this.queues.get(study.modality)!;
      q.push({
        order: order.id,
        patient: order.patient,
        study,
        // Time-critical protocols preempt: they enter the queue ahead of everything.
        rank: study.timeCritical ? -1_000_000 + this.rankSeq++ : order.priority === 'stat' ? this.rankSeq++ : 100_000 + this.rankSeq++,
        queuedAt: this.engine.now,
      });
    });
    return { ok: true };
  }

  /** Agent action: re-rank a modality queue. */
  prioritise(modality: Modality, orderIds: OrderId[]): void {
    const q = this.queues.get(modality);
    if (!q) return;
    let rank = -orderIds.length;
    for (const id of orderIds) {
      const item = q.find((x) => x.order === id);
      if (item) item.rank = rank++;
    }
  }

  /** Agent action: escalate a read that is sitting. */
  escalateRead(orderId: OrderId): { ok: boolean; reason?: string } {
    const o = this.orders.get(orderId);
    if (!o) return { ok: false, reason: `unknown order ${orderId}` };
    if (o.status !== 'awaiting-read') return { ok: false, reason: `order is ${o.status}, not awaiting-read` };
    o.meta.readEscalated = true;
    return { ok: true };
  }

  queueSnapshot(): { modality: Modality; depth: number; oldestWaitMinutes: number }[] {
    return [...this.queues.entries()].map(([modality, q]) => ({
      modality,
      depth: q.length,
      oldestWaitMinutes: q.length ? Math.round(this.engine.now - Math.min(...q.map((x) => x.queuedAt))) : 0,
    }));
  }

  /** Studies acquired but not yet read. The gap the agent must watch. */
  awaitingRead(): { order: OrderId; patient: PatientId; since: Minutes }[] {
    const out = [];
    for (const o of this.orders.values()) {
      if (o.kind === 'imaging' && o.status === 'awaiting-read') {
        out.push({ order: o.id, patient: o.patient, since: (o.meta.acquiredAt as number) ?? o.placedAt });
      }
    }
    return out;
  }

  private dispatchTick(): void {
    this.engine.schedule(1, 'imaging:dispatch', () => {
      for (const [modality, q] of this.queues.entries()) {
        q.sort((a, b) => a.rank - b.rank);
        const busy = this.scannerBusy.get(modality)!;
        for (const item of [...q]) {
          const slot = busy.findIndex((t) => t <= this.engine.now);
          if (slot < 0) break;
          const order = this.orders.get(item.order);
          const patient = this.patients.get(item.patient);
          if (!order || !patient || order.status === 'cancelled') {
            this.queues.set(modality, q.filter((x) => x !== item));
            continue;
          }

          // Portable studies come to the patient. Fixed scanners need transport,
          // and transport is a SupplyProcess like everything else — during a
          // surge, there is nobody to push the bed.
          if (!item.study.portable) {
            const existing = this.transportRequests.get(order.id);
            if (!existing) {
              this.transportRequests.set(
                order.id,
                this.transport.request({
                  patient: patient.id,
                  to: `${modality}-suite`,
                  escort: (order.meta.escort as boolean) ?? false,
                }),
              );
              continue;
            }
            const st = this.transport.poll(existing);
            if (st.status !== 'arrived') {
              if (st.status === 'no-show' || st.status === 'declined') this.transportRequests.delete(order.id);
              continue;
            }
            patient.phase = 'at-imaging';
          }

          this.queues.set(modality, this.queues.get(modality)!.filter((x) => x !== item));
          const s = this.ambient.stress;
          const duration = this.rng.logSpread(item.study.acquisitionMedian, 1.4) * StressResponse.grows(s, 1.3);
          busy[slot] = this.engine.now + duration;
          order.status = 'acquiring';

          this.engine.schedule(duration, 'imaging:acquired', () => {
            order.status = 'awaiting-read';
            order.meta.acquiredAt = this.engine.now;
            this.transportRequests.delete(order.id);
            // The patient comes back from the scanner.
            if (patient.phase === 'at-imaging') patient.phase = 'in-bed';
            this.enqueueRead(order, item.study);
          });
        }
      }
      this.dispatchTick();
    });
  }

  /**
   * The read queue is deliberately separate from acquisition. A scan can be
   * acquired in eight minutes and sit unread for ninety — and the agent's only
   * lever is escalation, which is finite.
   */
  private enqueueRead(order: Order, study: ImagingStudy): void {
    const slot = this.earliestSlot(this.readerBusy);
    const s = this.ambient.stress;
    const escalated = order.meta.readEscalated === true;
    const backlog = StressResponse.grows(s, 2.4);

    const startAt = study.timeCritical || escalated
      ? this.engine.now
      : Math.max(this.engine.now, this.readerBusy[slot]!);
    const duration = this.rng.logSpread(9, 1.5) * backlog;
    this.readerBusy[slot] = Math.max(this.readerBusy[slot]!, startAt + duration);

    this.engine.scheduleAt(startAt + duration, 'imaging:read', () => {
      // A late escalation still helps: re-check at read time.
      order.status = 'resulted';
      order.completedAt = this.engine.now;
      const patient = this.patients.get(order.patient);
      const severity = patient?.latent.severity ?? 0;
      order.critical = this.rng.bool(Math.min(0.85, 0.1 + 0.8 * severity) * (study.timeCritical ? 1 : 0.5));
      order.result = order.critical ? `${order.name}: acute abnormality` : `${order.name}: no acute finding`;
      this.onResult(order);
    });
  }

  private earliestSlot(busy: Minutes[]): number {
    let best = 0;
    for (let i = 1; i < busy.length; i++) if (busy[i]! < busy[best]!) best = i;
    return best;
  }
}
