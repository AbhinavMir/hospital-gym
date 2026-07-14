import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startViz, frameOf, NULL_VIZ } from '../src/viz/hub.js';
import { ErEnv } from '../src/gym/env.js';
import { getScenario } from '../src/scenarios/index.js';
import { PAGE } from '../src/viz/page.js';

/** Pick a high port per-test so a stray server never collides with a real run. */
let port = 7900;
const nextPort = () => ++port;

test('serves the page', async () => {
  const p = nextPort();
  const viz = startViz(p);
  const res = await fetch(`http://127.0.0.1:${p}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /er-gym/);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  viz.close();
});

test('streams a frame to a connected client', async () => {
  const p = nextPort();
  const viz = startViz(p);
  const env = new ErEnv(getScenario('ed-baseline'), 'viz-test');

  const res = await fetch(`http://127.0.0.1:${p}/events`);
  assert.match(res.headers.get('content-type') ?? '', /event-stream/);
  const reader = res.body!.getReader();

  const step = env.step([]);
  viz.broadcast(frameOf(env, 1, step));

  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);
  assert.match(text, /retry:|data:/);

  await reader.cancel();
  viz.close();
});

test('a late joiner immediately receives the current board', async () => {
  const p = nextPort();
  const viz = startViz(p);
  const env = new ErEnv(getScenario('ed-baseline'), 'late-joiner');
  // Broadcast BEFORE anyone connects.
  viz.broadcast(frameOf(env, 7, env.step([])));

  const res = await fetch(`http://127.0.0.1:${p}/events`);
  const reader = res.body!.getReader();
  let buf = '';
  // The retry directive and the replayed frame may arrive in one chunk or two.
  for (let i = 0; i < 3 && !buf.includes('data: '); i++) {
    const { value } = await reader.read();
    buf += new TextDecoder().decode(value);
  }
  const frame = JSON.parse(buf.slice(buf.indexOf('data: ') + 6).split('\n')[0]!);
  assert.equal(frame.step, 7, 'a client connecting mid-episode must not wait for the next step');

  await reader.cancel();
  viz.close();
});

test('the frame carries what the board needs and nothing latent', () => {
  const env = new ErEnv(getScenario('ed-baseline'), 'frame-shape');
  for (let i = 0; i < 20; i++) env.step([]);
  const f = frameOf(env, 20, env.step([]));

  for (const k of ['step', 'clock', 'scenario', 'reward', 'components', 'lastActions', 'observation', 'safety', 'done']) {
    assert.ok(k in f, `frame missing ${k}`);
  }
  // The dashboard is a view of the OBSERVATION. If latent state leaked into the
  // frame, anyone watching would see more than the agent does — and a frame is
  // exactly the kind of place that leak would go unnoticed.
  const json = JSON.stringify(f.observation);
  for (const forbidden of ['severity', 'hazard', 'trueEsi', 'truePriority', 'treatmentProgress']) {
    assert.ok(!json.includes(forbidden), `viz frame leaked "${forbidden}"`);
  }
});

test('NULL_VIZ is a safe no-op', () => {
  const env = new ErEnv(getScenario('ed-baseline'), 'nullviz');
  assert.doesNotThrow(() => {
    NULL_VIZ.publish(env);
    NULL_VIZ.broadcast(frameOf(env, 1, env.step([])));
    NULL_VIZ.close();
  });
  assert.equal(NULL_VIZ.url, '');
});

test('the page is self-contained: no external requests', () => {
  // The dashboard must work offline and never phone home. A CDN link here would
  // be an outbound request from a benchmark run.
  assert.ok(!/https?:\/\//.test(PAGE.replace(/http:\/\/127\.0\.0\.1/g, '')), 'page must not reference external hosts');
  assert.ok(!/<script[^>]+src=/.test(PAGE), 'page must not load external scripts');
  assert.ok(!/<link[^>]+href=/.test(PAGE), 'page must not load external stylesheets');
});
