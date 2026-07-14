import type { Minutes } from '../kernel/engine.js';
import type { SafetyEvent, SafetyViolation } from '../domain/types.js';

/**
 * Reward.
 *
 * Structure, in priority order:
 *  1. Clinical risk, integrated from TRUE latent state. Dominant term.
 *  2. Hard floors — bounded, large, and reported separately so a policy cannot
 *     hide safety failures inside an aggregate score.
 *  3. Access and flow costs.
 *  4. Resource and attention costs.
 *
 * The floors are not soft penalties to be traded against throughput. They are
 * priced so that no achievable throughput gain pays for one.
 */

export interface RewardWeights {
  /** Multiplier on integrated clinical risk. The dominant term. */
  clinicalRisk: number;
  /** Per death. */
  death: number;
  /** Per deterioration event (severity crossing a threshold under our care). */
  deterioration: number;
  /** Per LWBS. */
  lwbs: number;
  /** Per 72h bounce-back attributable to an unsafe discharge. */
  bounceBack: number;
  /** Per hour of boarding, per patient. */
  boardingHour: number;
  /** Per hour of ED LOS, per patient. */
  losHour: number;
  /** Per minute of door-to-provider beyond the ESI-appropriate target. */
  doorToProviderMinute: number;
  /** Per role-minute consumed by interrupt handling. */
  attentionMinute: number;
  /** Per task-switch-attributable error. */
  taskSwitchError: number;
  /** Per wasted/cancelled supply request. */
  wastedSupplyRequest: number;
  /** Per unit of transport tier cost. */
  transportCost: number;
  /** Per hour on diversion. */
  diversionHour: number;
  /** Per overtime hour. */
  overtimeHour: number;
  /** Per deferred-admin re-work event (denied claim, registration correction). */
  reworkEvent: number;
  /** Per hard floor. Applied per violation. */
  floor: Record<SafetyViolation, number>;
}

export const DEFAULT_WEIGHTS: RewardWeights = {
  clinicalRisk: -1200,
  death: -5000,
  deterioration: -220,
  lwbs: -160,
  bounceBack: -300,
  boardingHour: -14,
  losHour: -7,
  doorToProviderMinute: -0.35,
  attentionMinute: -0.5,
  taskSwitchError: -90,
  wastedSupplyRequest: -6,
  transportCost: -1.5,
  diversionHour: -60,
  overtimeHour: -25,
  reworkEvent: -12,
  floor: {
    // Identity and medication floors are priced above any plausible throughput
    // gain: there is no volume of door-to-provider improvement that buys one.
    'wrong-patient-identity': -2500,
    'verification-bypass': -2000,
    'controlled-substance-discrepancy': -1800,
    'contrast-without-renal-clearance': -2200,
    'non-transportable-to-fixed-scanner': -2000,
    'unsafe-destination-discharge': -2400,
    'under-triage-danger-zone': -2600,
    'missed-critical-callback': -2400,
    'inappropriate-transport-tier': -1800,
    'phi-leak': -2000,
    'ratio-breach': -400,
  },
};

export interface RewardComponents {
  clinicalRisk: number;
  deaths: number;
  deteriorations: number;
  lwbs: number;
  bounceBacks: number;
  boarding: number;
  los: number;
  doorToProvider: number;
  attention: number;
  taskSwitchErrors: number;
  wastedSupply: number;
  transport: number;
  diversion: number;
  overtime: number;
  rework: number;
  floors: number;
  total: number;
}

export interface RewardTally {
  /** Integrated clinical risk from true latent state, summed over patients. */
  integratedRisk: number;
  deaths: number;
  deteriorations: number;
  lwbs: number;
  bounceBacks: number;
  boardingHours: number;
  losHours: number;
  doorToProviderExcessMinutes: number;
  attentionMinutes: number;
  taskSwitchErrors: number;
  wastedSupplyRequests: number;
  transportCostUnits: number;
  diversionHours: number;
  overtimeHours: number;
  reworkEvents: number;
  safetyEvents: SafetyEvent[];
}

export function computeReward(tally: RewardTally, w: RewardWeights = DEFAULT_WEIGHTS): RewardComponents {
  let floors = 0;
  for (const e of tally.safetyEvents) floors += w.floor[e.kind] ?? -1000;

  const c: RewardComponents = {
    clinicalRisk: w.clinicalRisk * tally.integratedRisk,
    deaths: w.death * tally.deaths,
    deteriorations: w.deterioration * tally.deteriorations,
    lwbs: w.lwbs * tally.lwbs,
    bounceBacks: w.bounceBack * tally.bounceBacks,
    boarding: w.boardingHour * tally.boardingHours,
    los: w.losHour * tally.losHours,
    doorToProvider: w.doorToProviderMinute * tally.doorToProviderExcessMinutes,
    attention: w.attentionMinute * tally.attentionMinutes,
    taskSwitchErrors: w.taskSwitchError * tally.taskSwitchErrors,
    wastedSupply: w.wastedSupplyRequest * tally.wastedSupplyRequests,
    transport: w.transportCost * tally.transportCostUnits,
    diversion: w.diversionHour * tally.diversionHours,
    overtime: w.overtimeHour * tally.overtimeHours,
    rework: w.reworkEvent * tally.reworkEvents,
    floors,
    total: 0,
  };
  c.total =
    c.clinicalRisk +
    c.deaths +
    c.deteriorations +
    c.lwbs +
    c.bounceBacks +
    c.boarding +
    c.los +
    c.doorToProvider +
    c.attention +
    c.taskSwitchErrors +
    c.wastedSupply +
    c.transport +
    c.diversion +
    c.overtime +
    c.rework +
    c.floors;
  return c;
}

/**
 * ESI-appropriate door-to-provider targets, in minutes. Excess beyond these is
 * what gets charged — an ESI-5 waiting 40 minutes is not a failure.
 */
export const DOOR_TO_PROVIDER_TARGET: Record<number, Minutes> = {
  1: 0,
  2: 10,
  3: 30,
  4: 60,
  5: 90,
};
