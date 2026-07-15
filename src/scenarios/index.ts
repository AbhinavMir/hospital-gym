import type { ScenarioSpec } from './types.js';

/**
 * Scenarios.
 *
 * Each is a parameterisation, not a script. Nothing is hand-timed except the
 * declared stress events — the episode emerges from the arrival process, the
 * stress factor, and the agent's choices, so the same scenario at a different
 * seed is a genuinely different shift.
 */

function baseEd() {
  return {
    beds: [
      { kind: 'resus' as const, count: 3, monitored: true, negativePressure: 1 },
      { kind: 'main' as const, count: 22, monitored: true, negativePressure: 2 },
      { kind: 'fast-track' as const, count: 8, monitored: false, negativePressure: 0 },
      { kind: 'hallway' as const, count: 6, monitored: false, negativePressure: 0 },
    ],
    nurses: 12,
    physicians: 4,
    apps: 3,
    techs: 4,
    ratioNormal: 4,
    ratioCritical: 1,
    shiftLengthMinutes: 12 * 60,
    floatPoolSize: 4,
  };
}

function baseLab() {
  return { collectors: 3, analyserChannels: 4, verifiers: 2, transportMedian: 8, callbackDeadline: 30 };
}

function baseImaging() {
  return {
    scanners: { ct: 2, us: 2, 'plain-film': 2, mri: 1 } as Record<'ct' | 'us' | 'plain-film' | 'mri', number>,
    readers: 2,
    protocolMedian: 6,
  };
}

function basePharmacy() {
  return { pharmacists: 2, compounders: 2, firstDoseTarget: 60 };
}

function baseRegistry(startHour: number) {
  return {
    ambient: {
      startHour,
      baselineStress: 0.3,
      reversion: 0.35,
      volatility: 0.08,
      events: [],
      downtime: [],
      holiday: false,
    },
    handoff: {
      startHour,
      nursesPerLevel: { icu: 4, stepdown: 3, telemetry: 5, medsurg: 8, observation: 3 },
      reportMedian: 9,
      reportSpread: 1.5,
      // Change of shift: 07:00 and 19:00. Nobody takes report.
      shiftChangeHours: [7, 19],
      refusalAtZeroStress: 0.12,
      refusalAtMaxStress: 0.5,
    },
    headcounts: {
      'charge-nurse': 1,
      'ed-attending': 2,
      'house-supervisor': 1,
      'unit-clerk': 2,
      registrar: 2,
      'bedside-nurse': 12,
      security: 1,
    },
    consultServices: { cardiology: 1, neurology: 1, surgery: 1, psychiatry: 1, 'poison-control': 1, 'cath-lab': 1 },
    psychBedCapacity: 6,
    evsStaff: 6,
    internalTransportStaff: 4,
    orRooms: 4,
  };
}

function baseDownstream(startHour: number) {
  return {
    capacity: { icu: 20, stepdown: 16, telemetry: 30, medsurg: 60, observation: 12 },
    initialOccupancy: { icu: 0.85, stepdown: 0.8, telemetry: 0.82, medsurg: 0.88, observation: 0.6 },
    releaseRateMultiplier: 1.0,
    declineProbability: { icu: 0.15, stepdown: 0.08 },
    offerTtl: 30,
    startHour,
  };
}

function baseArrivals(startHour: number) {
  return {
    startHour,
    baseRatePerHour: 7.5,
    rateAtMaxStress: 1.9,
    emsFraction: 0.22,
    prealertFraction: 0.35,
    conditionMix: {},
    hawkesExcitation: 0.15,
    hawkesDecay: 1.2,
    isolationRate: 0.08,
  };
}

function scenario(over: Partial<ScenarioSpec> & Pick<ScenarioSpec, 'name' | 'description' | 'tests'>): ScenarioSpec {
  const startHour = over.startHour ?? 7;
  return {
    durationMinutes: 12 * 60,
    tickMinutes: 5,
    startHour,
    oNegStock: 8,
    ed: baseEd(),
    lab: baseLab(),
    imaging: baseImaging(),
    pharmacy: basePharmacy(),
    arrivals: baseArrivals(startHour),
    downstream: baseDownstream(startHour),
    registry: baseRegistry(startHour),
    ...over,
  } as ScenarioSpec;
}

