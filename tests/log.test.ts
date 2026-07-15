import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger, NULL_LOGGER } from '../src/kernel/log.js';
import { ErEnv } from '../src/gym/env.js';
import { getScenario } from '../src/scenarios/index.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'ergym-log-'));

test('writes JSONL, one parseable event per line', () => {
  const dir = tmp();
  const log = new Logger({ runId: 'r1', dir, toFile: true });
  log.emit({ t: 1, clock: '07:01', step: 0, kind: 'note', level: 'info', msg: 'hello' });
  log.emit({ t: 2, clock: '07:02', step: 0, kind: 'note', level: 'info', msg: 'world' });
  log.flush();

  const lines = readFileSync(log.path!, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]!).msg, 'hello');
  assert.equal(JSON.parse(lines[1]!).clock, '07:02');
});

test('close writes a run summary next to the event log', () => {
  const dir = tmp();
  const log = new Logger({ runId: 'r2', dir, toFile: true });
  log.emit({ t: 0, clock: '07:00', step: 0, kind: 'episode.start', level: 'info' });
  const p = log.close({ scenario: 'ed-baseline', deaths: 3 });
  assert.ok(p && existsSync(p));
  const s = JSON.parse(readFileSync(p, 'utf8'));
  assert.equal(s.runId, 'r2');
  assert.equal(s.scenario, 'ed-baseline');
  assert.equal(s.eventCounts['episode.start'], 1);
});

test('level filtering drops events below the threshold', () => {
  const log = new Logger({ runId: 'r3', level: 'warn' });
  log.emit({ t: 0, clock: '-', step: 0, kind: 'note', level: 'debug' });
  log.emit({ t: 0, clock: '-', step: 0, kind: 'note', level: 'info' });
  log.emit({ t: 0, clock: '-', step: 0, kind: 'safety', level: 'error' });
  assert.equal(log.events.length, 1);
  assert.equal(log.events[0]!.level, 'error');
});

test('the ring buffer is bounded', () => {
  const log = new Logger({ runId: 'r4', ringSize: 10 });
  for (let i = 0; i < 100; i++) {
    log.emit({ t: i, clock: '-', step: 0, kind: 'note', level: 'info', msg: String(i) });
  }
  assert.equal(log.events.length, 10);
  assert.equal(log.events[9]!.msg, '99', 'must keep the newest, not the oldest');
});

test('NULL_LOGGER swallows everything and costs nothing', () => {
  assert.doesNotThrow(() => {
    NULL_LOGGER.emit({ t: 0, clock: '-', step: 0, kind: 'note', level: 'error' });
    NULL_LOGGER.flush();
  });
  assert.equal(NULL_LOGGER.events.length, 0);
  assert.equal(NULL_LOGGER.close({}), null);
});

test('an episode logs the events that matter', () => {
  // debug level: `step` and `stress` are per-tick diagnostics and are correctly
  // filtered out at the default `info` level.
  const log = new Logger({ runId: 'ep', ringSize: 100_000, level: 'debug' });
  const env = new ErEnv(getScenario('ed-baseline'), 'log-episode', log);
  for (let i = 0; i < 60; i++) env.step([]);

  const kinds = new Set(log.events.map((e) => e.kind));
  assert.ok(kinds.has('patient.arrive'), 'arrivals must be logged');
  assert.ok(kinds.has('step'), 'step boundaries must be logged');
  // Every logged event carries the sim clock, which is what makes the log replayable.
  for (const e of log.events) {
    assert.equal(typeof e.t, 'number');
    assert.ok(e.clock.length > 0);
  }
});

test('actions are logged with their refusal reason', () => {
  const log = new Logger({ runId: 'act', ringSize: 100_000, level: 'debug' });
  const env = new ErEnv(getScenario('ed-baseline'), 'log-actions', log);
  for (let i = 0; i < 10; i++) env.step([]);
  // Triage without vitals is always refused — a stable way to assert the shape.
  const p = [...env.patients.values()].find((x) => x.phase !== 'departed');
  if (!p) return;
  p.lastVitals = null;
  env.step([{ type: 'triage', patient: p.id, esi: 3 }]);

  const refused = log.where((e) => e.kind === 'action.refused');
  assert.ok(refused.length > 0, 'a refused action must be logged');
  const last = refused[refused.length - 1]!;
  assert.match(last.msg ?? '', /vitals/, 'the refusal reason must be in the log');
  assert.equal(last.data?.action, 'triage');
});

test('safety floors are logged at error level with the violation kind', () => {
  const log = new Logger({ runId: 'safety', ringSize: 100_000 });
  const env = new ErEnv(getScenario('ed-baseline'), 'log-safety', log);
  for (let i = 0; i < 5; i++) env.step([]);
  const p = [...env.patients.values()].find((x) => x.phase !== 'departed');
  if (!p) return;
  p.latent.severity = 0.85;
  p.latent.treatmentProgress = 0;
  p.firstProviderTime = env.now;
  env.step([{ type: 'decide_disposition', patient: p.id, disposition: 'discharge' }]);

  const floors = log.where((e) => e.kind === 'safety');
  assert.ok(floors.length > 0);
  assert.equal(floors[0]!.level, 'error');
  assert.equal(floors[0]!.data?.violation, 'unsafe-destination-discharge');
});

test('logging does not perturb determinism', () => {
  const run = (withLog: boolean) => {
    const log = withLog ? new Logger({ runId: 'd', ringSize: 100_000 }) : undefined;
    const env = new ErEnv(getScenario('ed-baseline'), 'det-log', log);
    for (let i = 0; i < 40; i++) env.step([]);
    return env.metrics();
  };
  // The logger must never consume RNG or schedule events. If it did, turning
  // logging on would silently change the episode and every logged run would be
  // unreproducible from an unlogged one.
  assert.deepEqual(run(true), run(false));
});
