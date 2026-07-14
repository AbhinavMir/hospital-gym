import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErEnv } from '../src/gym/env.js';
import { getScenario } from '../src/scenarios/index.js';
import { Rng } from '../src/kernel/rng.js';
import { Engine } from '../src/kernel/engine.js';

/**
 * Determinism is a benchmark requirement, not a nice-to-have. If the same
 * (scenario, seed, action sequence) can produce two different episodes, then
 * two policies' scores are not comparable and the whole thing measures noise.
 */

function runEpisode(seed: string, steps = 40): { obs: unknown; reward: number } {
  const env = new ErEnv(getScenario('ed-baseline'), seed);
  let reward = 0;
  for (let i = 0; i < steps; i++) {
    // A fixed, non-trivial action sequence: measure everyone, then let time pass.
    const obs = env.observe();
    const actions = obs.patients
      .filter((p) => p.lastVitals === null)
      .slice(0, 3)
      .map((p) => ({ type: 'measure_vitals' as const, patient: p.id }));
    reward += env.step(actions).reward;
  }
  return { obs: env.observe(), reward };
}

test('same seed and actions reproduce the episode exactly', () => {
  const a = runEpisode('seed-alpha');
  const b = runEpisode('seed-alpha');
  assert.equal(a.reward, b.reward, 'cumulative reward diverged');
  assert.deepEqual(a.obs, b.obs, 'final observation diverged');
});

test('different seeds produce different episodes', () => {
  const a = runEpisode('seed-alpha');
  const b = runEpisode('seed-beta');
  assert.notDeepEqual(a.obs, b.obs, 'two seeds produced an identical episode');
});

test('metrics are reproducible across runs', () => {
  const run = (seed: string) => {
    const env = new ErEnv(getScenario('boarding-crisis'), seed);
    for (let i = 0; i < 30; i++) env.step([]);
    return env.metrics();
  };
  assert.deepEqual(run('m1'), run('m1'));
});

test('Rng is reproducible and forks are independent', () => {
  const a = new Rng('x');
  const b = new Rng('x');
  const seqA = Array.from({ length: 50 }, () => a.next());
  const seqB = Array.from({ length: 50 }, () => b.next());
  assert.deepEqual(seqA, seqB);

  // Different labels must yield independent child streams, so that two
  // subsystems forked from the same parent do not draw in lockstep.
  const p1 = new Rng('parent');
  const childA = p1.fork('sub-a');
  const p2 = new Rng('parent');
  const childB = p2.fork('sub-b');
  assert.notEqual(childA.next(), childB.next(), 'different fork labels produced the same stream');

  // The same label against the same parent state must reproduce exactly.
  const f1 = new Rng('p').fork('same');
  const f2 = new Rng('p').fork('same');
  assert.equal(f1.next(), f2.next(), 'identical fork labels diverged');

  // A fork consumes exactly one parent draw regardless of its label. This is
  // what lets subsystems be forked in a fixed order at construction and stay
  // reproducible — renaming a subsystem must not reshuffle the others.
  const q1 = new Rng('parent');
  q1.fork('name-one');
  const q2 = new Rng('parent');
  q2.fork('a-totally-different-name');
  assert.equal(q1.next(), q2.next(), 'fork label must not perturb the parent stream');
});

test('engine fires same-instant events in scheduling order', () => {
  const e = new Engine();
  const order: number[] = [];
  e.schedule(10, 'c', () => order.push(3));
  e.schedule(5, 'a', () => order.push(1));
  e.schedule(5, 'b', () => order.push(2));
  e.runUntil(20);
  // 1 and 2 are both at t=5; insertion order must break the tie, not heap order.
  assert.deepEqual(order, [1, 2, 3]);
  assert.equal(e.now, 20, 'clock must land exactly on the requested time');
});

test('engine honours cancellation', () => {
  const e = new Engine();
  let fired = false;
  const t = e.schedule(5, 'x', () => {
    fired = true;
  });
  t.cancel();
  e.runUntil(10);
  assert.equal(fired, false);
});
