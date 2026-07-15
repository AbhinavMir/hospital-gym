import type { Engine, Minutes } from '../kernel/engine.js';
import type { Rng } from '../kernel/rng.js';
import type {
  BedId,
  BedKind,
  EdBed,
  Esi,
  Isolation,
  Patient,
  PatientId,
  SafetyEvent,
  Staff,
  StaffId,
} from '../domain/types.js';
import type { AmbientState } from '../externalities/ambient.js';
import { StressResponse } from '../externalities/ambient.js';
import type { SupplyProcess } from '../externalities/supply.js';

/**
 * The ED's own resources: beds, nurses, providers.
 *
 * Everything here is inside the module boundary — no interface indirection,
 * because Modules 2-5 never replace the ED's own physical plant.
 */

export interface EdConfig {
  beds: { kind: BedKind; count: number; monitored: boolean; negativePressure: number }[];
  nurses: number;
  physicians: number;
  apps: number;
  techs: number;
  /** Max patients per nurse for non-critical assignments. */
  ratioNormal: number;
  /** Critical and trauma patients are 1:1. */
  ratioCritical: number;
  shiftLengthMinutes: Minutes;
  floatPoolSize: number;
}

export type RatioBreach = { nurse: StaffId; load: number; cap: number; at: Minutes };

export class EdDepartment {
  readonly beds = new Map<BedId, EdBed>();
  readonly staff = new Map<StaffId, Staff>();
  readonly safetyEvents: SafetyEvent[] = [];
  /** ED beds waiting on EVS, in the order the agent prioritised them. */
  private cleaningQueue: BedId[] = [];
  private evsRequests = new Map<BedId, string>();
  /** Dirty -> clean, per bed. The EVS loop's actual turnaround. */
  readonly evsTurnarounds: number[] = [];
  private dirtySince = new Map<BedId, Minutes>();
  private floatUsed = 0;
  private overtimeMinutes = 0;

  constructor(
    private readonly engine: Engine,
    private readonly rng: Rng,
    private readonly ambient: AmbientState,
    private readonly evs: SupplyProcess<{ bed: BedId; terminal: boolean }>,
    readonly cfg: EdConfig,
  ) {
    let n = 0;
    for (const spec of cfg.beds) {
      for (let i = 0; i < spec.count; i++) {
        const id = `${spec.kind}-${i + 1}`;
        this.beds.set(id, {
          id,
          kind: spec.kind,
          monitored: spec.monitored,
          negativePressure: i < spec.negativePressure,
          status: 'clean',
          patient: null,
          needsTerminalClean: false,
        });
        n++;
      }
    }
    if (n === 0) throw new Error('EdDepartment: no beds configured');

    const mk = (role: Staff['role'], count: number, prefix: string) => {
      for (let i = 0; i < count; i++) {
        const id = `${prefix}-${i + 1}`;
        this.staff.set(id, {
          id,
          role,
          assigned: [],
          fatigue: 0,
          onDutyUntil: cfg.shiftLengthMinutes,
          busyUntil: 0,
          overtime: false,
        });
      }
    };
    mk('nurse', cfg.nurses, 'rn');
    mk('physician', cfg.physicians, 'md');
    mk('app', cfg.apps, 'app');
    mk('tech', cfg.techs, 'tech');

    this.fatigueTick();
    this.evsTick();
    this.callOutTick();
  }

  // --- beds -----------------------------------------------------------------

  bed(id: BedId): EdBed | undefined {
    return this.beds.get(id);
  }

  bedOf(patient: PatientId): EdBed | undefined {
    for (const b of this.beds.values()) if (b.patient === patient) return b;
    return undefined;
  }

  /** Beds that are clean, empty, and compatible with the patient's needs. */
  availableBeds(opts: { isolation: Isolation; needsMonitor: boolean; kind?: BedKind }): EdBed[] {
    return [...this.beds.values()].filter((b) => {
      if (b.status !== 'clean' || b.patient) return false;
      if (opts.kind && b.kind !== opts.kind) return false;
      if (opts.needsMonitor && !b.monitored) return false;
      if (opts.isolation === 'airborne' && !b.negativePressure) return false;
      // Hallway beds cannot hold isolation patients at all.
      if (opts.isolation !== 'none' && b.kind === 'hallway') return false;
      return true;
    });
  }

