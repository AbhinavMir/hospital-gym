/**
 * The benchmark harness.
 *
 * Runs three policies against the SAME scenario and seed:
 *   null      — no actions at all. The floor. What happens if nobody works.
 *   reference — the deliberately mediocre policy in random-policy.ts.
 *   oracle    — perfect information (reads latent state). The reference ceiling.
 *
 * The normalised score places a policy between the floor and the ceiling:
 *
 *     score = (policy - null) / (oracle - null)
 *
 * 0.0 = no better than abandoning the department. 1.0 = matched the oracle.
 * Above 1.0 is possible and interesting: the oracle is a strong hand-written
 * policy, NOT a proven upper bound, so beating it means you found something it
 * does not know.
 *
 * Usage: npx tsx examples/bench.ts [scenario] [seed]
 */
import { ErEnv } from '../src/gym/env.js';
import { OraclePolicy } from '../src/gym/oracle.js';
import { getScenario, SCENARIOS } from '../src/scenarios/index.js';
import { Logger } from '../src/kernel/log.js';
import { inDangerZone } from '../src/domain/physiology.js';
import type { Action } from '../src/gym/actions.js';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
const scenarios = args[0] ? [args[0]] : Object.keys(SCENARIOS);
const seed = args[1] ?? 'bench-1';
const withLog = flags.has('--log');

function run(scenario: string, policy: 'null' | 'reference' | 'oracle') {
  const log = withLog
    ? new Logger({ runId: `bench-${scenario}-${policy}-${seed}`, dir: 'logs', toFile: true })
    : undefined;
  const env = new ErEnv(getScenario(scenario), seed, log);
  const oracle = policy === 'oracle' ? new OraclePolicy(env) : null;

  let done = false;
  while (!done) {
    let actions: Action[] = [];
    if (policy === 'oracle') actions = oracle!.act();
    else if (policy === 'reference') actions = referenceActions(env);
    done = env.step(actions).done;
  }

  const m = env.metrics();
  log?.close({ scenario, policy, seed, reward: env.components, metrics: m });
  return { reward: env.components.total, metrics: m, floors: env.components.floors };
}

/** The same mediocre policy as random-policy.ts, inlined so bench is standalone. */
function referenceActions(env: ErEnv): Action[] {
  const obs = env.observe();
  const a: Action[] = [];
  for (const p of obs.patients) {
    if (p.esi === null && p.lastVitals === null) {
      a.push({ type: 'measure_vitals', patient: p.id });
      continue;
    }
    if (p.esi === null && p.lastVitals) {
      a.push({ type: 'register', patient: p.id, mode: 'quick' });
      a.push({ type: 'triage', patient: p.id, esi: inDangerZone(p.lastVitals) ? 2 : 4 });
      continue;
    }
    if (p.phase === 'waiting-room') {
      const bed = obs.ed.beds.find((b) => b.status === 'clean' && !b.patient && (p.esi! > 2 || b.monitored));
      if (bed) a.push({ type: 'place_bed', patient: p.id, bed: bed.id });
      continue;
    }
    if (p.phase === 'in-bed') {
      if (!p.assignedNurse) {
        const n = obs.ed.nurses.filter((x) => x.onDuty).sort((x, y) => x.assigned.length - y.assigned.length)[0];
        if (n) a.push({ type: 'assign_nurse', patient: p.id, nurse: n.id });
      }
      if (!p.assignedProvider) {
        const d = obs.ed.providers.filter((x) => x.onDuty).sort((x, y) => x.assigned.length - y.assigned.length)[0];
        if (d) a.push({ type: 'assign_provider', patient: p.id, provider: d.id });
      }
      if (p.orders.length === 0) {
        a.push({ type: 'order_lab', patient: p.id, test: 'cbc', priority: 'stat', route: 'central' });
        a.push({ type: 'order_lab', patient: p.id, test: 'bmp', priority: 'stat', route: 'poct' });
      }
      if (p.assignedProvider && p.orders.some((o) => o.status === 'resulted') && !p.disposition) {
        a.push(
          p.esi! <= 2
            ? { type: 'decide_disposition', patient: p.id, disposition: 'admit', level: 'telemetry' }
            : { type: 'decide_disposition', patient: p.id, disposition: 'discharge' },
        );
      }
    }
    if (p.disposition === 'admit' && !obs.bedRequests.some((r) => r.patient === p.id)) {
      a.push({ type: 'request_bed', patient: p.id, level: 'telemetry' });
    }
    if (p.disposition === 'discharge') {
      a.push({ type: 'dispatch_transport', patient: p.id, tier: 'rideshare', direct: false });
    }
  }
  for (const r of obs.bedRequests) if (r.state === 'offered') a.push({ type: 'accept_bed_offer', request: r.request });
  for (const h of obs.handoffs) a.push({ type: 'attempt_handoff', handoff: h.id });
  for (const c of obs.queues.openCriticals) a.push({ type: 'ack_critical', order: c.order });
  for (const o of obs.patients.flatMap((p) => p.orders)) if (o.rejected) a.push({ type: 'redraw', order: o.id });
  for (const i of obs.interrupts.filter((x) => x.claimedPriority <= 2).slice(0, 3)) {
    a.push({ type: 'answer_interrupt', interrupt: i.id });
  }
  return a;
}

const pad = (s: string | number, n: number) => String(s).padStart(n);

console.log(`\ner-gym benchmark · seed=${seed}\n`);
console.log(
  'scenario'.padEnd(24) +
    pad('null', 12) +
    pad('reference', 12) +
    pad('oracle', 12) +
    pad('score', 8) +
    pad('deaths r/o', 12),
);
console.log('-'.repeat(80));

for (const s of scenarios) {
  const n = run(s, 'null');
  const r = run(s, 'reference');
  const o = run(s, 'oracle');

  // Normalise between the floor and the ceiling. If the oracle somehow fails to
  // beat doing nothing, the score is meaningless and we say so rather than
  // printing a confident number.
  const span = o.reward - n.reward;
  const score = span > 0 ? (r.reward - n.reward) / span : NaN;

  console.log(
    s.padEnd(24) +
      pad(Math.round(n.reward).toLocaleString(), 12) +
      pad(Math.round(r.reward).toLocaleString(), 12) +
      pad(Math.round(o.reward).toLocaleString(), 12) +
      pad(Number.isFinite(score) ? score.toFixed(2) : 'n/a', 8) +
      pad(`${r.metrics.clinical.deaths}/${o.metrics.clinical.deaths}`, 12),
  );
}

console.log(
  '\nscore = (reference - null) / (oracle - null).  0 = no better than doing nothing, 1 = matched the oracle.',
);
console.log(
  'The oracle reads latent state. It is a strong policy with perfect information,\nNOT a proven upper bound — beating it is possible and means you found something it does not know.',
);
