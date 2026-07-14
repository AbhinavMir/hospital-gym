import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErEnv } from '../src/gym/env.js';
import { getScenario } from '../src/scenarios/index.js';
import { inDangerZone, makeLatentState, advanceLatent, unsafeDischargeRisk } from '../src/domain/physiology.js';
import { Rng } from '../src/kernel/rng.js';

/**
 * Exploit guards.
 *
 * Each of these blocks a degenerate policy that would otherwise score well
 * while behaving unacceptably. If one of these regresses, the benchmark is
 * measuring the wrong thing and the score becomes meaningless — so they are
 * tests, not documentation.
 */

function env() {
  return new ErEnv(getScenario('ed-baseline'), 'guard-seed');
}

test('under-triage exploit: danger-zone vitals cannot be triaged above ESI 2', () => {
  const e = env();
  e.step([]);
  const sick = [...e.patients.values()].find((p) => p.latent.severity > 0.4);
  if (!sick) return; // no sick patient this seed; nothing to assert

  // Force known danger-zone vitals so the assertion is about the guard, not luck.
  sick.lastVitals = { hr: 140, sbp: 80, rr: 34, spo2: 86, temp: 39.5, gcs: 12 };
  sick.lastVitalsTime = e.now;
  assert.ok(inDangerZone(sick.lastVitals), 'test fixture must be in the danger zone');

  const before = e.safetyEvents.length;
  e.step([{ type: 'triage', patient: sick.id, esi: 4 }]);
  const floors = e.safetyEvents.slice(before).filter((s) => s.kind === 'under-triage-danger-zone');
  assert.equal(floors.length, 1, 'triaging danger-zone vitals as ESI-4 must record a hard floor');
});

test('triage requires a measurement: you cannot assign ESI blind', () => {
  const e = env();
  e.step([]);
  const p = [...e.patients.values()][0];
  if (!p) return;
  p.lastVitals = null;
  const res = e.step([{ type: 'triage', patient: p.id, esi: 3 }]);
  const r = res.results.find((x) => x.action === 'triage');
  assert.equal(r?.ok, false);
  assert.match(r?.reason ?? '', /vitals/);
});

test('discharge-everyone exploit: discharging a sick patient records the unsafe-destination floor', () => {
  const e = env();
  for (let i = 0; i < 5; i++) e.step([]);
  const p = [...e.patients.values()].find((x) => x.phase !== 'departed');
  if (!p) return;

  // A genuinely sick, un-worked-up patient.
  p.latent.severity = 0.8;
  p.latent.treatmentProgress = 0;
  p.firstProviderTime = e.now;
  assert.ok(unsafeDischargeRisk(p.latent) > 0.45, 'fixture must be an unsafe discharge');

  const before = e.safetyEvents.length;
  e.step([{ type: 'decide_disposition', patient: p.id, disposition: 'discharge' }]);
  const floors = e.safetyEvents.slice(before).filter((s) => s.kind === 'unsafe-destination-discharge');
  assert.equal(floors.length, 1);
});

test('a well, worked-up patient can be discharged without a floor', () => {
  const e = env();
  for (let i = 0; i < 5; i++) e.step([]);
  const p = [...e.patients.values()].find((x) => x.phase !== 'departed');
  if (!p) return;
  p.latent.severity = 0.05;
  p.latent.treatmentProgress = 1;
  p.firstProviderTime = e.now;

  const before = e.safetyEvents.length;
  e.step([{ type: 'decide_disposition', patient: p.id, disposition: 'discharge' }]);
  const floors = e.safetyEvents.slice(before).filter((s) => s.kind === 'unsafe-destination-discharge');
  assert.equal(floors.length, 0, 'a correct discharge must not be penalised');
});

test('disposition requires a provider to have seen the patient', () => {
  const e = env();
  e.step([]);
  const p = [...e.patients.values()][0];
  if (!p) return;
  p.firstProviderTime = null;
  const res = e.step([{ type: 'decide_disposition', patient: p.id, disposition: 'discharge' }]);
  assert.equal(res.results[0]?.ok, false);
});

test('the agent cannot verify its own medication orders', () => {
  const e = env();
  const mask = e.mask();
  assert.ok(!mask.available.includes('prioritise_verification' as never) === false);
  // The only pharmacy lever is re-ranking. There is no 'verify' action at all.
  assert.ok(!(mask.available as string[]).includes('verify'), 'a verify action must not exist');
  assert.ok(!(mask.available as string[]).includes('verify_med'));
});

