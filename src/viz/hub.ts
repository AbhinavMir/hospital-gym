import { createServer, type Server as HttpServer } from 'node:http';
import { PAGE } from './page.js';
import type { ErEnv } from '../gym/env.js';

/**
 * The live dashboard hub.
 *
 * Deliberately tiny: node:http + server-sent events + one static page. No
 * framework, no build step, no websockets, no deps. The whole point is that you
 * can watch the board move while an agent works, and that this never becomes a
 * thing anyone has to maintain.
 *
 * SSE (not websockets) because the traffic is one-way — the browser only ever
 * watches. Reconnection is built into EventSource for free.
 */

export interface VizFrame {
  step: number;
  clock: string;
  time: number;
  scenario: string;
  reward: number;
  components: Record<string, number>;
  /** What the agent just did, so you can see it working rather than infer it. */
  lastActions: { action: string; ok: boolean; reason?: string }[];
  observation: unknown;
  safety: { kind: string; at: number; patient: string | null; detail: string }[];
  done: boolean;
}

export interface Viz {
  broadcast(frame: VizFrame): void;
  /** Push the current env state without a step. Used on reset. */
  publish(env: ErEnv, lastActions?: VizFrame['lastActions']): void;
  close(): void;
  readonly url: string;
}

/** A no-op viz, so callers never have to branch on whether it is enabled. */
export const NULL_VIZ: Viz = {
  broadcast() {},
  publish() {},
  close() {},
  url: '',
};

export function startViz(port = 7777): Viz {
  const clients = new Set<{ write: (s: string) => void; end: () => void }>();
  let last: VizFrame | null = null;

  const server: HttpServer = createServer((req, res) => {
    const url = req.url ?? '/';

    if (url === '/' || url.startsWith('/?')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(PAGE);
      return;
    }

    if (url === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'access-control-allow-origin': '*',
      });
      res.write('retry: 1000\n\n');
      const client = {
        write: (s: string) => {
          try {
            res.write(s);
          } catch {
            /* client vanished mid-write; the close handler cleans up */
          }
        },
        end: () => res.end(),
      };
      clients.add(client);
      // A late joiner should see the current board immediately, not wait for
      // the next step.
      if (last) client.write(`data: ${JSON.stringify(last)}\n\n`);
      req.on('close', () => clients.delete(client));
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  server.listen(port, '127.0.0.1');
  server.on('error', (e) => {
    console.error(`[viz] could not listen on ${port}: ${(e as Error).message}`);
  });
  // Never hold the process open just because the dashboard is running.
  server.unref();

  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    broadcast(frame: VizFrame) {
      last = frame;
      const payload = `data: ${JSON.stringify(frame)}\n\n`;
      for (const c of clients) c.write(payload);
    },
    publish(env: ErEnv, lastActions: VizFrame['lastActions'] = []) {
      this.broadcast({
        step: 0,
        clock: '00:00',
        time: env.now,
        scenario: env.scenario.name,
        reward: 0,
        components: env.components as unknown as Record<string, number>,
        lastActions,
        observation: env.observe(),
        safety: env.safetyEvents.slice(-25),
        done: false,
      });
    },
    close() {
      for (const c of clients) c.end();
      clients.clear();
      server.close();
    },
  };
}

/** Build a frame from a step result. Keeps the wiring in one place. */
export function frameOf(
  env: ErEnv,
  step: number,
  res: { reward: number; components: unknown; done: boolean; results: { action: string; ok: boolean; reason?: string }[]; info: { clock: string; time: number } },
): VizFrame {
  return {
    step,
    clock: res.info.clock,
    time: res.info.time,
    scenario: env.scenario.name,
    reward: Math.round(res.reward * 100) / 100,
    components: res.components as Record<string, number>,
    lastActions: res.results,
    observation: env.observe(),
    safety: env.safetyEvents.slice(-25),
    done: res.done,
  };
}
