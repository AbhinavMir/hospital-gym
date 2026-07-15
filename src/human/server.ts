#!/usr/bin/env node
import { createServer } from 'node:http';
import { ErEnv } from '../gym/env.js';
import { OraclePolicy } from '../gym/oracle.js';
import { getScenario, listScenarios } from '../scenarios/index.js';
import { ActionSchema, type Action } from '../gym/actions.js';
import { patientActions, departmentActions } from '../gym/legal.js';
import { LAB_TESTS } from '../modules/labs.js';
import { IMAGING_STUDIES } from '../modules/imaging.js';
import { DRUGS } from '../modules/pharmacy.js';
import { SessionStore, type SessionHandle } from '../mcp/sessions.js';
import { PLAY_PAGE } from './page.js';

/**
 * Human-playable ER — the study interface.
 *
 * Turn-based, point-and-click. A clinician sees the board, clicks the actions
 * that are legal for a patient right now (from src/gym/legal.ts — the SAME set
 * an AI is handed, so information is equal), queues them for the window, and
 * advances 5 minutes. Every run writes the identical SQLite record an AI run
 * writes, so human, AI, and oracle land on one comparable scale.
 *
 * No framework, no build step: node:http + one embedded page.
 */

let idc = 0x12345678;
const idRand = () => ((idc = (Math.imul(idc ^ (idc >>> 15), 0x2c1b3c6d) >>> 0) || 1) >>> 0) / 0x100000000;
const store = new SessionStore(process.env.ER_GYM_RUNS_DIR ?? 'runs', idRand);

/** Actions the player has queued for the current window, per session. */
const queued = new Map<string, Action[]>();
/** Cached null/oracle anchors per (scenario|seed), computed once on first finish. */
const anchors = new Map<string, { null: number; oracle: number }>();

function computeAnchors(scenario: string, seed: string): { null: number; oracle: number } {
  const key = `${scenario}|${seed}`;
  const hit = anchors.get(key);
  if (hit) return hit;
  const run = (oracle: boolean) => {
    const env = new ErEnv(getScenario(scenario), seed);
    const pol = oracle ? new OraclePolicy(env) : null;
    let done = false;
    while (!done) done = env.step(pol ? pol.act() : []).done;
    return env.components.total;
  };
  const a = { null: run(false), oracle: run(true) };
  anchors.set(key, a);
  return a;
}

/** Everything the page needs to render one turn. */
function state(h: SessionHandle) {
  const env = h.env;
  const obs = env.observe();
  const live = [...env.patients.values()].filter((p) => p.phase !== 'departed');
  const m = env.metrics();
  return {
    sessionId: h.id,
    player: h.model,
    scenario: env.scenario.name,
    step: h.step,
    clock: obs.clock,
    totalSteps: Math.ceil(env.scenario.durationMinutes / env.scenario.tickMinutes),
    done: env.now >= env.scenario.durationMinutes,
    // Counts a charge nurse actually tracks — not a running score (which is a
    // big negative number and just demoralising mid-shift).
    inDept: live.length,
    needTriage: live.filter((p) => p.esi === null).length,
    needBed: live.filter((p) => p.phase === 'waiting-room').length,
    boarding: live.filter((p) => p.phase === 'boarding').length,
    deaths: m.clinical.deaths,
    leftWithoutCare: [...env.patients.values()].filter((p) => p.disposition?.kind === 'lwbs').length,
    onDiversion: obs.onDiversion,
    beds: obs.ed.beds,
    patients: obs.patients,
    department: departmentActions(env),
    // Per-patient legal actions, keyed by id, so a click needs no round-trip.
    legal: Object.fromEntries(live.map((p) => [p.id, patientActions(env, p)])),
    queued: (queued.get(h.id) ?? []).map((a, i) => ({ i, action: a, label: describe(a) })),
    formulary: { lab: Object.keys(LAB_TESTS), imaging: Object.keys(IMAGING_STUDIES), med: Object.keys(DRUGS) },
  };
}

