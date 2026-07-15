import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/mcp/sessions.js';
import { getScenario } from '../src/scenarios/index.js';

const store = () => {
  let c = 1;
  return new SessionStore(mkdtempSync(join(tmpdir(), 'ergym-sess-')), () => (c++ % 997) / 997);
};
const lines = (path: string) => readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('the handshake provisions a per-player .jsonl named <player>_<rand>', () => {
  const h = store().open('claude-opus-4-8', getScenario('ed-baseline'), 's1');
  assert.match(h.id, /^claude-opus-4-8_\d+$/);
  assert.ok(h.dbPath.endsWith(`${h.id}.jsonl`));
  assert.ok(existsSync(h.dbPath));
  const header = lines(h.dbPath)[0];
  assert.equal(header.kind, 'run');
  assert.equal(header.player, 'claude-opus-4-8');
  assert.equal(header.scenario, 'ed-baseline');
});

test('a hostile player name is sanitised into a safe filename', () => {
  const h = store().open('../../etc/passwd; rm -rf', getScenario('ed-baseline'), 's1');
  assert.ok(!h.id.includes('/') && !h.id.includes(' '));
  assert.match(h.id.split('_')[0]!, /^[a-zA-Z0-9._-]+$/);
});

test('two players get isolated sessions and isolated files', () => {
  const s = store();
  const a = s.open('modelA', getScenario('ed-baseline'), 's1');
  const b = s.open('modelB', getScenario('boarding-crisis'), 's2');
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.dbPath, b.dbPath);
  a.env.step([]);
  assert.equal(a.env.now > b.env.now, true);
});

test('get() falls back to the most recent session when id is omitted', () => {
  const s = store();
  s.open('a', getScenario('ed-baseline'), 's1');
  const b = s.open('b', getScenario('ed-baseline'), 's2');
  assert.equal(s.get()?.id, b.id);
  assert.equal(s.get('nope'), null);
});

test('steps and their reward are appended as lines', () => {
  const s = store();
  const h = s.open('m', getScenario('ed-baseline'), 's1');
  for (let i = 0; i < 12; i++) {
    const r = h.env.step([]);
    s.recordStep(h, [], r.results, r.reward, r.components.total, r.info.time, r.info.clock, r.info.newSafetyEvents);
  }
  const steps = lines(h.dbPath).filter((l) => l.kind === 'step');
  assert.equal(steps.length, 12);
  assert.equal(steps[11].step, 12);
  assert.equal(typeof steps[11].cumulative, 'number');
});

test('safety floors are appended as their own lines', () => {
  const s = store();
  const h = s.open('m', getScenario('ed-baseline'), 's1');
  for (let i = 0; i < 5; i++) {
    const r = h.env.step([]);
    s.recordStep(h, [], r.results, r.reward, r.components.total, r.info.time, r.info.clock, r.info.newSafetyEvents);
  }
  const p = [...h.env.patients.values()].find((x) => x.phase !== 'departed');
  if (!p) return;
  p.latent.severity = 0.85;
  p.latent.treatmentProgress = 0;
  p.firstProviderTime = h.env.now;
  const r = h.env.step([{ type: 'decide_disposition', patient: p.id, disposition: 'discharge' }]);
  s.recordStep(h, [], r.results, r.reward, r.components.total, r.info.time, r.info.clock, r.info.newSafetyEvents);
  const floors = lines(h.dbPath).filter((l) => l.kind === 'safety');
  assert.ok(floors.some((f) => f.violation === 'unsafe-destination-discharge'));
});

test('finalize writes a result line + summary.json and is idempotent', () => {
  const s = store();
  const h = s.open('m', getScenario('ed-baseline'), 's1');
  for (let i = 0; i < 8; i++) h.env.step([]);
  s.finalize(h);
  s.finalize(h);
  const results = lines(h.dbPath).filter((l) => l.kind === 'result');
  assert.equal(results.length, 1);
  const summary = JSON.parse(readFileSync(h.dbPath.replace(/\.jsonl$/, '.summary.json'), 'utf8'));
  assert.equal(summary.scenario, 'ed-baseline');
  assert.equal(typeof summary.reward, 'number');
});

test('the record is complete after a full episode', () => {
  const s = store();
  const h = s.open('full', getScenario('ed-baseline'), 's1');
  let done = false;
  while (!done) {
    const r = h.env.step([]);
    s.recordStep(h, [], r.results, r.reward, r.components.total, r.info.time, r.info.clock, r.info.newSafetyEvents);
    done = r.done;
  }
  s.finalize(h);
  const steps = lines(h.dbPath).filter((l) => l.kind === 'step');
  const expected = Math.ceil(h.env.scenario.durationMinutes / h.env.scenario.tickMinutes);
  assert.equal(steps.length, expected);
});
