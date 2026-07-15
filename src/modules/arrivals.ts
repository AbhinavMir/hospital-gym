import type { Engine, Minutes } from '../kernel/engine.js';
import { hourOfDay } from '../kernel/engine.js';
import type { Rng } from '../kernel/rng.js';
import {
  CONDITION_KINDS,
  type ArrivalMode,
  type ConditionKind,
  type Identity,
  type Isolation,
  type Patient,
  type PatientId,
} from '../domain/types.js';
import { makeLatentState } from '../domain/physiology.js';
import type { AmbientState } from '../externalities/ambient.js';
import { StressResponse } from '../externalities/ambient.js';
import type { AttentionModel } from '../externalities/attention.js';

/**
 * Arrivals, EMS pre-alert, and trauma activation.
 *
 * Arrival rate and acuity mix both rise with S — same surge, sicker patients.
 * A mass-casualty event is a Hawkes-style self-exciting burst layered on top.
 */

export interface ArrivalConfig {
  startHour: number;
  /** Baseline arrivals per hour at S=0, before the diurnal curve. */
  baseRatePerHour: number;
  /** Arrival-rate multiplier at S=1. */
  rateAtMaxStress: number;
  /** Fraction arriving by EMS. */
  emsFraction: number;
  /** Of EMS arrivals, the fraction that pre-alert. */
  prealertFraction: number;
  /** Condition mix weights. Overridden by scenarios (e.g. respiratory-season). */
  conditionMix: Partial<Record<ConditionKind, number>>;
  /** Hawkes burst: excitation added per high-acuity arrival. */
  hawkesExcitation: number;
  /** Hawkes decay per hour. */
  hawkesDecay: number;
  /** Probability an arrival needs isolation, before S scaling. */
  isolationRate: number;
}

export interface PreAlert {
  id: string;
  patient: PatientId;
  /** Minutes until the unit arrives. Noisy and revisable, like any ETA. */
  eta: Minutes;
  reportedComplaint: string;
  /** What EMS says the acuity is. Field triage is imperfect. */
  reportedEsi: number;
  /** True trauma-activation need. Never exposed. */
  trueActivationNeeded: boolean;
  raisedAt: Minutes;
}

export type ActivationTier = 'none' | 'limited' | 'full';

export class ArrivalProcess {
  private seq = 0;
  private hawkes = 0;
  private lastHawkes = 0;
  readonly preAlerts = new Map<string, PreAlert>();
  /** Person keys of discharged patients, for the 72h bounce-back process. */
  private discharged: { personKey: string; at: Minutes; unsafeRisk: number; patient: PatientId }[] = [];

  constructor(
    private readonly engine: Engine,
    private readonly rng: Rng,
    private readonly ambient: AmbientState,
    private readonly attention: AttentionModel,
    private readonly cfg: ArrivalConfig,
    private readonly onArrival: (p: Patient) => void,
  ) {
    this.tick();
  }

  /**
   * Record a discharge so the bounce-back process can bring them back.
   *
   * This is one half of the guard against the discharge-everyone exploit: a
   * patient discharged while still sick returns within 72h, sicker, and the
   * episode pays for it. The other half is the unsafe-destination floor.
   */
  recordDischarge(patient: Patient, unsafeRisk: number): void {
    this.discharged.push({
      personKey: patient.identity.personKey,
      at: this.engine.now,
      unsafeRisk,
      patient: patient.id,
    });
  }

  /** Acknowledge a pre-alert. Frees the radio; does not stage anything. */
  acknowledgePreAlert(id: string): boolean {
    return this.preAlerts.has(id);
  }

  private tick(): void {
    this.engine.schedule(5, 'arrivals:tick', () => {
      const s = this.ambient.stress;
      const hour = hourOfDay(this.engine.now, this.cfg.startHour);

      // Hawkes decay since the last tick.
      const dtHours = (this.engine.now - this.lastHawkes) / 60;
      this.hawkes *= Math.exp(-this.cfg.hawkesDecay * dtHours);
      this.lastHawkes = this.engine.now;

      const rate =
        this.cfg.baseRatePerHour *
        this.diurnal(hour) *
        StressResponse.grows(s, this.cfg.rateAtMaxStress) +
        this.hawkes;

      const n = this.rng.poisson(rate * (5 / 60));
      for (let i = 0; i < n; i++) this.spawn();
      this.tick();
    });
  }

  /** ED arrivals peak late morning through early evening. */
  private diurnal(hour: number): number {
    return 0.45 + 0.9 * Math.exp(-Math.pow(hour - 13, 2) / 40);
  }

