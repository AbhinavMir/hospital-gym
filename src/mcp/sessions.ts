import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ErEnv } from '../gym/env.js';
import type { ScenarioSpec } from '../scenarios/types.js';

/**
 * Session store + durable run record.
 *
 * Each model or human that connects gets its OWN env and its OWN run-record
 * file. That kills the single-global-env problem — two players benchmarking at
 * once can no longer corrupt each other's shift — and leaves a durable,
 * greppable record of every run on disk.
 *
 * The record is JSONL, NOT SQLite. An earlier version used better-sqlite3; it is
 * a native addon that breaks the instant the runtime's Node version differs from
 * the one it was compiled against, and it did exactly that — crashing the play
 * UI to a blank screen. A benchmark meant to be run by other people cannot carry
 * a dependency that shatters on a Node mismatch. JSONL needs no native code,
 * runs on any Node, and imports into SQLite/pandas/DuckDB in one line for anyone
 * who wants to query it (see scripts/runs-to-sqlite.sh).
 *
 * One file per run: `runs/<player>_<rand>.jsonl`, one event per line:
 *   {"kind":"run",    ...}   header: player, scenario, seed, timing
 *   {"kind":"step",   ...}   per step: actions, results, reward, cumulative
 *   {"kind":"safety", ...}   one line per safety-floor violation
 *   {"kind":"result", ...}   final scorecard (reward breakdown + metrics)
 * plus a `<player>_<rand>.summary.json` written on finalize.
 *
 * The live simulation stays in memory — it runs thousands of events per shift,
 * so nothing round-trips through the file except what actually happened.
 */

export interface SessionHandle {
  id: string;
  model: string;
  dbPath: string; // the .jsonl run record; named dbPath for API stability
  env: ErEnv;
  step: number;
  finalized: boolean;
}

export class SessionStore {
  private sessions = new Map<string, SessionHandle>();
  private lastId: string | null = null;

  constructor(
    private readonly dir: string,
    /** Deterministic id-suffix source; never touches the simulation's RNG. */
    private readonly rand: () => number,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  /**
   * The handshake. A player announces its name; we provision a fresh env and a
   * fresh `<name>_<rand>.jsonl`, and return the session id threaded through
   * every later call.
   */
  open(model: string, scenario: ScenarioSpec, seed: number | string): SessionHandle {
    const safe = model.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 64) || 'player';
    const id = `${safe}_${Math.floor(this.rand() * 1e9)}`;
    const path = join(this.dir, `${id}.jsonl`);

    writeFileSync(
      path,
      JSON.stringify({
        kind: 'run',
        session: id,
        player: model,
        scenario: scenario.name,
        seed: String(seed),
        startedAt: nowIso(),
        durationMinutes: scenario.durationMinutes,
        tickMinutes: scenario.tickMinutes,
      }) + '\n',
    );

    const env = new ErEnv(scenario, seed);
    const handle: SessionHandle = { id, model, dbPath: path, env, step: 0, finalized: false };
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

  /** Append one step (and any safety events it produced) to the record. */
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
    const lines = [
      JSON.stringify({ kind: 'step', session: h.id, step: h.step, simMinute, clock, reward, cumulative, actions, results }),
    ];
    for (const s of newSafety) {
      lines.push(JSON.stringify({ kind: 'safety', session: h.id, step: h.step, simMinute: s.at, violation: s.kind, patient: s.patient, detail: s.detail }));
    }
    appendFileSync(h.dbPath, lines.join('\n') + '\n');
  }

  /** Write the final scorecard line + a summary.json, and mark complete. Idempotent. */
  finalize(h: SessionHandle): void {
    if (h.finalized) return;
    const components = h.env.components;
    const metrics = h.env.metrics();
    appendFileSync(
      h.dbPath,
      JSON.stringify({ kind: 'result', session: h.id, endedAt: nowIso(), reward: components.total, components, metrics }) + '\n',
    );
    writeFileSync(
      h.dbPath.replace(/\.jsonl$/, '.summary.json'),
      JSON.stringify({ session: h.id, player: h.model, scenario: h.env.scenario.name, seed: String(h.env.seed), reward: components.total, components, metrics }, null, 2),
    );
    h.finalized = true;
  }

  /** Finalize and drop a session from memory. */
  close(id: string): void {
    const h = this.sessions.get(id);
    if (!h) return;
    this.finalize(h);
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
  // Wall-clock metadata only; never feeds the deterministic simulation.
  return new Date().toISOString();
}
