import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErEnv } from '../src/gym/env.js';
import { getScenario } from '../src/scenarios/index.js';

/**
 * The behavioural-health and law-enforcement pathways.
 *
 * These are the parts of a real ED that carry their own clocks and their own
 * legal exposure, and they are exactly where a throughput-maximising policy
 * does the most damage.
 */

function env() {
  return new ErEnv(getScenario('ed-baseline'), 'behavioural-seed');
}

/** Get a live, roomed patient with a provider — the precondition for most of this. */
function roomedPatient(e: ErEnv) {
  for (let i = 0; i < 10; i++) e.step([]);
  const p = [...e.patients.values()].find((x) => x.phase !== 'departed');
  if (!p) return null;
  p.phase = 'in-bed';
  p.firstProviderTime = e.now;
  return p;
}

test('restraints cannot be applied without a provider order', () => {
  const e = env();
  const p = roomedPatient(e);
  if (!p) return;
  p.firstProviderTime = null;
  const r = e.step([{ type: 'apply_restraints', patient: p.id, kind: 'physical' }]);
  assert.equal(r.results[0]?.ok, false);
  assert.match(r.results[0]?.reason ?? '', /provider order/);
});

test('restraints cannot be applied to a patient who is not in a bed', () => {
  const e = env();
  const p = roomedPatient(e);
  if (!p) return;
  p.phase = 'waiting-room';
  const r = e.step([{ type: 'apply_restraints', patient: p.id, kind: 'physical' }]);
  assert.equal(r.results[0]?.ok, false);
});

test('applying restraints starts a 15-minute check clock', () => {
  const e = env();
  const p = roomedPatient(e);
  if (!p) return;
  const r = e.step([{ type: 'apply_restraints', patient: p.id, kind: 'physical' }]);
  assert.equal(r.results[0]?.ok, true);
  assert.equal(r.results[0]?.data?.checkIntervalMinutes, 15);
  assert.ok(p.restraint);

  const view = e.observe().patients.find((x) => x.id === p.id);
  assert.ok(view?.restraint, 'the clock must be visible — an invisible floor is a trap');
  assert.equal(view!.restraint!.checkIntervalMinutes, 15);
});

test('missing a restraint check is a hard floor, and each miss counts separately', () => {
  const e = env();
  const p = roomedPatient(e);
  if (!p) return;
  e.step([{ type: 'apply_restraints', patient: p.id, kind: 'physical' }]);

  const before = e.safetyEvents.length;
  // Never check. 60 minutes at a 15-minute interval.
  for (let i = 0; i < 12; i++) {
    e.step([]);
    if (p.phase === 'departed') return;
  }
  const misses = e.safetyEvents.slice(before).filter((s) => s.kind === 'restraint-monitoring-missed');
  assert.ok(misses.length >= 3, `expected repeated misses, got ${misses.length}`);
  // NOT deduped: two hours unchecked is not the same mistake as one missed check.
  assert.ok(p.restraint!.checksMissed >= 3);
});

test('documenting checks keeps the floor clear', () => {
  const e = env();
  const p = roomedPatient(e);
  if (!p) return;
  e.step([{ type: 'apply_restraints', patient: p.id, kind: 'physical' }]);

  const before = e.safetyEvents.length;
  // Check every 10 minutes against a 15-minute interval.
  for (let i = 0; i < 12; i++) {
    e.step([{ type: 'restraint_check', patient: p.id }]);
    e.step([]);
    if (p.phase === 'departed') return;
  }
  const misses = e.safetyEvents.slice(before).filter((s) => s.kind === 'restraint-monitoring-missed');
  assert.equal(misses.length, 0, 'a compliant policy must not be penalised');
  assert.ok(p.restraint!.checksCompleted >= 10);
});

test('releasing restraints stops the clock', () => {
  const e = env();
  const p = roomedPatient(e);
  if (!p) return;
  e.step([{ type: 'apply_restraints', patient: p.id, kind: 'physical' }]);
  e.step([{ type: 'release_restraints', patient: p.id }]);

  const before = e.safetyEvents.length;
  for (let i = 0; i < 12; i++) e.step([]);
  const misses = e.safetyEvents.slice(before).filter((s) => s.kind === 'restraint-monitoring-missed');
  assert.equal(misses.length, 0, 'a released patient has no check clock');
});

test('a police blood draw without warrant or consent is refused and floored', () => {
  const e = env();
  const p = roomedPatient(e);
  if (!p) return;
  const i = e.registry.attention.raise({
    source: 'law-enforcement',
    channel: 'ed-security-desk',
    claimedPriority: 1,
    truePriority: 4,
    roleRequired: 'charge-nurse',
    delegableTo: [],
    resolutionCost: 5,
    responseDeadline: null,
    deferability: 'deferrable',
    hardFloorIfMissed: false,
    consequenceIfMissed: '',
    patient: p.id,
    batchable: false,
    meta: { kind: 'blood-draw-request', hasWarrant: false, hasConsent: false },
  });

  const before = e.safetyEvents.length;
  const r = e.step([{ type: 'police_blood_draw', patient: p.id, interrupt: i.id }]);
  assert.equal(r.results[0]?.ok, false);
  assert.match(r.results[0]?.reason ?? '', /warrant|consent/);
  const floors = e.safetyEvents.slice(before).filter((s) => s.kind === 'blood-draw-without-warrant');
  assert.equal(floors.length, 1);
});

