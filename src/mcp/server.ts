#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { ErEnv } from '../gym/env.js';
import { ActionSchema } from '../gym/actions.js';
import { getScenario, listScenarios } from '../scenarios/index.js';
import { LAB_TESTS } from '../modules/labs.js';
import { IMAGING_STUDIES } from '../modules/imaging.js';
import { DRUGS } from '../modules/pharmacy.js';
import { NULL_VIZ, frameOf, startViz, type Viz } from '../viz/hub.js';
import { SessionStore, type SessionHandle } from './sessions.js';

/**
 * MCP server.
 *
 * Exposes the ER gym as tools so an external harness can benchmark a model
 * against it. Each model that connects gets its OWN env and its OWN SQLite run
 * record (see sessions.ts), so two models benchmarking at once cannot corrupt
 * each other's shift.
 *
 * The tool descriptions carry the rules the agent needs and no more. They do
 * NOT reveal latent state, the true stress factor, or per-source true
 * priorities — those are what the benchmark measures.
 */

// A private seed for session-id suffixes only. Never touches the simulation,
// which owns its own deterministic RNG per (scenario, seed).
let idCounter = 0x9e3779b9;
const idRand = () => {
  idCounter = (Math.imul(idCounter ^ (idCounter >>> 15), 0x2c1b3c6d) >>> 0) || 1;
  return (idCounter >>> 0) / 0x100000000;
};

const store = new SessionStore(process.env.ER_GYM_RUNS_DIR ?? 'runs', idRand);
process.on('exit', () => store.closeAll());

/**
 * The live dashboard. On by default so that driving this over MCP is watchable
 * without any setup; ER_GYM_VIZ=0 turns it off, ER_GYM_VIZ_PORT moves it.
 *
 * It must never be able to take the server down: MCP talks stdio, and a dead
 * HTTP port is not a reason to stop serving tools. Hence the try/catch and the
 * NULL_VIZ fallback rather than a branch at every call site.
 */
const viz: Viz = (() => {
  if (process.env.ER_GYM_VIZ === '0') return NULL_VIZ;
  try {
    const v = startViz(Number(process.env.ER_GYM_VIZ_PORT ?? 7777));
    // stderr, not stdout: stdout is the MCP transport and any stray byte on it
    // corrupts the protocol stream.
    console.error(`[er-gym] live board: ${v.url}`);
    return v;
  } catch (e) {
    console.error(`[er-gym] viz disabled: ${(e as Error).message}`);
    return NULL_VIZ;
  }
})();

