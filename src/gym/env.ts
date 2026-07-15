import { Engine, HOUR, type Minutes, formatClock, hourOfDay } from '../kernel/engine.js';
import { Rng } from '../kernel/rng.js';
import { Logger, NULL_LOGGER, makeEmitter, type Emitter, type LoggerOptions } from '../kernel/log.js';
import {
  advanceLatent,
  inDangerZone,
  measureVitals,
  orderTherapeuticValue,
  riskRate,
  unsafeDischargeRisk,
} from '../domain/physiology.js';
import type {
  CareLevel,
  Order,
  OrderId,
  Patient,
  PatientId,
  SafetyEvent,
  SafetyViolation,
} from '../domain/types.js';
import { StochasticDownstream, type DownstreamBeds } from '../boundary/downstream.js';
import { ExternalityRegistry } from '../externalities/registry.js';
import type { AttentionRole } from '../externalities/attention.js';
import { EdDepartment, needsMonitor } from '../modules/ed.js';
import { BloodBank, LAB_TESTS, Laboratory } from '../modules/labs.js';
import { IMAGING_STUDIES, Imaging, type Modality } from '../modules/imaging.js';
import { DRUGS, Pharmacy } from '../modules/pharmacy.js';
import { ArrivalProcess } from '../modules/arrivals.js';
import { DISCHARGE_LADDER, EmsAgency, TIER_COST, tierSatisfies, type TransportTier } from '../externalities/transport.js';
import { ActionSchema, actionMask, type Action, type ActionResult } from './actions.js';
import { DOOR_TO_PROVIDER_TARGET, computeReward, DEFAULT_WEIGHTS, type RewardComponents, type RewardTally } from './reward.js';
import { buildObservation, type Observation } from './observation.js';
import { collectMetrics, type Metrics } from './metrics.js';
import type { ScenarioSpec } from '../scenarios/types.js';

export interface StepResult {
  observation: Observation;
  /** Reward accrued during THIS step only. */
  reward: number;
  /** Cumulative reward breakdown to date. */
  components: RewardComponents;
  done: boolean;
  results: ActionResult[];
  info: {
    time: Minutes;
    clock: string;
    step: number;
    newSafetyEvents: SafetyEvent[];
  };
}

/**
 * The environment.
 *
 * A step advances the clock by `tickMinutes` and processes every event in that
 * window. Actions submitted for a step are applied at the START of the window —
 * the agent is deciding, then time passes, exactly like standing at the board.
 */
export class ErEnv {
  readonly engine = new Engine();
  private rng: Rng;
  readonly patients = new Map<PatientId, Patient>();
  readonly orders = new Map<OrderId, Order>();

  readonly registry: ExternalityRegistry;
  readonly downstream: DownstreamBeds;
  readonly ed: EdDepartment;
  readonly lab: Laboratory;
  readonly bloodBank: BloodBank;
  readonly imaging: Imaging;
  readonly pharmacy: Pharmacy;
  readonly arrivals: ArrivalProcess;

  readonly safetyEvents: SafetyEvent[] = [];
  /** Dedup keys for per-patient hard floors. See `recordSafety`. */
  private recordedFloors = new Set<string>();
  private stepCount = 0;
  private orderSeq = 0;
  private diversion = false;
  private diversionSince: Minutes | null = null;
  private diversionHours = 0;

  /** Bed requests the agent has open, by patient. */
  private bedRequests = new Map<PatientId, string>();
  /** Transport requests, by patient. */
  private transportRequests = new Map<PatientId, { tier: TransportTier; id: string }>();
  /** Consult requests, by order. */
  private consultRequests = new Map<OrderId, { service: string; id: string }>();
  /** OR requests, by patient. */
  private orRequests = new Map<PatientId, string>();
  /** Psychiatric bed requests, by patient. The longest boarding tail. */
  private psychRequests = new Map<PatientId, string>();
  /** Reassessment intervals set by the agent. */
  private reassessInterval = new Map<PatientId, Minutes>();
  /**
   * How far down the transport fallback ladder each patient ended up.
   * rideshare=1, nemt=2, taxi=3, family=4. Depth is the cost of a doomed
   * dispatch the agent waited through instead of re-planning early.
   */
  readonly ladderDepths: number[] = [];
  private ladderAttempts = new Map<PatientId, number>();
  /** System stress at the moment each bed request was submitted. */
  readonly stressAtBedRequest: number[] = [];

  private tally: RewardTally = emptyTally();
  private lastComponents: RewardComponents = computeReward(emptyTally());
  private prevTotal = 0;
  private lastAdvance: Minutes = 0;

  readonly log: Logger;
  /** Bound emitter: stamps sim time, clock, and step onto every event. */
  private readonly ev: Emitter;

  constructor(
    readonly scenario: ScenarioSpec,
    readonly seed: number | string,
    logging?: Partial<LoggerOptions> | Logger,
  ) {
    this.rng = new Rng(seed);

    this.log =
      logging instanceof Logger
        ? logging
        : logging
          ? new Logger({ runId: `${scenario.name}-${seed}`, ...logging })
          : NULL_LOGGER;
    this.ev = makeEmitter(
      this.log,
      () => this.engine.now,
      () => formatClock(this.engine.now, this.scenario.startHour),
      () => this.stepCount,
    );

    this.registry = new ExternalityRegistry(
      this.engine,
      this.rng.fork('externalities'),
      scenario.registry,
      () => [...this.patients.values()].filter((p) => p.phase !== 'departed').map((p) => p.id),
    );

    this.downstream = new StochasticDownstream(this.engine, this.rng.fork('downstream'), scenario.downstream);

    this.ed = new EdDepartment(
      this.engine,
      this.rng.fork('ed'),
      this.registry.ambient,
      this.registry.get('evs'),
      scenario.ed,
    );

    this.lab = new Laboratory(
      this.engine,
      this.rng.fork('lab'),
      this.registry.ambient,
      this.registry.attention,
      scenario.lab,
      this.orders,
      this.patients,
      (o) => this.onOrderResult(o),
      (kind, patient, detail) => this.recordSafety(kind, patient, detail),
    );

    this.bloodBank = new BloodBank(this.engine, this.rng.fork('blood'), this.registry.ambient, scenario.oNegStock);

    this.imaging = new Imaging(
      this.engine,
      this.rng.fork('imaging'),
      this.registry.ambient,
      this.registry.get('internal-transport'),
      scenario.imaging,
      this.orders,
      this.patients,
      (o) => this.onOrderResult(o),
      (kind, patient, detail) => this.recordSafety(kind, patient, detail),
    );

    this.pharmacy = new Pharmacy(
      this.engine,
      this.rng.fork('pharmacy'),
      this.registry.ambient,
      this.registry.attention,
      scenario.pharmacy,
      this.orders,
      this.patients,
      (o) => this.onOrderResult(o),
      (kind, patient, detail) => this.recordSafety(kind, patient, detail),
    );

    this.arrivals = new ArrivalProcess(
      this.engine,
      this.rng.fork('arrivals'),
      this.registry.ambient,
      this.registry.attention,
      scenario.arrivals,
      (p) => this.admitToEd(p),
    );

    this.physiologyTick();
    this.lwbsTick();
    this.boardingTick();
    this.consultTick();
    this.restraintTick();
    this.scheduleDowntimeFreezes();
  }

  // --- gym interface --------------------------------------------------------

  observe(): Observation {
    return buildObservation(this);
  }

