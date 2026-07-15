import type { ErEnv } from './env.js';
import type { Action } from './actions.js';
import type { Patient } from '../domain/types.js';
import { LAB_TESTS } from '../modules/labs.js';
import { IMAGING_STUDIES } from '../modules/imaging.js';
import { DRUGS } from '../modules/pharmacy.js';

/**
 * Contextual legal actions — one source of truth for "what can be done right now".
 *
 * This is the parity mechanism from the study design. The human UI renders these
 * as buttons; the AI is handed the same list each turn. Both agents therefore
 * KNOW the same set of legal moves — the only difference left is input modality
 * (click vs. JSON), which is an acknowledged, minor confound rather than an
 * information asymmetry.
 *
 * It never encodes strategy. It answers "is this move legal for this patient
 * now", the same question the env's own guards answer — not "is this move wise".
 * Sequencing and choice stay the agent's job.
 */

export interface ActionButton {
  label: string;
  action: Action;
}

export interface OrderMenu {
  kind: 'lab' | 'imaging' | 'med' | 'consult';
  /** Item names the agent may order. */
  items: string[];
}

export interface PatientActions {
  patient: string;
  /** Grouped one-click actions with concrete arguments already filled in. */
  groups: { name: string; buttons: ActionButton[] }[];
  /** Order menus need a second choice (which test, stat/routine), so they are
   *  rendered as a small form rather than pre-enumerated buttons. */
  orderMenus: OrderMenu[];
}

const needsMonitor = (esi: number | null) => esi !== null && esi <= 2;

/** The moves legal for one patient at this instant. */
export function patientActions(env: ErEnv, p: Patient): PatientActions {
  const groups: { name: string; buttons: ActionButton[] }[] = [];
  const push = (name: string, buttons: ActionButton[]) => {
    if (buttons.length) groups.push({ name, buttons });
  };

  // --- assessment ---
  const assess: ActionButton[] = [];
  assess.push({ label: 'Measure vitals', action: { type: 'measure_vitals', patient: p.id } });
  if (p.registrationTime === null) {
    assess.push({ label: 'Register (quick)', action: { type: 'register', patient: p.id, mode: 'quick' } });
    assess.push({ label: 'Register (full)', action: { type: 'register', patient: p.id, mode: 'full' } });
  }
  push('Assess', assess);

  // --- triage / re-triage (only once vitals exist) ---
  if (p.lastVitals !== null) {
    const kind = p.triageTime === null ? 'triage' : 'retriage';
    const label = p.triageTime === null ? 'Triage' : 'Re-triage';
    push(
      label,
      ([1, 2, 3, 4, 5] as const).map((esi) => ({
        label: `ESI ${esi}`,
        action: kind === 'triage' ? { type: 'triage', patient: p.id, esi } : { type: 'retriage', patient: p.id, esi },
      })),
    );
  }

  // --- placement (triaged, not yet in a bed) ---
  if (p.esi !== null && p.phase === 'waiting-room') {
    const beds = env.ed.availableBeds({ isolation: p.isolation, needsMonitor: needsMonitor(p.esi) });
    push(
      'Place in bed',
      beds.slice(0, 12).map((b) => ({
        label: `${b.id}${b.monitored ? ' (mon)' : ''}`,
        action: { type: 'place_bed', patient: p.id, bed: b.id },
      })),
    );
  }

  // --- staffing (in a bed) ---
  if (p.phase === 'in-bed' || p.phase === 'boarding') {
    if (!p.assignedNurse) {
      push(
        'Assign nurse',
        env.ed
          .nurses()
          .filter((n) => n.onDutyUntil > env.now)
          .slice(0, 10)
          .map((n) => ({ label: `${n.id} (${n.assigned.length})`, action: { type: 'assign_nurse', patient: p.id, nurse: n.id } })),
      );
    }
    if (!p.assignedProvider) {
      push(
        'Assign provider',
        env.ed
          .providers()
          .filter((s) => s.onDutyUntil > env.now)
          .slice(0, 8)
          .map((s) => ({ label: `${s.id} (${s.assigned.length})`, action: { type: 'assign_provider', patient: p.id, provider: s.id } })),
      );
    }
    push('Escalate', [
      { label: 'Rapid response', action: { type: 'escalate', patient: p.id, kind: 'rapid-response' } },
      { label: 'Code', action: { type: 'escalate', patient: p.id, kind: 'code' } },
    ]);
  }

  // --- orders (a provider is on the case) ---
  if (p.assignedProvider) {
    groups.push({ name: 'Orders', buttons: [] }); // placeholder header; forms rendered from orderMenus
  }

  // --- disposition (a provider has seen them) ---
  if (p.firstProviderTime !== null && !p.disposition) {
    const dispo: ActionButton[] = [
      { label: 'Discharge home', action: { type: 'decide_disposition', patient: p.id, disposition: 'discharge' } },
      { label: 'Admit · telemetry', action: { type: 'decide_disposition', patient: p.id, disposition: 'admit', level: 'telemetry' } },
      { label: 'Admit · med/surg', action: { type: 'decide_disposition', patient: p.id, disposition: 'admit', level: 'medsurg' } },
      { label: 'Admit · stepdown', action: { type: 'decide_disposition', patient: p.id, disposition: 'admit', level: 'stepdown' } },
      { label: 'Admit · ICU', action: { type: 'decide_disposition', patient: p.id, disposition: 'admit', level: 'icu' } },
      { label: 'To OR', action: { type: 'decide_disposition', patient: p.id, disposition: 'or' } },
      { label: 'Transfer out', action: { type: 'decide_disposition', patient: p.id, disposition: 'transfer-out' } },
    ];
    push('Disposition', dispo);
  }

  // --- after disposition: move them ---
  if (p.disposition?.kind === 'admit') {
    push('Bed request', [
      { label: 'Request telemetry bed', action: { type: 'request_bed', patient: p.id, level: 'telemetry' } },
      { label: 'Request med/surg bed', action: { type: 'request_bed', patient: p.id, level: 'medsurg' } },
      { label: 'Request ICU bed', action: { type: 'request_bed', patient: p.id, level: 'icu' } },
    ]);
  }
  if (p.disposition?.kind === 'discharge') {
    push('Transport home', [
      { label: 'Rideshare', action: { type: 'dispatch_transport', patient: p.id, tier: 'rideshare', direct: false } },
      { label: 'NEMT (wheelchair)', action: { type: 'dispatch_transport', patient: p.id, tier: 'nemt', direct: false } },
      { label: 'Taxi voucher', action: { type: 'dispatch_transport', patient: p.id, tier: 'taxi-voucher', direct: false } },
    ]);
  }

  // --- behavioural / restraints ---
  if (p.psychHold && !p.sitter) {
    const techs = [...env.ed.staff.values()].filter((s) => s.role === 'tech' && s.onDutyUntil > env.now);
    push('Psychiatric hold', [
      { label: 'Request psych bed', action: { type: 'request_psych_bed', patient: p.id } },
      ...techs.slice(0, 4).map((t) => ({ label: `Sitter: ${t.id}`, action: { type: 'assign_sitter' as const, patient: p.id, staff: t.id } })),
    ]);
  }
  if (p.restraint && p.restraint.releasedAt === null) {
    push('Restraints', [
      { label: 'Document check', action: { type: 'restraint_check', patient: p.id } },
      { label: 'Release', action: { type: 'release_restraints', patient: p.id } },
    ]);
  } else if (p.phase === 'in-bed' || p.phase === 'boarding') {
    push('Restraints', [
      { label: 'Apply physical', action: { type: 'apply_restraints', patient: p.id, kind: 'physical' } },
      { label: 'Apply chemical', action: { type: 'apply_restraints', patient: p.id, kind: 'chemical' } },
    ]);
  }

  const orderMenus: OrderMenu[] = p.assignedProvider
    ? [
        { kind: 'lab', items: Object.keys(LAB_TESTS) },
        { kind: 'imaging', items: Object.keys(IMAGING_STUDIES) },
        { kind: 'med', items: Object.keys(DRUGS) },
        { kind: 'consult', items: Object.keys(env.scenario.registry.consultServices) },
      ]
    : [];

  return { patient: p.id, groups: groups.filter((g) => g.buttons.length), orderMenus };
}

