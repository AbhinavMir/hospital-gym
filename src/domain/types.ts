import type { Minutes } from '../kernel/engine.js';

// --- identifiers ------------------------------------------------------------

export type PatientId = string;
export type BedId = string;
export type StaffId = string;
export type OrderId = string;
export type RequestId = string;

// --- acuity -----------------------------------------------------------------

/** Emergency Severity Index. 1 = resuscitation, 5 = non-urgent. */
export type Esi = 1 | 2 | 3 | 4 | 5;

/** Inpatient care levels. Ordered most to least intensive. */
export const CARE_LEVELS = ['icu', 'stepdown', 'telemetry', 'medsurg', 'observation'] as const;
export type CareLevel = (typeof CARE_LEVELS)[number];

/** Higher index = less intensive. Used to detect over/under-requesting. */
export function levelRank(level: CareLevel): number {
  return CARE_LEVELS.indexOf(level);
}

export type Isolation = 'none' | 'contact' | 'droplet' | 'airborne';

// --- physiology -------------------------------------------------------------

/** Observable vitals. What the agent sees when a measurement is taken. */
export interface Vitals {
  hr: number;
  sbp: number;
  rr: number;
  spo2: number;
  temp: number;
  gcs: number;
}

/**
 * The patient's true state. Never exposed to the agent directly — the agent
 * only ever sees measurements of it, taken at the times it chooses to take them.
 * Reward is computed against this.
 */
export interface LatentState {
  /** 0 = well, 1 = dead. Integrates untreated time weighted by hazard. */
  severity: number;
  /** Intrinsic deterioration rate per hour while untreated. */
  hazard: number;
  /** True acuity, independent of whatever ESI the agent assigned. */
  trueEsi: Esi;
  /** Underlying complaint driver; selects which workup actually helps. */
  condition: ConditionKind;
  /** How much of the needed workup/treatment has landed. 0..1. */
  treatmentProgress: number;
  /** Set once irreversible. */
  dead: boolean;
}

export const CONDITION_KINDS = [
  'sepsis',
  'stroke',
  'stemi',
  'trauma',
  'respiratory',
  'abdominal',
  'psych',
  'minor',
  'chest-pain-lowrisk',
  'overdose',
] as const;
export type ConditionKind = (typeof CONDITION_KINDS)[number];

// --- patient ----------------------------------------------------------------

export type PatientPhase =
  | 'arriving'
  | 'waiting-registration'
  | 'waiting-triage'
  | 'waiting-room' // triaged, waiting for an ED bed
  | 'in-bed'
  | 'at-imaging'
  | 'boarding' // dispositioned to admit, holding an ED bed
  | 'departed';

export type Disposition =
  | { kind: 'discharge' }
  | { kind: 'admit'; level: CareLevel }
  | { kind: 'transfer-out' }
  | { kind: 'or' }
  | { kind: 'lwbs' }
  | { kind: 'ama' }
  | { kind: 'died' };

export type ArrivalMode = 'walk-in' | 'ems' | 'ems-prealert';

export interface Identity {
  name: string;
  dob: string;
  sex: 'M' | 'F' | 'X';
  /** True identity key. Two encounters of the same human share this. */
  personKey: string;
}

export interface Patient {
  id: PatientId;
  /** Assigned at registration. Null until then. */
  mrn: string | null;
  identity: Identity;
  /** What the agent knows about identity. Degraded for unidentified EMS arrivals. */
  statedIdentity: Partial<Identity> | null;
  arrivalMode: ArrivalMode;
  arrivalTime: Minutes;
  chiefComplaint: string;
  isolation: Isolation;
  /** Requires a monitored bed and cannot go to a fixed scanner unescorted. */
  transportable: boolean;
  /** eGFR proxy; contrast without clearance on a low value is a safety floor. */
  renalCleared: boolean | null;

  phase: PatientPhase;
  location: BedId | null;
  esi: Esi | null;
  triageTime: Minutes | null;
  registrationTime: Minutes | null;
  firstProviderTime: Minutes | null;
  dispositionDecisionTime: Minutes | null;
  bedRequestTime: Minutes | null;
  departureTime: Minutes | null;
  disposition: Disposition | null;

