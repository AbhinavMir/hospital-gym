import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/mcp/sessions.js';
import { getScenario } from '../src/scenarios/index.js';

const store = () => {
  let c = 1;
  return new SessionStore(mkdtempSync(join(tmpdir(), 'ergym-sess-')), () => (c++ % 997) / 997);
};

test('the handshake provisions a per-model sqlite file named <model>_<rand>', () => {
  const s = store();
  const h = s.open('claude-opus-4-8', getScenario('ed-baseline'), 's1');
  assert.match(h.id, /^claude-opus-4-8_\d+$/);
  assert.ok(h.dbPath.endsWith(`${h.id}.sqlite`));
  assert.ok(existsSync(h.dbPath));
  const run = new Database(h.dbPath, { readonly: true }).prepare('select model,scenario,seed from run').get() as any;
  assert.equal(run.model, 'claude-opus-4-8');
  assert.equal(run.scenario, 'ed-baseline');
});

test('a hostile model name is sanitised into a safe filename', () => {
  const s = store();
  const h = s.open('../../etc/passwd; rm -rf', getScenario('ed-baseline'), 's1');
  // No slashes, no spaces, no shell metacharacters survive into the path.
  assert.ok(!h.id.includes('/'));
  assert.ok(!h.id.includes(' '));
  assert.match(h.id.split('_')[0]!, /^[a-zA-Z0-9._-]+$/);
});

test('two models get isolated sessions and isolated files', () => {
  const s = store();
  const a = s.open('modelA', getScenario('ed-baseline'), 's1');
  const b = s.open('modelB', getScenario('boarding-crisis'), 's2');
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.dbPath, b.dbPath);
  assert.notEqual(a.env, b.env);
  // Stepping one must not touch the other.
  a.env.step([]);
  assert.equal(a.env.now > b.env.now, true);
});

test('get() falls back to the most recent session when id is omitted', () => {
  const s = store();
  s.open('a', getScenario('ed-baseline'), 's1');
  const b = s.open('b', getScenario('ed-baseline'), 's2');
  assert.equal(s.get()?.id, b.id, 'omitted id resolves to the last-opened run');
  assert.equal(s.get('nope'), null);
});

test('steps and their reward land in the run record', () => {
  const s = store();
  const h = s.open('m', getScenario('ed-baseline'), 's1');
  for (let i = 0; i < 12; i++) {
    const r = h.env.step([]);
    s.recordStep(h, [], r.results, r.reward, r.components.total, r.info.time, r.info.clock, r.info.newSafetyEvents);
  }
  const db = new Database(h.dbPath, { readonly: true });
  const n = (db.prepare('select count(*) c from step').get() as any).c;
  assert.equal(n, 12);
  const last = db.prepare('select step, cumulative from step order by step desc limit 1').get() as any;
  assert.equal(last.step, 12);
  assert.equal(typeof last.cumulative, 'number');
});

test('safety floors are captured as rows', () => {
  const s = store();
  const h = s.open('m', getScenario('ed-baseline'), 's1');
  for (let i = 0; i < 5; i++) {
    const r = h.env.step([]);
    s.recordStep(h, [], r.results, r.reward, r.components.total, r.info.time, r.info.clock, r.info.newSafetyEvents);
  }
  // Force a floor: discharge a sick patient.
  const p = [...h.env.patients.values()].find((x) => x.phase !== 'departed');
  if (p) {
    p.latent.severity = 0.85;
    p.latent.treatmentProgress = 0;
    p.firstProviderTime = h.env.now;
    const r = h.env.step([{ type: 'decide_disposition', patient: p.id, disposition: 'discharge' }]);
    s.recordStep(h, [], r.results, r.reward, r.components.total, r.info.time, r.info.clock, r.info.newSafetyEvents);
  }
  const db = new Database(h.dbPath, { readonly: true });
  const kinds = db.prepare('select distinct kind from safety').all() as { kind: string }[];
  if (p) assert.ok(kinds.some((k) => k.kind === 'unsafe-destination-discharge'));
});

test('finalize writes the scorecard and is idempotent', () => {
  const s = store();
  const h = s.open('m', getScenario('ed-baseline'), 's1');
  for (let i = 0; i < 8; i++) h.env.step([]);
  s.finalize(h);
  s.finalize(h); // second call must not throw or duplicate
  const db = new Database(h.dbPath, { readonly: true });
  const rows = (db.prepare('select count(*) c from result').get() as any).c;
  assert.equal(rows, 1);
  const res = db.prepare('select reward, metrics from result').get() as any;
  assert.equal(typeof res.reward, 'number');
  assert.ok(JSON.parse(res.metrics).scenario === 'ed-baseline');
  const run = db.prepare('select finalized from run').get() as any;
  assert.equal(run.finalized, 1);
});

test('the run record is complete after a full episode', () => {
  const s = store();
  const h = s.open('full', getScenario('ed-baseline'), 's1');
  let done = false;
  while (!done) {
    const r = h.env.step([]);
    s.recordStep(h, [], r.results, r.reward, r.components.total, r.info.time, r.info.clock, r.info.newSafetyEvents);
    done = r.done;
  }
  s.finalize(h);
  const db = new Database(h.dbPath, { readonly: true });
  const steps = (db.prepare('select count(*) c from step').get() as any).c;
  const expected = Math.ceil(h.env.scenario.durationMinutes / h.env.scenario.tickMinutes);
  assert.equal(steps, expected, 'every step of the shift must be recorded');
});
