# PLAN.md — er-gym

Persistent working context. Update after each subsystem lands.

## What this is

An open-source TypeScript benchmark gym for AI scheduling/orchestration policies, modelling
an emergency department kernel. Exposed over MCP so a policy can drive it as tools.
Module 1 = ER only. Modules 2-5 (wards, ICU, OR, discharge planning) snap in behind
interfaces without rewriting the ED.

## Non-negotiable design rules

1. **Determinism.** Every draw goes through `Rng` (`src/kernel/rng.ts`). Never `Math.random()`.
   Same (scenario, seed, action sequence) → same episode, or scores are not comparable.
   Engine ties broken by insertion `seq`, never heap order.
2. **The boundary is an interface, not a hardcode.** `SupplyProcess` / `DownstreamBeds`.
   v1 = stochastic exogenous responder; v2 = real ward sim behind the identical contract.
   Module 2+ abilities (`expediteDischarge`, `pushEvs`) are OPTIONAL methods, gated out of
   the v1 action mask. The ED never reaches past the interface.
3. **Peeks are always noisy and stale**, in every implementation. A policy must not learn to
   trust a clean signal that later becomes real-but-still-noisy.
4. **The agent never reads latent state.** It reads measurements it chose to take.
   Reward reads latent. That gap is the point.
5. **Correlated scarcity.** Everything reads `AmbientState.stress` (S). Independent
   externalities make the env far too easy; the real failure mode is everything degrading
   at once. S is not observable — only noisy proxies.
6. **Attention is finite.** Interrupts occupy role-servers. Claimed ≠ true priority.

## Status: Module 1 + dashboard + logging + behavioural/LE pathways. 55/55 tests pass.
Pushed: github.com/AbhinavMir/hospital-gym (public, main).

Calibration sanity (seed-dependent, `ed-baseline`):
- null policy (no actions at all): 19 deaths / 133 arrivals. Deaths concentrate correctly —
  6/6 STEMI, 5/7 stroke, 3/16 respiratory, 0/36 minor, 0/9 psych. The model discriminates.
- reference (deliberately bad) policy: ~7-8 deaths. Beats null → the gradient points the right way.
  It never orders ecg/aspirin/thrombolytic, so its STEMI patients die. That is correct.
- `boarding-crisis` vs `ed-baseline` chain verified: stress ↑ → handoff refusals 0.13→0.33 →
  handoff latency 15→37min → boarding 3.9→7.1h → LWBS 0.26→0.42 → deaths 7→21.
  Correlated scarcity is doing real work, not decorating.

### Done
- `src/kernel/` — rng (sfc32 + distributions + fork), heap, engine (DES, deterministic ties)
- `src/domain/types.ts` — patients, orders, beds, staff, safety floors
- `src/domain/physiology.ts` — latent state, condition profiles, hazard, danger zone,
  vitals measurement, unsafe-discharge risk
- `src/boundary/downstream.ts` — `DownstreamBeds` + `StochasticDownstream` (v1).
  Release process reproduces the morning-discharge lag → afternoon boarding peak.
- `src/externalities/ambient.ts` — S(t) as OU process + events + downtime; `StressResponse` curves
- `src/externalities/supply.ts` — `SupplyProcess` + `StochasticSupply` (declines, ETA
  revisions, no-shows, cancel cost, noisy peek)
- `src/externalities/attention.ts` — role servers, interrupts, defer/batch/delegate,
  role-locking, ringbacks, task-switch cost, false-urgency base rates
- `src/externalities/handoff.ts` — report rendezvous (two specific role-instances free
  simultaneously), shift-change refusal spike, escalation to house supervisor
- `src/externalities/interrupts.ts` — billing, legal/risk, law enforcement, family, admin, media
- `src/externalities/transport.ts` — rideshare/NEMT/taxi/family ladder + EMS IFT agencies
  (pool shared with 911 → collapses under S) + broker
- `src/externalities/registry.ts` — one registration point for all three primitives

- `src/modules/ed.ts` — beds, nurse ratios, fatigue, call-outs, float/overtime, ED EVS queue
- `src/modules/labs.ts` — full pipeline, rejection/redraw, critical callback clock, blood bank + MTP
- `src/modules/imaging.ts` — modality servers, protocolling, contrast/renal gate, read queue
  separate from acquisition
- `src/modules/pharmacy.ts` — verification queue (re-rank only), override list, two-person check,
  controlled-substance discrepancies
- `src/modules/arrivals.ts` — diurnal + Hawkes arrivals, EMS pre-alert, bounce-back process
- `src/gym/` — env, actions + mask, observation (latent-leak tested), reward, metrics
- `src/scenarios/` — 5 scenarios + `degraded()` variant generator
- `src/mcp/server.ts` — 7 tools, verified over stdio
- `src/viz/` — live board. node:http + SSE + one embedded page, zero deps. On by default
  under MCP (er_reset returns URL, er_step pushes a frame); ER_GYM_VIZ=0 disables.
  Notice goes to STDERR — stdout is the MCP transport and any stray byte corrupts it.
  Renders the observation only, never world state; a test enforces that.
- `tests/` — determinism (6) + exploit guards (14) + IT downtime (6) + viz (6). 32 total, all pass.
- README with the v1 boarding limitation stated up front, and the caveat carried in `metrics()`

