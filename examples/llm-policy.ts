/**
 * Reference LLM policy adapter — one file.
 *
 * Drives an er-gym episode with a language model, so any model is a one-argument
 * swap. Works with OpenAI directly OR OpenRouter — the provider is auto-detected
 * from the key prefix (sk-or-... = OpenRouter, else OpenAI), or forced with
 * --base-url:
 *
 *   npx tsx examples/llm-policy.ts --model gpt-4o-mini              --key sk-proj-...  (OpenAI)
 *   npx tsx examples/llm-policy.ts --model openai/gpt-5            --key sk-or-...    (OpenRouter)
 *   npx tsx examples/llm-policy.ts --model anthropic/claude-sonnet-4 --key sk-or-...
 *
 * This file talks to the env DIRECTLY via the library. That keeps it a single
 * runnable file. The three functions that touch the model — buildMessages,
 * callModel, parseActions — are transport-agnostic: in a separate harness
 * that drives the server over MCP, keep them verbatim and replace
 * `env.observe()` / `env.step()` with the `er_observe` / `er_step` tool calls.
 *
 * KEYS: this never reads a key from the ambient environment on its own. Pass
 * --key explicitly, or set OPENROUTER_API_KEY and pass --use-env to opt in. With
 * neither, only --dry-run works (a local stub, no network, no key), which is how
 * you smoke-test the harness for free.
 *
 * COST: one completion per step, ~144 steps per shift. Use --max-steps to cap a
 * cheap trial. The observation is compacted before it is sent (see compactObs).
 */
import { ErEnv } from '../src/gym/env.js';
import { getScenario } from '../src/scenarios/index.js';
import { ActionSchema, type Action, type ActionResult } from '../src/gym/actions.js';
import type { Observation } from '../src/gym/observation.js';
import { LAB_TESTS } from '../src/modules/labs.js';
import { IMAGING_STUDIES } from '../src/modules/imaging.js';
import { DRUGS } from '../src/modules/pharmacy.js';
import { Logger } from '../src/kernel/log.js';

// --- config ------------------------------------------------------------------

// Both endpoints speak the OpenAI chat-completions shape, so one call path
// serves either. The provider is auto-detected from the key prefix
// (sk-or-... = OpenRouter, anything else sk-... = OpenAI direct) or forced with
// --base-url. OpenRouter lets you address any model as "vendor/model"; OpenAI
// direct takes bare model names like "gpt-4o-mini".
const ENDPOINTS = {
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  openai: 'https://api.openai.com/v1/chat/completions',
};

function resolveEndpoint(key: string | null, override?: string): string {
  if (override) return override;
  if (key && !key.startsWith('sk-or-')) return ENDPOINTS.openai;
  return ENDPOINTS.openrouter;
}

interface Cfg {
  model: string;
  scenario: string;
  seed: string;
  key: string | null;
  endpoint: string;
  dryRun: boolean;
  maxSteps: number;
  temperature: number;
  log: boolean;
}

function parseArgs(argv: string[]): Cfg {
  const get = (flag: string, def?: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : def;
  };
  const has = (flag: string) => argv.includes(flag);

  // Key resolution is deliberately explicit. --key wins. --use-env opts into
  // OPENROUTER_API_KEY. Otherwise there is NO key and only --dry-run runs.
  const key = get('--key') ?? (has('--use-env') ? process.env.OPENROUTER_API_KEY ?? null : null);

  return {
    model: get('--model', 'anthropic/claude-sonnet-4')!,
    scenario: get('--scenario', 'ed-baseline')!,
    seed: get('--seed', 's1')!,
    key,
    endpoint: resolveEndpoint(key, get('--base-url')),
    dryRun: has('--dry-run'),
    maxSteps: Number(get('--max-steps', '0')), // 0 = full shift
    temperature: Number(get('--temperature', '0.2')),
    log: has('--log'),
  };
}

// --- the model-facing surface (lift these three into any harness) ------------

