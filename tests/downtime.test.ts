import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErEnv } from '../src/gym/env.js';
import { getScenario, degraded, SCENARIOS } from '../src/scenarios/index.js';

/**
 * IT downtime.
 *
 * This is the condition under which an over-trusting agent fails
 * catastrophically, so it gets its own tests. The two properties that matter:
 * a silent outage does not announce itself, and a dead feed is distinguishable
 * from a feed with nothing to report ONLY by noticing it has gone quiet.
 */

function envAt(minute: number) {
  const spec = degraded(SCENARIOS['ed-baseline']!());
  const env = new ErEnv(spec, 'downtime-seed');
  while (env.now < minute) env.step([]);
  return env;
}

test('the degraded variant declares downtime windows', () => {
  const spec = getScenario('ed-baseline-degraded-integrations');
  assert.ok(spec.registry.ambient.downtime.length > 0);
  assert.ok(spec.registry.ambient.downtime.some((w) => w.silent), 'needs at least one silent outage');
});

test('a silent outage does not announce itself', () => {
  // Window 1: starts at 120min, silent, partial.
  const env = envAt(150);
  const obs = env.observe();
  assert.equal(obs.itDowntime, null, 'a silent outage must not set itDowntime — that is the whole test');
  // But it IS degrading the feed underneath.
  for (const d of obs.downstream) {
    assert.ok(d.staleness >= 45, 'a silent partial outage must still inflate staleness');
  }
});

test('a non-silent full outage announces itself and kills the capacity feeds', () => {
  // Window 2: starts at 420min, not silent, full.
  const env = envAt(440);
  const obs = env.observe();
  assert.deepEqual(obs.itDowntime, { severity: 'full' });
  assert.equal(obs.downstream.length, 0, 'a full outage means you cannot see capacity at all');
  assert.equal(obs.supply.length, 0);
});

test('a full outage freezes the order board; the world moves on underneath', () => {
  // Place the order BEFORE the outage opens at t=420, so it is in the frozen
  // snapshot. Then let it result while the feed is dead.
  const env = envAt(410);

  // Room a patient properly so they will not LWBS out from under the test.
  const p = [...env.patients.values()].find((x) => x.phase !== 'departed');
  assert.ok(p, 'need a live patient');
  p!.phase = 'in-bed';
  p!.firstProviderTime = env.now;

  // A slow central CBC: still in flight when the feed dies at t=420, resulting
  // while the board is frozen.
  env.step([{ type: 'order_lab', patient: p!.id, test: 'cbc', priority: 'stat', route: 'central' }]);
  const orderId = p!.orders[p!.orders.length - 1]!;
  const statusBefore = env.orders.get(orderId)!.status;

  // Cross into the outage window and let the POCT glucose land.
  while (env.now < 445) {
    env.step([]);
    p!.phase = 'in-bed'; // hold them in the department for the duration
  }

  const truth = env.orders.get(orderId)!;
  const seen = env
    .observe()
    .patients.find((x) => x.id === p!.id)
    ?.orders.find((o) => o.id === orderId);

  assert.ok(seen, 'order must still be listed during an outage');
  assert.equal(env.observe().itDowntime?.severity, 'full', 'test must actually be inside the outage');
  // The order really did advance underneath. The agent still sees the old board.
  assert.notEqual(truth.status, statusBefore, 'the world must have moved on');
  assert.equal(seen!.status, statusBefore, 'a frozen board must show the pre-outage status');
});

test('the board reconciles on recovery', () => {
  // Window 2 runs 420-465. By 500 the feed is back.
  const env = envAt(500);
  const obs = env.observe();
  assert.equal(obs.itDowntime, null);
  assert.ok(obs.downstream.length > 0, 'feeds must come back after the window closes');
  assert.ok(obs.supply.length > 0);
  for (const d of obs.downstream) {
    assert.ok(d.staleness < 45, 'staleness must return to normal after recovery');
  }
});

test('downtime does not break determinism', () => {
  const run = () => {
    const env = new ErEnv(degraded(SCENARIOS['ed-baseline']!()), 'dt-det');
    for (let i = 0; i < 100; i++) env.step([]);
    return env.metrics();
  };
  assert.deepEqual(run(), run());
});