  assignedNurse: StaffId | null;
  assignedProvider: StaffId | null;

  latent: LatentState;
  /** Last recorded vitals and when. The agent sees these, not the latent state. */
  lastVitals: Vitals | null;
  lastVitalsTime: Minutes | null;

  /** Minutes of un-reassessed waiting the patient tolerates before leaving. */
  patience: Minutes;
  /** Accrued clinical risk, integrated over the episode. Drives reward. */
  riskAccrued: number;
  /** Set when the patient is a repeat visit within 72h of a prior discharge. */
  bounceBackOf: PatientId | null;

  orders: OrderId[];
  flags: Set<string>;
}

// --- orders -----------------------------------------------------------------

export type OrderKind = 'lab' | 'imaging' | 'med' | 'consult' | 'blood';
export type Priority = 'stat' | 'routine';

export type OrderStatus =
  | 'ordered'
  | 'collecting' // lab: awaiting draw
  | 'in-transit'
  | 'accessioned'
  | 'analysing'
  | 'awaiting-verification' // pharmacy: awaiting pharmacist verification
  | 'scheduled' // imaging: queued for a modality
  | 'acquiring'
  | 'awaiting-read'
  | 'rejected'
  | 'resulted'
  | 'administered'
  | 'complete'
  | 'cancelled';

export interface Order {
  id: OrderId;
  patient: PatientId;
  kind: OrderKind;
  /** Specific test/modality/drug/service. */
  name: string;
  priority: Priority;
  status: OrderStatus;
  placedAt: Minutes;
  completedAt: Minutes | null;
  /** Set when a specimen is rejected; the agent must notice and redraw. */
  rejected: boolean;
  /** Whether a redraw has been triggered for a rejected specimen. */
  redrawOf: OrderId | null;
  /** True when the result is a critical value requiring a callback. */
  critical: boolean;
  /** When the critical-value callback clock started, and whether it was closed. */
  criticalAt: Minutes | null;
  criticalAckedAt: Minutes | null;
  /** How much this order's completion advances treatmentProgress. */
  therapeuticValue: number;
  result: string | null;
  /** Free-form per-kind detail (modality, drug class, service, ...). */
  meta: Record<string, string | number | boolean>;
}

// --- resources --------------------------------------------------------------

export type BedKind = 'main' | 'resus' | 'fast-track' | 'hallway';
export type BedStatus = 'clean' | 'occupied' | 'dirty' | 'cleaning';

export interface EdBed {
  id: BedId;
  kind: BedKind;
  monitored: boolean;
  /** Negative-pressure; required for airborne isolation. */
  negativePressure: boolean;
  status: BedStatus;
  patient: PatientId | null;
  /** Terminal clean required (isolation patient departed). */
  needsTerminalClean: boolean;
}

export type StaffRole = 'nurse' | 'physician' | 'app' | 'tech' | 'evs' | 'transport' | 'pharmacist';

export interface Staff {
  id: StaffId;
  role: StaffRole;
  /** Patients currently assigned (nurses) or tasks in hand (others). */
  assigned: PatientId[];
  /** 0..1; rises with hours worked and load, degrades service times. */
  fatigue: number;
  onDutyUntil: Minutes;
  /** True while doing something that blocks other work. */
  busyUntil: Minutes;
  overtime: boolean;
}

// --- safety -----------------------------------------------------------------

/**
 * Hard floors. These are not soft penalties to be traded against throughput —
 * each one is a bounded, large negative and is reported separately so a policy
 * cannot hide safety failures inside an aggregate score.
 */
export const SAFETY_VIOLATIONS = [
  'ratio-breach',
  'wrong-patient-identity',
  'phi-leak',
  'controlled-substance-discrepancy',
  'verification-bypass',
  'inappropriate-transport-tier',
  'unsafe-destination-discharge',
  'non-transportable-to-fixed-scanner',
  'contrast-without-renal-clearance',
  'under-triage-danger-zone',
  'missed-critical-callback',
] as const;
export type SafetyViolation = (typeof SAFETY_VIOLATIONS)[number];

export interface SafetyEvent {
  kind: SafetyViolation;
  at: Minutes;
  patient: PatientId | null;
  detail: string;
}