/** The system prompt: the job, the rules, and the exact response contract. */
function systemPrompt(): string {
  return [
    'You are the charge nurse running a simulated emergency department, minute by minute.',
    'Your job: keep patients from deteriorating and move them through, without ever crossing a hard safety line.',
    '',
    'HARD RULES (violations are large, unrecoverable penalties — never trade against them):',
    '- Never triage a patient with danger-zone vitals above ESI 2. Measure vitals before triaging.',
    '- Never discharge a still-sick patient, or one on a psychiatric hold.',
    '- Never order a contrast scan unless renal clearance is confirmed.',
    '- Never send a monitored/critical patient home in a rideshare.',
    '- Never leave a restrained patient un-checked; each restraint has a check clock.',
    '- Never draw blood for police without a warrant or consent. Never discuss a named patient with media.',
    '- You RE-RANK the pharmacy verification queue; you never verify a drug yourself.',
    '',
    'KEY DYNAMICS:',
    '- You only know a vital sign if you measured it; readings go stale. Nothing pushes deterioration to you.',
    '- Downstream beds, ambulances, and consultants are outside services: they queue, decline, and run late.',
    '- A bed being assigned does NOT move the patient — a nurse-to-nurse report handoff must complete first.',
    '- Interrupts report a CLAIMED priority. Most callers exaggerate; a lab critical-value callback never does.',
    '',
    'RESPONSE CONTRACT: reply with ONE fenced json block and nothing else:',
    '```json',
    '{ "reasoning": "one or two sentences", "actions": [ { "type": "...", ... }, ... ] }',
    '```',
    'Submit as many actions as you want in one step; they apply, then 5 minutes pass. An empty list lets time pass.',
    'Refused actions come back with a reason — read them and adapt.',
  ].join('\n');
}

/** A compact action cheat-sheet. The full schema is large; these are the verbs
 *  and their key arguments, enough for a model to act without the raw JSON schema. */
function actionReference(): string {
  return [
    'ACTIONS (type + arguments):',
    'measure_vitals{patient} · register{patient,mode:quick|full} · triage{patient,esi:1-5,isolation?} · retriage{patient,esi}',
    'route{patient,destination:main|fast-track|vertical|waiting} · standing_orders{patient,orders:[]} · set_reassessment{patient,intervalMinutes}',
    'place_bed{patient,bed} · assign_nurse{patient,nurse} · assign_provider{patient,provider} · escalate{patient,kind:rapid-response|code}',
    'order_lab{patient,test,priority:stat|routine,route:poct|central} · order_imaging{patient,study,priority,escort?}',
    'order_med{patient,drug,priority,source:cabinet|central|compounding} · order_consult{patient,service,priority}',
    'prioritise_collection{orders:[]} · redraw{order} · ack_critical{order} · prioritise_imaging{modality,orders:[]} · escalate_read{order}',
    'prioritise_verification{orders:[]} · document_controlled{order} · request_blood{patient,product,units} · warm_blood_bank{patient} · stop_mtp{patient}',
    'activate_trauma{patient,tier:none|limited|full} · prestage{patient,bay?,warmBlood?,pullMeds?}',
    'answer_interrupt{interrupt,role?} · defer_interrupt{interrupt,minutes} · batch_interrupts{interrupts:[]}',
    'attempt_handoff{handoff} · escalate_handoff{handoff}',
    'request_bed{patient,level:icu|stepdown|telemetry|medsurg|observation} · accept_bed_offer{request} · cancel_bed_request{request}',
    'decide_disposition{patient,disposition:discharge|admit|transfer-out|or|ama,level?}',
    'dispatch_transport{patient,tier:rideshare|nemt|taxi-voucher|family-pickup|bls|als|cct,direct?} · cancel_transport{patient}',
    'apply_restraints{patient,kind:physical|chemical} · restraint_check{patient} · release_restraints{patient}',
    'request_psych_bed{patient} · assign_sitter{patient,staff} · police_blood_draw{patient,interrupt}',
    'prioritise_cleaning{beds:[]} · set_diversion{on} · call_float · authorise_overtime{staff,minutes} · no_op',
    '',
    `LABS: ${Object.keys(LAB_TESTS).join(', ')}`,
    `IMAGING: ${Object.keys(IMAGING_STUDIES).join(', ')}`,
    `DRUGS: ${Object.keys(DRUGS).join(', ')}`,
  ].join('\n');
}

/** Trim the observation to what a decision needs. The full object is large and
 *  every token is paid for once per step. */
