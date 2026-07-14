import { Rng } from '../kernel/rng.js';
import type { ConditionKind, Esi, LatentState, Vitals } from './types.js';

/**
 * Latent physiology.
 *
 * The design rule: the agent never reads `LatentState`. It reads `Vitals`, and
 * only for patients it has chosen to measure. Reward is computed from the
 * latent state. That gap is the entire point — a policy that stops measuring
 * stops seeing deterioration but still pays for it.
 */

interface ConditionProfile {
  /** Baseline severity at arrival. */
  severity0: [number, number];
  /** Deterioration per hour while untreated, before severity scaling. */
  hazard: [number, number];
  /** Distribution over true ESI. */
  esi: (readonly [Esi, number])[];
  /** Orders that actually advance treatment for this condition. */
  helpful: string[];
  /** Vitals shift at maximum severity, added to the well baseline. */
  derangement: Partial<Vitals>;
}

const PROFILES: Record<ConditionKind, ConditionProfile> = {
  sepsis: {
    severity0: [0.15, 0.35],
    hazard: [0.10, 0.22],
    esi: [[1, 0.1], [2, 0.6], [3, 0.3]],
    helpful: ['lactate', 'blood-culture', 'cbc', 'bmp', 'antibiotics', 'fluids', 'ct-abdomen'],
    derangement: { hr: 45, sbp: -50, rr: 12, temp: 2.5, spo2: -8, gcs: -4 },
  },
  stroke: {
    severity0: [0.2, 0.4],
    hazard: [0.25, 0.5], // time is brain: steepest hazard in the model
    esi: [[1, 0.25], [2, 0.7], [3, 0.05]],
    helpful: ['ct-head', 'cta-head-neck', 'cbc', 'coags', 'glucose', 'thrombolytic', 'neurology'],
    derangement: { sbp: 40, gcs: -6, hr: 10 },
  },
  stemi: {
    severity0: [0.2, 0.4],
    hazard: [0.22, 0.45],
    esi: [[1, 0.3], [2, 0.7]],
    helpful: ['ecg', 'troponin', 'aspirin', 'heparin', 'cardiology', 'cath-lab'],
    derangement: { hr: 30, sbp: -40, spo2: -6, rr: 8 },
  },
  trauma: {
    severity0: [0.2, 0.5],
    hazard: [0.3, 0.6],
    esi: [[1, 0.4], [2, 0.5], [3, 0.1]],
    helpful: ['type-and-screen', 'cbc', 'ct-pan-scan', 'fast-us', 'blood-products', 'surgery', 'plain-film'],
    derangement: { hr: 55, sbp: -60, rr: 14, spo2: -10, gcs: -5 },
  },
  respiratory: {
    severity0: [0.15, 0.35],
    hazard: [0.12, 0.28],
    esi: [[1, 0.08], [2, 0.42], [3, 0.5]],
    helpful: ['cxr', 'abg', 'bnp', 'nebulizer', 'steroids', 'bipap', 'cbc'],
    derangement: { rr: 20, spo2: -18, hr: 30 },
  },
  abdominal: {
    severity0: [0.1, 0.25],
    hazard: [0.06, 0.16],
    esi: [[2, 0.2], [3, 0.65], [4, 0.15]],
    helpful: ['cbc', 'bmp', 'lipase', 'ct-abdomen', 'us-abdomen', 'analgesia', 'surgery'],
    derangement: { hr: 25, sbp: -20, temp: 1.2 },
  },
  psych: {
    severity0: [0.05, 0.2],
    hazard: [0.02, 0.08],
    esi: [[2, 0.15], [3, 0.6], [4, 0.25]],
    helpful: ['tox-screen', 'bmp', 'psychiatry', 'sedation'],
    derangement: { hr: 15, gcs: -1 },
  },
  minor: {
    severity0: [0.0, 0.08],
    hazard: [0.005, 0.03],
    esi: [[4, 0.55], [5, 0.45]],
    helpful: ['plain-film', 'analgesia', 'wound-care'],
    derangement: { hr: 8 },
  },
  'chest-pain-lowrisk': {
    severity0: [0.05, 0.18],
    hazard: [0.03, 0.14], // occasionally this is a real MI in disguise
    esi: [[2, 0.25], [3, 0.65], [4, 0.1]],
    helpful: ['ecg', 'troponin', 'cxr', 'cbc', 'bmp'],
    derangement: { hr: 18, sbp: -12 },
  },
  overdose: {
    severity0: [0.1, 0.4],
    hazard: [0.15, 0.35],
    esi: [[1, 0.15], [2, 0.5], [3, 0.35]],
    helpful: ['tox-screen', 'bmp', 'ecg', 'naloxone', 'activated-charcoal', 'poison-control'],
    derangement: { rr: -8, spo2: -14, gcs: -7, hr: -20 },
  },
};

const WELL: Vitals = { hr: 76, sbp: 124, rr: 16, spo2: 98, temp: 37.0, gcs: 15 };

export function conditionProfile(kind: ConditionKind): ConditionProfile {
  return PROFILES[kind];
}