  step(rawActions: unknown[] = []): StepResult {
    const results: ActionResult[] = [];
    const safetyBefore = this.safetyEvents.length;

    for (const raw of rawActions) {
      const parsed = ActionSchema.safeParse(raw);
      if (!parsed.success) {
        results.push({
          action: (raw as { type?: string })?.type as Action['type'],
          ok: false,
          reason: `invalid action: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
        });
        this.ev('action.invalid', 'schema rejected', { raw: raw as Record<string, unknown> });
        continue;
      }
      const r = this.apply(parsed.data);
      results.push(r);
      this.ev(
        r.ok ? 'action.ok' : 'action.refused',
        r.reason,
        { action: r.action, ...(r.data ?? {}) },
        { patient: (parsed.data as { patient?: string }).patient ?? null },
      );
    }

    this.engine.runUntil(this.engine.now + this.scenario.tickMinutes);
    this.stepCount++;
    this.ev('step', undefined, {
      census: [...this.patients.values()].filter((p) => p.phase !== 'departed').length,
      boarding: [...this.patients.values()].filter((p) => p.phase === 'boarding').length,
      stress: Math.round(this.registry.ambient.stress * 1000) / 1000,
    });

    this.settleTally();
    const components = computeReward(this.tally, this.scenario.weights ?? DEFAULT_WEIGHTS);
    const reward = components.total - this.prevTotal;
    this.prevTotal = components.total;
    this.lastComponents = components;

    const done = this.engine.now >= this.scenario.durationMinutes;

    return {
      observation: this.observe(),
      reward,
      components,
      done,
      results,
      info: {
        time: this.engine.now,
        clock: formatClock(this.engine.now, this.scenario.startHour),
        step: this.stepCount,
        newSafetyEvents: this.safetyEvents.slice(safetyBefore),
      },
    };
  }

  metrics(): Metrics {
    return collectMetrics(this);
  }

  mask() {
    return actionMask(this.downstream.kind);
  }

  get components(): RewardComponents {
    return this.lastComponents;
  }

  get onDiversion(): boolean {
    return this.diversion;
  }

  /** Total diversion hours, closed + currently open. */
  get diversionHoursTotal(): number {
    return this.diversionHours + (this.diversionSince !== null ? (this.engine.now - this.diversionSince) / 60 : 0);
  }

  get wastedSupplyRequests(): number {
    return this.tally.wastedSupplyRequests;
  }

  get now(): Minutes {
    return this.engine.now;
  }

  get hour(): number {
    return hourOfDay(this.engine.now, this.scenario.startHour);
  }

  bedRequestOf(patient: PatientId): string | undefined {
    return this.bedRequests.get(patient);
  }

  /** Whether a transport request is already open for this patient. */
  hasTransport(patient: PatientId): boolean {
    return this.transportRequests.has(patient);
  }


  /**
   * Frozen order snapshot taken when an IT downtime window opens.
   *
   * During downtime the EHR stops updating: the agent keeps seeing whatever the
   * board said when the feed died. This is the read surface going stale, which
   * is the actual failure mode — not an error message. Orders keep progressing
   * in the real world underneath; the agent just cannot see it.
   */
  private frozenOrders: Map<OrderId, { status: string; result: string | null }> | null = null;
  private frozenAt: Minutes | null = null;

  /**
   * The feed dies at a defined moment, whether or not anyone is looking. Freezing
   * lazily on the first observation would make the frozen state depend on when
   * the agent happened to call observe() — which would be both wrong and
   * non-deterministic across policies.
   */
  private scheduleDowntimeFreezes(): void {
    for (const w of this.scenario.registry.ambient.downtime) {
      this.engine.scheduleAt(w.startsAt, 'env:downtime-open', () => {
        this.frozenOrders = new Map();
        this.frozenAt = this.engine.now;
        for (const [id, o] of this.orders) this.frozenOrders.set(id, { status: o.status, result: o.result });
      });
      this.engine.scheduleAt(w.startsAt + w.durationMinutes, 'env:downtime-close', () => {
        // Recovery: the feed comes back and the agent must reconcile.
        this.frozenOrders = null;
        this.frozenAt = null;
      });
    }
  }

  /** Called by buildObservation. Returns the stale view during an outage. */
  downtimeView(): { active: boolean; frozen: Map<OrderId, { status: string; result: string | null }> | null } {
    const dt = this.registry.ambient.downtime();
    if (!dt) return { active: false, frozen: null };
    // A full outage freezes the board. A partial one still shows status
    // transitions but is stale — degraded, not dead.
    return { active: true, frozen: dt.severity === 'full' ? this.frozenOrders : null };
  }

  // --- action dispatch ------------------------------------------------------

  private apply(a: Action): ActionResult {
    const ok = (data?: Record<string, unknown>): ActionResult => ({ action: a.type, ok: true, data });
    const no = (reason: string): ActionResult => ({ action: a.type, ok: false, reason });

    const P = (id: string): Patient | null => this.patients.get(id) ?? null;

    switch (a.type) {
      case 'no_op':
        return ok();

      // --- registration ---
      case 'register': {
        const p = P(a.patient);
        if (!p) return no(`unknown patient ${a.patient}`);
        if (p.registrationTime !== null) return no('already registered');
        p.registrationTime = this.engine.now;
        p.mrn = `MRN-${this.rng.int(100000, 999999)}`;
        // Quick-reg is faster but leaves identity unconfirmed. EMTALA: neither
        // mode may gate the medical screening exam, which is why registration
        // never blocks triage or rooming anywhere in this env.
        p.flags.add(a.mode === 'quick' ? 'quick-reg' : 'full-reg');
        if (a.mode === 'quick') p.flags.add('identity-unconfirmed');
        return ok({ mrn: p.mrn });
      }

      case 'mpi_resolve': {
        const p = P(a.patient);
        if (!p) return no(`unknown patient ${a.patient}`);
        // Linking this encounter to the wrong person is an overlay: the hard
        // floor that identity management exists to prevent.
        if (a.personKey !== p.identity.personKey) {
          this.recordSafety(
            'wrong-patient-identity',
            p.id,
            `MPI overlay: encounter linked to ${a.personKey}, true person is ${p.identity.personKey}`,
          );
          return no('MPI overlay created — this is a hard floor');
        }
        p.flags.delete('identity-unconfirmed');
        p.flags.add('identity-confirmed');
        return ok();
      }

      // --- triage ---
      case 'triage': {
        const p = P(a.patient);
        if (!p) return no(`unknown patient ${a.patient}`);
        if (p.triageTime !== null) return no('already triaged');

        // Triage requires vitals. Assigning an ESI without measuring is how
        // under-triage happens, so the env forces the measurement to exist.
        if (p.lastVitals === null) return no('triage requires vitals: measure_vitals first');

        // The danger-zone floor. Vitals in the danger zone triaged above ESI 2
        // is under-triage, full stop. This is the guard that blocks calling
        // everyone a 4 to empty the waiting room.
        if (inDangerZone(p.lastVitals) && a.esi > 2) {
          this.recordSafety(
            'under-triage-danger-zone',
            p.id,
            `ESI ${a.esi} assigned with danger-zone vitals ${JSON.stringify(p.lastVitals)}`,
          );
        }

        p.esi = a.esi;
        p.triageTime = this.engine.now;
        if (a.isolation) p.isolation = a.isolation;
        p.phase = 'waiting-room';
        return ok({ esi: a.esi });
      }

      case 'retriage': {
        const p = P(a.patient);
        if (!p) return no(`unknown patient ${a.patient}`);
        if (p.triageTime === null) return no('patient has not been triaged yet — use triage');
        if (p.lastVitals === null) return no('retriage requires vitals: measure_vitals first');
        // Same danger-zone floor as initial triage. A patient who decompensates
        // in the waiting room and is re-triaged as a 4 is the same error as
        // under-triaging them at the door, and it is scored the same way.
        if (inDangerZone(p.lastVitals) && a.esi > 2) {
          this.recordSafety(
            'under-triage-danger-zone',
            p.id,
            `retriaged to ESI ${a.esi} with danger-zone vitals ${JSON.stringify(p.lastVitals)}`,
          );
        }
        const from = p.esi;
        p.esi = a.esi;
        p.flags.add('retriaged');
        this.ev('patient.triage', `retriaged ${from} -> ${a.esi}`, { from, to: a.esi }, { patient: p.id });
        return ok({ from, to: a.esi });
      }

      case 'route': {
        const p = P(a.patient);
        if (!p) return no(`unknown patient ${a.patient}`);
        if (p.esi === null) return no('triage before routing');
        if (a.destination === 'fast-track' && p.esi <= 2) {
          return no('ESI 1-2 cannot be routed to fast-track');
        }
        p.flags.add(`route:${a.destination}`);
        return ok();
      }

      case 'standing_orders': {
        const p = P(a.patient);
        if (!p) return no(`unknown patient ${a.patient}`);
        const placed: string[] = [];
        const refused: string[] = [];
        for (const name of a.orders) {
          // Standing orders are nurse-scope only. Anything else needs a provider.
          if (!NURSE_SCOPE.includes(name)) {
            refused.push(name);
            continue;
          }
          const r = this.placeOrder(p, name, 'stat');
          if (r.ok) placed.push(r.orderId!);
          else refused.push(name);
        }
        return ok({ placed, refused });
      }

      case 'set_reassessment': {
        const p = P(a.patient);
        if (!p) return no(`unknown patient ${a.patient}`);
        this.reassessInterval.set(p.id, a.intervalMinutes);
        return ok();
      }

      case 'measure_vitals': {
        const p = P(a.patient);
        if (!p) return no(`unknown patient ${a.patient}`);
        if (p.phase === 'departed') return no('patient has departed');
        p.lastVitals = measureVitals(p.latent, this.rng);
        p.lastVitalsTime = this.engine.now;
        return ok({ vitals: p.lastVitals });
      }

      // --- flow ---
      case 'assign_nurse': {
        const p = P(a.patient);
        if (!p) return no(`unknown patient ${a.patient}`);
        const r = this.ed.assignNurse(a.nurse, p, this.patients);
        if (!r.ok) return no(r.reason);
        if (r.breach) {
          this.recordSafety(
            'ratio-breach',
            p.id,
            `${r.breach.nurse} at acuity-weighted load ${r.breach.load.toFixed(1)} over cap ${r.breach.cap}`,
          );
        }
        return ok({ breach: r.breach !== null });
      }

      case 'assign_provider': {
        const p = P(a.patient);
        if (!p) return no(`unknown patient ${a.patient}`);
        const r = this.ed.assignProvider(a.provider, p);
        return r.ok ? ok({ firstProviderTime: p.firstProviderTime }) : no(r.reason!);
      }

      case 'place_bed': {
        const p = P(a.patient);
        if (!p) return no(`unknown patient ${a.patient}`);
        if (p.esi === null) return no('triage before rooming');
        const bed = this.ed.bed(a.bed);
        if (bed && needsMonitor(p.esi) && !bed.monitored) {
          return no(`ESI ${p.esi} requires a monitored bed; ${a.bed} is not monitored`);
        }
        const r = this.ed.place(p, a.bed);
        return r.ok ? ok({ bed: a.bed }) : no(r.reason);
      }

      case 'escalate': {
        const p = P(a.patient);
        if (!p) return no(`unknown patient ${a.patient}`);
        // A code or rapid response pulls a provider and nurses immediately and
        // materially suppresses deterioration — at the cost of everyone else.
        p.flags.add(`escalated:${a.kind}`);
        p.latent.treatmentProgress = Math.min(1, p.latent.treatmentProgress + (a.kind === 'code' ? 0.3 : 0.15));
        this.registry.attention.chargeTaskSwitch('ed-attending', a.kind, p.id, 1.0);
        return ok();
      }

      // --- orders ---
      case 'order_lab': {
        const p = P(a.patient);
        if (!p) return no(`unknown patient ${a.patient}`);
        if (!LAB_TESTS[a.test]) return no(`unknown lab test ${a.test}`);
        const r = this.placeOrder(p, a.test, a.priority, 'lab');
        if (!r.ok) return no(r.reason!);
        const order = this.orders.get(r.orderId!)!;
        const lr = this.lab.order(order, a.route);
        if (!lr.ok) {
          order.status = 'cancelled';
          return no(lr.reason!);
        }
        return ok({ order: order.id });
      }

      case 'order_imaging': {
        const p = P(a.patient);
        if (!p) return no(`unknown patient ${a.patient}`);
        if (!IMAGING_STUDIES[a.study]) return no(`unknown study ${a.study}`);
        const r = this.placeOrder(p, a.study, a.priority, 'imaging');
        if (!r.ok) return no(r.reason!);
        const order = this.orders.get(r.orderId!)!;
        const ir = this.imaging.order(order, a.escort);
        if (!ir.ok) {
          order.status = 'cancelled';
          return no(ir.reason!);
        }
        return ok({ order: order.id });
      }

      case 'order_med': {
        const p = P(a.patient);
        if (!p) return no(`unknown patient ${a.patient}`);
        if (!DRUGS[a.drug]) return no(`unknown drug ${a.drug}`);
        const r = this.placeOrder(p, a.drug, a.priority, 'med');
        if (!r.ok) return no(r.reason!);
        const order = this.orders.get(r.orderId!)!;
        const pr = this.pharmacy.order(order, a.source);
        if (!pr.ok) {
          order.status = 'cancelled';
          return no(pr.reason!);
        }
        return ok({ order: order.id });
      }

      case 'order_consult': {
        const p = P(a.patient);
        if (!p) return no(`unknown patient ${a.patient}`);
        const proc = this.registry.consultFor(a.service);
        if (!proc) return no(`no consult service "${a.service}"`);
        const r = this.placeOrder(p, a.service, a.priority, 'consult');
        if (!r.ok) return no(r.reason!);
        const id = proc.request({ patient: p.id, service: a.service });
        this.consultRequests.set(r.orderId!, { service: a.service, id });
        return ok({ order: r.orderId, request: id });
      }

      // --- ancillary orchestration ---
      case 'prioritise_collection':
        this.lab.prioritiseCollection(a.orders);
        return ok();

      case 'redraw': {
        const r = this.lab.redraw(a.order);
        return r.ok ? ok({ newOrder: r.newOrder }) : no(r.reason!);
      }

      case 'ack_critical': {
        const r = this.lab.acknowledgeCritical(a.order);
        if (!r.ok) return no(r.reason!);
        // Acknowledging the value also closes the interrupt: find it and answer.
        const pending = this.registry.attention
          .pending()
          .find((i) => i.interrupt.source === 'critical-callback' && i.interrupt.meta.order === a.order);
        if (pending) this.registry.attention.answer(pending.interrupt.id);
        return ok();
      }

      case 'prioritise_imaging':
        this.imaging.prioritise(a.modality as Modality, a.orders);
        return ok();

      case 'escalate_read': {
        const r = this.imaging.escalateRead(a.order);
        return r.ok ? ok() : no(r.reason!);
      }

      case 'prioritise_verification': {
        const r = this.pharmacy.prioritiseVerification(a.orders);
        return ok({ reranked: r.reranked });
      }

      case 'document_controlled': {
        const r = this.pharmacy.documentControlled(a.order);
        return r.ok ? ok() : no(r.reason!);
      }

      // --- blood ---
      case 'request_blood': {
        const p = P(a.patient);
        if (!p) return no(`unknown patient ${a.patient}`);
        const hasTs = [...this.orders.values()].some(
          (o) => o.patient === p.id && o.name === 'type-and-screen' && o.status === 'resulted',
        );
        const r = this.bloodBank.request(p.id, a.product, a.units, hasTs);
        if (!r.ok) return no(r.reason);
        p.latent.treatmentProgress = Math.min(1, p.latent.treatmentProgress + 0.1);
        return ok({ readyAt: Math.round(r.readyAt) });
      }

      case 'stop_mtp': {
        const p = P(a.patient);
        if (!p) return no(`unknown patient ${a.patient}`);
        if (!this.bloodBank.isMtpActive(p.id)) return no('no massive transfusion protocol is running');
        this.bloodBank.stopMtp(p.id);
        this.ev('note', 'MTP stopped', {}, { patient: p.id });
        return ok();
      }

      case 'warm_blood_bank': {
        const p = P(a.patient);
        if (!p) return no(`unknown patient ${a.patient}`);
        const r = this.bloodBank.warm(p.id);
        p.flags.add('blood-warmed');
        return ok({ readyAt: Math.round(r.readyAt) });
      }

      // --- EMS / trauma ---
      case 'activate_trauma': {
        const p = P(a.patient);
        if (!p) return no(`unknown patient ${a.patient}`);
        p.flags.add(`trauma:${a.tier}`);
        // Over- and under-triage are asymmetric: a full activation on a patient
        // who did not need it burns the team; a missed one costs the patient.
        // Both are scored in metrics, not here.
        if (a.tier === 'full') {
          this.registry.attention.chargeTaskSwitch('ed-attending', 'trauma-activation', p.id, 1.0);
        }
        return ok();
      }

      case 'prestage': {
        const p = P(a.patient);
        if (!p) return no(`unknown patient ${a.patient}`);
        if (a.bay) {
          const bed = this.ed.bed(a.bay);
          if (!bed) return no(`no such bay ${a.bay}`);
          if (bed.patient) return no(`${a.bay} is occupied`);
          p.flags.add(`prestaged-bay:${a.bay}`);
        }
        if (a.warmBlood) {
          this.bloodBank.warm(p.id);
          p.flags.add('blood-warmed');
        }
        for (const m of a.pullMeds) p.flags.add(`premed:${m}`);
        p.flags.add('prestaged');
        return ok({ staged: { bay: a.bay ?? null, warmBlood: a.warmBlood, meds: a.pullMeds } });
      }

      // --- interrupts ---
      case 'answer_interrupt': {
        const entry = this.registry.attention.get(a.interrupt);
        if (!entry) return no(`unknown interrupt ${a.interrupt}`);

        // EMTALA: honouring a registration/billing interrupt that would delay a
        // medical screening exam is a hard floor. The agent must defer it.
        if (entry.interrupt.source === 'billing' && entry.interrupt.meta.wouldDelayMse === true) {
          const p = entry.interrupt.patient ? this.patients.get(entry.interrupt.patient) : null;
          if (p && p.triageTime === null) {
            this.recordSafety(
              'phi-leak',
              p.id,
              'EMTALA: billing interrupt honoured before the medical screening exam',
            );
            return no('EMTALA: cannot gate a medical screening exam on registration/payment — defer this');
          }
        }

        // Answering a media inquiry about a named patient is a PHI leak
        // regardless of framing.
        if (entry.interrupt.source === 'media' && entry.interrupt.patient) {
          this.recordSafety('phi-leak', entry.interrupt.patient, 'media inquiry answered about a named patient');
          return no('PHI: cannot discuss a named patient with media');
        }

        const r = this.registry.attention.answer(a.interrupt, a.role as AttentionRole | undefined);
        return r.ok ? ok({ occupiesUntil: Math.round(r.occupiesUntil ?? 0), role: r.role }) : no(r.reason);
      }

      case 'defer_interrupt': {
        const r = this.registry.attention.defer(a.interrupt, a.minutes);
        if (!r.ok && r.illegalDeferral) {
          const entry = this.registry.attention.get(a.interrupt);
          const kind: SafetyViolation =
            entry?.interrupt.source === 'critical-callback'
              ? 'missed-critical-callback'
              : 'mandatory-reporting-missed';
          this.recordSafety(kind, entry?.interrupt.patient ?? null, `illegal deferral of ${entry?.interrupt.source}`);
          return no('this interrupt class cannot be deferred — that is a hard floor');
        }
        return r.ok ? ok({ deferredUntil: Math.round(r.deferredUntil ?? 0) }) : no(r.reason);
      }

      case 'batch_interrupts': {
        const r = this.registry.attention.batch(a.interrupts, a.role as AttentionRole | undefined);
        return r.ok ? ok({ batched: r.batched, occupiesUntil: Math.round(r.occupiesUntil ?? 0) }) : no(r.reason);
      }

      // --- handoff ---
      case 'attempt_handoff': {
        const h = this.registry.handoff.get(a.handoff);
        if (!h) return no(`unknown handoff ${a.handoff}`);
        const nurse = this.ed.staffMember(h.edNurse);
        const free = !nurse || nurse.busyUntil <= this.engine.now;
        const r = this.registry.handoff.attempt(a.handoff, free);
        if (!r.ok) return no(r.reason);
        // The ED nurse is locked for the duration of report — that is the cost.
        if (nurse && r.edNurseBusyUntil) nurse.busyUntil = r.edNurseBusyUntil;
        return ok({ reportEndsAt: Math.round(r.reportEndsAt ?? 0) });
      }

      case 'escalate_handoff': {
        const r = this.registry.handoff.escalate(a.handoff);
        return r.ok ? ok() : no(r.reason);
      }

      // --- downstream boundary ---
      case 'request_bed': {
        const p = P(a.patient);
        if (!p) return no(`unknown patient ${a.patient}`);
        if (this.bedRequests.has(p.id)) return no('a bed request is already open for this patient');
        const id = this.downstream.requestBed({
          patient: p.id,
          level: a.level as CareLevel,
          isolation: p.isolation,
          cohort: a.cohort,
          requestedAt: this.engine.now,
        });
        this.bedRequests.set(p.id, id);
        if (p.bedRequestTime === null) p.bedRequestTime = this.engine.now;
        this.stressAtBedRequest.push(this.registry.ambient.stress);
        this.ev(
          'bed.request',
          `${a.level} bed requested`,
          {
            level: a.level,
            leadMinutes:
              p.dispositionDecisionTime !== null ? Math.round(this.engine.now - p.dispositionDecisionTime) : null,
          },
          { patient: p.id },
        );
        return ok({ request: id, state: this.downstream.poll(id) });
      }

      case 'accept_bed_offer': {
        const patientId = [...this.bedRequests.entries()].find(([, id]) => id === a.request)?.[0];
        if (!patientId) return no(`unknown bed request ${a.request}`);
        const p = this.patients.get(patientId);
        if (!p) return no('patient gone');
        let accepted;
        try {
          accepted = this.downstream.accept(a.request);
        } catch (e) {
          return no((e as Error).message);
        }
        const state = this.downstream.poll(a.request);
        const bed = state.status === 'accepted' ? state.bed : 'unknown';
        const level = (p.disposition?.kind === 'admit' ? p.disposition.level : 'medsurg') as CareLevel;

        // A bed is assigned. The patient STILL cannot move until report is
        // given — that is the rendezvous, and it is where the boarding hours go.
        const h = this.registry.handoff.open(p.id, p.assignedNurse ?? 'unassigned', level, bed);
        return ok({ bed, readyAt: Math.round(accepted.readyAt), handoff: h.id });
      }

      case 'cancel_bed_request': {
        const patientId = [...this.bedRequests.entries()].find(([, id]) => id === a.request)?.[0];
        if (!patientId) return no(`unknown bed request ${a.request}`);
        this.downstream.cancel(a.request);
        this.bedRequests.delete(patientId);
        this.tally.wastedSupplyRequests++;
        return ok();
      }

      // --- disposition ---
      case 'decide_disposition': {
        const p = P(a.patient);
        if (!p) return no(`unknown patient ${a.patient}`);
        if (p.phase === 'departed') return no('patient has departed');
        if (p.firstProviderTime === null) return no('a provider must see the patient before disposition');

        p.dispositionDecisionTime = this.engine.now;

        if (a.disposition === 'discharge') {
          // A psychiatric hold is a legal status, not a clinical opinion. You
          // cannot discharge your way out of it — they wait for a psych bed.
          // Without this guard a throughput policy simply discharges the psych
          // board, which is both illegal and the easiest exploit in the module.
          if (p.psychHold) {
            return no('patient is on a psychiatric hold and cannot be discharged — they need a psych bed');
          }
          const risk = unsafeDischargeRisk(p.latent);
          // The unsafe-destination floor. Together with the bounce-back process
          // in arrivals.ts, this is what blocks the discharge-everyone exploit:
          // you cannot empty the department by sending sick people home.
          if (risk > 0.45) {
            this.recordSafety(
              'unsafe-destination-discharge',
              p.id,
              `discharged with unsafe-discharge risk ${risk.toFixed(2)} (severity ${p.latent.severity.toFixed(2)}, workup ${(p.latent.treatmentProgress * 100).toFixed(0)}%)`,
            );
          }
          p.disposition = { kind: 'discharge' };
          this.arrivals.recordDischarge(p, risk);
          return ok({ unsafeRisk: round2(risk) });
        }

        if (a.disposition === 'admit') {
          if (!a.level) return no('admit requires a level');
          p.disposition = { kind: 'admit', level: a.level as CareLevel };
          p.phase = 'boarding';
          return ok();
        }

        if (a.disposition === 'ama') {
          // A patient leaving against medical advice. A hold cannot: that is the
          // whole point of a hold.
          if (p.psychHold) return no('a patient on a psychiatric hold cannot leave AMA');
          const risk = unsafeDischargeRisk(p.latent);
          p.disposition = { kind: 'ama' };
          // AMA is a reportable event. It is NOT an unsafe-destination floor —
          // the agent did not choose it, the patient did — but the clinical risk
          // still lands on the department, and it still bounces back.
          this.registry.attention.raise({
            source: 'legal-risk',
            channel: 'risk-management',
            claimedPriority: 2,
            truePriority: 2,
            roleRequired: 'ed-attending',
            delegableTo: [],
            resolutionCost: this.rng.logSpread(10, 1.3),
            responseDeadline: this.engine.now + 120,
            deferability: 'schedulable',
            hardFloorIfMissed: false,
            consequenceIfMissed: 'AMA departure undocumented',
            patient: p.id,
            batchable: false,
            meta: { trigger: 'ama-departure' },
          });
          this.arrivals.recordDischarge(p, risk);
          this.ev('patient.depart', 'left against medical advice', { unsafeRisk: round2(risk) }, { patient: p.id, level: 'warn' });
          this.depart(p);
          return ok({ unsafeRisk: round2(risk) });
        }

        if (a.disposition === 'transfer-out') {
          p.disposition = { kind: 'transfer-out' };
          return ok();
        }

        p.disposition = { kind: 'or' };
        const orProc = this.registry.get('or-room');
        const id = orProc.request({ patient: p.id });
        this.orRequests.set(p.id, id);
        this.ev('supply.request', 'OR requested', { request: id }, { patient: p.id });
        return ok({ orRequest: id, state: orProc.poll(id) });
      }

      // --- transport ---
      case 'dispatch_transport': {
        const p = P(a.patient);
        if (!p) return no(`unknown patient ${a.patient}`);
        if (this.transportRequests.has(p.id)) return no('transport already dispatched for this patient');

        const need = this.transportNeed(p);
        // Inappropriate transport tier is a hard floor: a rideshare cannot carry
        // a monitored patient, and a standard car cannot carry a wheelchair.
        if (!tierSatisfies(a.tier, need)) {
          this.recordSafety(
            'inappropriate-transport-tier',
            p.id,
            `${a.tier} dispatched for a patient needing ${describeNeed(need)}`,
          );
          return no(`tier ${a.tier} cannot safely carry this patient (${describeNeed(need)})`);
        }

        const isIft = ['bls', 'als', 'cct'].includes(a.tier);
        const procName = isIft ? `ems-${a.tier}` : a.tier;
        if (!this.registry.has(procName)) return no(`no supply process for tier ${a.tier}`);

        let id: string;
        if (isIft && !a.direct) {
          // The broker: an extra layer of indirection over the agencies. Slower
          // to answer than working the phone yourself, but it costs no attention.
          const r = this.registry.broker.request({ ...need, tier: a.tier });
          if (!r.id) return no(r.reason ?? 'broker declined');
          id = r.id;
        } else {
          const proc = this.registry.get(procName);
          id = proc.request({ ...need, tier: a.tier });
          // A direct agency call bypasses broker latency and gets a faster,
          // more honest answer — at the cost of a clerk working the phone.
          if (a.direct) this.registry.attention.chargeTaskSwitch('unit-clerk', 'direct-agency-call', p.id, 0.5);
        }

        // Wrong address: a linkage error, not a supply failure. The car goes
        // somewhere else and the agent only finds out by noticing it never came.
        if (!isIft && this.rng.bool(this.registry.broker.wrongAddressProbability())) {
          p.flags.add('transport-wrong-address');
          this.ev('note', 'transport dispatched to the wrong address (linkage error)', {}, { patient: p.id, level: 'warn' });
        }

        this.transportRequests.set(p.id, { tier: a.tier, id });
        this.tally.transportCostUnits += TIER_COST[a.tier];
        const depth = DISCHARGE_LADDER.indexOf(a.tier);
        if (depth >= 0) this.ladderAttempts.set(p.id, depth + 1);
        this.ev(
          'supply.request',
          `${a.tier} dispatched${isIft ? (a.direct ? ' (direct call)' : ' (via broker)') : ''}`,
          { tier: a.tier, direct: a.direct },
          { patient: p.id },
        );
        return ok({ request: id, state: this.registry.get(procName).poll(id) });
      }

      case 'cancel_transport': {
        const t = this.transportRequests.get(a.patient);
        if (!t) return no('no transport dispatched for this patient');
        const procName = ['bls', 'als', 'cct'].includes(t.tier) ? `ems-${t.tier}` : t.tier;
        const r = this.registry.get(procName).cancel(t.id);
        this.transportRequests.delete(a.patient);
        this.tally.wastedSupplyRequests++;
        return r.ok ? ok() : ok({ lateCancellationCost: r.cost });
      }

      // --- restraints ---
      case 'apply_restraints': {
        const p = P(a.patient);
        if (!p) return no(`unknown patient ${a.patient}`);
        if (p.restraint && p.restraint.releasedAt === null) return no('already restrained');
        // Restraints need a provider order and a bed. You cannot restrain
        // someone in the waiting room.
        if (p.firstProviderTime === null) return no('restraints require a provider order');
        if (p.phase !== 'in-bed' && p.phase !== 'boarding') return no('patient must be in a bed to be restrained');

        p.restraint = {
          appliedAt: this.engine.now,
          kind: a.kind,
          // Physical restraints are checked every 15 minutes. This clock is the
          // whole point: applying them is easy, keeping up with them is not.
          checkIntervalMinutes: a.kind === 'physical' ? 15 : 30,
          lastCheckAt: this.engine.now,
          checksCompleted: 0,
          checksMissed: 0,
          releasedAt: null,
        };
        // Restraint application is a mandatory legal/risk notification.
        this.registry.attention.raise({
          source: 'legal-risk',
          channel: 'risk-management',
          claimedPriority: 1,
          truePriority: 1,
          roleRequired: 'ed-attending',
          delegableTo: [],
          resolutionCost: this.rng.logSpread(12, 1.3),
          responseDeadline: this.engine.now + 60,
          deferability: 'immediate',
          hardFloorIfMissed: true,
          consequenceIfMissed: 'restraint applied without the mandatory notification',
          patient: p.id,
          batchable: false,
          meta: { trigger: 'restraint-application', kind: a.kind },
        });
        this.ev('note', `${a.kind} restraints applied; ${p.restraint.checkIntervalMinutes}m check clock started`, { kind: a.kind }, { patient: p.id, level: 'warn' });
        return ok({ checkIntervalMinutes: p.restraint.checkIntervalMinutes });
      }

      case 'restraint_check': {
        const p = P(a.patient);
        if (!p) return no(`unknown patient ${a.patient}`);
        if (!p.restraint || p.restraint.releasedAt !== null) return no('patient is not restrained');
        p.restraint.lastCheckAt = this.engine.now;
        p.restraint.checksCompleted++;
        // A check costs a nurse's attention. It is not free paperwork.
        this.registry.attention.chargeTaskSwitch('bedside-nurse', 'restraint-check', p.id, 0.5);
        return ok({ checksCompleted: p.restraint.checksCompleted });
      }

      case 'release_restraints': {
        const p = P(a.patient);
        if (!p) return no(`unknown patient ${a.patient}`);
        if (!p.restraint || p.restraint.releasedAt !== null) return no('patient is not restrained');
        p.restraint.releasedAt = this.engine.now;
        this.ev('note', `restraints released after ${Math.round(this.engine.now - p.restraint.appliedAt)}m`, {
          checksCompleted: p.restraint.checksCompleted,
          checksMissed: p.restraint.checksMissed,
        }, { patient: p.id });
        return ok();
      }

      // --- psychiatric holds ---
      case 'request_psych_bed': {
        const p = P(a.patient);
        if (!p) return no(`unknown patient ${a.patient}`);
        if (this.psychRequests.has(p.id)) return no('a psych bed request is already open');
        if (p.firstProviderTime === null) return no('a provider must see the patient first');
        const proc = this.registry.get('psych-bed');
        const id = proc.request({ patient: p.id });
        this.psychRequests.set(p.id, id);
        if (p.bedRequestTime === null) p.bedRequestTime = this.engine.now;
        // The psych boarder is the longest tail in the department. Starting the
        // search early is the only lever the ED has on it.
        this.ev('bed.request', 'psych bed requested', { request: id }, { patient: p.id });
        return ok({ request: id, state: proc.poll(id) });
      }

      case 'assign_sitter': {
        const p = P(a.patient);
        if (!p) return no(`unknown patient ${a.patient}`);
        if (!p.psychHold) return no('patient is not on a psychiatric hold');
        const s = this.ed.staffMember(a.staff);
        if (!s) return no(`no such staff ${a.staff}`);
        if (s.role !== 'tech' && s.role !== 'nurse') return no('a sitter must be a tech or a nurse');
        p.sitter = a.staff;
        return ok();
      }

      // --- law enforcement ---
      case 'police_blood_draw': {
        const p = P(a.patient);
        if (!p) return no(`unknown patient ${a.patient}`);
        const entry = this.registry.attention.get(a.interrupt);
        if (!entry) return no(`unknown interrupt ${a.interrupt}`);
        if (entry.interrupt.source !== 'law-enforcement' || entry.interrupt.meta.kind !== 'blood-draw-request') {
          return no('that interrupt is not a law-enforcement blood-draw request');
        }

        // The floor. An officer asking is not authorisation, and they will claim
        // urgency either way. Warrant or consent, or it does not happen.
        const hasWarrant = entry.interrupt.meta.hasWarrant === true;
        const hasConsent = entry.interrupt.meta.hasConsent === true;
        if (!hasWarrant && !hasConsent) {
          this.recordSafety(
            'blood-draw-without-warrant',
            p.id,
            'blood drawn for law enforcement with neither a warrant nor patient consent',
          );
          return no('no warrant and no consent — this is a hard floor, refuse the officer');
        }

        this.registry.attention.answer(a.interrupt);
        this.ev('note', `law-enforcement blood draw performed (${hasWarrant ? 'warrant' : 'consent'})`, { hasWarrant, hasConsent }, { patient: p.id });
        return ok({ basis: hasWarrant ? 'warrant' : 'consent' });
      }

      // --- EVS ---
      case 'prioritise_cleaning':
        this.ed.prioritiseCleaning(a.beds);
        return ok();

      // --- house ---
      case 'set_diversion': {
        if (a.on && !this.diversion) {
          this.diversion = true;
          this.diversionSince = this.engine.now;
        } else if (!a.on && this.diversion) {
          this.diversion = false;
          if (this.diversionSince !== null) {
            this.diversionHours += (this.engine.now - this.diversionSince) / 60;
          }
          this.diversionSince = null;
        }
        return ok({ diversion: this.diversion });
      }

      case 'call_float': {
        const r = this.ed.callFloat();
        return r.ok ? ok({ nurse: r.nurse }) : no(r.reason!);
      }

      case 'authorise_overtime': {
        const r = this.ed.authoriseOvertime(a.staff, a.minutes);
        return r.ok ? ok() : no(r.reason!);
      }
    }
  }

  // --- internals ------------------------------------------------------------

  private admitToEd(p: Patient): void {
    // Diversion turns away incoming EMS, but never walk-ins and never anyone
    // already at the door. EMTALA does not bend for a full department.
    if (this.diversion && p.arrivalMode !== 'walk-in' && this.rng.bool(0.7)) {
      p.phase = 'departed';
      p.departureTime = this.engine.now;
      p.disposition = { kind: 'transfer-out' };
      return;
    }
    this.patients.set(p.id, p);
    this.ev(
      'patient.arrive',
      p.chiefComplaint,
      { mode: p.arrivalMode, isolation: p.isolation },
      { patient: p.id },
    );
  }

  private placeOrder(
    p: Patient,
    name: string,
    priority: 'stat' | 'routine',
    kind?: Order['kind'],
  ): { ok: boolean; orderId?: string; reason?: string } {
    if (p.phase === 'departed') return { ok: false, reason: 'patient has departed' };
    const resolved: Order['kind'] =
      kind ?? (LAB_TESTS[name] ? 'lab' : IMAGING_STUDIES[name] ? 'imaging' : DRUGS[name] ? 'med' : 'consult');
    const id = `ord-${++this.orderSeq}`;
    const order: Order = {
      id,
      patient: p.id,
      kind: resolved,
      name,
      priority,
      status: 'ordered',
      placedAt: this.engine.now,
      completedAt: null,
      rejected: false,
      redrawOf: null,
      critical: false,
      criticalAt: null,
      criticalAckedAt: null,
      therapeuticValue: orderTherapeuticValue(p.latent, name),
      result: null,
      meta: {},
    };
    this.orders.set(id, order);
    p.orders.push(id);
    return { ok: true, orderId: id };
  }

  /**
   * An order landing advances treatment only if it was the RIGHT order. This is
   * what stops shotgunning every test on every patient from working: the wrong
   * workup costs time, queue capacity, and money, and buys nothing.
   */
  private onOrderResult(order: Order): void {
    const p = this.patients.get(order.patient);
    if (!p) return;

    if (order.name === 'bmp' || order.name === 'glucose') {
      // A resulted creatinine is what opens the contrast gate.
      p.renalCleared = !this.rng.bool(0.12);
    }

    const value = orderTherapeuticValue(p.latent, order.name);
    if (value > 0) {
      p.latent.treatmentProgress = Math.min(1, p.latent.treatmentProgress + value);
    }
  }

  /**
   * What this patient actually needs to travel, based on their CURRENT state —
   * not their triage ESI. A patient triaged ESI-2 who has been worked up and is
   * now well enough to go home does not need an ambulance, and pricing them as
   * if they did would make the correct action look like a violation.
   *
   * Reads latent state, which is legitimate: this is the world deciding what is
   * safe, not the agent being told. The agent has to infer it from vitals and
   * the workup, which is the point.
   */
  private transportNeed(p: Patient) {
    const s = p.latent.severity;
    const discharge = p.disposition?.kind === 'discharge';

    if (discharge) {
      // You do not send someone home on a monitor. If they need one, the
      // discharge itself was the error and the unsafe-destination floor has it.
      return {
        patient: p.id,
        wheelchair: s > 0.35 || !p.transportable,
        stretcher: false,
        monitored: false,
        paramedic: false,
        destination: 'home',
        discharge: true,
      };
    }

    // An inter-facility transfer of a still-sick patient: the tier tracks how
    // sick they actually are right now.
    return {
      patient: p.id,
      wheelchair: true,
      stretcher: true,
      monitored: s > 0.3,
      paramedic: s > 0.6,
      destination: 'receiving-facility',
      discharge: false,
    };
  }

  /**
   * Record a hard floor, deduped per (patient, kind).
   *
   * The dedup matters. Most unsafe actions are REFUSED by the env — the world
   * physically stops you — so a policy that retries a blocked dispatch every
   * tick would otherwise rack up hundreds of identical floors and swamp the
   * score with what is really one mistake, repeated. One violation per patient
   * per kind is the honest count: it says "this policy tried to do this unsafe
   * thing to this patient", which is the signal we want, exactly once.
   *
   * Floors with no patient (system-level) are not deduped.
   */
  private recordSafety(kind: SafetyViolation, patient: PatientId | null, detail: string): void {
    if (patient !== null) {
      const key = `${patient}:${kind}`;
      if (this.recordedFloors.has(key)) return;
      this.recordedFloors.add(key);
    }
    this.safetyEvents.push({ kind, at: this.engine.now, patient, detail });
    this.ev('safety', detail, { violation: kind }, { patient, level: 'error' });
  }

  /**
   * Physiology and care. Runs every minute of sim time so that the risk
   * integral is accurate rather than a step-sized approximation.
   */
  private physiologyTick(): void {
    this.engine.schedule(1, 'env:physiology', () => {
      const dt = this.engine.now - this.lastAdvance;
      this.lastAdvance = this.engine.now;
      if (dt <= 0) {
        this.physiologyTick();
        return;
      }

      for (const p of this.patients.values()) {
        if (p.phase === 'departed' || p.latent.dead) continue;

        const before = p.latent.severity;
        advanceLatent(p.latent, dt, this.careFactor(p), this.rng);

        // Risk is integrated from TRUE state, whether or not anyone measured it.
        const rate = riskRate(p.latent);
        const risk = rate * (dt / 60);
        p.riskAccrued += risk;
        this.tally.integratedRisk += risk;

        // A deterioration event: crossing 0.7 under our care.
        if (before < 0.7 && p.latent.severity >= 0.7) {
          this.tally.deteriorations++;
          p.flags.add('deteriorated');
          if (p.phase === 'boarding') p.flags.add('deteriorated-while-boarding');
          this.ev(
            'patient.deteriorate',
            `crossed severity 0.7 while ${p.phase}`,
            { phase: p.phase, esi: p.esi, vitalsAge: p.lastVitalsTime === null ? null : Math.round(this.engine.now - p.lastVitalsTime) },
            { patient: p.id, level: 'warn' },
          );
        }

        if (p.latent.dead && !p.flags.has('counted-death')) {
          p.flags.add('counted-death');
          this.tally.deaths++;
          this.ev(
            'patient.death',
            `died in department after ${Math.round(this.engine.now - p.arrivalTime)}m`,
            { condition: p.latent.condition, esi: p.esi, phase: p.phase, workup: Math.round(p.latent.treatmentProgress * 100) },
            { patient: p.id, level: 'error' },
          );
          p.disposition = { kind: 'died' };
          p.phase = 'departed';
          p.departureTime = this.engine.now;
          const bed = this.ed.bedOf(p.id);
          if (bed) this.ed.vacate(bed.id, p);
          this.ed.unassign(p.id);
        }
      }

      this.checkDepartures();
      this.physiologyTick();
    });
  }

  /**
   * How much the current setting suppresses deterioration. Being in a monitored
   * bed with a nurse and a provider is worth a great deal; sitting in the
   * waiting room is worth nothing.
   */
  private careFactor(p: Patient): number {
    if (p.phase === 'waiting-registration' || p.phase === 'waiting-room') {
      // Reassessment in the waiting room catches some of it, if the agent set one.
      const interval = this.reassessInterval.get(p.id);
      return interval && interval <= 30 ? 0.85 : 1.0;
    }
    let f = 0.55;
    const bed = this.ed.bedOf(p.id);
    if (bed?.monitored) f -= 0.1;
    if (p.assignedNurse) f -= 0.1;
    if (p.assignedProvider) f -= 0.1;
    if (p.flags.has('escalated:code')) f -= 0.1;
    // Boarding is not a safe holding state: the ED is not a ward, and a boarder
    // is watched less closely than a patient in active workup.
    if (p.phase === 'boarding') f += 0.15;
    return Math.max(0.15, f);
  }

  /** Patients whose care is finished and whose ride/report has landed leave. */
  private checkDepartures(): void {
    for (const p of this.patients.values()) {
      if (p.phase === 'departed' || !p.disposition) continue;

      if (p.disposition.kind === 'discharge') {
        const t = this.transportRequests.get(p.id);
        if (!t) continue; // the discharge stalls until a ride is dispatched
        const procName = ['bls', 'als', 'cct'].includes(t.tier) ? `ems-${t.tier}` : t.tier;
        const st = this.registry.get(procName).poll(t.id);
        if (st.status === 'arrived') {
          this.depart(p);
        } else if (st.status === 'no-show' || st.status === 'declined') {
          // The ladder rung failed. The agent must notice and go down a rung —
          // and until it does, the bed does not free. This is exactly how
          // rideshare unavailability turns into boarding.
          this.transportRequests.delete(p.id);
        }
        continue;
      }

      if (p.disposition.kind === 'admit') {
        const reqId = this.bedRequests.get(p.id);
        if (!reqId) continue;
        const state = this.downstream.poll(reqId);
        if (state.status !== 'accepted') continue;
        const h = this.registry.handoff.byPatient(p.id);
        // Bed assigned AND report complete AND the bed is physically ready.
        if (h?.state.status === 'complete' && this.engine.now >= state.readyAt) {
          this.depart(p);
        }
        continue;
      }

      if (p.disposition.kind === 'transfer-out') {
        const t = this.transportRequests.get(p.id);
        if (!t) continue;
        const proc = this.registry.get(`ems-${t.tier}`);

        // Level-of-care upgrade en route: a BLS transport that becomes ALS
        // mid-route. The agent finds out late and has to re-plan.
        if (proc instanceof EmsAgency) {
          const up = proc.maybeUpgrade(t.id);
          if (up?.upgraded && !p.flags.has('transport-upgraded')) {
            p.flags.add('transport-upgraded');
            this.ev(
              'note',
              `transport upgraded ${t.tier} -> ${up.newTier} en route`,
              { from: t.tier, to: up.newTier },
              { patient: p.id, level: 'warn' },
            );
          }
        }

        const st = proc.poll(t.id);
        if (st.status === 'arrived') this.depart(p);
        continue;
      }

      // A psychiatric hold cannot be discharged and does not take a medical
      // bed: they wait for a psych bed, which is its own scarce supply.
      const psychReq = this.psychRequests.get(p.id);
      if (psychReq && p.psychHold) {
        const st = this.registry.get('psych-bed').poll(psychReq);
        if (st.status === 'arrived') {
          this.ev('patient.depart', 'psych bed accepted', { via: 'psych-bed' }, { patient: p.id });
          this.depart(p);
        } else if (st.status === 'declined') {
          // Declined by the receiving facility. The search restarts, and the
          // patient keeps boarding — this is the real psych-boarder loop.
          this.psychRequests.delete(p.id);
          this.ev('supply.declined', 'psych bed declined; search restarts', {}, { patient: p.id, level: 'warn' });
        }
        continue;
      }

      if (p.disposition.kind === 'or') {
        // The OR takes them when the room is ready. Module 4 makes the room a
        // real simulation; the interface and this departure path do not change.
        const reqId = this.orRequests.get(p.id);
        if (!reqId) continue;
        const st = this.registry.get('or-room').poll(reqId);
        if (st.status === 'arrived') {
          this.ev('patient.depart', 'to OR', { via: 'or-room' }, { patient: p.id });
          this.depart(p);
        } else if (st.status === 'declined' || st.status === 'no-show') {
          // The room fell through. The agent has to notice and re-plan — an OR
          // request during a full block is functionally a decline.
          this.orRequests.delete(p.id);
          this.ev('supply.declined', 'OR request fell through; re-plan needed', { patient: p.id }, { patient: p.id });
        }
        continue;
      }
    }
  }

  /**
   * Poll consult requests and complete the order when the consultant actually
   * turns up.
   *
   * Without this the agent can place a consult and nothing ever happens — no
   * result, no treatment progress, no signoff. Since `neurology` is on the
   * stroke pathway and `cardiology`/`cath-lab` are on the STEMI pathway, a dead
   * consult loop means those patients can never be treated at all, no matter
   * what the policy does.
   */
  private consultTick(): void {
    this.engine.schedule(1, 'env:consults', () => {
      for (const [orderId, req] of [...this.consultRequests]) {
        const order = this.orders.get(orderId);
        if (!order || order.status === 'complete' || order.status === 'cancelled') {
          this.consultRequests.delete(orderId);
          continue;
        }
        const proc = this.registry.get(`consult-${req.service}`);
        const st = proc.poll(req.id);

        if (st.status === 'arrived') {
          order.status = 'complete';
          order.completedAt = this.engine.now;
          order.result = `${req.service}: seen, recommendations documented`;
          this.consultRequests.delete(orderId);
          this.onOrderResult(order);
          this.ev(
            'order.result',
            `${req.service} consult complete`,
            { service: req.service, minutes: Math.round(this.engine.now - order.placedAt) },
            { patient: order.patient, order: orderId },
          );
        } else if (st.status === 'declined' || st.status === 'no-show') {
          order.status = 'cancelled';
          this.consultRequests.delete(orderId);
          // Overnight, this is the whole game: a consult that will not come is a
          // disposition decision, not a waiting game.
          this.ev(
            'supply.declined',
            `${req.service} consult unavailable — this is a disposition decision, not a wait`,
            { service: req.service, reason: st.status },
            { patient: order.patient, order: orderId, level: 'warn' },
          );
        }
      }
      this.consultTick();
    });
  }

  private depart(p: Patient): void {
    const depth = this.ladderAttempts.get(p.id);
    if (depth !== undefined) {
      this.ladderDepths.push(depth);
      this.ladderAttempts.delete(p.id);
    }
    this.ev(
      'patient.depart',
      `${p.disposition?.kind} after ${Math.round(this.engine.now - p.arrivalTime)}m`,
      { disposition: p.disposition?.kind, los: Math.round(this.engine.now - p.arrivalTime) },
      { patient: p.id },
    );
    p.phase = 'departed';
    p.departureTime = this.engine.now;
    const bed = this.ed.bedOf(p.id);
    if (bed) this.ed.vacate(bed.id, p);
    this.ed.unassign(p.id);
    this.bedRequests.delete(p.id);
    this.transportRequests.delete(p.id);
    this.orRequests.delete(p.id);
    this.psychRequests.delete(p.id);
  }

  /**
   * LWBS. Patience runs out, and the clock only pauses if someone is actually
   * reassessing them. A patient who leaves without being seen still carries
   * whatever they came in with — which is why LWBS is a clinical cost here, not
   * a throughput win.
   */
  private lwbsTick(): void {
    this.engine.schedule(5, 'env:lwbs', () => {
      for (const p of this.patients.values()) {
        if (p.phase !== 'waiting-room' && p.phase !== 'waiting-registration') continue;
        if (p.firstProviderTime !== null) continue;

        const waited = this.engine.now - p.arrivalTime;
        const interval = this.reassessInterval.get(p.id);
        // Reassessment buys patience: being seen and told you are next helps.
        const effective = interval ? p.patience * (interval <= 30 ? 1.6 : 1.2) : p.patience;
        if (waited > effective) {
          // A patient on a hold who leaves has ELOPED — a reportable event with
          // a mandatory notification, not a quiet LWBS. Modelling it as an LWBS
          // would make losing a hold patient cheaper than losing a sprained
          // ankle, which is backwards.
          if (p.psychHold) {
            this.registry.attention.raise({
              source: 'legal-risk',
              channel: 'risk-management',
              claimedPriority: 1,
              truePriority: 1,
              roleRequired: 'ed-attending',
              delegableTo: [],
              resolutionCost: this.rng.logSpread(20, 1.3),
              responseDeadline: this.engine.now + 45,
              deferability: 'immediate',
              hardFloorIfMissed: true,
              consequenceIfMissed: 'elopement of a patient on a psychiatric hold never reported',
              patient: p.id,
              batchable: false,
              meta: { trigger: 'elopement', psychHold: true },
            });
            this.ev('note', 'ELOPEMENT: patient on a psychiatric hold left the department', {}, { patient: p.id, level: 'error' });
          }
          p.phase = 'departed';
          p.departureTime = this.engine.now;
          p.disposition = { kind: 'lwbs' };
          this.tally.lwbs++;
          this.ev(
            'patient.lwbs',
            `left without being seen after ${Math.round(waited)}m`,
            { esi: p.esi, waited: Math.round(waited) },
            { patient: p.id, level: 'warn' },
          );
          this.ed.unassign(p.id);
          const bed = this.ed.bedOf(p.id);
          if (bed) this.ed.vacate(bed.id, p);
        }
      }
      this.lwbsTick();
    });
  }

  /**
   * The restraint monitoring clock.
   *
   * Applying restraints is one action; keeping up with them is a commitment the
   * agent has to fund every 15 minutes, with a nurse, forever, until it
   * releases them. Missing an interval is a hard floor — a restrained patient
   * nobody is watching is the classic way people die in a corridor.
   *
   * Deliberately NOT deduped per patient: each missed interval is its own
   * failure. Leaving someone restrained and unchecked for two hours is not the
   * same mistake as missing one check, and the score should say so.
   */
  private restraintTick(): void {
    this.engine.schedule(5, 'env:restraints', () => {
      for (const p of this.patients.values()) {
        const r = p.restraint;
        if (!r || r.releasedAt !== null) continue;

        const overdueBy = this.engine.now - r.lastCheckAt - r.checkIntervalMinutes;
        if (overdueBy > 0) {
          r.checksMissed++;
          // Advance the clock so the next miss is a fresh interval rather than
          // the same one re-firing every tick.
          r.lastCheckAt = this.engine.now;
          this.safetyEvents.push({
            kind: 'restraint-monitoring-missed',
            at: this.engine.now,
            patient: p.id,
            detail: `${r.kind} restraint check missed (interval ${r.checkIntervalMinutes}m, ${r.checksMissed} missed so far)`,
          });
          this.ev(
            'safety',
            `restraint check missed (${r.checksMissed} total)`,
            { violation: 'restraint-monitoring-missed', kind: r.kind },
            { patient: p.id, level: 'error' },
          );
        }

        // Restraints are not benign. An unchecked restrained patient
        // deteriorates: positional asphyxia, aspiration, rhabdomyolysis.
        if (r.checksMissed > 0) {
          p.latent.hazard = Math.min(1.5, p.latent.hazard * 1.002);
        }
      }

      // A psych hold in an unsafe room without a sitter is its own floor: the
      // room, not the diagnosis, is what kills.
      for (const p of this.patients.values()) {
        if (!p.psychHold || p.phase === 'departed') continue;
        if (p.sitter) continue;
        const bed = this.ed.bedOf(p.id);
        // A hallway bed is inherently unsafe for a hold — no ligature control,
        // no line of sight, nowhere to put them.
        if (bed?.kind === 'hallway') {
          this.recordSafety(
            'psych-hold-unsafe-room',
            p.id,
            'psychiatric hold in a hallway bed with no sitter',
          );
        }
      }

      this.restraintTick();
    });
  }

  /** Accrue boarding hours continuously so the tail is measurable, not bucketed. */
  private boardingTick(): void {
    this.engine.schedule(5, 'env:boarding', () => {
      for (const p of this.patients.values()) {
        if (p.phase === 'boarding') this.tally.boardingHours += 5 / 60;
      }
      this.boardingTick();
    });
  }

  /** Roll up the tallies that are cheaper to compute at step boundaries. */
  private settleTally(): void {
    let los = 0;
    let dtp = 0;
    let bounce = 0;
    for (const p of this.patients.values()) {
      const end = p.departureTime ?? this.engine.now;
      los += (end - p.arrivalTime) / 60;
      if (p.firstProviderTime !== null && p.esi !== null) {
        const target = DOOR_TO_PROVIDER_TARGET[p.esi] ?? 60;
        dtp += Math.max(0, p.firstProviderTime - p.arrivalTime - target);
      }
      if (p.bounceBackOf) bounce++;
    }
    this.tally.losHours = los;
    this.tally.doorToProviderExcessMinutes = dtp;
    this.tally.bounceBacks = bounce;

    let attention = 0;
    for (const role of [
      'charge-nurse',
      'ed-attending',
      'house-supervisor',
      'unit-clerk',
      'registrar',
      'bedside-nurse',
      'security',
    ] as AttentionRole[]) {
      attention += this.registry.attention.server(role).attentionSpent;
    }
    this.tally.attentionMinutes = attention;
    this.tally.taskSwitchErrors = this.registry.attention.taskSwitchEvents.filter((e) => e.causedError).length;

    this.tally.diversionHours = this.diversionHoursTotal;
    this.tally.overtimeHours = this.ed.overtimeUsed / 60;

    // Missed hard interrupt deadlines become safety events exactly once.
    for (const missed of this.registry.attention.missedHardDeadlines) {
      const already = this.safetyEvents.some((e) => e.detail.includes(missed.id));
      if (already) continue;
      // Label the floor by what actually failed. Mapping every missed mandatory
      // interrupt to 'phi-leak' was wrong: a blown reporting clock discloses
      // nothing, and it made a do-nothing policy look like it leaked records.
      const kind: SafetyViolation =
        missed.source === 'critical-callback' ? 'missed-critical-callback' : 'mandatory-reporting-missed';
      this.recordSafety(kind, missed.patient, `${missed.consequenceIfMissed} [${missed.id}]`);
    }

    // Deferred admin that blew its (soft) deadline is re-work.
    this.tally.reworkEvents = this.registry.attention.all.filter(
      (i) => i.state.status === 'missed' && !i.interrupt.hardFloorIfMissed,
    ).length;

    this.tally.safetyEvents = this.safetyEvents;
  }
}

const NURSE_SCOPE = ['ecg', 'cbc', 'bmp', 'glucose', 'lactate', 'troponin', 'cxr', 'plain-film', 'analgesia', 'fluids'];

function emptyTally(): RewardTally {
  return {
    integratedRisk: 0,
    deaths: 0,
    deteriorations: 0,
    lwbs: 0,
    bounceBacks: 0,
    boardingHours: 0,
    losHours: 0,
    doorToProviderExcessMinutes: 0,
    attentionMinutes: 0,
    taskSwitchErrors: 0,
    wastedSupplyRequests: 0,
    transportCostUnits: 0,
    diversionHours: 0,
    overtimeHours: 0,
    reworkEvents: 0,
    safetyEvents: [],
  };
}

function describeNeed(n: ReturnType<ErEnv['transportNeed']>): string {
  const parts: string[] = [];
  if (n.paramedic) parts.push('paramedic escort');
  if (n.monitored) parts.push('monitoring');
  if (n.stretcher) parts.push('stretcher');
  if (n.wheelchair) parts.push('wheelchair');
  return parts.length ? parts.join(', ') : 'ambulatory';
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

export { HOUR };