function compactObs(o: Observation) {
  return {
    clock: o.clock,
    hourOfDay: o.hourOfDay,
    onDiversion: o.onDiversion,
    stressProxy: o.stressProxy,
    itDowntime: o.itDowntime,
    beds: {
      clean: o.ed.beds.filter((b) => b.status === 'clean' && !b.patient).map((b) => b.id),
      dirty: o.queues.cleaning,
    },
    staff: {
      nurses: o.ed.nurses.filter((n) => n.onDuty).map((n) => ({ id: n.id, load: n.assigned.length })),
      providers: o.ed.providers.filter((p) => p.onDuty).map((p) => ({ id: p.id, role: p.role, load: p.assigned.length })),
    },
    patients: o.patients.map((p) => ({
      id: p.id,
      esi: p.esi,
      phase: p.phase,
      complaint: p.chiefComplaint,
      waitMin: p.waitingMinutes,
      vitals: p.lastVitals,
      vitalsAgeMin: p.vitalsAgeMinutes,
      nurse: p.assignedNurse,
      provider: p.assignedProvider,
      renalCleared: p.renalCleared,
      isolation: p.isolation !== 'none' ? p.isolation : undefined,
      disposition: p.disposition,
      boardingMin: p.boardingMinutes,
      psychHold: p.psychHold || undefined,
      restraint: p.restraint ? { checkDueMin: p.restraint.minutesUntilCheckDue, missed: p.restraint.checksMissed } : undefined,
      orders: p.orders.map((x) => ({ id: x.id, name: x.name, status: x.status, critical: x.critical || undefined, rejected: x.rejected || undefined })),
    })),
    interrupts: o.interrupts.map((i) => ({
      id: i.id,
      source: i.source,
      claimedPriority: i.claimedPriority,
      role: i.roleRequired,
      deferability: i.deferability,
      deadlineMin: i.deadlineInMinutes,
      patient: i.patient,
    })),
    handoffs: o.handoffs.map((h) => ({ id: h.id, patient: h.patient, status: h.status, openMin: h.openMinutes })),
    bedRequests: o.bedRequests,
    openCriticals: o.queues.openCriticals,
    downstream: o.downstream.map((d) => ({ level: d.level, occupied: d.occupied, capacity: d.capacity, staleMin: d.staleness })),
  };
}

/** Build the message list for one step. */
function buildMessages(o: Observation, lastResults: ActionResult[]): { role: string; content: string }[] {
  const refused = lastResults.filter((r) => !r.ok);
  const feedback =
    refused.length > 0
      ? `\nLast step, these actions were REFUSED — adapt:\n` +
        refused.map((r) => `- ${r.action}: ${r.reason}`).join('\n')
      : '';
  return [
    { role: 'system', content: `${systemPrompt()}\n\n${actionReference()}` },
    {
      role: 'user',
      content: `Current board:\n${JSON.stringify(compactObs(o), null, 1)}${feedback}\n\nYour actions for this step:`,
    },
  ];
}

/** One chat completion (OpenAI or OpenRouter — same shape). Returns raw text. */
async function callModel(cfg: Cfg, messages: { role: string; content: string }[]): Promise<string> {
  const res = await fetch(cfg.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.key}`,
      'Content-Type': 'application/json',
      // Harmless on OpenAI, used for attribution on OpenRouter.
      'HTTP-Referer': 'https://github.com/AbhinavMir/hospital-gym',
      'X-Title': 'er-gym',
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: cfg.temperature,
      max_tokens: 2000,
    }),
  });
  if (!res.ok) {
    throw new Error(`${cfg.endpoint} ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content ?? '';
}

/**
 * Parse a model reply into validated actions. Lenient about the wrapping (fenced
 * or bare JSON), strict about each action: anything that fails the schema is
 * dropped with its reason, never guessed at.
 */