export const SCENARIOS: Record<string, () => ScenarioSpec> = {
  /** Moderate volume, adequate staffing, normal downstream release. The control. */
  'ed-baseline': () =>
    scenario({
      name: 'ed-baseline',
      description: 'Moderate volume, adequate staffing, downstream beds releasing at a normal rate.',
      tests: 'Baseline competence: triage accuracy, ancillary orchestration, disposition timing, interrupt triage.',
    }),

  /**
   * The signature scenario. Downstream release is throttled hard: the ED fills
   * with admitted patients it cannot move. This tests boarding management under
   * an unfixable upstream, which is the actual real-world condition.
   */
  'boarding-crisis': () =>
    scenario({
      name: 'boarding-crisis',
      description:
        'Downstream bed release throttled to 35% of normal. The ED fills with admitted patients. ' +
        'The upstream cause is NOT fixable from inside Module 1 — that is the point.',
      tests:
        'Boarding management under an unfixable upstream: bed-request lead time, level selection, ' +
        'boarder sequencing against offered beds, working the report handoff, keeping boarders from ' +
        'deteriorating, and knowing when boarding is bad enough to warrant transfer-out or diversion.',
      startHour: 10,
      durationMinutes: 14 * 60,
      downstream: {
        ...baseDownstream(10),
        releaseRateMultiplier: 0.35,
        initialOccupancy: { icu: 0.95, stepdown: 0.93, telemetry: 0.94, medsurg: 0.96, observation: 0.8 },
        declineProbability: { icu: 0.35, stepdown: 0.2, telemetry: 0.1 },
      },
      registry: {
        ...baseRegistry(10),
        ambient: { ...baseRegistry(10).ambient, baselineStress: 0.6, volatility: 0.06 },
        handoff: { ...baseRegistry(10).handoff, refusalAtZeroStress: 0.2, refusalAtMaxStress: 0.65 },
      },
    }),

  /** Thin nursing, skeleton ancillary, no in-house night consults. */
  'understaffed-nights': () =>
    scenario({
      name: 'understaffed-nights',
      description:
        'Overnight shift. Thin nursing, skeleton lab and imaging, no in-house consultants. ' +
        'The absence of overnight coverage converts ED dispositions into observation admissions.',
      tests:
        'Doing more with less; recognising that a consult that will not come until morning is a ' +
        'disposition decision, not a waiting game. Float pool and overtime under a real shortfall.',
      startHour: 19,
      durationMinutes: 12 * 60,
      ed: { ...baseEd(), nurses: 7, physicians: 2, apps: 1, techs: 2, floatPoolSize: 2 },
      lab: { collectors: 1, analyserChannels: 2, verifiers: 1, transportMedian: 12, callbackDeadline: 30 },
      imaging: { scanners: { ct: 1, us: 1, 'plain-film': 1, mri: 0 }, readers: 1, protocolMedian: 10 },
      pharmacy: { pharmacists: 1, compounders: 1, firstDoseTarget: 60 },
      registry: {
        ...baseRegistry(19),
        headcounts: {
          'charge-nurse': 1,
          'ed-attending': 1,
          'house-supervisor': 1,
          'unit-clerk': 1,
          registrar: 1,
          'bedside-nurse': 7,
          security: 1,
        },
        consultServices: { cardiology: 1, neurology: 1, surgery: 1, psychiatry: 1, 'poison-control': 1, 'cath-lab': 1 },
        evsStaff: 1,
        internalTransportStaff: 2,
      },
    }),

  /** Sustained mid-acuity volume; isolation and cohorting bind. */
  'respiratory-season': () =>
    scenario({
      name: 'respiratory-season',
      description:
        'Sustained high volume of mid-acuity respiratory presentations. Isolation and cohorting bind: ' +
        'negative-pressure rooms and terminal cleans become the constraint.',
      tests:
        'Isolation-aware bed management, EVS queue prioritisation under terminal-clean load, and ' +
        'cohorting constraints propagating into downstream bed requests.',
      startHour: 9,
      durationMinutes: 14 * 60,
      arrivals: {
        ...baseArrivals(9),
        baseRatePerHour: 10,
        isolationRate: 0.35,
        conditionMix: { respiratory: 0.42, sepsis: 0.12, minor: 0.14, 'chest-pain-lowrisk': 0.1, abdominal: 0.08, psych: 0.05, trauma: 0.04, overdose: 0.03, stroke: 0.015, stemi: 0.005 },
      },
      registry: {
        ...baseRegistry(9),
        ambient: { ...baseRegistry(9).ambient, baselineStress: 0.55 },
        evsStaff: 7,
      },
    }),

  /**
   * A Hawkes burst of high-acuity trauma layered on a normal shift, plus a
   * stress event so that every externality degrades together: fewer beds,
   * fewer ambulances, slower consultants, and the press calling.
   */
  'mass-casualty': () =>
    scenario({
      name: 'mass-casualty',
      description:
        'A mass-casualty event three hours into the shift. Self-exciting high-acuity arrivals, ' +
        'and every externality degrades simultaneously because they share the same cause.',
      tests:
        'Correlated scarcity. Trauma activation tiering under an asymmetric over/under-triage cost, ' +
        'blood bank ladder and MTP, resus bay allocation, and interrupt triage when the media, legal, ' +
        'and law enforcement channels all light up at once.',
      startHour: 13,
      durationMinutes: 10 * 60,
      oNegStock: 12,
      arrivals: {
        ...baseArrivals(13),
        hawkesExcitation: 0.9,
        hawkesDecay: 0.5,
        emsFraction: 0.6,
        prealertFraction: 0.7,
        conditionMix: { trauma: 0.45, minor: 0.2, respiratory: 0.1, abdominal: 0.08, sepsis: 0.06, 'chest-pain-lowrisk': 0.05, psych: 0.03, overdose: 0.02, stroke: 0.008, stemi: 0.002 },
      },
      registry: {
        ...baseRegistry(13),
        ambient: {
          ...baseRegistry(13).ambient,
          baselineStress: 0.35,
          events: [
            {
              label: 'mass-casualty-incident',
              startsAt: 3 * 60,
              rampMinutes: 20,
              durationMinutes: 4 * 60,
              magnitude: 0.55,
            },
          ],
        },
      },
    }),
};

