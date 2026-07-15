import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErEnv } from '../src/gym/env.js';
import { getScenario } from '../src/scenarios/index.js';
import { patientActions, departmentActions } from '../src/gym/legal.js';
import { ActionSchema } from '../src/gym/actions.js';

/**
 * Contextual legal actions — the parity mechanism.
 *
 * The human UI and the AI both consume this list, so it has to (1) only ever
 * surface moves the env will actually accept, and (2) unfold in the right
 * clinical order as a patient progresses, so the workflow is discoverable
 * rather than something each agent must know a priori.
 */

function roomed(e: ErEnv) {
  for (let i = 0; i < 6; i++) e.step([]);
  return [...e.patients.values()].find((p) => p.phase !== 'departed') ?? null;
}

test('a fresh arrival can only be assessed', () => {
  const e = new ErEnv(getScenario('ed-baseline'), 's1');
  const p = roomed(e);
  if (!p) return;
  p.lastVitals = null;
  p.triageTime = null;
  const g = patientActions(e, p).groups.map((x) => x.name);
  assert.deepEqual(g, ['Assess'], 'no triage/room/orders before vitals');
});

test('triage appears only after vitals, placement only after triage', () => {
  const e = new ErEnv(getScenario('ed-baseline'), 's1');
  const p = roomed(e);
  if (!p) return;

  p.lastVitals = { hr: 80, sbp: 120, rr: 16, spo2: 98, temp: 37, gcs: 15 };
  p.lastVitalsTime = e.now;
  assert.ok(patientActions(e, p).groups.some((x) => x.name === 'Triage'));
  assert.ok(!patientActions(e, p).groups.some((x) => x.name === 'Place in bed'), 'cannot room before triage');

  e.step([{ type: 'register', patient: p.id, mode: 'quick' }, { type: 'triage', patient: p.id, esi: 3 }]);
  assert.ok(patientActions(e, p).groups.some((x) => x.name === 'Place in bed'), 'rooming unlocks after triage');
});

test('orders and disposition unlock only after a provider is assigned', () => {
  const e = new ErEnv(getScenario('ed-baseline'), 's1');
  const p = roomed(e);
  if (!p) return;
  p.lastVitals = { hr: 80, sbp: 120, rr: 16, spo2: 98, temp: 37, gcs: 15 };
  p.lastVitalsTime = e.now;
  e.step([{ type: 'triage', patient: p.id, esi: 3 }]);
  const bed = e.ed.availableBeds({ isolation: p.isolation, needsMonitor: false })[0]!;
  e.step([{ type: 'place_bed', patient: p.id, bed: bed.id }]);

  assert.equal(patientActions(e, p).orderMenus.length, 0, 'no orders before a provider');
  e.step([{ type: 'assign_provider', patient: p.id, provider: 'md-1' }]);
  const pa = patientActions(e, p);
  assert.equal(pa.orderMenus.length, 4, 'lab/imaging/med/consult menus appear');
  assert.ok(pa.groups.some((g) => g.name === 'Disposition'));
});

test('every surfaced action is one the env accepts (or refuses cleanly)', () => {
  const e = new ErEnv(getScenario('ed-baseline'), 's1');
  for (let i = 0; i < 10; i++) e.step([]);
  for (const p of e.patients.values()) {
    if (p.phase === 'departed') continue;
    for (const g of patientActions(e, p).groups) {
      for (const b of g.buttons) {
        // The action must at least be schema-valid — the UI never emits garbage.
        assert.doesNotThrow(() => ActionSchema.parse(b.action), `invalid action for ${p.id}: ${JSON.stringify(b.action)}`);
      }
    }
  }
});

test('placement options are real clean beds', () => {
  const e = new ErEnv(getScenario('ed-baseline'), 's1');
  const p = roomed(e);
  if (!p) return;
  p.lastVitals = { hr: 80, sbp: 120, rr: 16, spo2: 98, temp: 37, gcs: 15 };
  p.lastVitalsTime = e.now;
  e.step([{ type: 'triage', patient: p.id, esi: 4 }]);
  const beds = patientActions(e, p).groups.find((g) => g.name === 'Place in bed')?.buttons ?? [];
  for (const b of beds) {
    const bedId = (b.action as { bed: string }).bed;
    assert.equal(e.ed.bed(bedId)?.status, 'clean', `${bedId} offered but not clean`);
  }
});

test('department actions surface pending interrupts and the house controls', () => {
  const e = new ErEnv(getScenario('ed-baseline'), 's1');
  for (let i = 0; i < 20; i++) e.step([]);
  const dept = departmentActions(e);
  assert.ok(dept.some((g) => g.name === 'House'), 'house controls always present');
  for (const g of dept) for (const b of g.buttons) assert.doesNotThrow(() => ActionSchema.parse(b.action));
});