const server = new Server(
  { name: 'er-gym', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

/** Resolve the session for a call. `sessionId` is optional for a serial harness
 *  driving one run at a time; required once more than one run is open. */
const requireSession = (sessionId?: string): SessionHandle => {
  const h = store.get(sessionId);
  if (!h) {
    throw new Error(
      sessionId
        ? `No such session "${sessionId}". Call er_reset to start one.`
        : 'No episode running. Call er_reset first (pass your model name).',
    );
  }
  return h;
};

const TOOLS = [
  {
    name: 'er_scenarios',
    description:
      'List available scenarios, what each one is, and what it tests. Call this before er_reset.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'er_reset',
    description:
      'Handshake + start a run. Pass your model name; the server provisions a fresh episode and a ' +
      'durable SQLite run record named <model>_<rand>.sqlite, and returns a sessionId. Thread that ' +
      'sessionId through er_observe / er_step / er_metrics so concurrent runs stay isolated. ' +
      'Deterministic: the same (scenario, seed, action sequence) reproduces the same episode. ' +
      'Returns the sessionId, first observation, action mask, and scenario briefing.',
    inputSchema: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          description: 'Name of the model being benchmarked. Becomes the run-record filename stem.',
          default: 'model',
        },
        scenario: { type: 'string', description: 'Scenario name from er_scenarios.', default: 'ed-baseline' },
        seed: {
          type: ['string', 'number'],
          description: 'Any string or number. Fixes the episode. Vary it to get a different shift.',
          default: 'default-seed',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'er_observe',
    description:
      'Current observation without advancing time. Free to call. Pass your sessionId. ' +
      'NOTE: vitals are only present for patients you have measured, and every downstream/supply ' +
      'number carries its own staleness in minutes. Nothing here is ground truth.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string', description: 'From er_reset. Optional for a single serial run.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'er_step',
    description:
      'Submit a batch of actions and advance the clock by the scenario tick (default 5 sim minutes). ' +
      'Actions apply at the START of the window, then time passes. Each action returns its own ' +
      'result — a refused action tells you why rather than silently no-opping. ' +
      'Returns the new observation, the reward for this step, the cumulative breakdown, and any ' +
      'new safety events.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'From er_reset. Optional for a single serial run.' },
        actions: {
          type: 'array',
          description: 'Actions to apply. Use er_action_space for the full schema. Empty = let time pass.',
          items: zodToJsonSchema(ActionSchema, { $refStrategy: 'none' }) as object,
        },
      },
      required: ['actions'],
      additionalProperties: false,
    },
  },
  {
    name: 'er_action_space',
    description:
      'The full action schema, the currently-legal action list, and the actions that are GATED OUT ' +
      'because their module is not installed (with the reason). Call this to see what you can do.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'er_formulary',
    description:
      'The orderable catalogue: lab tests (and which have a POCT assay), imaging studies (and which ' +
      'need contrast or are portable), drugs (and which are on the override list, high-alert, ' +
      'controlled, or need compounding), and consult services.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'er_metrics',
    description:
      'Full metric report for the episode so far: clinical, access, boarding (decomposed into ' +
      'bed-request lead time vs report-handoff latency), ancillary stage splits, attention/interrupt ' +
      'triage quality, anticipation, capacity, and safety-floor counts.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'er_sessions',
    description: 'List open runs on this server: sessionId, model, scenario, step, and whether finalized.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
] as const;

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS as unknown as object[] }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const json = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] });

  try {
    switch (name) {
      case 'er_scenarios':
        return json({ scenarios: listScenarios() });

      case 'er_reset': {
        const a = z
          .object({
            model: z.string().default('model'),
            scenario: z.string().default('ed-baseline'),
            seed: z.union([z.string(), z.number()]).default('default-seed'),
          })
          .parse(args ?? {});
        const spec = getScenario(a.scenario);
        const h = store.open(a.model, spec, a.seed);
        viz.publish(h.env);
        return json({
          sessionId: h.id,
          runRecord: h.dbPath,
          liveBoard: viz.url || undefined,
          briefing: {
            scenario: spec.name,
            description: spec.description,
            tests: spec.tests,
            durationMinutes: spec.durationMinutes,
            tickMinutes: spec.tickMinutes,
            startHour: spec.startHour,
            steps: Math.ceil(spec.durationMinutes / spec.tickMinutes),
          },
          rules: [
            'You only see vitals for patients you have measured. Nothing pushes deterioration to you.',
            'Every downstream and supply reading is noisy and stale. The staleness is in the payload.',
            'Interrupts report a CLAIMED priority. Learn the per-source discount; one source never lies.',
            'You re-rank the pharmacist verification queue. You never verify.',
            'A bed assignment does not move a patient. Report handoff must complete first.',
            'Hard safety floors are priced above any achievable throughput gain. Do not trade against them.',
          ],
          mask: h.env.mask(),
          observation: h.env.observe(),
        });
      }

      case 'er_observe': {
        const a = z.object({ sessionId: z.string().optional() }).parse(args ?? {});
        return json(requireSession(a.sessionId).env.observe());
      }

      case 'er_step': {
        const a = z
          .object({ sessionId: z.string().optional(), actions: z.array(z.unknown()).default([]) })
          .parse(args ?? {});
        const h = requireSession(a.sessionId);
        const res = h.env.step(a.actions);
        // Persist the step to the run record BEFORE returning, so a crashed
        // client still leaves a complete audit trail up to the last step.
        store.recordStep(
          h,
          a.actions,
          res.results,
          res.reward,
          res.components.total,
          res.info.time,
          res.info.clock,
          res.info.newSafetyEvents,
        );
        if (res.done) store.finalize(h);
        viz.broadcast(frameOf(h.env, h.step, res));
        return json({
          sessionId: h.id,
          reward: round2(res.reward),
          cumulative: res.components,
          done: res.done,
          results: res.results,
          info: res.info,
          observation: res.observation,
          ...(res.done ? { metrics: h.env.metrics(), runRecord: h.dbPath } : {}),
        });
      }

      case 'er_action_space': {
        const a = z.object({ sessionId: z.string().optional() }).parse(args ?? {});
        return json({
          schema: zodToJsonSchema(ActionSchema, { $refStrategy: 'none' }),
          mask: requireSession(a.sessionId).env.mask(),
        });
      }

      case 'er_formulary':
        return json({
          labs: Object.values(LAB_TESTS).map((t) => ({
            name: t.name,
            poctAvailable: t.poct,
            note: t.poct ? 'POCT is faster but skips the central rejection check' : 'central lab only',
          })),
          imaging: Object.values(IMAGING_STUDIES).map((s) => ({
            name: s.name,
            modality: s.modality,
            needsContrast: s.contrast,
            portable: s.portable,
            timeCritical: s.timeCritical,
          })),
          drugs: Object.values(DRUGS).map((d) => ({
            name: d.name,
            inCabinet: d.inCabinet,
            onOverrideList: d.overridable,
            highAlert: d.highAlert,
            controlled: d.controlled,
            requiresCompounding: d.requiresCompounding,
          })),
          consultServices: Object.keys(
            requireSession(z.object({ sessionId: z.string().optional() }).parse(args ?? {}).sessionId).env.scenario
              .registry.consultServices,
          ),
        });

      case 'er_metrics': {
        const a = z.object({ sessionId: z.string().optional() }).parse(args ?? {});
        const h = requireSession(a.sessionId);
        store.finalize(h);
        return json({ sessionId: h.id, runRecord: h.dbPath, ...h.env.metrics() });
      }

      case 'er_sessions':
        return json({ sessions: store.list() });

      default:
        throw new Error(`unknown tool ${name}`);
    }
  } catch (e) {
    return {
      isError: true,
      content: [{ type: 'text' as const, text: `${(e as Error).message}` }],
    };
  }
});

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

const transport = new StdioServerTransport();
await server.connect(transport);
