import type { ErEnv } from './env.js';
import type { Action } from './actions.js';
import { conditionProfile, inDangerZone } from '../domain/physiology.js';
import type { CareLevel, Patient } from '../domain/types.js';
import { LAB_TESTS } from '../modules/labs.js';
import { IMAGING_STUDIES } from '../modules/imaging.js';
import { DRUGS } from '../modules/pharmacy.js';

/**
 * THE ORACLE POLICY.
 *
 * This reads latent state directly. That is legitimate here and NOWHERE else:
 * the oracle exists to produce a reference ceiling, not to be benchmarked. An
 * agent that did this would be cheating; the oracle's whole job is to cheat, so
 * that we know what a policy with perfect information can achieve against the
 * same seed and the same exogenous release process.
 *
 * WHAT THIS IS NOT
 * ================
 * This is **not a proven upper bound**. A true clairvoyant bound would require
 * solving an NP-hard joint scheduling problem over beds, staff, ancillary
 * queues, and attention. This is a strong hand-written policy with perfect
 * information — an *achievable reference*, not a mathematical ceiling. A better
 * policy could in principle beat it.
 *
 * Calling it a bound would be a lie, so the metric is named `oracleReference`
 * and the normalised score is explicitly labelled as relative to it.
 *
 * What the oracle knows that an agent cannot:
 *  - each patient's true ESI, condition, and severity (no measurement needed)
 *  - exactly which orders advance treatment for that condition
 *  - that a bed request should go in the instant a disposition is decided
 *
 * What the oracle still CANNOT do — and this is the point of Module 1:
 *  - make a downstream bed appear. It faces the same exogenous release process.
 *  - make a consultant come, an ambulance arrive, or a unit take report.
 *  - escape the attention budget.
 *
 * So the oracle-vs-agent gap measures *management skill*, and the oracle's own
 * distance from perfection measures what Module 2 will later buy back.
 */

export interface OracleOptions {
  /** Treat the interrupt board honestly rather than by claimed priority. */
  triageInterrupts: boolean;
}

export class OraclePolicy {
  private bedRequested = new Set<string>();
  /** nurseId -> extra acuity weight already committed in the current batch. */
  private pendingAssignments = new Map<string, number>();
  /** Bed ids already claimed in the current batch. */
  private claimedBeds = new Set<string>();
  private ordered = new Set<string>();
  private dispositioned = new Set<string>();

  constructor(
    private readonly env: ErEnv,
    private readonly opts: OracleOptions = { triageInterrupts: true },
  ) {}