  place(patient: Patient, bedId: BedId): { ok: true } | { ok: false; reason: string } {
    const bed = this.beds.get(bedId);
    if (!bed) return { ok: false, reason: `no such bed ${bedId}` };
    if (bed.patient) return { ok: false, reason: `${bedId} occupied` };
    if (bed.status !== 'clean') return { ok: false, reason: `${bedId} is ${bed.status}` };
    if (patient.isolation === 'airborne' && !bed.negativePressure) {
      return { ok: false, reason: `${bedId} is not negative-pressure` };
    }
    if (patient.isolation !== 'none' && bed.kind === 'hallway') {
      return { ok: false, reason: 'isolation patient cannot go to a hallway bed' };
    }
    const prev = this.bedOf(patient.id);
    if (prev) this.vacate(prev.id, patient);
    bed.patient = patient.id;
    bed.status = 'occupied';
    patient.location = bedId;
    patient.phase = 'in-bed';
    return { ok: true };
  }

  vacate(bedId: BedId, patient: Patient): void {
    const bed = this.beds.get(bedId);
    if (!bed) return;
    bed.patient = null;
    bed.status = 'dirty';
    bed.needsTerminalClean = patient.isolation !== 'none';
    this.dirtySince.set(bedId, this.engine.now);
    if (!this.cleaningQueue.includes(bedId)) this.cleaningQueue.push(bedId);
  }

  /** Agent action: re-rank the ED cleaning queue. */
  prioritiseCleaning(order: BedId[]): void {
    const known = order.filter((b) => this.cleaningQueue.includes(b));
    const rest = this.cleaningQueue.filter((b) => !known.includes(b));
    this.cleaningQueue = [...known, ...rest];
  }

  get dirtyBeds(): BedId[] {
    return [...this.cleaningQueue];
  }

  /** Dispatch EVS against the queue as capacity allows. */
  private evsTick(): void {
    this.engine.schedule(2, 'ed:evs-tick', () => {
      for (const bedId of [...this.cleaningQueue]) {
        const bed = this.beds.get(bedId);
        if (!bed) continue;

        const existing = this.evsRequests.get(bedId);
        if (existing) {
          const st = this.evs.poll(existing);
          if (st.status === 'arrived') {
            // Terminal cleans for isolation take substantially longer.
            const duration = bed.needsTerminalClean
              ? this.rng.logSpread(45, 1.4)
              : this.rng.logSpread(20, 1.5);
            bed.status = 'cleaning';
            this.evsRequests.delete(bedId);
            this.cleaningQueue = this.cleaningQueue.filter((b) => b !== bedId);
            this.engine.schedule(duration, 'ed:clean-done', () => {
              bed.status = 'clean';
              bed.needsTerminalClean = false;
              const since = this.dirtySince.get(bedId);
              if (since !== undefined) {
                this.evsTurnarounds.push(this.engine.now - since);
                this.dirtySince.delete(bedId);
              }
            });
          } else if (st.status === 'no-show' || st.status === 'declined' || st.status === 'cancelled') {
            this.evsRequests.delete(bedId);
          }
          continue;
        }

        if (bed.status === 'dirty') {
          this.evsRequests.set(bedId, this.evs.request({ bed: bedId, terminal: bed.needsTerminalClean }));
        }
      }
      this.evsTick();
    });
  }

  // --- staff ----------------------------------------------------------------

  nurses(): Staff[] {
    return [...this.staff.values()].filter((s) => s.role === 'nurse');
  }

  providers(): Staff[] {
    return [...this.staff.values()].filter((s) => s.role === 'physician' || s.role === 'app');
  }

  staffMember(id: StaffId): Staff | undefined {
    return this.staff.get(id);
  }

