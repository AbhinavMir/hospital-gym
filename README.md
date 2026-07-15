# er-gym

A deterministic emergency-department simulation for benchmarking AI scheduling and orchestration policies. Written in TypeScript, driveable over MCP.

The ED is a scheduling problem with hard safety constraints, finite human attention, and correlated scarcity. This is a kernel for that problem: door to disposition, with every ancillary pipeline modelled in stages rather than as a delay distribution, and with the world past the ED exit sitting behind interfaces so that later modules can replace it without rewriting anything.

Module 1 (the ER) is what exists today. Modules 2–5 are designed for, not built.

## Install

```bash
npm install
npm test
npm run demo                      # reference policy on ed-baseline
npm run demo -- boarding-crisis   # the signature scenario
npm run watch                     # same, with the live board at :7777
```

## Logging

Every consequential event is logged as JSONL — the audit trail for a run.

```bash
npm run logs                                              # writes logs/<run>.jsonl + .summary.json
npx tsx examples/random-policy.ts boarding-crisis s1 --log --debug --verbose
```

Determinism extends to the log: the same `(scenario, seed, actions)` reproduces it. Enabling logging never consumes RNG, so a logged run and an unlogged run are the *same episode* — there's a test for that. Grep a patient id out of the JSONL and you get their whole story, arrival to departure, including every action the agent took and every refusal reason.

## Live board

A dashboard so you can watch a policy work instead of reading a metrics dump afterwards.
Zero dependencies: `node:http` + server-sent events + one static page. No framework, no build step.

```bash
npm run watch                                        # paced so a human can follow
npx tsx examples/random-policy.ts boarding-crisis s1 --watch --pace=300
```

Open <http://127.0.0.1:7777>. It shows the bed grid, the patient board (sickest first, with vitals age so you can see what's gone unmeasured), pending interrupts by claimed priority, role attention load, downstream capacity with staleness, open report handoffs, queues, the agent's last actions with refusal reasons, safety floors as they fire, and the live reward breakdown.

**It is on by default when driving over MCP** — `er_reset` returns the URL, and every `er_step` pushes a frame, so you watch the agent work in real time. Turn it off with `ER_GYM_VIZ=0`, move it with `ER_GYM_VIZ_PORT`.

The board renders the *observation*, not the world — it shows exactly what the agent can see and no more. A test enforces this: if latent state ever leaked into a frame, the dashboard is exactly where it would go unnoticed.

## Use as a library

```ts
import { ErEnv, getScenario } from 'er-gym';

const env = new ErEnv(getScenario('boarding-crisis'), 'seed-1');
let obs = env.observe();
let done = false;

while (!done) {
  const actions = myPolicy(obs);          // Action[]
  const res = env.step(actions);
  obs = res.observation;
  done = res.done;
}

console.log(env.metrics());
```

## Use over MCP

```jsonc
// claude_desktop_config.json / any MCP client
{
  "mcpServers": {
    "er-gym": { "command": "npx", "args": ["tsx", "/path/to/er-gym/src/mcp/server.ts"] }
  }
}
```

Tools: `er_scenarios`, `er_reset`, `er_observe`, `er_step`, `er_action_space`, `er_formulary`, `er_metrics`, `er_sessions`.

**Each model gets its own run.** `er_reset` is a handshake: pass your model name and it provisions a fresh episode plus a durable SQLite record at `runs/<model>_<rand>.sqlite`, returning a `sessionId`. Thread that id through `er_observe`/`er_step`/`er_metrics` and concurrent models never corrupt each other. The `.sqlite` holds the whole run — handshake metadata, every step's actions and reward, safety events, and the final scorecard — so a run is auditable and comparable after the fact. (Omit the id for a single serial run; it resolves to the most recent.)

## The honest limitation, stated up front

**In Module 1, boarding is observable and costly but only partially actionable.**

The agent can compress the ED-side contributors: request the bed early, request the right level, sequence boarders against offered beds, work the report handoff, keep boarders from deteriorating, and decide when boarding is bad enough to warrant transfer-out or diversion. It **cannot** fix the actual upstream cause — inpatient discharge timing — because that lives in Module 2.

So v1's boarding metrics measure *boarding management*, not *boarding elimination*.

The ceiling is computed against the **same** exogenous release process, so it is honest for this module. When Module 2 lands, the ceiling rises, the same policy is re-benchmarked, and that delta measures what the hospital module buys.

This caveat is carried in the `metrics()` payload, not just here.

## Benchmark

```bash
npm run bench                        # all scenarios, 8 seeds
npm run bench -- ed-baseline --seeds=20
```