/**
 * The `degraded-integrations` variant.
 *
 * Every scenario has one. This is the condition under which an over-trusting
 * agent fails catastrophically: the feeds go silent WITHOUT erroring, so the
 * agent must notice that a quiet feed is not the same as a feed with nothing to
 * report, fall back, throttle the actions that depend on the dead system, and
 * reconcile on recovery.
 *
 * A policy that cannot do this is not deployable, which is why it is a
 * first-class variant rather than a hard-mode toggle.
 */
export function degraded(base: ScenarioSpec): ScenarioSpec {
  return {
    ...base,
    name: `${base.name}-degraded-integrations`,
    description: `${base.description} EHR/IT downtime windows: feeds go silent without erroring.`,
    tests: `${base.tests} Plus: detecting a silent feed, operating on a stale picture, and reconciling on recovery.`,
    registry: {
      ...base.registry,
      ambient: {
        ...base.registry.ambient,
        downtime: [
          { startsAt: 2 * 60, durationMinutes: 75, severity: 'partial', silent: true },
          { startsAt: 7 * 60, durationMinutes: 45, severity: 'full', silent: false },
        ],
      },
    },
  };
}

export function listScenarios(): { name: string; description: string; tests: string }[] {
  const out = [];
  for (const [name, make] of Object.entries(SCENARIOS)) {
    const s = make();
    out.push({ name, description: s.description, tests: s.tests });
    const d = degraded(s);
    out.push({ name: d.name, description: d.description, tests: d.tests });
  }
  return out;
}

export function getScenario(name: string): ScenarioSpec {
  if (name.endsWith('-degraded-integrations')) {
    const base = name.slice(0, -'-degraded-integrations'.length);
    const make = SCENARIOS[base];
    if (!make) throw new Error(`unknown scenario "${name}"`);
    return degraded(make());
  }
  const make = SCENARIOS[name];
  if (!make) throw new Error(`unknown scenario "${name}". Known: ${Object.keys(SCENARIOS).join(', ')}`);
  return make();
}

export type { ScenarioSpec };