  /**
   * Acuity-weighted nurse load. An ESI-1 counts as a full 1:1 assignment; an
   * in-progress admission still consumes capacity even though the patient is
   * "leaving". That second fact is why boarding eats nursing capacity and why
   * the ratio breaches show up during a boarding crisis rather than a volume one.
   */
  nurseLoad(nurse: StaffId, patients: Map<PatientId, Patient>): number {
    const s = this.staff.get(nurse);
    if (!s) return 0;
    let load = 0;
    for (const pid of s.assigned) {
      const p = patients.get(pid);
      if (!p) continue;
      if (p.esi === 1) load += this.cfg.ratioNormal / this.cfg.ratioCritical; // consumes the whole assignment
      else if (p.esi === 2) load += 1.5;
      else load += 1;
      if (p.phase === 'boarding') load += 0.5; // boarders are not free to nurse
    }
    return load;
  }

  nurseCap(nurse: StaffId, patients: Map<PatientId, Patient>): number {
    const s = this.staff.get(nurse);
    if (!s) return 0;
    const hasCritical = s.assigned.some((pid) => patients.get(pid)?.esi === 1);
    return hasCritical ? this.cfg.ratioNormal / this.cfg.ratioCritical : this.cfg.ratioNormal;
  }

  /**
   * Assign a nurse. Returns a ratio breach rather than silently allowing it —
   * the caller decides whether to record the safety floor, because an assignment
   * forced by a genuine surge and one made carelessly are the same event here.
   */
  assignNurse(
    nurse: StaffId,
    patient: Patient,
    patients: Map<PatientId, Patient>,
  ): { ok: true; breach: RatioBreach | null } | { ok: false; reason: string } {
    const s = this.staff.get(nurse);
    if (!s || s.role !== 'nurse') return { ok: false, reason: `no such nurse ${nurse}` };
    if (s.onDutyUntil <= this.engine.now && !s.overtime) {
      return { ok: false, reason: `${nurse} is off duty` };
    }
    if (s.assigned.includes(patient.id)) return { ok: true, breach: null };

    for (const other of this.nurses()) {
      other.assigned = other.assigned.filter((p) => p !== patient.id);
    }
    s.assigned.push(patient.id);
    patient.assignedNurse = nurse;

    const load = this.nurseLoad(nurse, patients);
    const cap = this.nurseCap(nurse, patients);
    if (load > cap) {
      return { ok: true, breach: { nurse, load, cap, at: this.engine.now } };
    }
    return { ok: true, breach: null };
  }

  assignProvider(provider: StaffId, patient: Patient): { ok: boolean; reason?: string } {
    const s = this.staff.get(provider);
    if (!s || (s.role !== 'physician' && s.role !== 'app')) {
      return { ok: false, reason: `no such provider ${provider}` };
    }
    // APPs cannot independently carry ESI-1.
    if (s.role === 'app' && patient.esi === 1) {
      return { ok: false, reason: 'APP cannot independently manage an ESI-1' };
    }
    if (!s.assigned.includes(patient.id)) s.assigned.push(patient.id);
    patient.assignedProvider = provider;
    if (patient.firstProviderTime === null) patient.firstProviderTime = this.engine.now;
    return { ok: true };
  }

  unassign(patient: PatientId): void {
    for (const s of this.staff.values()) {
      s.assigned = s.assigned.filter((p) => p !== patient);
    }
  }

  /** Agent action: call in float staff or authorise overtime. */
  callFloat(): { ok: boolean; reason?: string; nurse?: StaffId } {
    if (this.floatUsed >= this.cfg.floatPoolSize) {
      return { ok: false, reason: 'float pool exhausted' };
    }
    // The float pool empties under stress: the whole region is short.
    const s = this.ambient.stress;
    if (this.rng.bool(StressResponse.probability(s, 0.05, 0.7))) {
      return { ok: false, reason: 'no float staff available (regional shortfall)' };
    }
    this.floatUsed++;
    const id = `rn-float-${this.floatUsed}`;
    this.staff.set(id, {
      id,
      role: 'nurse',
      assigned: [],
      fatigue: 0.1,
      onDutyUntil: this.engine.now + this.cfg.shiftLengthMinutes,
      busyUntil: 0,
      overtime: false,
    });
    // Float staff take time to arrive and orient.
    return { ok: true, nurse: id };
  }

