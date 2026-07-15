import { z } from 'zod';
import { CARE_LEVELS } from '../domain/types.js';

/**
 * The action surface.
 *
 * Actions are submitted as a batch per step. Each returns an individual result,
 * so a rejected action never silently no-ops — the agent is told why, because
 * "why was that refused" is information a real charge nurse has.
 *
 * Module 2+ actions (expedite_discharge, push_evs) are deliberately ABSENT.
 * They arrive with the ward simulation, behind the same DownstreamBeds
 * interface, and the action mask gates them out until then.
 */

const esi = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]);
const priority = z.enum(['stat', 'routine']);
const careLevel = z.enum(CARE_LEVELS as unknown as [string, ...string[]]);

export const ActionSchema = z.discriminatedUnion('type', [
  // --- registration / identity ---
  z.object({
    type: z.literal('register'),
    patient: z.string(),
    mode: z.enum(['quick', 'full']).describe('quick-reg trades identity certainty for speed'),
  }),
  z.object({
    type: z.literal('mpi_resolve'),
    patient: z.string(),
    /** Link this encounter to an existing person. Wrong link = overlay = hard floor. */
    personKey: z.string(),
  }),

  // --- triage ---
  z.object({
    type: z.literal('triage'),
    patient: z.string(),
    esi,
    isolation: z.enum(['none', 'contact', 'droplet', 'airborne']).optional(),
  }),
  z.object({
    type: z.literal('retriage'),
    patient: z.string(),
    esi,
  }).describe('re-triage a patient whose condition changed; the danger-zone floor still applies'),
  z.object({
    type: z.literal('route'),
    patient: z.string(),
    destination: z.enum(['main', 'fast-track', 'vertical', 'waiting']),
  }),
  z.object({
    type: z.literal('standing_orders'),
    patient: z.string(),
    orders: z.array(z.string()).describe('nurse-scope orders placed at triage'),
  }),
  z.object({
    type: z.literal('set_reassessment'),
    patient: z.string(),
    intervalMinutes: z.number().min(5).max(240),
  }),
  z.object({ type: z.literal('measure_vitals'), patient: z.string() }),

  // --- ED flow ---
  z.object({ type: z.literal('assign_nurse'), patient: z.string(), nurse: z.string() }),
  z.object({ type: z.literal('assign_provider'), patient: z.string(), provider: z.string() }),
  z.object({ type: z.literal('place_bed'), patient: z.string(), bed: z.string() }),
  z.object({
    type: z.literal('escalate'),
    patient: z.string(),
    kind: z.enum(['rapid-response', 'code']),
  }),

  // --- ancillary orders ---
  z.object({
    type: z.literal('order_lab'),
    patient: z.string(),
    test: z.string(),
    priority,
    route: z.enum(['poct', 'central']),
  }),
  z.object({
    type: z.literal('order_imaging'),
    patient: z.string(),
    study: z.string(),
    priority,
    escort: z.boolean().default(false),
  }),
  z.object({
    type: z.literal('order_med'),
    patient: z.string(),
    drug: z.string(),
    priority,
    source: z.enum(['cabinet', 'central', 'compounding']),
  }),
  z.object({ type: z.literal('order_consult'), patient: z.string(), service: z.string(), priority }),

  // --- ancillary orchestration (the agent's real levers) ---
  z.object({ type: z.literal('prioritise_collection'), orders: z.array(z.string()) }),
  z.object({ type: z.literal('redraw'), order: z.string() }),
  z.object({ type: z.literal('ack_critical'), order: z.string() }),
  z.object({
    type: z.literal('prioritise_imaging'),
    modality: z.enum(['ct', 'us', 'plain-film', 'mri']),
    orders: z.array(z.string()),
  }),
  z.object({ type: z.literal('escalate_read'), order: z.string() }),
  z.object({
    type: z.literal('prioritise_verification'),
    orders: z.array(z.string()).describe('re-rank the pharmacist queue; you cannot verify'),
  }),
  z.object({ type: z.literal('document_controlled'), order: z.string() }),

  // --- blood bank ---
  z.object({
    type: z.literal('request_blood'),
    patient: z.string(),
    product: z.enum(['o-neg-emergency', 'type-specific', 'crossmatched', 'mtp-pack']),
    units: z.number().int().min(1).max(10),
  }),
  z.object({ type: z.literal('warm_blood_bank'), patient: z.string() }),
  z.object({
    type: z.literal('stop_mtp'),
    patient: z.string(),
    /** An MTP left running drains a bank that someone else will need. */
  }),

  // --- EMS / trauma anticipation ---
  z.object({
    type: z.literal('activate_trauma'),
    patient: z.string(),
    tier: z.enum(['none', 'limited', 'full']),
  }),
  z.object({
    type: z.literal('prestage'),
    patient: z.string(),
    bay: z.string().optional(),
    warmBlood: z.boolean().default(false),
    pullMeds: z.array(z.string()).default([]),
  }),

  // --- interrupts (attention triage) ---
  z.object({ type: z.literal('answer_interrupt'), interrupt: z.string(), role: z.string().optional() }),
  z.object({
    type: z.literal('defer_interrupt'),
    interrupt: z.string(),
    minutes: z.number().min(1).max(480),
  }),
  z.object({
    type: z.literal('batch_interrupts'),
    interrupts: z.array(z.string()).min(2),
    role: z.string().optional(),
  }),

  // --- report handoff rendezvous ---
  z.object({ type: z.literal('attempt_handoff'), handoff: z.string() }),
  z.object({ type: z.literal('escalate_handoff'), handoff: z.string() }),

  // --- downstream boundary ---
  z.object({
    type: z.literal('request_bed'),
    patient: z.string(),
    level: careLevel,
    cohort: z.string().optional(),
  }),
  z.object({ type: z.literal('accept_bed_offer'), request: z.string() }),
  z.object({ type: z.literal('cancel_bed_request'), request: z.string() }),

  // --- disposition ---
  z.object({
    type: z.literal('decide_disposition'),
    patient: z.string(),
    disposition: z.enum(['discharge', 'admit', 'transfer-out', 'or', 'ama']),
    level: careLevel.optional().describe('required when disposition is admit'),
  }),

  // --- transport ---
  z.object({
    type: z.literal('dispatch_transport'),
    patient: z.string(),
    tier: z.enum(['rideshare', 'nemt', 'taxi-voucher', 'family-pickup', 'bls', 'als', 'cct']),
    direct: z.boolean().default(false).describe('direct agency call: costs attention, faster answer'),
  }),
  z.object({ type: z.literal('cancel_transport'), patient: z.string() }),

  // --- restraints (each application starts a monitoring clock) ---
  z.object({
    type: z.literal('apply_restraints'),
    patient: z.string(),
    kind: z.enum(['physical', 'chemical']),
  }),
  z.object({
    type: z.literal('restraint_check'),
    patient: z.string(),
    describe: z.string().optional().describe('documented check; closes the current interval'),
  }),
  z.object({ type: z.literal('release_restraints'), patient: z.string() }),

  // --- psychiatric holds ---
  z.object({
    type: z.literal('request_psych_bed'),
    patient: z.string(),
  }),
  z.object({
    type: z.literal('assign_sitter'),
    patient: z.string(),
    staff: z.string(),
  }),

  // --- law enforcement ---
  z.object({
    type: z.literal('police_blood_draw'),
    patient: z.string(),
    interrupt: z.string().describe('the law-enforcement interrupt requesting the draw'),
  }),

  // --- EVS ---
  z.object({ type: z.literal('prioritise_cleaning'), beds: z.array(z.string()) }),

  // --- house ---
  z.object({ type: z.literal('set_diversion'), on: z.boolean() }),
  z.object({ type: z.literal('call_float') }),
  z.object({ type: z.literal('authorise_overtime'), staff: z.string(), minutes: z.number().min(30).max(480) }),
  z.object({ type: z.literal('no_op') }),
]);

