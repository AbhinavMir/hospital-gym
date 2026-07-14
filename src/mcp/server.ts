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

/**
 * MCP server.
 *
 * Exposes the ER gym as tools so a policy can drive an episode conversationally.
 * One env per session; `er_reset` starts a new episode.
 *
 * The tool descriptions carry the rules the agent needs and no more. They do
 * NOT reveal latent state, the true stress factor, or per-source true
 * priorities — those are what the benchmark measures.
 */

let env: ErEnv | null = null;

const server = new Server(
  { name: 'er-gym', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

const requireEnv = (): ErEnv => {
  if (!env) throw new Error('No episode running. Call er_reset first.');
  return env;
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
      'Start a new episode. Deterministic: the same (scenario, seed, action sequence) always ' +
      'reproduces the same episode, so scores are comparable across runs and machines. ' +
      'Returns the first observation, the action mask, and the scenario briefing.',
    inputSchema: {
      type: 'object',
      properties: {
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
      'Current observation without advancing time. Free to call. ' +
      'NOTE: vitals are only present for patients you have measured, and every downstream/supply ' +
      'number carries its own staleness in minutes. Nothing here is ground truth.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
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
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
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
            scenario: z.string().default('ed-baseline'),
            seed: z.union([z.string(), z.number()]).default('default-seed'),
          })
          .parse(args ?? {});
        const spec = getScenario(a.scenario);
        env = new ErEnv(spec, a.seed);
        return json({
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
          mask: env.mask(),
          observation: env.observe(),
        });
      }

      case 'er_observe':
        return json(requireEnv().observe());

      case 'er_step': {
        const a = z.object({ actions: z.array(z.unknown()).default([]) }).parse(args ?? {});
        const e = requireEnv();
        const res = e.step(a.actions);
        return json({
          reward: round2(res.reward),
          cumulative: res.components,
          done: res.done,
          results: res.results,
          info: res.info,
          observation: res.observation,
          ...(res.done ? { metrics: e.metrics() } : {}),
        });
      }

      case 'er_action_space': {
        const e = requireEnv();
        return json({
          schema: zodToJsonSchema(ActionSchema, { $refStrategy: 'none' }),
          mask: e.mask(),
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
          consultServices: Object.keys(requireEnv().scenario.registry.consultServices),
        });

      case 'er_metrics':
        return json(requireEnv().metrics());

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