Three policies on the same seeds: **null** (no actions — what happens if nobody works), **reference** (the deliberately mediocre policy), **oracle** (perfect information — reads latent state).

```
scenario                     null  reference     oracle           score  deaths r/o
ed-baseline              -171,984   -176,057    -51,035     -0.03 ±0.08     8.3/3.3
boarding-crisis          -274,508   -329,673   -179,329     -1.02 ±0.51   21.8/14.8
understaffed-nights       -78,445    -74,516    -38,351     -1.17 ±1.08     4.0/3.1
respiratory-season       -447,043   -595,961   -293,095     -1.08 ±0.26   34.8/23.8
mass-casualty            -847,240   -838,574   -687,915     -1.44 ±1.68   75.4/71.9
```

`score = (policy − null) / (oracle − null)`, averaged per seed, ±SEM. **0** = no better than abandoning the department, **1** = matched the oracle.

**Report the interval, not the point.** The floor-to-ceiling span varies ~15% (cv) seed to seed, so a single-seed score carries roughly ±20% noise. At 8 seeds, `understaffed-nights` (±1.08) and `mass-casualty` (±1.68) have error bars **wider than the effect** — those two need far more seeds before any claim about them means anything. Only `ed-baseline` and `respiratory-season` are tight enough at n=8 to say much.

What survives the error bars: the reference policy is **not better than doing nothing** anywhere, and is clearly *worse* in `boarding-crisis` and `respiratory-season`. Hard floors only fire when you **act**, so a careless policy commits them while an idle one cannot. That is the floors working, and it fell out of the measurement rather than being designed in.

**The oracle is not a proven upper bound.** A true clairvoyant bound would mean solving an NP-hard joint scheduling problem over beds, staff, ancillary queues, and attention. This is a strong hand-written policy with perfect information — an *achievable reference*. Beating it is possible and means you found something it doesn't know. It still loses ~72 patients in `mass-casualty` and still boards heavily in `boarding-crisis`: perfect information cannot make a bed appear, which is the whole Module 1 thesis.

### What has NOT been benchmarked

**No language model has ever played this.** `npm run bench` runs three hardcoded TypeScript policies. The MCP server works and is verified over stdio, but nothing has driven it end-to-end. The thing this was built for — measuring an AI's scheduling ability — has not been done, and until it is, the value of these scenarios as an *AI* benchmark is unproven. See `examples/` for where an LLM policy would slot in.

## Design rules

These are load-bearing. Breaking one makes the benchmark measure something other than what it claims.

**1. Determinism.** Every stochastic draw goes through the seeded `Rng`. Same `(scenario, seed, action sequence)` → identical episode, on any machine. Same-instant events fire in scheduling order, never heap order. Without this, two policies' scores are not comparable.

**2. The agent never reads latent state.** Patients have a true physiological state that drives reward. The agent sees `Vitals` — and only for patients it chose to measure, timestamped so it knows how stale they are. A policy that stops measuring stops seeing deterioration but still pays for it. The observation is tested to contain no `severity`, `hazard`, `trueEsi`, or `truePriority` field.

**3. The boundary is an interface, not a hardcode.** Everything past the ED exit — beds, OR, transfers, consultants, transport — implements `SupplyProcess` / `DownstreamBeds`. In v1 they are stochastic exogenous responders. In v2+ the same contract is backed by real simulations. Module 2+ abilities (`expediteDischarge`, `pushEvs`) are optional interface methods, gated out of the action mask with a stated reason. The ED never reaches past the interface.

**4. Every peek is noisy and stale.** In every implementation, forever. Staleness rides in the payload. A policy trained against v1 must not learn to trust a clean signal that later becomes real-but-still-noisy.

**5. Scarcity is correlated.** All externalities read a shared latent system-stress factor `S(t)`. As `S` rises: arrivals up, acuity up, downstream releases down, ambulance availability down (units are on 911 calls), consultant latency up, staff call-outs up, float pool empty, interrupt volume up — *simultaneously*, because they share a cause. Independent externalities make the environment far too easy; the failure mode that actually breaks hospitals is everything degrading at once. `S` is not observable. The agent gets a deliberately bad proxy and must infer stress from decline rates, ETA drift, and call-outs.

**6. Attention is finite.** Each human role is a server. Interrupts occupy roles, queue, ring back, and escalate. Claimed priority ≠ true priority, with per-source base rates: billing claims urgent and rarely is; a critical-value callback claims urgent and always is. Answering everything at claimed priority destroys throughput; discounting by source uniformly kills someone. Interrupting med prep or specimen collection raises the error rate on *that task*, which is how wrong-patient events are generated — they are caused, not sprinkled.

## What's modelled