function parseActions(text: string): { actions: Action[]; reasoning: string; dropped: string[] } {
  const dropped: string[] = [];
  let obj: unknown;

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  // Fenced content wins. Otherwise slice from the first opening bracket to the
  // last closing one — using whichever of { or [ comes first, so a bare
  // top-level array is not silently truncated into its first object.
  let raw: string;
  if (fence) {
    raw = fence[1]!;
  } else {
    const firstObj = text.indexOf('{');
    const firstArr = text.indexOf('[');
    const start =
      firstArr >= 0 && (firstObj < 0 || firstArr < firstObj) ? firstArr : firstObj;
    const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']')) + 1;
    raw = start >= 0 && end > start ? text.slice(start, end) : text;
  }
  try {
    obj = JSON.parse(raw);
  } catch {
    return { actions: [], reasoning: '', dropped: ['response was not valid JSON'] };
  }

  const record = obj as { reasoning?: unknown; actions?: unknown };
  const reasoning = typeof record.reasoning === 'string' ? record.reasoning : '';
  const list = Array.isArray(record.actions) ? record.actions : Array.isArray(obj) ? obj : [];

  const actions: Action[] = [];
  for (const candidate of list) {
    const parsed = ActionSchema.safeParse(candidate);
    if (parsed.success) actions.push(parsed.data);
    else dropped.push(`${(candidate as { type?: string })?.type ?? '?'}: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  }
  return { actions, reasoning, dropped };
}

// --- a free, keyless stub so the harness is testable without a model ---------

/**
 * A tiny local "model" for --dry-run. It emits the SAME JSON contract a real
 * model would, so it exercises the entire parse + step path with no network and
 * no key. It is intentionally dumb — it proves the plumbing, not good play.
 */
function stubReply(o: Observation): string {
  const actions: unknown[] = [];
  for (const p of o.patients.slice(0, 6)) {
    if (p.esi === null && p.vitalsAgeMinutes === null) actions.push({ type: 'measure_vitals', patient: p.id });
    else if (p.esi === null && p.lastVitals) {
      actions.push({ type: 'register', patient: p.id, mode: 'quick' });
      actions.push({ type: 'triage', patient: p.id, esi: 3 });
    }
  }
  for (const c of o.queues.openCriticals) actions.push({ type: 'ack_critical', order: c.order });
  return '```json\n' + JSON.stringify({ reasoning: 'stub: measure, triage, ack criticals', actions }) + '\n```';
}

// --- the loop ----------------------------------------------------------------

async function main() {
  const cfg = parseArgs(process.argv.slice(2));

  if (!cfg.dryRun && !cfg.key) {
    console.error(
      [
        'No API key. This will not run a real model without one, and it will not',
        'read your environment on its own.',
        '',
        '  Smoke-test for free (local stub, no key, no network):',
        '    npx tsx examples/llm-policy.ts --dry-run --max-steps 20',
        '',
        '  Run a real model:',
        '    npx tsx examples/llm-policy.ts --model anthropic/claude-sonnet-4 --key sk-or-...',
        '    (or set OPENROUTER_API_KEY and add --use-env to opt in)',
      ].join('\n'),
    );
    process.exit(1);
  }

  const label = cfg.dryRun ? 'dry-run-stub' : cfg.model;
  const log = cfg.log
    ? new Logger({ runId: `llm-${label.replace(/\W+/g, '-')}-${cfg.scenario}-${cfg.seed}`, dir: 'logs', toFile: true })
    : undefined;
  const env = new ErEnv(getScenario(cfg.scenario), cfg.seed, log);

  console.log(`\ner-gym · ${label} · ${cfg.scenario} · seed ${cfg.seed}${cfg.dryRun ? ' · DRY RUN (no key, no network)' : ''}\n`);

  let obs = env.observe();
  let lastResults: ActionResult[] = [];
  let step = 0;
  let done = false;

  while (!done) {
    let reply: string;
    try {
      reply = cfg.dryRun ? stubReply(obs) : await callModel(cfg, buildMessages(obs, lastResults));
    } catch (e) {
      console.error(`step ${step}: model call failed — ${(e as Error).message}`);
      console.error('stopping. partial metrics below.');
      break;
    }

    const { actions, reasoning, dropped } = parseActions(reply);
    const res = env.step(actions);
    lastResults = res.results;
    obs = res.observation;
    done = res.done;
    step++;

    const refused = res.results.filter((r) => !r.ok).length;
    console.log(
      `[${res.info.clock}] step ${String(step).padStart(3)} · ${actions.length} actions` +
        ` (${refused} refused${dropped.length ? `, ${dropped.length} dropped` : ''})` +
        ` · reward ${res.reward.toFixed(0)}` +
        (reasoning ? ` · ${reasoning.slice(0, 80)}` : ''),
    );

    if (cfg.maxSteps && step >= cfg.maxSteps) break;
  }

  const m = env.metrics();
  console.log(`\n--- ${label} · ${step} steps · sim ${m.simMinutes} min ---`);
  console.log('reward total:', Math.round(env.components.total).toLocaleString());
  console.log('deaths:', m.clinical.deaths, '· LWBS rate:', m.access.lwbsRate, '· safety floors:', JSON.stringify(m.safety));
  if (log) console.log('event log:', log.close({ model: label, scenario: cfg.scenario, seed: cfg.seed, metrics: m }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