  /** Produce the action batch for this step, reading ground truth. */
  act(): Action[] {
    const a: Action[] = [];
    const env = this.env;
    // Provisional assignments made earlier in THIS batch. The env applies
    // actions in order, but we build the whole list against one snapshot — so
    // without this, two patients both pick the same "least loaded" nurse and
    // the second one breaches the ratio. Planning against stale within-batch
    // state is the bug; this is the fix.
    this.pendingAssignments.clear();
    this.claimedBeds.clear();

    for (const p of env.patients.values()) {
      if (p.phase === 'departed') continue;

      // Triage from TRUE acuity — but the danger zone overrides it. A trueEsi-3
      // patient who has deteriorated into danger-zone vitals IS an ESI-2 right
      // now; the label is about the underlying condition, the floor is about
      // current state. Triaging on the label alone earns the under-triage floor.
      if (p.esi === null) {
        // Measure FIRST, triage on the NEXT step. Batching both means esiFor
        // reads lastVitals before the measurement has landed, so the danger
        // zone is invisible and the under-triage floor fires on a patient the
        // oracle actually understood.
        if (p.lastVitals === null) {
          a.push({ type: 'measure_vitals', patient: p.id });
          a.push({ type: 'register', patient: p.id, mode: 'quick' });
          continue;
        }
        a.push({ type: 'triage', patient: p.id, esi: this.esiFor(p) });
        continue;
      }

      // Re-triage on deterioration: the danger zone keeps applying after the door.
      if (p.esi !== null && p.esi > 2 && p.lastVitals && inDangerZone(p.lastVitals)) {
        a.push({ type: 'measure_vitals', patient: p.id });
        a.push({ type: 'retriage', patient: p.id, esi: 2 });
      }

      // Room by true acuity: sickest into monitored beds first.
      if (p.phase === 'waiting-room') {
        const bed = this.pickBed(p);
        if (bed) {
          this.claimedBeds.add(bed);
          a.push({ type: 'place_bed', patient: p.id, bed });
        }
        continue;
      }

      if (p.phase !== 'in-bed' && p.phase !== 'boarding') continue;

      if (!p.assignedNurse) {
        const n = this.freeNurseFor(p);
        if (n) a.push({ type: 'assign_nurse', patient: p.id, nurse: n });
      }
      if (!p.assignedProvider) {
        const prov = this.leastLoadedProvider(p);
        if (prov) a.push({ type: 'assign_provider', patient: p.id, provider: prov });
      }

      // A hold without a sitter in an unsafe room is a floor. Fund the sitter.
      if (p.psychHold && !p.sitter) {
        const tech = [...this.env.ed.staff.values()].find(
          (s) => s.role === 'tech' && s.onDutyUntil > this.env.now && s.assigned.length === 0,
        );
        if (tech) a.push({ type: 'assign_sitter', patient: p.id, staff: tech.id });
      }

      // Order EXACTLY the workup that helps this condition — nothing else.
      // Shotgunning is what a policy without the oracle's information has to do.
      if (!this.ordered.has(p.id) && p.assignedProvider) {
        this.ordered.add(p.id);
        for (const name of conditionProfile(p.latent.condition).helpful) {
          a.push(...this.orderFor(p, name));
        }
      }

      // Disposition as soon as the workup has meaningfully landed, and request
      // the bed in the SAME breath — lead time is the ED's only real lever.
      if (!this.dispositioned.has(p.id) && p.firstProviderTime !== null && !p.disposition) {
        const done = p.latent.treatmentProgress;
        const better = p.latent.severity < 0.25;
        if (p.psychHold) {
          this.dispositioned.add(p.id);
          a.push({ type: 'request_psych_bed', patient: p.id });
        } else if (done >= 0.6 && better) {
          this.dispositioned.add(p.id);
          a.push({ type: 'decide_disposition', patient: p.id, disposition: 'discharge' });
        } else if (done >= 0.5 && !better) {
          this.dispositioned.add(p.id);
          const level = this.levelFor(p);
          a.push({ type: 'decide_disposition', patient: p.id, disposition: 'admit', level });
          a.push({ type: 'request_bed', patient: p.id, level });
          this.bedRequested.add(p.id);
        }
      }
    }

    const obs = env.observe();

    // Take every bed offer immediately: an unaccepted offer is withdrawn.
    for (const r of obs.bedRequests) {
      if (r.state === 'offered') a.push({ type: 'accept_bed_offer', request: r.request });
    }

    // Work the report handoff every single step. It is the highest-yield action
    // in the module and the oracle knows it.
    for (const h of obs.handoffs) {
      a.push({ type: 'attempt_handoff', handoff: h.id });
      if (h.attempts >= 2 && !h.escalated) a.push({ type: 'escalate_handoff', handoff: h.id });
    }

    // Critical callbacks: never miss one.
    for (const c of obs.queues.openCriticals) a.push({ type: 'ack_critical', order: c.order });

    // Notice rejections immediately — the oracle does not wait to be told.
    for (const o of obs.patients.flatMap((x) => x.orders)) {
      if (o.rejected) a.push({ type: 'redraw', order: o.id });
    }

    // Close every controlled-substance pull. Leaving one open past the audit
    // window is a discrepancy floor, and the oracle ordered the analgesia that
    // created it.
    for (const c of obs.queues.openControlled) {
      a.push({ type: 'document_controlled', order: c.order });
    }

    // Restraint clocks: always compliant.
    for (const p of obs.patients) {
      if (p.restraint && p.restraint.minutesUntilCheckDue <= 5) {
        a.push({ type: 'restraint_check', patient: p.id });
      }
    }

    // Transport at the correct tier, chosen from true state rather than guessed.
    for (const p of env.patients.values()) {
      if (p.phase === 'departed' || !p.disposition) continue;
      if (p.disposition.kind !== 'discharge') continue;
      if (env.hasTransport(p.id)) continue;
      a.push({ type: 'dispatch_transport', patient: p.id, tier: this.tierFor(p), direct: false });
    }

    if (this.opts.triageInterrupts) a.push(...this.handleInterrupts());
    a.push(...this.evs(obs));

    return a;
  }

  /**
   * Interrupt triage using TRUE priority. This is the single biggest advantage
   * the oracle has over any real policy: it never spends a minute of attending
   * time on a billing call that claimed to be urgent.
   */
  private handleInterrupts(): Action[] {
    const a: Action[] = [];
    const pending = this.env.registry.attention
      .pending()
      .sort((x, y) => x.interrupt.truePriority - y.interrupt.truePriority);

    const batchable = new Map<string, string[]>();
    let answered = 0;

    for (const { interrupt: i } of pending) {
      // Never defer what legally cannot be deferred.
      if (i.deferability === 'immediate') {
        a.push({ type: 'answer_interrupt', interrupt: i.id });
        continue;
      }
      if (i.truePriority <= 2 && answered < 3) {
        a.push({ type: 'answer_interrupt', interrupt: i.id });
        answered++;
        continue;
      }
      // Low true priority: batch it if we can, defer it if we cannot.
      if (i.batchable) {
        const g = batchable.get(i.source) ?? [];
        g.push(i.id);
        batchable.set(i.source, g);
      } else {
        a.push({ type: 'defer_interrupt', interrupt: i.id, minutes: 60 });
      }
    }

    for (const ids of batchable.values()) {
      if (ids.length >= 2) a.push({ type: 'batch_interrupts', interrupts: ids.slice(0, 6) });
    }
    return a;
  }

  private evs(obs: ReturnType<ErEnv['observe']>): Action[] {
    return obs.queues.cleaning.length
      ? [{ type: 'prioritise_cleaning', beds: obs.queues.cleaning }]
      : [];
  }