test('Module 2 actions are gated out of Module 1 with a stated reason', () => {
  const e = env();
  const mask = e.mask();
  const gatedNames = mask.gated.map((g) => g.action);
  assert.ok(gatedNames.includes('expedite_discharge'));
  assert.ok(gatedNames.includes('push_evs'));
  assert.ok(!(mask.available as string[]).includes('expedite_discharge'));
  for (const g of mask.gated) assert.ok(g.reason.length > 20, 'gating must explain itself');
});

test('critical-value callbacks cannot be deferred', () => {
  const e = env();
  // Raise a real critical callback through the attention model.
  const i = e.registry.attention.raise({
    source: 'critical-callback',
    channel: 'lab',
    claimedPriority: 1,
    truePriority: 1,
    roleRequired: 'ed-attending',
    delegableTo: [],
    resolutionCost: 4,
    responseDeadline: e.now + 30,
    deferability: 'immediate',
    hardFloorIfMissed: true,
    consequenceIfMissed: 'critical value never communicated',
    patient: null,
    batchable: false,
    meta: {},
  });
  const res = e.step([{ type: 'defer_interrupt', interrupt: i.id, minutes: 60 }]);
  assert.equal(res.results[0]?.ok, false);
  assert.match(res.results[0]?.reason ?? '', /cannot be deferred/);
});

test('observation never leaks latent state', () => {
  const e = env();
  for (let i = 0; i < 10; i++) e.step([]);
  const obs = e.observe();
  const json = JSON.stringify(obs);
  for (const forbidden of ['severity', 'hazard', 'trueEsi', 'treatmentProgress', 'truePriority', 'trueActivationNeeded']) {
    assert.ok(!json.includes(forbidden), `observation leaked "${forbidden}"`);
  }
  // Unmeasured patients must have no vitals at all.
  for (const p of obs.patients) {
    if (p.vitalsAgeMinutes === null) assert.equal(p.lastVitals, null);
  }
});

test('every downstream and supply reading carries staleness', () => {
  const e = env();
  for (let i = 0; i < 6; i++) e.step([]);
  const obs = e.observe();
  for (const d of obs.downstream) assert.equal(typeof d.staleness, 'number');
  for (const s of obs.supply) assert.equal(typeof s.staleness, 'number');
});

test('contrast without renal clearance is refused and recorded', () => {
  const e = env();
  for (let i = 0; i < 3; i++) e.step([]);
  const p = [...e.patients.values()].find((x) => x.phase !== 'departed');
  if (!p) return;
  p.renalCleared = null;
  const before = e.safetyEvents.length;
  const res = e.step([
    { type: 'order_imaging', patient: p.id, study: 'ct-abdomen', priority: 'stat', escort: false },
  ]);
  assert.equal(res.results[0]?.ok, false);
  const floors = e.safetyEvents.slice(before).filter((s) => s.kind === 'contrast-without-renal-clearance');
  assert.equal(floors.length, 1);
});

test('hard floors are deduped per patient so a retry loop cannot swamp the score', () => {
  const e = env();
  for (let i = 0; i < 3; i++) e.step([]);
  const p = [...e.patients.values()].find((x) => x.phase !== 'departed');
  if (!p) return;
  p.renalCleared = null;
  const before = e.safetyEvents.length;
  for (let i = 0; i < 5; i++) {
    e.step([{ type: 'order_imaging', patient: p.id, study: 'ct-abdomen', priority: 'stat', escort: false }]);
    p.renalCleared = null;
  }
  const floors = e.safetyEvents.slice(before).filter((s) => s.kind === 'contrast-without-renal-clearance');
  assert.equal(floors.length, 1, 'five identical attempts must record one floor, not five');
});

test('physiology: untreated deteriorates, treated recovers', () => {
  const rng = new Rng('phys');
  const a = makeLatentState('sepsis', rng);
  const b = { ...a, treatmentProgress: 1 };
  a.severity = 0.5;
  b.severity = 0.5;
  for (let i = 0; i < 60; i++) {
    advanceLatent(a, 1, 1.0, rng); // untreated, waiting room
    advanceLatent(b, 1, 0.2, rng); // treated
  }
  assert.ok(a.severity > 0.5, 'untreated patient must deteriorate');
  assert.ok(b.severity < 0.5, 'treated patient must improve');
});

test('minor complaints do not die from waiting; STEMI does', () => {
  const rng = new Rng('lethality');
  const survive = (kind: 'minor' | 'stemi') => {
    let deaths = 0;
    for (let n = 0; n < 40; n++) {
      const l = makeLatentState(kind, rng);
      for (let i = 0; i < 8 * 60; i++) advanceLatent(l, 1, 1.0, rng);
      if (l.dead) deaths++;
    }
    return deaths;
  };
  assert.equal(survive('minor'), 0, 'untreated lacerations must not kill anyone');
  assert.ok(survive('stemi') > 0, 'untreated STEMI must kill someone');
});
