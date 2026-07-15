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
/**
 * Seeds, not seed.
 *
 * A single seed is not a measurement. The floor-to-ceiling span on ed-baseline
 * swings 85k..143k across seeds (cv ~0.15), and the normalised score divides by
 * that span — so a one-seed score carries roughly +/-20% of noise and any
 * comparison between two policies on one seed is close to meaningless.
 *
 * Scores are averaged per seed (not computed from averaged rewards): each seed
 * is its own paired null/oracle span, which is the whole point of holding the
 * seed fixed across policies.
 */
const nSeeds = Number([...flags].find((f) => f.startsWith('--seeds='))?.split('=')[1] ?? 8);
const seedBase = args[1] ?? 's';
const seeds = Array.from({ length: nSeeds }, (_, i) => `${seedBase}${i + 1}`);
const withLog = flags.has('--log');

function run(scenario: string, policy: 'null' | 'reference' | 'oracle', seed: string) {
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
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};
/** Standard error of the mean: how much we would trust this if we re-ran it. */
const sem = (xs: number[]) => sd(xs) / Math.sqrt(xs.length);

console.log(`\ner-gym benchmark · ${seeds.length} seeds (${seeds[0]}..${seeds[seeds.length - 1]})\n`);
console.log(
  'scenario'.padEnd(22) +
    pad('null', 11) +
    pad('reference', 11) +
    pad('oracle', 11) +
    pad('score', 16) +
    pad('deaths r/o', 12),
);
console.log('-'.repeat(84));

for (const s of scenarios) {
  const nulls: number[] = [];
  const refs: number[] = [];
  const oracles: number[] = [];
  const scores: number[] = [];
  const refDeaths: number[] = [];
  const oraDeaths: number[] = [];

  for (const seed of seeds) {
    const n = run(s, 'null', seed);
    const r = run(s, 'reference', seed);
    const o = run(s, 'oracle', seed);
    nulls.push(n.reward);
    refs.push(r.reward);
    oracles.push(o.reward);
    refDeaths.push(r.metrics.clinical.deaths);
    oraDeaths.push(o.metrics.clinical.deaths);

    // Score PER SEED against that seed's own paired span. Averaging rewards
    // first and dividing once would let a single extreme seed dominate.
    const span = o.reward - n.reward;
    if (span > 0) scores.push((r.reward - n.reward) / span);
  }

  const scoreStr = scores.length
    ? `${mean(scores).toFixed(2)} ±${sem(scores).toFixed(2)}`
    : 'n/a';

  console.log(
    s.padEnd(22) +
      pad(Math.round(mean(nulls)).toLocaleString(), 11) +
      pad(Math.round(mean(refs)).toLocaleString(), 11) +
      pad(Math.round(mean(oracles)).toLocaleString(), 11) +
      pad(scoreStr, 16) +
      pad(`${mean(refDeaths).toFixed(1)}/${mean(oraDeaths).toFixed(1)}`, 12),
  );
}

console.log('\nRewards are means over seeds. score = mean per-seed (policy - null) / (oracle - null), ±SEM.');
console.log('0 = no better than doing nothing, 1 = matched the oracle. Negative = worse than doing nothing.');
console.log(
  'The oracle reads latent state. It is a strong policy with perfect information,\nNOT a proven upper bound — beating it means you found something it does not know.',
);
console.log(`\nSingle-seed scores are NOT reliable: the floor-to-ceiling span varies ~15% (cv) across seeds.\nUse --seeds=N (default 8) and report the interval, not a point.`);
