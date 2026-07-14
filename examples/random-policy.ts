/**
 * A deliberately mediocre reference policy.
 *
 * It exists to prove the environment runs end-to-end and to give a floor to
 * compare against — NOT as an example of good play. It triages by vitals,
 * rooms whoever it can, orders a generic workup, answers interrupts by claimed
 * priority (which is the mistake the attention model is built to punish), and
 * requests beds only at disposition (which is the mistake the boarding model is
 * built to punish).
 */
import { ErEnv } from '../src/gym/env.js';
import { getScenario } from '../src/scenarios/index.js';
import type { Action } from '../src/gym/actions.js';
import { inDangerZone } from '../src/domain/physiology.js';
import { NULL_VIZ, frameOf, startViz } from '../src/viz/hub.js';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
const scenarioName = args[0] ?? 'ed-baseline';
const seed = args[1] ?? 'demo-seed';

// --watch paces the episode so a human can actually follow it. Without it the
// whole shift runs in under a second, which is right for benchmarking and
// useless for watching.
const watch = flags.has('--watch');
const paceMs = Number([...flags].find((f) => f.startsWith('--pace='))?.split('=')[1] ?? 120);

const env = new ErEnv(getScenario(scenarioName), seed);
const viz = watch ? startViz(Number(process.env.ER_GYM_VIZ_PORT ?? 7777)) : NULL_VIZ;
if (watch) {
  viz.publish(env);
  console.log(`live board: ${viz.url}  (scenario=${scenarioName} seed=${seed})`);
  console.log('waiting 2s for you to open it…');
  await new Promise((r) => setTimeout(r, 2000));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let done = false;
let steps = 0;
let obs = env.observe();

while (!done) {
  const actions: Action[] = [];

  for (const p of obs.patients) {
    // Measure, then triage. Never triage blind.
    if (p.esi === null && p.lastVitals === null) {
      actions.push({ type: 'measure_vitals', patient: p.id });
      continue;
    }
    if (p.esi === null && p.lastVitals) {
      const esi = inDangerZone(p.lastVitals) ? 2 : 4;
      actions.push({ type: 'register', patient: p.id, mode: 'quick' });
      actions.push({ type: 'triage', patient: p.id, esi });
      continue;
    }

    // Room whoever fits.
    if (p.phase === 'waiting-room') {
      const bed = obs.ed.beds.find(
        (b) => b.status === 'clean' && !b.patient && (p.esi! > 2 || b.monitored),
      );
      if (bed) actions.push({ type: 'place_bed', patient: p.id, bed: bed.id });
      continue;
    }

    if (p.phase === 'in-bed') {
      if (!p.assignedNurse) {
        const nurse = obs.ed.nurses.filter((n) => n.onDuty).sort((a, b) => a.assigned.length - b.assigned.length)[0];
        if (nurse) actions.push({ type: 'assign_nurse', patient: p.id, nurse: nurse.id });
      }
      if (!p.assignedProvider) {
        const prov = obs.ed.providers.filter((x) => x.onDuty).sort((a, b) => a.assigned.length - b.assigned.length)[0];
        if (prov) actions.push({ type: 'assign_provider', patient: p.id, provider: prov.id });
      }
      // A generic shotgun workup: cheap to write, and the wrong answer.
      if (p.orders.length === 0) {
        actions.push({ type: 'order_lab', patient: p.id, test: 'cbc', priority: 'stat', route: 'central' });
        actions.push({ type: 'order_lab', patient: p.id, test: 'bmp', priority: 'stat', route: 'poct' });
      }
      // Disposition once anything has resulted.
      if (p.assignedProvider && p.orders.some((o) => o.status === 'resulted') && !p.disposition) {
        actions.push(
          p.esi! <= 2
            ? { type: 'decide_disposition', patient: p.id, disposition: 'admit', level: 'telemetry' }
            : { type: 'decide_disposition', patient: p.id, disposition: 'discharge' },
        );
      }
    }

    // Request the bed only now — far too late, on purpose.
    if (p.disposition === 'admit' && !obs.bedRequests.some((r) => r.patient === p.id)) {
      actions.push({ type: 'request_bed', patient: p.id, level: 'telemetry' });
    }
    if (p.disposition === 'discharge') {
      actions.push({ type: 'dispatch_transport', patient: p.id, tier: 'rideshare', direct: false });
    }
  }

  for (const r of obs.bedRequests) {
    if (r.state === 'offered') actions.push({ type: 'accept_bed_offer', request: r.request });
  }
  for (const h of obs.handoffs) {
    actions.push({ type: 'attempt_handoff', handoff: h.id });
  }
  for (const c of obs.queues.openCriticals) {
    actions.push({ type: 'ack_critical', order: c.order });
  }
  for (const o of obs.patients.flatMap((p) => p.orders)) {
    if (o.rejected) actions.push({ type: 'redraw', order: o.id });
  }

  // Answer by CLAIMED priority. This is the mistake.
  for (const i of obs.interrupts.filter((x) => x.claimedPriority <= 2).slice(0, 3)) {
    actions.push({ type: 'answer_interrupt', interrupt: i.id });
  }

  const res = env.step(actions);
  obs = res.observation;
  done = res.done;
  steps++;

  viz.broadcast(frameOf(env, steps, res));
  if (watch) await sleep(paceMs);
}

const m = env.metrics();
console.log(`\n=== ${scenarioName} (seed=${seed}) — ${steps} steps, ${m.simMinutes} sim minutes ===\n`);
console.log('reward:', JSON.stringify(env.components, null, 2));
console.log('\nmetrics:', JSON.stringify(m, null, 2));