export function makeLatentState(kind: ConditionKind, rng: Rng): LatentState {
  const p = PROFILES[kind];
  return {
    severity: rng.uniform(p.severity0[0], p.severity0[1]),
    hazard: rng.uniform(p.hazard[0], p.hazard[1]),
    trueEsi: rng.weighted(p.esi),
    condition: kind,
    treatmentProgress: 0,
    dead: false,
  };
}

/**
 * Advance a patient's latent state by `dt` minutes.
 *
 * `careFactor` is how much the current setting suppresses deterioration:
 *   1.0  = untreated (waiting room, unmonitored)
 *   ~0.5 = roomed and monitored, no definitive care yet
 *   ~0.2 = actively treated
 * Treatment progress separately pulls severity back down — that is recovery,
 * as opposed to merely slowing the decline.
 */
export function advanceLatent(latent: LatentState, dt: number, careFactor: number, rng: Rng): void {
  if (latent.dead) return;
  const hours = dt / 60;

  // Deterioration accelerates as severity rises: sick patients get sick faster.
  // The (1 - severity) term makes severity approach 1 asymptotically rather than
  // marching across it on a timer — a crashing patient is a hazard to be
  // survived, not a countdown that expires.
  const accel = 1 + 1.6 * latent.severity;
  const decline = latent.hazard * accel * careFactor * hours * (1 - latent.severity);

  // Definitive care pulls severity down, scaled by how much of the workup landed.
  const recovery = 0.55 * latent.treatmentProgress * hours;

  latent.severity = clamp01(latent.severity + decline - recovery);

  // Death is a stochastic hazard concentrated at the top of the severity range,
  // not a threshold crossing. Quartic so that it is negligible below ~0.8 and
  // sharp above it: most sick patients survive a bad shift, and the ones who do
  // not are the ones who sat at maximum severity for a long time.
  const deathRate = 0.5 * Math.pow(latent.severity, 6);
  if (rng.bool(1 - Math.exp(-deathRate * hours))) {
    latent.severity = 1;
    latent.dead = true;
  }
}

/**
 * Instantaneous mortality/major-morbidity risk rate, per hour, from true state.
 * Convex in severity so that the last stretch dominates — this is what makes
 * letting an ESI-2 sit in the waiting room expensive rather than merely
 * suboptimal.
 */
export function riskRate(latent: LatentState): number {
  if (latent.dead) return 0;
  const s = latent.severity;
  return Math.pow(s, 3) * 1.0;
}

/** Vitals implied by the latent state, plus measurement noise. */
export function measureVitals(latent: LatentState, rng: Rng): Vitals {
  const d = PROFILES[latent.condition].derangement;
  const s = latent.severity;
  const v: Vitals = {
    hr: WELL.hr + (d.hr ?? 0) * s + rng.normal(0, 4),
    sbp: WELL.sbp + (d.sbp ?? 0) * s + rng.normal(0, 6),
    rr: WELL.rr + (d.rr ?? 0) * s + rng.normal(0, 1.5),
    spo2: WELL.spo2 + (d.spo2 ?? 0) * s + rng.normal(0, 1),
    temp: WELL.temp + (d.temp ?? 0) * s + rng.normal(0, 0.15),
    gcs: WELL.gcs + (d.gcs ?? 0) * s + rng.normal(0, 0.3),
  };
  return {
    hr: round(clamp(v.hr, 20, 220), 0),
    sbp: round(clamp(v.sbp, 40, 240), 0),
    rr: round(clamp(v.rr, 4, 60), 0),
    spo2: round(clamp(v.spo2, 50, 100), 0),
    temp: round(clamp(v.temp, 33, 42), 1),
    gcs: round(clamp(v.gcs, 3, 15), 0),
  };
}

/**
 * Danger-zone vitals. Triaging a patient with any of these above ESI 2 is a
 * hard safety floor — this is the guard that blocks the under-triage exploit
 * (call everyone a 4, empty the waiting room, collect the throughput score).
 */
export function inDangerZone(v: Vitals): boolean {
  return (
    v.hr >= 130 ||
    v.hr <= 40 ||
    v.sbp <= 90 ||
    v.rr >= 30 ||
    v.rr <= 8 ||
    v.spo2 <= 90 ||
    v.temp >= 40.5 ||
    v.gcs <= 13
  );
}

/** Whether an order name advances treatment for this condition. */
export function isHelpful(latent: LatentState, orderName: string): boolean {
  return PROFILES[latent.condition].helpful.includes(orderName);
}

/** Fraction of the condition's helpful workup represented by one order. */
export function orderTherapeuticValue(latent: LatentState, orderName: string): number {
  const helpful = PROFILES[latent.condition].helpful;
  if (!helpful.includes(orderName)) return 0;
  return 1 / helpful.length;
}

/**
 * Probability that discharging this patient now is unsafe, i.e. the patient is
 * still meaningfully sick. Drives both the unsafe-destination floor and the
 * 72h bounce-back process — together these block the discharge-everyone exploit.
 */
export function unsafeDischargeRisk(latent: LatentState): number {
  const untreated = 1 - latent.treatmentProgress;
  return clamp01(latent.severity * (0.35 + 0.65 * untreated));
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
function clamp01(x: number): number {
  return clamp(x, 0, 1);
}
function round(x: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.round(x * f) / f;
}