export type Action = z.infer<typeof ActionSchema>;
export type ActionType = Action['type'];

export interface ActionResult {
  action: ActionType;
  ok: boolean;
  reason?: string;
  /** Free-form payload: new order ids, request ids, ETAs. */
  data?: Record<string, unknown>;
}

/**
 * The action mask.
 *
 * Two jobs. First, tell the agent what is legal right now, so it is not
 * guessing. Second — and this is the part that matters for the roadmap —
 * gate out actions that belong to modules that are not installed. When Module 2
 * lands, `expedite_discharge` and `push_evs` appear here and nowhere else
 * changes.
 */
export interface ActionMask {
  available: ActionType[];
  /** Actions that exist in the full spec but are gated out, with the reason. */
  gated: { action: string; reason: string }[];
}

const ALWAYS_AVAILABLE: ActionType[] = [
  'register',
  'mpi_resolve',
  'triage',
  'retriage',
  'route',
  'standing_orders',
  'set_reassessment',
  'measure_vitals',
  'assign_nurse',
  'assign_provider',
  'place_bed',
  'escalate',
  'order_lab',
  'order_imaging',
  'order_med',
  'order_consult',
  'prioritise_collection',
  'redraw',
  'ack_critical',
  'prioritise_imaging',
  'escalate_read',
  'prioritise_verification',
  'document_controlled',
  'request_blood',
  'warm_blood_bank',
  'stop_mtp',
  'activate_trauma',
  'prestage',
  'answer_interrupt',
  'defer_interrupt',
  'batch_interrupts',
  'attempt_handoff',
  'escalate_handoff',
  'request_bed',
  'accept_bed_offer',
  'cancel_bed_request',
  'decide_disposition',
  'dispatch_transport',
  'cancel_transport',
  'apply_restraints',
  'restraint_check',
  'release_restraints',
  'request_psych_bed',
  'assign_sitter',
  'police_blood_draw',
  'prioritise_cleaning',
  'set_diversion',
  'call_float',
  'authorise_overtime',
  'no_op',
];

export function actionMask(downstreamKind: string): ActionMask {
  const gated: { action: string; reason: string }[] = [];
  if (downstreamKind === 'stochastic-v1') {
    gated.push({
      action: 'expedite_discharge',
      reason:
        'Module 2 (inpatient wards) not installed. Downstream bed release is exogenous in Module 1 — you cannot make a bed appear.',
    });
    gated.push({
      action: 'push_evs',
      reason: 'Module 2 (inpatient wards) not installed. House-wide EVS is not in the ED module.',
    });
  }
  return { available: [...ALWAYS_AVAILABLE], gated };
}
