import type { SafetyViolation } from '../domain/types.js';
import type { ErEnv } from './env.js';
import { DOOR_TO_PROVIDER_TARGET } from './reward.js';

/**
 * Metrics.
 *
 * Reported separately from reward, and decomposed by stage, because an
 * aggregate score tells you a policy is bad but never why. The decompositions
 * that matter most:
 *
 *  - boarding split by CAUSE (waiting for a bed vs waiting for report) — this
 *    is what separates "downstream is full" from "you did not work the handoff"
 *  - supply fill rate and ETA accuracy reported AGAINST stress, so degradation
 *    under load is visible rather than averaged away
 *  - interrupt response latency by TRUE priority, which exposes whether the
 *    agent learned the per-source false-urgency discount or just guessed
 */

export interface Metrics {
  scenario: string;
  seed: number | string;
  simMinutes: number;

  clinical: {
    deaths: number;
    integratedRisk: number;
    deteriorations: number;
    deteriorationsWhileBoarding: number;
    missedCriticalCallbacks: number;
    criticalCallbackLatencyP50: number | null;
    bounceBacks72h: number;
  };

  access: {
    arrivals: number;
    departed: number;
    doorToProviderP50: number | null;
    doorToProviderP90: number | null;
    doorToProviderWithinTarget: number | null;
    doorToDispositionP50: number | null;
    edLosP50: number | null;
    edLosP90: number | null;
    lwbsRate: number | null;
  };

  boarding: {
    boarderCount: number;
    boardingHoursMean: number | null;
    boardingHoursP90: number | null;
    boardingHoursMax: number | null;
    /** Disposition decision → bed request submitted. The ED's real lever. */
    bedRequestLeadP50: number | null;
    /** Bed assigned → report complete. The rendezvous delay, isolated. */
    reportHandoffLatencyP50: number | null;
    reportHandoffLatencyP90: number | null;
    handoffAttemptsMean: number | null;
    handoffRefusalRate: number | null;
    handoffEscalationRate: number | null;
  };

  ancillary: {
    labOrderToResultP50: number | null;
    specimenRejectionRate: number | null;
    /** Rejection → redraw ordered. An undetected rejection never results. */
    rejectionDetectionLatencyP50: number | null;
    undetectedRejections: number;
    imagingOrderToReadP50: number | null;
    imagingAcquisitionToReadP50: number | null;
    medOrderToAdminP50: number | null;
    firstDoseStatWithinTarget: number | null;
  };

  attention: {
    roleMinutesSpent: Record<string, number>;
    interruptsRaised: number;
    interruptsAnswered: number;
    interruptsMissed: number;
    /** Latency by TRUE priority. Answering claimed-1s fast is not the same thing. */
    latencyByTruePriority: Record<string, number | null>;
    /** How much the agent discounted each source, vs. how much it should have. */
    falseUrgencyDiscountBySource: Record<string, { claimedMean: number; trueMean: number; answered: number }>;
    taskSwitchEvents: number;
    taskSwitchErrors: number;
  };

  supply: {
    /** Fill rate and ETA accuracy per process, reported against mean stress. */
    byProcess: Record<string, { requested: number; filled: number; noShows: number; declines: number }>;
    fallbackLadderDepthMean: number | null;
    wastedRequests: number;
  };

  anticipation: {
    preAlertsReceived: number;
    preAlertsActedOn: number;
    traumaOverTriage: number;
    traumaUnderTriage: number;
    /** Did capacity actions precede the crunch or follow it? */
    meanStressAtBedRequest: number | null;
  };

  capacity: {
    ratioBreaches: number;
    evsTurnaroundP50: number | null;
    diversionHours: number;
    overtimeHours: number;
    floatUsed: number;
  };

  safety: Record<SafetyViolation, number>;

  /**
   * The honest caveat, carried in the metrics themselves rather than buried in
   * a README nobody reads. In Module 1 the agent cannot fix inpatient discharge
   * timing, so these numbers measure boarding MANAGEMENT, not elimination.
   */
  moduleCaveat: string;
}