### Iteration 2 (loop) — fixed
- **`availableUnits()` used Math.floor → every capacity-1 pool was permanently dead.**
  A consult service (pool 1) at any stress computed 0.8 units, floored to 0, and never
  existed. So `order_consult` could never complete — meaning stroke (neurology) and STEMI
  (cardiology/cath-lab) were UNTREATABLE by any policy. Now rounds.
- **Consult requests were never polled.** Set in the action handler, read by nothing.
  Added `consultTick`: completes the order, advances treatment, and declines loudly when
  the consultant will not come (that is a disposition decision, not a wait).
- **OR dispositions never departed.** `orRequests` now tracked and polled.
- **Queued requests waited forever.** Added `queueTimeoutMinutes` per process — an infinite
  wait is not a decision. Tuned per semantics: EVS/internal transport are staff and do not
  decline (long timeout); consults 2h; psych beds 72h (the real long tail); rideshare 30m.
- **EVS was structurally impossible.** 3 staff × 720m ÷ 25m hold ≈ 86 cleans vs 100+ needed,
  and my new timeout made the ED re-request and lose queue position — a starvation livelock.
  evsStaff 3→6. Result: EVS fill 0.24→0.80, declines 80→1, deaths 18→6, LWBS 0.26→0.09.
- Metrics stubs now real: `supply.byProcess` (fill rate, ETA error, mean stress at request),
  `evsTurnaroundP50`, `fallbackLadderDepthMean`, `meanStressAtBedRequest`, `diversionHours`
  (reads the tally, no longer reverse-derived from the reward component).
- `moduleCaveat` corrected — it still claimed the clairvoyant ceiling was computed.
- Structured logging: `src/kernel/log.ts`, JSONL + run summary. `npm run logs`.
  Tested that logging never consumes RNG (logged and unlogged runs are identical).

### Iteration 3 (loop) — extended toward a complete ER
- **Psychiatric holds.** psych-bed was registered but unreachable. Now: `request_psych_bed`,
  departure path, and re-search on decline. A hold CANNOT be discharged — without that guard
  discharging the psych board is the cheapest exploit in the module, and the reference policy
  was doing exactly it (psych boarding read 1.16h; now 5.92h mean / 10.25h max = the real tail).
  A hold who walks out ELOPES: mandatory non-deferrable legal notification, not a quiet LWBS.
  A hold in a hallway bed with no sitter is a floor.
- **Restraints.** 15-min check clock, funded with a nurse, until release. Each missed interval
  is its OWN floor — deliberately not deduped (2h unchecked != one missed check). Clock is in
  the observation: a floor you cannot see coming is a trap, not a test. Unchecked restraints
  raise the hazard.
- **Law enforcement.** `police_blood_draw` refused + floored without warrant/consent.
- 3 new floors priced with the identity tier; new `metrics().behavioural` block.

### Known gaps / next
- `metrics().supply.byProcess` is a stub `{}` — needs per-process request/fill/no-show/decline
  counters threaded out of `StochasticSupply`. Same for `fallbackLadderDepthMean`,
  `anticipation.meanStressAtBedRequest`, `capacity.evsTurnaroundP50`.
- `capacity.diversionHours` is derived from the reward component; should read the tally directly.
- No clairvoyant upper bound implemented yet. README claim SOFTENED to say so explicitly.
  Build it next: replay the same seed's release process with a perfect-information policy.
- Parameters are plausible, not fitted. Stated honestly in the README's Status section.
- Dead code still unwired: `EmsAgency.maybeUpgrade` (BLS→ALS en route), `directCall`,
  `wrongAddressProbability`, `TransportBroker` (registry builds it, env never uses it),
  `blood-products` supply (BloodBank is a separate class), `stopMtp`/`isMtpActive`,
  `acknowledgePreAlert`. Either wire or delete — leaving them is a lie about coverage.
- No AMA action (`Disposition` has the `ama` kind but nothing produces it).
- No re-triage: danger-zone check only fires at initial triage. A patient who decompensates
  in the waiting room is never re-triaged, so the under-triage floor cannot catch it.
- Viz does not show restraints/psych holds.
- ~~IT downtime does not actually degrade the read surface~~ FIXED. Full outage freezes the
  order board + empties capacity feeds; partial inflates staleness; silent outages never set
  `itDowntime`. Freeze is event-driven at the window boundary (NOT lazy on first observe —
  that made the frozen state depend on when the agent happened to look). 6 tests in
  tests/downtime.test.ts.

## Honest v1 limitation (must stay in README)

Boarding is observable and costly but only PARTIALLY actionable in Module 1. The agent can
compress ED-side contributors (request early, right level, sequence boarders, work the
report handoff, keep boarders from deteriorating, transfer out / divert). It cannot fix
inpatient discharge timing — that is Module 2. So v1 metrics measure boarding *management*,
not boarding *elimination*. INTENDED: a clairvoyant upper bound computed against the same
exogenous release process, so the ceiling is honest; when Module 2 lands the ceiling rises and
the same policy is re-benchmarked, and that delta measures what the hospital module buys.
NOT YET IMPLEMENTED — README says so explicitly. Until it exists, compare policies to each
other and to the reference policy, never to an absolute ceiling.

## Exploit guards (must not regress)

- discharge-everyone → blocked by bounce-back dynamics + unsafe-destination floor
- under-triage → blocked by danger-zone enforcement + true-state hazard
- ignore-all-interrupts → blocked by ringbacks, hard-floor deadlines, missed real ones
- answer-all-interrupts → blocked by attention scarcity destroying throughput
- trust-the-peek → blocked by mandatory noise/staleness in every peek