/** Department-level moves not tied to one patient: interrupts, handoffs, house. */
export function departmentActions(env: ErEnv): { name: string; buttons: ActionButton[] }[] {
  const out: { name: string; buttons: ActionButton[] }[] = [];
  const obs = env.observe();

  const interrupts: ActionButton[] = [];
  for (const i of obs.interrupts.slice(0, 12)) {
    interrupts.push({ label: `Answer ${i.source} (claims ${i.claimedPriority})`, action: { type: 'answer_interrupt', interrupt: i.id } });
    if (i.deferability !== 'immediate') {
      interrupts.push({ label: `Defer ${i.source} 60m`, action: { type: 'defer_interrupt', interrupt: i.id, minutes: 60 } });
    }
  }
  if (interrupts.length) out.push({ name: `Interrupts (${obs.interrupts.length})`, buttons: interrupts });

  const handoffs: ActionButton[] = [];
  for (const h of obs.handoffs) {
    handoffs.push({ label: `Attempt report: ${h.patient.replace('pt-', '#')} → ${h.level}`, action: { type: 'attempt_handoff', handoff: h.id } });
    if (h.attempts >= 2 && !h.escalated) handoffs.push({ label: `Escalate ${h.patient.replace('pt-', '#')}`, action: { type: 'escalate_handoff', handoff: h.id } });
  }
  if (handoffs.length) out.push({ name: `Report handoffs (${obs.handoffs.length})`, buttons: handoffs });

  const criticals = obs.queues.openCriticals.map((c) => ({ label: `Ack critical: ${c.patient.replace('pt-', '#')}`, action: { type: 'ack_critical' as const, order: c.order } }));
  if (criticals.length) out.push({ name: `Critical callbacks (${criticals.length})`, buttons: criticals });

  const bedOffers = obs.bedRequests
    .filter((r) => r.state === 'offered')
    .map((r) => ({ label: `Accept bed offer: ${r.patient.replace('pt-', '#')}`, action: { type: 'accept_bed_offer' as const, request: r.request } }));
  if (bedOffers.length) out.push({ name: 'Bed offers', buttons: bedOffers });

  const house: ActionButton[] = [
    { label: obs.onDiversion ? 'Diversion OFF' : 'Diversion ON', action: { type: 'set_diversion', on: !obs.onDiversion } },
    { label: 'Call float nurse', action: { type: 'call_float' } },
  ];
  out.push({ name: 'House', buttons: house });

  return out;
}
