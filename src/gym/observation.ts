import { formatClock } from '../kernel/engine.js';
import type { Minutes } from '../kernel/engine.js';
import type { Vitals } from '../domain/types.js';
import type { ErEnv } from './env.js';

/**
 * The observation.
 *
 * THE RULE: nothing in here may be derived from latent state except through a
 * measurement the agent actually took. `lastVitals` is what the agent measured,
 * when it measured it. There is no severity field, no hazard field, no "true
 * ESI" field, and no clean stress reading. If you are tempted to add one, the
 * benchmark stops measuring anything.
 *
 * Every downstream/supply number here carries its own staleness. That is not
 * decoration — a policy that ignores staleness should be able to be caught
 * doing so.
 */

export interface PatientView {
  id: string;
  mrn: string | null;
  /** What we know, not who they are. Null for an unidentified EMS arrival. */
  statedIdentity: { name?: string; dob?: string; sex?: string } | null;
  arrivalMode: string;
  chiefComplaint: string;
  waitingMinutes: number;
  phase: string;
  location: string | null;
  esi: number | null;
  isolation: string;
  transportable: boolean;
  renalCleared: boolean | null;
  assignedNurse: string | null;
  assignedProvider: string | null;
  /** The last measurement taken, and how old it is. Null if never measured. */
  lastVitals: Vitals | null;
  vitalsAgeMinutes: number | null;
  disposition: string | null;
  boardingMinutes: number | null;
  /** Minutes from the disposition decision to the bed request. The lead-time lever. */
  bedRequestLeadMinutes: number | null;
  orders: OrderView[];
  flags: string[];
}

export interface OrderView {
  id: string;
  kind: string;
  name: string;
  priority: string;
  status: string;
  ageMinutes: number;
  result: string | null;
  /** Rejected specimens sit here silently until the agent notices. */
  rejected: boolean;
  rejectionReason: string | null;
  critical: boolean;
  criticalAcked: boolean;
}

export interface InterruptView {
  id: string;
  source: string;
  channel: string;
  /** What the caller CLAIMS. Learn the per-source discount yourself. */
  claimedPriority: number;
  roleRequired: string;
  delegableTo: string[];
  deferability: string;
  resolutionCostMinutes: number;
  deadlineInMinutes: number | null;
  consequenceIfMissed: string;
  patient: string | null;
  batchable: boolean;
  waitingMinutes: number;
  ringbacks: number;
  status: string;
  meta: Record<string, unknown>;
}

export interface Observation {
  time: number;
  clock: string;
  hourOfDay: number;
  scenario: string;
  onDiversion: boolean;

  patients: PatientView[];
  ed: ReturnType<ErEnv['ed']['snapshot']>;

  /** Pending interrupts. Triaging these is half the job. */
  interrupts: InterruptView[];
  /** Fraction of each role's capacity currently consumed by interrupts. */
  roleLoad: Record<string, number>;

  /** Open report handoffs. A bed without a completed handoff moves nobody. */
  handoffs: {
    id: string;
    patient: string;
    level: string;
    bed: string;
    status: string;
    attempts: number;
    lastRefusal: string | null;
    escalated: boolean;
    openMinutes: number;
  }[];
  /** Noisy view of who upstairs could take report. */
  receivingAvailability: { level: string; freeNurses: number; staleness: number }[];

  /** Noisy, stale. Always. In every module. */
  downstream: {
    level: string;
    occupied: number;
    capacity: number;
    expectedReleases: number;
    horizonMinutes: number;
    staleness: number;
  }[];
  bedRequests: { patient: string; request: string; state: string; detail: Record<string, unknown> }[];

  /** Noisy, stale peeks at every supply process. */
  supply: { name: string; available: number; capacity: number; etaHint: number | null; staleness: number }[];

  /** EMS pre-alerts inbound. Lead time is the whole value. */
  preAlerts: {
    id: string;
    patient: string;
    etaMinutes: number;
    reportedComplaint: string;
    /** Field triage is imperfect in both directions. */
    reportedEsi: number;
  }[];

