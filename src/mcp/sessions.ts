import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ErEnv } from '../gym/env.js';
import type { ScenarioSpec } from '../scenarios/types.js';

/**
 * Session store + durable run record.
 *
 * Each model that connects gets its OWN env and its OWN SQLite file. That kills
 * the single-global-env problem — two models benchmarking at once can no longer
 * corrupt each other's shift — and it leaves a durable, queryable record of
 * every run on disk.
 *
 * The SQLite file is the RUN RECORD, not the live simulation. The env is an
 * in-memory discrete-event object running thousands of events per shift; the DB
 * captures what happened (handshake, per-step actions and reward, safety
 * events, final metrics) so a run can be compared and audited after the fact.
 * The sim's live state never round-trips through SQLite — that would be slow
 * and would buy nothing.
 */

export interface SessionHandle {
  id: string;
  model: string;
  dbPath: string;
  env: ErEnv;
  db: Database.Database;
  step: number;
  finalized: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS run (
  session_id   TEXT PRIMARY KEY,
  model        TEXT NOT NULL,
  scenario     TEXT NOT NULL,
  seed         TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  duration_min INTEGER,
  tick_min     INTEGER,
  finalized    INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS step (
  session_id   TEXT NOT NULL,
  step         INTEGER NOT NULL,
  sim_minute   REAL NOT NULL,
  clock        TEXT NOT NULL,
  actions      TEXT NOT NULL,   -- JSON array the model submitted
  results      TEXT NOT NULL,   -- JSON array of per-action outcomes
  reward       REAL NOT NULL,   -- reward for this step
  cumulative   REAL NOT NULL,   -- cumulative total reward
  PRIMARY KEY (session_id, step)
);
CREATE TABLE IF NOT EXISTS safety (
  session_id TEXT NOT NULL,
  step       INTEGER NOT NULL,
  sim_minute REAL NOT NULL,
  kind       TEXT NOT NULL,
  patient    TEXT,
  detail     TEXT
);
CREATE TABLE IF NOT EXISTS result (
  session_id TEXT PRIMARY KEY,
  ended_at   TEXT NOT NULL,
  reward     REAL NOT NULL,
  components TEXT NOT NULL,     -- JSON reward breakdown
  metrics    TEXT NOT NULL      -- JSON full scorecard
);
`;

export class SessionStore {
  private sessions = new Map<string, SessionHandle>();
  private lastId: string | null = null;

  constructor(
    private readonly dir: string,
    /** Deterministic id suffix source — the env owns real randomness, not us. */
    private readonly rand: () => number,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  /**
   * The handshake. A model announces its name; we provision a fresh env and a
   * fresh `<model>_<rand>.sqlite`, and return the session id the model threads
   * through every later call.
   */
  open(model: string, scenario: ScenarioSpec, seed: number | string): SessionHandle {
    const safeModel = model.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 64) || 'model';
    const suffix = Math.floor(this.rand() * 1e9);
    const id = `${safeModel}_${suffix}`;
    const dbPath = join(this.dir, `${id}.sqlite`);

    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(SCHEMA);

    const env = new ErEnv(scenario, seed);
    db.prepare(
      `INSERT INTO run (session_id, model, scenario, seed, started_at, duration_min, tick_min)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, model, scenario.name, String(seed), nowIso(), scenario.durationMinutes, scenario.tickMinutes);

    const handle: SessionHandle = { id, model, dbPath, env, db, step: 0, finalized: false };
    this.sessions.set(id, handle);
    this.lastId = id;
    return handle;
  }

  /** Resolve a session. Falls back to the most recent when id is omitted, so a
   *  single serial harness never has to thread the id. */
  get(id?: string): SessionHandle | null {
    const key = id ?? this.lastId;
    return key ? this.sessions.get(key) ?? null : null;
  }

  /** Record one step into the run's DB. */
  recordStep(
    h: SessionHandle,
    actions: unknown[],
    results: unknown[],
    reward: number,
    cumulative: number,
    simMinute: number,
    clock: string,
    newSafety: { kind: string; at: number; patient: string | null; detail: string }[],
  ): void {
    h.step += 1;
    h.db
      .prepare(
        `INSERT INTO step (session_id, step, sim_minute, clock, actions, results, reward, cumulative)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(h.id, h.step, simMinute, clock, JSON.stringify(actions), JSON.stringify(results), reward, cumulative);

    if (newSafety.length) {
      const ins = h.db.prepare(
        `INSERT INTO safety (session_id, step, sim_minute, kind, patient, detail) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const tx = h.db.transaction((rows: typeof newSafety) => {
        for (const s of rows) ins.run(h.id, h.step, s.at, s.kind, s.patient, s.detail);
      });
      tx(newSafety);
    }
  }

  /** Write the final scorecard and mark the run complete. Idempotent. */
  finalize(h: SessionHandle): void {
    if (h.finalized) return;
    const components = h.env.components;
    const metrics = h.env.metrics();
    h.db
      .prepare(`INSERT OR REPLACE INTO result (session_id, ended_at, reward, components, metrics) VALUES (?, ?, ?, ?, ?)`)
      .run(h.id, nowIso(), components.total, JSON.stringify(components), JSON.stringify(metrics));
    h.db.prepare(`UPDATE run SET finalized = 1, duration_min = ? WHERE session_id = ?`).run(h.env.now, h.id);
    h.finalized = true;
  }

  /** Close a session's DB and drop it from memory. */
  close(id: string): void {
    const h = this.sessions.get(id);
    if (!h) return;
    this.finalize(h);
    h.db.close();
    this.sessions.delete(id);
    if (this.lastId === id) this.lastId = null;
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }

  list(): { id: string; model: string; scenario: string; step: number; finalized: boolean }[] {
    return [...this.sessions.values()].map((h) => ({
      id: h.id,
      model: h.model,
      scenario: h.env.scenario.name,
      step: h.step,
      finalized: h.finalized,
    }));
  }
}

function nowIso(): string {
  // The sim is deterministic; wall-clock timestamps are metadata only and never
  // feed the simulation, so using the real clock here is safe.
  return new Date().toISOString();
}