  private spawn(): void {
    const s = this.ambient.stress;
    const id: PatientId = `pt-${++this.seq}`;

    // Bounce-back: a patient discharged unsafely within 72h returns, sicker.
    const bounce = this.pickBounceBack();
    const condition = bounce ? this.bounceCondition() : this.pickCondition(s);

    const latent = makeLatentState(condition, this.rng);
    if (bounce) {
      // They come back worse than they left. That is the cost of the exploit.
      latent.severity = Math.min(0.95, latent.severity + 0.25 + 0.4 * bounce.unsafeRisk);
      latent.hazard *= 1.3;
    }

    // Acuity mix shifts up with stress: the surge brings sicker people, not
    // just more of them.
    if (this.rng.bool(StressResponse.probability(s, 0.05, 0.3))) {
      latent.severity = Math.min(0.95, latent.severity * 1.4);
      latent.hazard *= 1.2;
    }

    const isEms = this.rng.bool(this.cfg.emsFraction);
    const isPrealert = isEms && this.rng.bool(this.cfg.prealertFraction);
    const mode: ArrivalMode = isPrealert ? 'ems-prealert' : isEms ? 'ems' : 'walk-in';

    const identity = this.makeIdentity(bounce?.personKey);
    const isolation: Isolation = this.rng.bool(this.cfg.isolationRate * StressResponse.grows(s, 1.6))
      ? this.rng.weighted([
          ['contact', 0.5],
          ['droplet', 0.35],
          ['airborne', 0.15],
        ] as const)
      : 'none';

    const patient: Patient = {
      id,
      mrn: null,
      identity,
      // An unidentified EMS arrival is the identity-resolution problem in its
      // hardest form: no name, no DOB, and an MPI that will happily overlay.
      statedIdentity: isEms && this.rng.bool(0.12) ? null : { name: identity.name, dob: identity.dob, sex: identity.sex },
      arrivalMode: mode,
      arrivalTime: this.engine.now,
      chiefComplaint: COMPLAINTS[condition],
      isolation,
      transportable: !(latent.severity > 0.6 && this.rng.bool(0.5)),
      renalCleared: null,
      phase: 'arriving',
      location: null,
      esi: null,
      triageTime: null,
      registrationTime: null,
      firstProviderTime: null,
      dispositionDecisionTime: null,
      bedRequestTime: null,
      departureTime: null,
      disposition: null,
      assignedNurse: null,
      assignedProvider: null,
      latent,
      lastVitals: null,
      lastVitalsTime: null,
      // Sicker patients wait longer before walking out; low-acuity patients bail.
      patience: this.rng.logSpread(latent.trueEsi <= 2 ? 300 : latent.trueEsi === 3 ? 150 : 90, 1.7),
      riskAccrued: 0,
      bounceBackOf: bounce?.patient ?? null,
      orders: [],
      flags: new Set(bounce ? ['bounce-back'] : []),
      restraint: null,
      // Psych presentations arrive on a hold a fair fraction of the time; the
      // hold is a legal status the ED inherits, not something it chooses.
      psychHold: condition === 'psych' && this.rng.bool(0.55),
      sitter: null,
    };

    // Hawkes self-excitation: high-acuity arrivals beget more (an MCI, a
    // multi-vehicle crash, a building fire).
    if (latent.trueEsi <= 2) {
      this.hawkes += this.cfg.hawkesExcitation;
    }

    if (isPrealert) {
      this.raisePreAlert(patient);
    } else {
      patient.phase = 'waiting-registration';
      this.onArrival(patient);
    }
  }

  /**
   * EMS pre-alert. The radio call comes in before the patient does, which is
   * the entire value: it buys lead time to pre-stage a bay, warm the blood
   * bank, and pull meds. It also costs attention to take the call.
   */
  private raisePreAlert(patient: Patient): void {
    const eta = this.rng.logSpread(11, 1.5);
    const trueEsi = patient.latent.trueEsi;

    // Field triage is imperfect in BOTH directions, which is what creates the
    // asymmetric over/under-triage cost. EMS reports what it sees, not truth.
    const reportedEsi = this.rng.bool(0.7)
      ? trueEsi
      : Math.max(1, Math.min(5, trueEsi + this.rng.pick([-1, 1])));

    const alert: PreAlert = {
      id: `prealert-${patient.id}`,
      patient: patient.id,
      eta,
      reportedComplaint: patient.chiefComplaint,
      reportedEsi,
      trueActivationNeeded: trueEsi <= 2 && patient.latent.condition === 'trauma',
      raisedAt: this.engine.now,
    };
    this.preAlerts.set(alert.id, alert);

    this.attention.raise({
      source: 'ems-radio',
      channel: 'ems-radio',
      claimedPriority: reportedEsi <= 2 ? 1 : 3,
      truePriority: trueEsi <= 2 ? 1 : 3,
      roleRequired: 'charge-nurse',
      delegableTo: ['ed-attending'],
      resolutionCost: this.rng.logSpread(3, 1.3),
      responseDeadline: this.engine.now + eta,
      deferability: 'deferrable',
      hardFloorIfMissed: false,
      consequenceIfMissed: 'patient arrives unannounced; no pre-staging',
      patient: patient.id,
      batchable: false,
      meta: { prealert: alert.id, eta: Math.round(eta), reportedEsi, complaint: patient.chiefComplaint },
    });

    // The unit arrives whether or not anyone answered the radio.
    this.engine.schedule(eta, 'arrivals:ems-arrive', () => {
      this.preAlerts.delete(alert.id);
      patient.phase = 'waiting-registration';
      this.onArrival(patient);
    });
  }