  private orderFor(p: Patient, name: string): Action[] {
    if (LAB_TESTS[name]) {
      const t = LAB_TESTS[name]!;
      return [{ type: 'order_lab', patient: p.id, test: name, priority: 'stat', route: t.poct ? 'poct' : 'central' }];
    }
    if (IMAGING_STUDIES[name]) {
      const st = IMAGING_STUDIES[name]!;
      // Respect the contrast gate: the oracle does not violate floors to win.
      if (st.contrast && p.renalCleared !== true) return [];
      if (!st.portable && !p.transportable) return [];
      return [{ type: 'order_imaging', patient: p.id, study: name, priority: 'stat', escort: (p.esi ?? 5) <= 2 }];
    }
    if (DRUGS[name]) {
      const d = DRUGS[name]!;
      const source = d.requiresCompounding ? 'compounding' : d.overridable ? 'cabinet' : 'central';
      return [{ type: 'order_med', patient: p.id, drug: name, priority: 'stat', source }];
    }
    // Anything else in the helpful list is a consult service.
    return [{ type: 'order_consult', patient: p.id, service: name, priority: 'stat' }];
  }

  private levelFor(p: Patient): CareLevel {
    // Request the level the patient actually needs. Over-requesting ICU burns
    // scarce capacity and gets declined — the oracle knows the true severity,
    // so it never does it.
    const s = p.latent.severity;
    if (s > 0.75) return 'icu';
    if (s > 0.55) return 'stepdown';
    if (s > 0.35) return 'telemetry';
    if (s > 0.15) return 'medsurg';
    return 'observation';
  }

  private tierFor(p: Patient): 'rideshare' | 'nemt' | 'taxi-voucher' | 'family-pickup' {
    // Match the tier to true mobility. Mirrors the env's own need model, so the
    // oracle never trips the inappropriate-tier floor.
    return p.latent.severity > 0.35 || !p.transportable ? 'nemt' : 'rideshare';
  }

  private pickBed(p: Patient): string | null {
    const needsMonitor = (p.latent.trueEsi ?? 5) <= 2;
    const beds = this.env.ed
      .availableBeds({ isolation: p.isolation, needsMonitor })
      // Two patients cannot take the same bed in one batch.
      .filter((b) => !this.claimedBeds.has(b.id));
    if (beds.length === 0) return null;
    // Resus bays for the truly critical; keep them free otherwise.
    const critical = p.latent.trueEsi === 1;
    let preferred = beds.filter((b) => (critical ? b.kind === 'resus' : b.kind !== 'resus'));
    // Never hallway a psychiatric hold: the room is what kills, not the label.
    if (p.psychHold) preferred = preferred.filter((b) => b.kind !== 'hallway');
    return (preferred[0] ?? beds.find((b) => !p.psychHold || b.kind !== 'hallway') ?? null)?.id ?? null;
  }

  /**
   * The danger zone overrides the true label. See the triage comment above.
   * Falls back to the true ESI when we have no measurement yet.
   */
  private esiFor(p: Patient) {
    if (p.lastVitals && inDangerZone(p.lastVitals)) {
      return Math.min(p.latent.trueEsi, 2) as 1 | 2;
    }
    return p.latent.trueEsi;
  }

  /**
   * Least-loaded nurse who is actually UNDER their cap. Assigning past the cap
   * is a ratio breach — a floor — so the oracle declines to assign rather than
   * commit one. The patient waits, which is the honest trade.
   */
  private freeNurseFor(p: Patient): string | null {
    const ed = this.env.ed;
    const weight = p.esi === 1 ? 4 : p.esi === 2 ? 1.5 : 1;
    const ns = ed
      .nurses()
      .filter((n) => n.onDutyUntil > this.env.now)
      // Ask whether the assignment WOULD breach, rather than assigning and
      // discovering it. The patient waiting is better than the floor.
      .filter((n) => !ed.wouldBreach(n.id, p, this.env.patients))
      // ...and account for what we already promised this nurse in this batch.
      .filter((n) => {
        const pending = this.pendingAssignments.get(n.id) ?? 0;
        const load = ed.nurseLoad(n.id, this.env.patients) + pending + weight;
        return load <= ed.nurseCap(n.id, this.env.patients);
      })
      .sort(
        (a, b) =>
          ed.nurseLoad(a.id, this.env.patients) + (this.pendingAssignments.get(a.id) ?? 0) -
          (ed.nurseLoad(b.id, this.env.patients) + (this.pendingAssignments.get(b.id) ?? 0)),
      );
    const chosen = ns[0]?.id ?? null;
    if (chosen) this.pendingAssignments.set(chosen, (this.pendingAssignments.get(chosen) ?? 0) + weight);
    return chosen;
  }

  private leastLoadedProvider(p: Patient): string | null {
    const ps = this.env.ed
      .providers()
      .filter((s) => s.onDutyUntil > this.env.now)
      .filter((s) => !(s.role === 'app' && p.latent.trueEsi === 1))
      .sort((a, b) => a.assigned.length - b.assigned.length);
    return ps[0]?.id ?? null;
  }
}
