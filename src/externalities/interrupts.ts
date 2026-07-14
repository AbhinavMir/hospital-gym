import type { Engine, Minutes } from '../kernel/engine.js';
import type { Rng } from '../kernel/rng.js';
import type { PatientId } from '../domain/types.js';
import type { AmbientState } from './ambient.js';
import { StressResponse } from './ambient.js';
import { type AttentionModel, type Interrupt, type InterruptSource, claimPriority } from './attention.js';

/**
 * PRIMITIVE 2 — InterruptChannel. Unsolicited: the world demands attention.
 *
 * Interrupt volume rises with S, like everything else: more patients means more
 * calls about more patients, at exactly the moment attention is scarcest.
 */
export interface InterruptChannel {
  readonly source: InterruptSource;
  /** Base events per hour at S=0. */
  readonly baseRate: number;
  /** Rate multiplier at S=1. */
  readonly rateAtMaxStress: number;
  /** Build one interrupt. `patients` is the current census, for targeting. */
  make(rng: Rng, now: Minutes, patients: PatientId[]): Omit<Interrupt, 'id' | 'raisedAt'> | null;
}

const p = (rng: Rng, patients: PatientId[]): PatientId | null =>
  patients.length ? rng.pick(patients) : null;

/**
 * Billing / registration. Claimed priority is always high; true priority is
 * usually low. Deferrable and batchable — this is the class the agent should
 * learn to hold and return in one callback.
 *
 * Two things keep it from being pure noise: patient class (observation vs
 * inpatient) is flow-relevant, and deferring indefinitely produces re-work and
 * denied claims. Both costed, neither a floor.
 *
 * EMTALA: an interrupt from billing that would delay a medical screening exam
 * MUST be deferred. Complying with it is a hard floor. That check lives in the
 * env's action handler, not here.
 */
export const BillingChannel: InterruptChannel = {
  source: 'billing',
  baseRate: 1.4,
  rateAtMaxStress: 1.8,
  make(rng, now, patients) {
    const isPatientClass = rng.bool(0.3);
    const truePriority = isPatientClass ? 3 : rng.int(4, 5);
    const target = p(rng, patients);
    return {
      source: 'billing',
      channel: 'registration-line',
      claimedPriority: claimPriority('billing', truePriority, rng),
      truePriority,
      roleRequired: 'registrar',
      delegableTo: ['unit-clerk'],
      resolutionCost: rng.logSpread(5, 1.5),
      responseDeadline: now + rng.uniform(180, 480),
      deferability: 'deferrable',
      hardFloorIfMissed: false,
      consequenceIfMissed: isPatientClass ? 'patient class unresolved; bed eligibility wrong' : 'denied claim, re-work',
      patient: target,
      batchable: true,
      meta: {
        topic: isPatientClass ? 'patient-class' : rng.pick(['eligibility', 'insurance-verify', 'reg-error']),
        /** Set when this interrupt, if honoured now, would delay an MSE. */
        wouldDelayMse: rng.bool(0.15),
      },
    };
  },
};

/**
 * Legal / risk. Some carry mandatory reporting clocks — missing one is a hard
 * floor, not a cost. There is no throughput optimisation here: the correct
 * behaviour is compliance. The graded skill is not letting the compliance work
 * destroy the rest of the board, i.e. backfilling the occupied role.
 */
export const LegalRiskChannel: InterruptChannel = {
  source: 'legal-risk',
  baseRate: 0.12,
  rateAtMaxStress: 2.0,
  make(rng, now, patients) {
    const trigger = rng.weighted([
      ['elopement', 0.2],
      ['ama-departure', 0.2],
      ['restraint-application', 0.18],
      ['patient-death', 0.06],
      ['reportable-event', 0.16],
      ['subpoena', 0.1],
      ['complaint', 0.1],
    ] as const);
    // Mandatory-reporting classes cannot be deferred and blow a hard floor.
    const mandatory = ['reportable-event', 'patient-death', 'restraint-application'].includes(trigger);
    const truePriority = mandatory ? 1 : trigger === 'subpoena' || trigger === 'complaint' ? 5 : 2;
    return {
      source: 'legal-risk',
      channel: 'risk-management',
      claimedPriority: claimPriority('legal-risk', truePriority, rng),
      truePriority,
      roleRequired: mandatory ? 'ed-attending' : 'house-supervisor',
      // Cannot be delegated to a clerk. Ever.
      delegableTo: mandatory ? [] : ['ed-attending'],
      resolutionCost: rng.logSpread(mandatory ? 22 : 10, 1.4),
      responseDeadline: mandatory ? now + rng.uniform(45, 90) : now + rng.uniform(240, 720),
      deferability: mandatory ? 'immediate' : 'schedulable',
      hardFloorIfMissed: mandatory,
      consequenceIfMissed: mandatory ? 'mandatory reporting clock missed' : 're-work and escalation',
      patient: p(rng, patients),
      batchable: !mandatory && rng.bool(0.5),
      meta: { trigger, mandatoryClock: mandatory },
    };
  },
};

/**
 * Law enforcement. The blood-draw request is the one to get right: drawing
 * without a warrant or consent is a hard-floor legal violation, and the officer
 * will claim urgency either way.
 */