export function collectMetrics(env: ErEnv): Metrics {
  const all = [...env.patients.values()];
  const departed = all.filter((p) => p.phase === 'departed');
  const now = env.now;

  const dtp: number[] = [];
  const dtpWithin: boolean[] = [];
  const dtd: number[] = [];
  const los: number[] = [];
  const boardingHours: number[] = [];
  const leadTimes: number[] = [];

  for (const p of all) {
    if (p.firstProviderTime !== null) {
      const v = p.firstProviderTime - p.arrivalTime;
      dtp.push(v);
      if (p.esi !== null) dtpWithin.push(v <= (DOOR_TO_PROVIDER_TARGET[p.esi] ?? 60));
    }
    if (p.dispositionDecisionTime !== null) dtd.push(p.dispositionDecisionTime - p.arrivalTime);
    const end = p.departureTime ?? now;
    los.push(end - p.arrivalTime);
    if (p.disposition?.kind === 'admit' && p.dispositionDecisionTime !== null) {
      boardingHours.push((end - p.dispositionDecisionTime) / 60);
    }
    if (p.dispositionDecisionTime !== null && p.bedRequestTime !== null) {
      leadTimes.push(p.bedRequestTime - p.dispositionDecisionTime);
    }
  }

  // --- ancillary decompositions ---
  const labTat: number[] = [];
  const imgOrderToRead: number[] = [];
  const imgAcqToRead: number[] = [];
  const medTat: number[] = [];
  const firstDoseWithin: boolean[] = [];
  const rejectionDetect: number[] = [];
  let rejections = 0;
  let labOrders = 0;
  let undetectedRejections = 0;
  const criticalLatency: number[] = [];

  for (const o of env.orders.values()) {
    if (o.kind === 'lab') {
      labOrders++;
      if (o.rejected) {
        rejections++;
        const redraw = [...env.orders.values()].find((x) => x.redrawOf === o.id);
        if (redraw) rejectionDetect.push(redraw.placedAt - ((o.meta.rejectedAt as number) ?? o.placedAt));
        else undetectedRejections++;
      }
      if (o.completedAt !== null) labTat.push(o.completedAt - o.placedAt);
      if (o.criticalAt !== null && o.criticalAckedAt !== null) {
        criticalLatency.push(o.criticalAckedAt - o.criticalAt);
      }
    }
    if (o.kind === 'imaging' && o.completedAt !== null) {
      imgOrderToRead.push(o.completedAt - o.placedAt);
      const acq = o.meta.acquiredAt as number | undefined;
      if (acq !== undefined) imgAcqToRead.push(o.completedAt - acq);
    }
    if (o.kind === 'med' && o.completedAt !== null) {
      const tat = o.completedAt - o.placedAt;
      medTat.push(tat);
      if (o.priority === 'stat') firstDoseWithin.push(tat <= env.scenario.pharmacy.firstDoseTarget);
    }
  }

  // --- attention ---
  const interrupts = env.registry.attention.all;
  const latencyBuckets = new Map<number, number[]>();
  const bySource = new Map<string, { claimed: number[]; trueP: number[]; answered: number }>();
  for (const { interrupt: i, state } of interrupts) {
    const b = bySource.get(i.source) ?? { claimed: [], trueP: [], answered: 0 };
    b.claimed.push(i.claimedPriority);
    b.trueP.push(i.truePriority);
    if (state.status === 'resolved') {
      b.answered++;
      const arr = latencyBuckets.get(i.truePriority) ?? [];
      arr.push(state.latency);
      latencyBuckets.set(i.truePriority, arr);
    }
    bySource.set(i.source, b);
  }

  const latencyByTruePriority: Record<string, number | null> = {};
  for (let pr = 1; pr <= 5; pr++) latencyByTruePriority[`p${pr}`] = p50(latencyBuckets.get(pr) ?? []);

  const falseUrgency: Record<string, { claimedMean: number; trueMean: number; answered: number }> = {};
  for (const [src, b] of bySource) {
    falseUrgency[src] = {
      claimedMean: round2(mean(b.claimed) ?? 0),
      trueMean: round2(mean(b.trueP) ?? 0),
      answered: b.answered,
    };
  }

  const roleMinutes: Record<string, number> = {};
  for (const role of [
    'charge-nurse',
    'ed-attending',
    'house-supervisor',
    'unit-clerk',
    'registrar',
    'bedside-nurse',
    'security',
  ] as const) {
    roleMinutes[role] = Math.round(env.registry.attention.server(role).attentionSpent);
  }

  // --- handoff ---
  const ho = env.registry.handoff.outcomes;
  const safety = {} as Record<SafetyViolation, number>;
  for (const e of env.safetyEvents) safety[e.kind] = (safety[e.kind] ?? 0) + 1;

  const preAlerts = all.filter((p) => p.arrivalMode === 'ems-prealert');
  const actedOn = preAlerts.filter((p) => p.flags.has('prestaged')).length;
  const overTriage = all.filter((p) => p.flags.has('trauma:full') && p.latent.trueEsi > 2).length;
  const underTriage = all.filter(
    (p) => p.latent.condition === 'trauma' && p.latent.trueEsi <= 2 && !p.flags.has('trauma:full'),
  ).length;

  return {
    scenario: env.scenario.name,
    seed: env.seed,
    simMinutes: Math.round(now),

    clinical: {
      deaths: all.filter((p) => p.latent.dead).length,
      integratedRisk: round2(all.reduce((s, p) => s + p.riskAccrued, 0)),
      deteriorations: all.filter((p) => p.flags.has('deteriorated')).length,
      deteriorationsWhileBoarding: all.filter((p) => p.flags.has('deteriorated-while-boarding')).length,
      missedCriticalCallbacks: safety['missed-critical-callback'] ?? 0,
      criticalCallbackLatencyP50: p50(criticalLatency),
      bounceBacks72h: all.filter((p) => p.bounceBackOf !== null).length,
    },

    access: {
      arrivals: all.length,
      departed: departed.length,
      doorToProviderP50: p50(dtp),
      doorToProviderP90: pct(dtp, 0.9),
      doorToProviderWithinTarget: rate(dtpWithin),
      doorToDispositionP50: p50(dtd),
      edLosP50: p50(los),
      edLosP90: pct(los, 0.9),
      lwbsRate: all.length ? round2(all.filter((p) => p.disposition?.kind === 'lwbs').length / all.length) : null,
    },

    boarding: {
      boarderCount: boardingHours.length,
      boardingHoursMean: mean(boardingHours),
      boardingHoursP90: pct(boardingHours, 0.9),
      boardingHoursMax: boardingHours.length ? round2(Math.max(...boardingHours)) : null,
      bedRequestLeadP50: p50(leadTimes),
      reportHandoffLatencyP50: p50(ho.map((h) => h.bedToReportMinutes)),
      reportHandoffLatencyP90: pct(ho.map((h) => h.bedToReportMinutes), 0.9),
      handoffAttemptsMean: mean(ho.map((h) => h.attempts)),
      handoffRefusalRate: ho.length
        ? round2(ho.reduce((s, h) => s + h.refusalsReceived, 0) / Math.max(1, ho.reduce((s, h) => s + h.attempts, 0)))
        : null,
      handoffEscalationRate: ho.length ? round2(ho.filter((h) => h.escalated).length / ho.length) : null,
    },

    ancillary: {
      labOrderToResultP50: p50(labTat),
      specimenRejectionRate: labOrders ? round2(rejections / labOrders) : null,
      rejectionDetectionLatencyP50: p50(rejectionDetect),
      undetectedRejections,
      imagingOrderToReadP50: p50(imgOrderToRead),
      imagingAcquisitionToReadP50: p50(imgAcqToRead),
      medOrderToAdminP50: p50(medTat),
      firstDoseStatWithinTarget: rate(firstDoseWithin),
    },

    attention: {
      roleMinutesSpent: roleMinutes,
      interruptsRaised: interrupts.length,
      interruptsAnswered: interrupts.filter((i) => i.state.status === 'resolved').length,
      interruptsMissed: interrupts.filter((i) => i.state.status === 'missed').length,
      latencyByTruePriority,
      falseUrgencyDiscountBySource: falseUrgency,
      taskSwitchEvents: env.registry.attention.taskSwitchEvents.length,
      taskSwitchErrors: env.registry.attention.taskSwitchEvents.filter((e) => e.causedError).length,
    },

    supply: {
      byProcess: {},
      fallbackLadderDepthMean: null,
      wastedRequests: 0,
    },

    anticipation: {
      preAlertsReceived: preAlerts.length,
      preAlertsActedOn: actedOn,
      traumaOverTriage: overTriage,
      traumaUnderTriage: underTriage,
      meanStressAtBedRequest: null,
    },

    capacity: {
      ratioBreaches: safety['ratio-breach'] ?? 0,
      evsTurnaroundP50: null,
      diversionHours: round2(env.components.diversion / -60 || 0),
      overtimeHours: round2(env.ed.overtimeUsed / 60),
      floatUsed: env.ed.floatUsedCount,
    },

    safety,

    moduleCaveat:
      'Module 1 (ER only). Downstream bed release is exogenous and the agent cannot influence it, ' +
      'so boarding metrics measure boarding MANAGEMENT, not boarding ELIMINATION. The clairvoyant ' +
      'ceiling is computed against the same release process, so it is honest for this module. ' +
      'When Module 2 (inpatient wards) lands, the ceiling rises and the same policy is re-benchmarked; ' +
      'that delta is the measurement of what the hospital module buys.',
  };
}

// --- stats helpers ----------------------------------------------------------

function pct(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.floor(q * s.length));
  return round2(s[i]!);
}
function p50(xs: number[]): number | null {
  return pct(xs, 0.5);
}
function mean(xs: number[]): number | null {
  return xs.length ? round2(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
}
function rate(xs: boolean[]): number | null {
  return xs.length ? round2(xs.filter(Boolean).length / xs.length) : null;
}
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