  authoriseOvertime(staffId: StaffId, minutes: Minutes): { ok: boolean; reason?: string } {
    const s = this.staff.get(staffId);
    if (!s) return { ok: false, reason: `no such staff ${staffId}` };
    // Fatigued staff can be held over, but it degrades them further — that is a
    // real cost, not a free capacity lever.
    s.overtime = true;
    s.onDutyUntil = Math.max(s.onDutyUntil, this.engine.now + minutes);
    s.fatigue = Math.min(1, s.fatigue + 0.15);
    this.overtimeMinutes += minutes;
    return { ok: true };
  }

  get overtimeUsed(): Minutes {
    return this.overtimeMinutes;
  }

  get floatUsedCount(): number {
    return this.floatUsed;
  }

  /**
   * Service-time multiplier for a staff member. Fatigue and congestion both
   * slow everything down — this is what makes a death spiral possible rather
   * than merely a bad hour.
   */
  slowdown(staffId: StaffId, patients: Map<PatientId, Patient>): number {
    const s = this.staff.get(staffId);
    if (!s) return 1;
    const fatigue = 1 + 0.5 * s.fatigue;
    const load = s.role === 'nurse' ? this.nurseLoad(staffId, patients) / Math.max(1, this.cfg.ratioNormal) : 1;
    const congestion = 1 + 0.25 * Math.max(0, load - 1);
    return fatigue * congestion;
  }

  private fatigueTick(): void {
    this.engine.schedule(30, 'ed:fatigue', () => {
      for (const s of this.staff.values()) {
        if (s.onDutyUntil <= this.engine.now) continue;
        const base = 0.012;
        const overtimePenalty = s.overtime ? 2.0 : 1;
        s.fatigue = Math.min(1, s.fatigue + base * overtimePenalty);
      }
      this.fatigueTick();
    });
  }

  /**
   * Staff call-outs rise with S and the float pool empties at the same time —
   * the same surge that brings the patients keeps the staff home.
   */
  private callOutTick(): void {
    this.engine.schedule(60, 'ed:call-out', () => {
      const s = this.ambient.stress;
      const p = StressResponse.probability(s, 0.005, 0.09);
      for (const st of this.nurses()) {
        if (st.onDutyUntil <= this.engine.now) continue;
        if (st.assigned.length === 0 && this.rng.bool(p)) {
          st.onDutyUntil = this.engine.now;
          this.safetyEvents.push({
            kind: 'ratio-breach',
            at: this.engine.now,
            patient: null,
            detail: `${st.id} called out; remaining nurses absorb the load`,
          });
        }
      }
      this.callOutTick();
    });
  }

  /** Snapshot for the observation. Beds are fully observable; the agent is in the room. */
  snapshot() {
    return {
      beds: [...this.beds.values()].map((b) => ({
        id: b.id,
        kind: b.kind,
        monitored: b.monitored,
        negativePressure: b.negativePressure,
        status: b.status,
        patient: b.patient,
      })),
      cleaningQueue: [...this.cleaningQueue],
      nurses: this.nurses().map((n) => ({
        id: n.id,
        assigned: [...n.assigned],
        fatigue: round2(n.fatigue),
        onDuty: n.onDutyUntil > this.engine.now,
        overtime: n.overtime,
      })),
      providers: this.providers().map((p) => ({
        id: p.id,
        role: p.role,
        assigned: [...p.assigned],
        fatigue: round2(p.fatigue),
        onDuty: p.onDutyUntil > this.engine.now,
      })),
      floatUsed: this.floatUsed,
      overtimeMinutes: Math.round(this.overtimeMinutes),
    };
  }
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** ESI-driven monitoring requirement. */
export function needsMonitor(esi: Esi | null): boolean {
  return esi !== null && esi <= 2;
}