  private pickCondition(stress: number): ConditionKind {
    const mix = this.cfg.conditionMix;
    const entries: [ConditionKind, number][] = CONDITION_KINDS.map((k) => [k, mix[k] ?? DEFAULT_MIX[k]]);
    return this.rng.weighted(entries);
  }

  private bounceCondition(): ConditionKind {
    return this.rng.weighted([
      ['sepsis', 0.3],
      ['abdominal', 0.2],
      ['respiratory', 0.2],
      ['chest-pain-lowrisk', 0.15],
      ['overdose', 0.15],
    ] as const);
  }

  /** Returns a prior discharge to bounce back, if the dice say so. */
  private pickBounceBack(): { personKey: string; unsafeRisk: number; patient: PatientId } | null {
    const window = 72 * 60;
    const eligible = this.discharged.filter((d) => this.engine.now - d.at < window);
    this.discharged = eligible;
    for (const d of eligible) {
      // Bounce-back probability scales with how unsafe the discharge was. A
      // correctly discharged patient almost never comes back.
      const p = 0.02 + 0.5 * d.unsafeRisk;
      if (this.rng.bool(p * (5 / 60) / 4)) {
        this.discharged = this.discharged.filter((x) => x !== d);
        return { personKey: d.personKey, unsafeRisk: d.unsafeRisk, patient: d.patient };
      }
    }
    return null;
  }

  private makeIdentity(existingKey?: string): Identity {
    const first = this.rng.pick(FIRST_NAMES);
    const last = this.rng.pick(LAST_NAMES);
    return {
      name: `${first} ${last}`,
      dob: `19${this.rng.int(35, 99)}-${String(this.rng.int(1, 12)).padStart(2, '0')}-${String(this.rng.int(1, 28)).padStart(2, '0')}`,
      sex: this.rng.weighted([
        ['M', 0.48],
        ['F', 0.49],
        ['X', 0.03],
      ] as const),
      personKey: existingKey ?? `person-${this.rng.int(1, 1_000_000)}`,
    };
  }
}

const DEFAULT_MIX: Record<ConditionKind, number> = {
  minor: 0.24,
  'chest-pain-lowrisk': 0.14,
  abdominal: 0.16,
  respiratory: 0.13,
  psych: 0.08,
  sepsis: 0.07,
  trauma: 0.07,
  overdose: 0.05,
  stroke: 0.04,
  stemi: 0.02,
};

const COMPLAINTS: Record<ConditionKind, string> = {
  sepsis: 'fever and confusion',
  stroke: 'sudden weakness, slurred speech',
  stemi: 'crushing chest pain',
  trauma: 'motor vehicle collision',
  respiratory: 'shortness of breath',
  abdominal: 'abdominal pain',
  psych: 'agitation, suicidal ideation',
  minor: 'laceration',
  'chest-pain-lowrisk': 'chest discomfort',
  overdose: 'unresponsive, suspected ingestion',
};

const FIRST_NAMES = ['Ana', 'Ben', 'Chi', 'Dara', 'Eli', 'Fay', 'Gus', 'Hana', 'Ivo', 'Jae', 'Kit', 'Lou', 'Mei', 'Nils', 'Ola', 'Pia', 'Quinn', 'Rui', 'Sol', 'Tam'];
const LAST_NAMES = ['Adler', 'Bek', 'Cruz', 'Dahl', 'Eze', 'Fell', 'Grau', 'Holm', 'Iyer', 'Jung', 'Kaur', 'Lind', 'Moss', 'Nagy', 'Okafor', 'Pratt', 'Rao', 'Sato', 'Tan', 'Vogel'];