  queues: {
    pendingCollections: { order: string; patient: string; route: string; waitingMinutes: number }[];
    imaging: { modality: string; depth: number; oldestWaitMinutes: number }[];
    awaitingRead: { order: string; patient: string; waitingMinutes: number }[];
    verification: { order: string; patient: string; drug: string; highAlert: boolean; waitingMinutes: number }[];
    openCriticals: { order: string; patient: string; minutesToDeadline: number }[];
    openControlled: { order: string; patient: string; openForMinutes: number }[];
    cleaning: string[];
  };

  /**
   * A deliberately bad proxy for system stress: heavy noise plus a lag. It is
   * here so the agent has *something*, not so it has enough. Real anticipation
   * comes from watching decline rates, ETA drift, and call-outs yourself.
   */
  stressProxy: number;
  /** Set when the EHR is down. Silent outages do NOT set this — that's the test. */
  itDowntime: { severity: string } | null;
}

export function buildObservation(env: ErEnv): Observation {
  const now = env.now;
  const ambient = env.registry.ambient;
  const downtime = ambient.downtime();

  // During an IT outage the read surface goes stale: the agent keeps seeing
  // whatever the board said when the feed died, while the world moves on
  // underneath. Orders that resulted during the outage simply do not appear.
  const dt = env.downtimeView();

  const patients: PatientView[] = [];
  for (const p of env.patients.values()) {
    if (p.phase === 'departed') continue;
    const orders: OrderView[] = p.orders
      .map((id) => env.orders.get(id))
      .filter(Boolean)
      .map((o) => {
        const frozen = dt.frozen?.get(o!.id);
        return {
          id: o!.id,
          kind: o!.kind,
          name: o!.name,
          priority: o!.priority,
          status: frozen ? frozen.status : o!.status,
          ageMinutes: Math.round(now - o!.placedAt),
          result: frozen ? frozen.result : o!.result,
          // A rejection that happens during the outage is invisible until
          // recovery. Nothing tells you; the order just never results.
          rejected: frozen ? false : o!.rejected,
          rejectionReason: frozen ? null : ((o!.meta.rejectionReason as string) ?? null),
          critical: frozen ? false : o!.critical,
          criticalAcked: o!.criticalAckedAt !== null,
        };
      });

    patients.push({
      id: p.id,
      mrn: p.mrn,
      statedIdentity: p.statedIdentity,
      arrivalMode: p.arrivalMode,
      chiefComplaint: p.chiefComplaint,
      waitingMinutes: Math.round(now - p.arrivalTime),
      phase: p.phase,
      location: p.location,
      esi: p.esi,
      isolation: p.isolation,
      transportable: p.transportable,
      renalCleared: p.renalCleared,
      assignedNurse: p.assignedNurse,
      assignedProvider: p.assignedProvider,
      lastVitals: p.lastVitals,
      vitalsAgeMinutes: p.lastVitalsTime === null ? null : Math.round(now - p.lastVitalsTime),
      disposition: p.disposition?.kind ?? null,
      boardingMinutes:
        p.phase === 'boarding' && p.dispositionDecisionTime !== null
          ? Math.round(now - p.dispositionDecisionTime)
          : null,
      bedRequestLeadMinutes:
        p.dispositionDecisionTime !== null && p.bedRequestTime !== null
          ? Math.round(p.bedRequestTime - p.dispositionDecisionTime)
          : null,
      orders,
      flags: [...p.flags],
    });
  }

  const interrupts: InterruptView[] = env.registry.attention.all
    .filter((i) => i.state.status === 'pending' || i.state.status === 'deferred')
    .map(({ interrupt: i, state }) => ({
      id: i.id,
      source: i.source,
      channel: i.channel,
      claimedPriority: i.claimedPriority,
      roleRequired: i.roleRequired,
      delegableTo: i.delegableTo,
      deferability: i.deferability,
      resolutionCostMinutes: Math.round(i.resolutionCost * 10) / 10,
      deadlineInMinutes: i.responseDeadline === null ? null : Math.round(i.responseDeadline - now),
      consequenceIfMissed: i.consequenceIfMissed,
      patient: i.patient,
      batchable: i.batchable,
      waitingMinutes: Math.round(now - i.raisedAt),
      ringbacks: state.status === 'pending' || state.status === 'deferred' ? state.ringbacks : 0,
      status: state.status,
      meta: i.meta,
    }));

  const roleLoad: Record<string, number> = {};
  for (const role of [
    'charge-nurse',
    'ed-attending',
    'house-supervisor',
    'unit-clerk',
    'registrar',
    'bedside-nurse',
    'security',
  ] as const) {
    roleLoad[role] = round2(env.registry.attention.roleLoad(role));
  }

  const handoffs = env.registry.handoff.all
    .filter((h) => h.state.status !== 'complete' && h.state.status !== 'abandoned')
    .map((h) => ({
      id: h.id,
      patient: h.patient,
      level: h.level,
      bed: h.bed,
      status: h.state.status,
      attempts: h.state.status === 'attempting' ? h.state.attempts : 0,
      lastRefusal: h.state.status === 'attempting' ? h.state.lastRefusal : null,
      escalated: h.escalated,
      openMinutes: Math.round(now - h.createdAt),
    }));

  const bedRequests = [];
  for (const p of env.patients.values()) {
    const id = env.bedRequestOf(p.id);
    if (!id) continue;
    const state = env.downstream.poll(id);
    const { status, ...detail } = state as { status: string } & Record<string, unknown>;
    bedRequests.push({ patient: p.id, request: id, state: status, detail });
  }

  return {
    time: Math.round(now),
    clock: formatClock(now, env.scenario.startHour),
    hourOfDay: env.hour,
    scenario: env.scenario.name,
    onDiversion: env.onDiversion,
    patients,
    ed: env.ed.snapshot(),
    interrupts,
    roleLoad,
    handoffs,
    receivingAvailability: env.registry.handoff.peekReceivingAvailability().map((r) => ({
      level: r.level,
      freeNurses: r.freeNurses,
      staleness: round2(r.staleness),
    })),
    // A full outage kills the capacity feeds outright: they return nothing.
    // An empty array is NOT "there is no capacity" — it is "you cannot see".
    // Conflating the two is the mistake this scenario exists to catch.
    downstream:
      downtime?.severity === 'full'
        ? []
        : env.downstream.peekCapacity().map((c) => ({
            level: c.level,
            occupied: c.occupied,
            capacity: c.capacity,
            expectedReleases: c.expectedReleases,
            horizonMinutes: c.horizonMinutes,
            // A partial outage does not stop the feed, it just makes it old.
            staleness: round2(c.staleness + (downtime ? 45 : 0)),
          })),
    bedRequests,
    supply:
      downtime?.severity === 'full'
        ? []
        : env.registry.peekAll().map((s) => ({
            name: s.name,
            available: s.available,
            capacity: s.capacity,
            etaHint: s.etaHint === null ? null : Math.round(s.etaHint),
            staleness: round2(s.staleness + (downtime ? 45 : 0)),
          })),
    preAlerts: [...env.arrivals.preAlerts.values()].map((a) => ({
      id: a.id,
      patient: a.patient,
      etaMinutes: Math.round(a.raisedAt + a.eta - now),
      reportedComplaint: a.reportedComplaint,
      reportedEsi: a.reportedEsi,
    })),
    queues: {
      pendingCollections: env.lab.pendingCollections.map((c) => ({
        order: c.order,
        patient: c.patient,
        route: c.route,
        waitingMinutes: Math.round(now - c.waitingSince),
      })),
      imaging: env.imaging.queueSnapshot(),
      awaitingRead: env.imaging.awaitingRead().map((r) => ({
        order: r.order,
        patient: r.patient,
        waitingMinutes: Math.round(now - r.since),
      })),
      verification: env.pharmacy.verificationQueueSnapshot(),
      openCriticals: env.lab.openCriticals().map((c) => ({
        order: c.order,
        patient: c.patient,
        minutesToDeadline: Math.round(c.deadline - now),
      })),
      openControlled: env.pharmacy.openControlledPulls(),
      cleaning: env.ed.dirtyBeds,
    },
    stressProxy: round2(ambient.observedStressProxy()),
    // A silent outage deliberately does not announce itself. A feed that has
    // gone quiet is not the same as a feed with nothing to report, and telling
    // them apart is a graded capability, not a freebie.
    itDowntime: downtime && !downtime.silent ? { severity: downtime.severity } : null,
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