export const LawEnforcementChannel: InterruptChannel = {
  source: 'law-enforcement',
  baseRate: 0.15,
  rateAtMaxStress: 1.6,
  make(rng, now, patients) {
    const kind = rng.weighted([
      ['blood-draw-request', 0.35],
      ['patient-in-custody', 0.25],
      ['psychiatric-hold', 0.25],
      ['violent-patient', 0.15],
    ] as const);
    const hasWarrant = kind === 'blood-draw-request' ? rng.bool(0.45) : false;
    const hasConsent = kind === 'blood-draw-request' && !hasWarrant ? rng.bool(0.3) : false;
    const truePriority = kind === 'violent-patient' ? 1 : kind === 'psychiatric-hold' ? 3 : 4;
    return {
      source: 'law-enforcement',
      channel: 'ed-security-desk',
      claimedPriority: claimPriority('law-enforcement', truePriority, rng),
      truePriority,
      roleRequired: kind === 'violent-patient' ? 'security' : 'charge-nurse',
      delegableTo: kind === 'violent-patient' ? [] : ['house-supervisor'],
      resolutionCost: rng.logSpread(kind === 'violent-patient' ? 25 : 9, 1.5),
      responseDeadline: kind === 'violent-patient' ? now + 10 : null,
      deferability: kind === 'violent-patient' ? 'immediate' : 'deferrable',
      hardFloorIfMissed: false,
      consequenceIfMissed: 'situation escalates; staff and patient safety',
      patient: p(rng, patients),
      batchable: false,
      meta: { kind, hasWarrant, hasConsent },
    };
  },
};

/** Family. High claimed urgency, low true urgency, but not zero. */
export const FamilyChannel: InterruptChannel = {
  source: 'family',
  baseRate: 0.9,
  rateAtMaxStress: 2.4,
  make(rng, now, patients) {
    const truePriority = rng.weighted([
      [2, 0.05], // occasionally family reports a real change the staff missed
      [4, 0.45],
      [5, 0.5],
    ] as const);
    return {
      source: 'family',
      channel: 'front-desk',
      claimedPriority: claimPriority('family', truePriority, rng),
      truePriority,
      roleRequired: 'bedside-nurse',
      delegableTo: ['unit-clerk', 'charge-nurse'],
      resolutionCost: rng.logSpread(6, 1.6),
      responseDeadline: now + rng.uniform(60, 240),
      deferability: 'deferrable',
      hardFloorIfMissed: false,
      consequenceIfMissed: 'complaint; occasionally a missed clinical change',
      patient: p(rng, patients),
      batchable: false,
      meta: { topic: rng.pick(['update-request', 'visitation', 'clinical-concern']) },
    };
  },
};

/** Admin and media. Almost always deferrable noise, always claimed urgent. */
export const AdminChannel: InterruptChannel = {
  source: 'admin',
  baseRate: 0.6,
  rateAtMaxStress: 1.5,
  make(rng, now) {
    const truePriority = rng.int(4, 5);
    return {
      source: 'admin',
      channel: 'admin-line',
      claimedPriority: claimPriority('admin', truePriority, rng),
      truePriority,
      roleRequired: 'charge-nurse',
      delegableTo: ['unit-clerk', 'house-supervisor'],
      resolutionCost: rng.logSpread(7, 1.5),
      responseDeadline: now + rng.uniform(240, 960),
      deferability: 'schedulable',
      hardFloorIfMissed: false,
      consequenceIfMissed: 're-work',
      patient: null,
      batchable: true,
      meta: { topic: rng.pick(['staffing-survey', 'metrics-request', 'policy-ack', 'meeting']) },
    };
  },
};

export const MediaChannel: InterruptChannel = {
  source: 'media',
  baseRate: 0.04,
  rateAtMaxStress: 6.0, // a mass-casualty event brings the press
  make(rng, now) {
    const truePriority = rng.int(4, 5);
    return {
      source: 'media',
      channel: 'switchboard',
      claimedPriority: claimPriority('media', truePriority, rng),
      truePriority,
      roleRequired: 'house-supervisor',
      delegableTo: [],
      resolutionCost: rng.logSpread(12, 1.4),
      responseDeadline: null,
      deferability: 'schedulable',
      hardFloorIfMissed: false,
      // PHI leak risk lives in the action handler: answering media about a
      // named patient is a hard floor regardless of how it is framed.
      consequenceIfMissed: 'reputational; no clinical consequence',
      patient: null,
      batchable: true,
      meta: { topic: 'press-inquiry' },
    };
  },
};

export const DEFAULT_CHANNELS: InterruptChannel[] = [
  BillingChannel,
  LegalRiskChannel,
  LawEnforcementChannel,
  FamilyChannel,
  AdminChannel,
  MediaChannel,
];

/**
 * Drives interrupt generation. EMS radio, report handoff, and critical
 * callbacks are NOT here — those are raised by the modules that own them
 * (ems.ts, handoff.ts, labs.ts) because they carry real state.
 */
export class InterruptGenerator {
  constructor(
    private readonly engine: Engine,
    private readonly rng: Rng,
    private readonly ambient: AmbientState,
    private readonly attention: AttentionModel,
    private readonly channels: InterruptChannel[],
    private readonly census: () => PatientId[],
  ) {
    this.tick();
  }

  private tick(): void {
    this.engine.schedule(10, 'interrupts:tick', () => {
      const s = this.ambient.stress;
      for (const ch of this.channels) {
        const rate = ch.baseRate * StressResponse.grows(s, ch.rateAtMaxStress);
        const n = this.rng.poisson(rate * (10 / 60));
        for (let i = 0; i < n; i++) {
          const spec = ch.make(this.rng, this.engine.now, this.census());
          if (spec) this.attention.raise(spec);
        }
      }
      this.tick();
    });
  }
}