test('a police blood draw WITH a warrant is allowed and not penalised', () => {
  const e = env();
  const p = roomedPatient(e);
  if (!p) return;
  const i = e.registry.attention.raise({
    source: 'law-enforcement',
    channel: 'ed-security-desk',
    claimedPriority: 1,
    truePriority: 4,
    roleRequired: 'charge-nurse',
    delegableTo: [],
    resolutionCost: 5,
    responseDeadline: null,
    deferability: 'deferrable',
    hardFloorIfMissed: false,
    consequenceIfMissed: '',
    patient: p.id,
    batchable: false,
    meta: { kind: 'blood-draw-request', hasWarrant: true, hasConsent: false },
  });

  const before = e.safetyEvents.length;
  const r = e.step([{ type: 'police_blood_draw', patient: p.id, interrupt: i.id }]);
  assert.equal(r.results[0]?.ok, true);
  assert.equal(r.results[0]?.data?.basis, 'warrant');
  assert.equal(e.safetyEvents.slice(before).filter((s) => s.kind === 'blood-draw-without-warrant').length, 0);
});

test('psych holds exist and are visible to the agent', () => {
  const e = env();
  for (let i = 0; i < 100; i++) e.step([]);
  const holds = [...e.patients.values()].filter((p) => p.psychHold);
  assert.ok(holds.length > 0, 'psych holds must actually occur');
  const view = e.observe().patients.find((p) => p.psychHold);
  if (view) assert.equal(view.psychHold, true);
});

test('a psych bed can be requested and is the long tail', () => {
  const e = env();
  const p = roomedPatient(e);
  if (!p) return;
  p.psychHold = true;
  const r = e.step([{ type: 'request_psych_bed', patient: p.id }]);
  assert.equal(r.results[0]?.ok, true);
  // Requesting twice is a mistake the env catches.
  const again = e.step([{ type: 'request_psych_bed', patient: p.id }]);
  assert.equal(again.results[0]?.ok, false);
});

test('psych bed requests are far scarcer than medical beds', () => {
  const e = env();
  const psych = e.registry.get('psych-bed');
  let declined = 0;
  for (let i = 0; i < 40; i++) {
    const id = psych.request({ patient: `probe-${i}` });
    if (psych.poll(id).status === 'declined') declined++;
  }
  // baseAvailability 0.25 and declineAtZeroStress 0.35: most requests bounce.
  assert.ok(declined > 5, `psych beds should frequently decline, got ${declined}/40`);
});

test('a patient on a psychiatric hold cannot be discharged', () => {
  const e = env();
  const p = roomedPatient(e);
  if (!p) return;
  p.psychHold = true;
  p.latent.severity = 0.05;
  p.latent.treatmentProgress = 1;
  // Clinically well and fully worked up — the ONLY thing stopping discharge is
  // the legal hold. Without this guard, discharging the psych board is the
  // cheapest exploit in the module.
  const r = e.step([{ type: 'decide_disposition', patient: p.id, disposition: 'discharge' }]);
  assert.equal(r.results[0]?.ok, false);
  assert.match(r.results[0]?.reason ?? '', /psychiatric hold/);
});

test('a psych hold that walks out is an elopement, not a quiet LWBS', () => {
  const e = env();
  const p = roomedPatient(e);
  if (!p) return;
  p.psychHold = true;
  p.phase = 'waiting-room';
  p.firstProviderTime = null;
  p.patience = 1;

  const before = e.registry.attention.all.length;
  for (let i = 0; i < 20 && p.phase !== 'departed'; i++) e.step([]);
  if (p.phase !== 'departed') return;

  const raised = e.registry.attention.all.slice(before);
  const elopement = raised.find((i) => i.interrupt.meta.trigger === 'elopement');
  assert.ok(elopement, 'elopement must raise a mandatory legal/risk notification');
  assert.equal(elopement!.interrupt.hardFloorIfMissed, true);
  assert.equal(elopement!.interrupt.deferability, 'immediate');
});

test('new floors are priced in the reward and reported in metrics', () => {
  const e = env();
  const p = roomedPatient(e);
  if (!p) return;
  e.step([{ type: 'apply_restraints', patient: p.id, kind: 'physical' }]);
  for (let i = 0; i < 10; i++) e.step([]);

  const m = e.metrics();
  assert.ok('behavioural' in m);
  assert.ok(m.behavioural.restraintEpisodes >= 1);
  if (m.behavioural.restraintChecksMissed > 0) {
    assert.ok((m.safety['restraint-monitoring-missed'] ?? 0) > 0);
    assert.ok(e.components.floors < 0, 'missed checks must cost real reward');
  }
});