| Area | Detail |
|---|---|
| Arrivals | Diurnal + `S`-scaled rate, Hawkes self-excitation for mass-casualty, EMS pre-alert with imperfect field triage, 72h bounce-back |
| Triage | ESI, danger-zone vitals as a hard floor, LWBS patience, reassessment intervals |
| ED | Beds by kind, negative pressure, acuity-weighted nurse ratios, fatigue, congestion slowdown, EVS with terminal cleans |
| Labs | Collection queue → POCT vs central → transport → accession → analyse → verify, rejection/redraw loop, critical-value callback clock, blood bank ladder + MTP |
| Imaging | Modality servers, protocolling, contrast/renal gate, transport-to-scanner, **read queue separate from acquisition** |
| Pharmacy | Verification queue (agent re-ranks, **never verifies**), cabinet/central/compounding, override list, high-alert two-person check, controlled-substance discrepancies |
| Behavioural | Psychiatric holds (cannot be discharged; need a psych bed — the longest tail), restraints with a 15-min check clock, sitters, elopement as a reportable event |
| Law enforcement | Blood draw gated on warrant or consent; custody, holds, violent patients as interrupts |
| Externalities | Three primitives: `SupplyProcess` (solicited), `InterruptChannel` (unsolicited), `AmbientState` (global modifiers) |
| Report handoff | A **rendezvous**, not a queue: two specific role-instances free simultaneously, shift-change refusal spike, escalation to house supervisor |

### Why the report handoff matters

A boarder cannot move even when a bed is clean and assigned until report is given. The ED nurse and the receiving unit nurse must be simultaneously free. The receiving nurse is in a med pass, in an admission, at lunch, or on another handoff. The bed sits ready and the patient sits in the ED for another 30–60 minutes.

Modelling this as a delay distribution would delete the decision. It is the highest-yield externality in Module 1: it sits directly on the boarding path, it is fully inside the ED's control surface, and in most real EDs no single role is accountable for it. `metrics().boarding` reports it separately from bed availability so the two causes never blur.

## Exploit guards

Every one is a test in `tests/guards.test.ts`. If one regresses, the score stops meaning anything.

| Exploit | Guard |
|---|---|
| Triage everyone ESI-4, empty the waiting room | Danger-zone vitals above ESI-2 is a hard floor; risk accrues from true state regardless |
| Discharge everyone | Unsafe-destination floor + 72h bounce-back process, returning sicker |
| Triage blind (skip measuring) | Triage requires vitals |
| Ignore all interrupts | Ringbacks, escalation, hard-floor deadlines |
| Answer all interrupts | Attention is finite; throughput collapses |
| Trust the capacity peek | Mandatory noise and staleness everywhere |
| Retry a blocked unsafe action forever | Floors dedupe per (patient, kind) — one mistake counts once |
| Discharge the psych board | A psychiatric hold is a legal status; discharge is refused outright |
| Restrain and forget | A 15-min check clock; **every** missed interval is its own floor (not deduped) |
| Do the officer a favour | Blood draw without warrant or consent is refused and floored |

## Scenarios

`ed-baseline`, `boarding-crisis`, `understaffed-nights`, `respiratory-season`, `mass-casualty` — each with a `-degraded-integrations` variant where EHR feeds go **silent without erroring**. Distinguishing "the feed is dead" from "the feed has nothing to report" is a graded capability: a policy that cannot detect an outage, fall back, and reconcile on recovery is not deployable.

## Roadmap

| Module | Adds | Unlocks |
|---|---|---|
| **1. ER** ✅ | Everything above; downstream as a stochastic interface | Boarding management, triage, ancillary orchestration, interrupt triage |
| **2. Inpatient wards** | Ward sim behind `DownstreamBeds`; rounding, discharge decisions, house-wide EVS | Boarding *causation*; `expedite_discharge`/`push_evs` enter the mask |
| **3. ICU + step-down** | Critical-care dynamics, vent/monitor resources | ICU rationing; the trauma anticipation loop becomes real |
| **4. OR + PACU** | Real OR behind the `OR` interface | Elective cancellation; PACU downstream-blocking cascade |
| **5. Discharge planning** | SNF/rehab placement, insurance auth, home health | The long-stay boarder; early-initiation value |

Each module adds actions to the mask and raises the clairvoyant ceiling. None rewrites the ED.

## Status

Module 1 is complete and tested, but the parameters are **plausible, not fitted**. Service times, hazards, and rates are drawn from reasonable priors and sanity-checked for ordering (untreated STEMI kills; untreated lacerations do not), not calibrated against a real ED's data. Anyone using this for research should recalibrate `src/domain/physiology.ts` and the scenario configs against their own numbers. The structure is the contribution; the constants are a starting point.

## License

MIT