/** A short human label for a queued action, for the pending list. */
function describe(a: Action): string {
  const p = (a as { patient?: string }).patient;
  const tail = Object.entries(a)
    .filter(([k]) => k !== 'type' && k !== 'patient')
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`)
    .join(' ');
  return `${a.type}${p ? ` ${p.replace('pt-', '#')}` : ''}${tail ? ` · ${tail}` : ''}`;
}

async function body(req: import('node:http').IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const send = (code: number, obj: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  };

  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(PLAY_PAGE);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/scenarios') {
      return send(200, { scenarios: listScenarios().filter((s) => !s.name.includes('degraded')) });
    }

    if (req.method === 'POST' && url.pathname === '/api/reset') {
      const b = await body(req);
      const h = store.open(b.player || 'nurse', getScenario(b.scenario || 'ed-baseline'), b.seed || 's1');
      queued.set(h.id, []);
      // Skip the quiet opening: advance (recording the empty windows honestly)
      // until the first patient actually arrives, so the nurse starts with
      // someone to work on instead of a blank board. No decisions were possible
      // in that window anyway, so it does not affect the comparison.
      for (let i = 0; i < 40 && [...h.env.patients.values()].every((p) => p.phase === 'departed'); i++) {
        const r = h.env.step([]);
        store.recordStep(h, [], r.results, r.reward, r.components.total, r.info.time, r.info.clock, r.info.newSafetyEvents);
        if ([...h.env.patients.values()].some((p) => p.phase !== 'departed')) break;
      }
      return send(200, state(h));
    }

    if (req.method === 'POST' && url.pathname === '/api/queue') {
      const b = await body(req);
      const h = store.get(b.sessionId);
      if (!h) return send(404, { error: 'no such session' });
      const parsed = ActionSchema.safeParse(b.action);
      if (!parsed.success) return send(400, { error: parsed.error.issues[0]?.message ?? 'invalid action' });
      queued.set(h.id, [...(queued.get(h.id) ?? []), parsed.data]);
      return send(200, state(h));
    }

    if (req.method === 'POST' && url.pathname === '/api/unqueue') {
      const b = await body(req);
      const h = store.get(b.sessionId);
      if (!h) return send(404, { error: 'no such session' });
      const q = queued.get(h.id) ?? [];
      q.splice(b.index, 1);
      queued.set(h.id, q);
      return send(200, state(h));
    }

    if (req.method === 'POST' && url.pathname === '/api/advance') {
      const b = await body(req);
      const h = store.get(b.sessionId);
      if (!h) return send(404, { error: 'no such session' });
      const actions = queued.get(h.id) ?? [];
      const res2 = h.env.step(actions);
      store.recordStep(h, actions, res2.results, res2.reward, res2.components.total, res2.info.time, res2.info.clock, res2.info.newSafetyEvents);
      queued.set(h.id, []);
      const s = state(h) as Record<string, unknown>;
      s.lastResults = res2.results;
      if (res2.done) {
        store.finalize(h);
        const anc = computeAnchors(h.env.scenario.name, String(h.env.seed));
        const span = anc.oracle - anc.null;
        s.final = {
          reward: Math.round(res2.components.total),
          nullAnchor: Math.round(anc.null),
          oracleAnchor: Math.round(anc.oracle),
          score: span > 0 ? Number(((res2.components.total - anc.null) / span).toFixed(3)) : null,
          metrics: h.env.metrics(),
          runRecord: h.dbPath,
        };
      }
      return send(200, s);
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  } catch (e) {
    send(500, { error: (e as Error).message });
  }
});

const port = Number(process.env.ER_GYM_PLAY_PORT ?? 7788);
server.listen(port, '127.0.0.1', () => {
  console.log(`\ner-gym · human play · http://127.0.0.1:${port}\n`);
  console.log('Open it, enter a player name, pick a scenario, and run the shift.');
  console.log('Every run is saved to runs/<player>_<id>.sqlite — the same record an AI run writes.\n');
});
