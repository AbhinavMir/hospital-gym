import type { Engine } from '../kernel/engine.js';
import type { Rng } from '../kernel/rng.js';
import type { CareLevel, PatientId } from '../domain/types.js';
import { AmbientState, type AmbientConfig } from './ambient.js';
import { AttentionModel, type AttentionRole } from './attention.js';
import { ReportHandoff, type HandoffConfig } from './handoff.js';
import { DEFAULT_CHANNELS, InterruptGenerator } from './interrupts.js';
import { StochasticSupply, type SupplyPeek, type SupplyProcess } from './supply.js';
import {
  EmsAgency,
  TransportBroker,
  familyPickupConfig,
  nemtConfig,
  rideshareConfig,
  taxiVoucherConfig,
  type TransportNeed,
  type TransportTier,
} from './transport.js';

/**
 * EXTERNALITY REGISTRY — every externality is registered in one place.
 *
 * Each supply process exposes the same request/poll/cancel contract. Each
 * interrupt channel emits typed interrupts against roles. Ambient state
 * modulates the parameters of both. This is what lets Modules 2-5 replace a
 * stochastic responder with a real simulation without the agent's code
 * changing.
 */
export interface RegistryConfig {
  ambient: AmbientConfig;
  handoff: HandoffConfig;
  headcounts: Partial<Record<AttentionRole, number>>;
  /** Consultant services and their pool sizes. */
  consultServices: Record<string, number>;
  psychBedCapacity: number;
  evsStaff: number;
  internalTransportStaff: number;
  orRooms: number;
}

export class ExternalityRegistry {
  readonly ambient: AmbientState;
  readonly attention: AttentionModel;
  readonly handoff: ReportHandoff;
  readonly supply = new Map<string, SupplyProcess<any>>();
  readonly broker: TransportBroker;
  private interruptGen: InterruptGenerator;

  constructor(
    engine: Engine,
    rng: Rng,
    cfg: RegistryConfig,
    census: () => PatientId[],
  ) {
    this.ambient = new AmbientState(engine, rng.fork('ambient'), cfg.ambient);
    this.attention = new AttentionModel(engine, rng.fork('attention'), cfg.headcounts);
    this.handoff = new ReportHandoff(engine, rng.fork('handoff'), this.ambient, this.attention, cfg.handoff);

    const reg = <T>(name: string, proc: SupplyProcess<T>) => {
      this.supply.set(name, proc);
      return proc;
    };

    // --- discharge transport ladder ---
    reg('rideshare', new StochasticSupply<TransportNeed>(engine, rng.fork('rideshare'), this.ambient, rideshareConfig()));
    reg('nemt', new StochasticSupply<TransportNeed>(engine, rng.fork('nemt'), this.ambient, nemtConfig()));
    reg('taxi-voucher', new StochasticSupply<TransportNeed>(engine, rng.fork('taxi'), this.ambient, taxiVoucherConfig()));
    reg('family-pickup', new StochasticSupply<TransportNeed>(engine, rng.fork('family'), this.ambient, familyPickupConfig()));

    // --- IFT agencies: pool shared with 911, so they collapse under stress ---
    const agencies = new Map<TransportTier, StochasticSupply<TransportNeed & { tier: TransportTier }>>();
    for (const [tier, cap] of [['bls', 6], ['als', 4], ['cct', 2]] as [TransportTier, number][]) {
      const agency = new EmsAgency(engine, rng.fork(`ems-${tier}`), this.ambient, tier, cap);
      agencies.set(tier, agency);
      reg(`ems-${tier}`, agency);
    }
    this.broker = new TransportBroker(engine, rng.fork('broker'), agencies);

    // --- consultants: one pool per service, availability by hour ---
    for (const [service, pool] of Object.entries(cfg.consultServices)) {
      reg(
        `consult-${service}`,
        new StochasticSupply(engine, rng.fork(`consult-${service}`), this.ambient, {
          name: `consult-${service}`,
          capacity: pool,
          baseAvailability: 1,
          availabilityAtMaxStress: 0.5,
          baseEta: 25,
          etaAtMaxStress: 3.0,
          etaSpread: 1.9,
          declineAtZeroStress: 0.02,
          declineAtMaxStress: 0.2,
          noShowAtZeroStress: 0.02,
          noShowAtMaxStress: 0.1,
          etaRevisionProbability: 0.3,
          cancelGraceMinutes: 10,
          cancelCost: 0,
          // Overnight coverage is thin: this is what converts an ED disposition
          // into an observation admission when no one will come see the patient.
          hourCurve: (h) => (h >= 19 || h < 7 ? 0.3 : 1),
          holdMinutes: 40,
        }),
      );
    }

    // --- psych beds: their own SupplyProcess, with terrible availability and
    //     strong S-correlation. The psych-hold boarder is the long tail. ---
    reg(
      'psych-bed',
      new StochasticSupply(engine, rng.fork('psych'), this.ambient, {
        name: 'psych-bed',
        capacity: cfg.psychBedCapacity,
        baseAvailability: 0.25,
        availabilityAtMaxStress: 0.05,
        baseEta: 8 * 60,
        etaAtMaxStress: 3.0,
        etaSpread: 2.2,
        declineAtZeroStress: 0.35,
        declineAtMaxStress: 0.75,
        noShowAtZeroStress: 0,
        noShowAtMaxStress: 0.02,
        etaRevisionProbability: 0.55,
        cancelGraceMinutes: 60,
        cancelCost: 0,
        holdMinutes: 24 * 60,
      }),
    );

    // --- in-house services ---
    reg('evs', new StochasticSupply(engine, rng.fork('evs'), this.ambient, {
      name: 'evs',
      capacity: cfg.evsStaff,
      baseAvailability: 1,
      availabilityAtMaxStress: 0.55,
      baseEta: 12,
      etaAtMaxStress: 2.5,
      etaSpread: 1.5,
      declineAtZeroStress: 0,
      declineAtMaxStress: 0.1,
      noShowAtZeroStress: 0,
      noShowAtMaxStress: 0.03,
      etaRevisionProbability: 0.2,
      cancelGraceMinutes: 5,
      cancelCost: 0,
      hourCurve: (h) => (h >= 23 || h < 6 ? 0.5 : 1),
      holdMinutes: 25,
    }));

    reg('internal-transport', new StochasticSupply(engine, rng.fork('int-transport'), this.ambient, {
      name: 'internal-transport',
      capacity: cfg.internalTransportStaff,
      baseAvailability: 1,
      availabilityAtMaxStress: 0.5,
      baseEta: 10,
      etaAtMaxStress: 2.8,
      etaSpread: 1.6,
      declineAtZeroStress: 0,
      declineAtMaxStress: 0.12,
      noShowAtZeroStress: 0,
      noShowAtMaxStress: 0.04,
      etaRevisionProbability: 0.25,
      cancelGraceMinutes: 5,
      cancelCost: 0,
      holdMinutes: 20,
    }));

    reg('blood-products', new StochasticSupply(engine, rng.fork('blood'), this.ambient, {
      name: 'blood-products',
      capacity: 20,
      baseAvailability: 0.9,
      availabilityAtMaxStress: 0.45,
      baseEta: 15,
      etaAtMaxStress: 2.2,
      etaSpread: 1.5,
      declineAtZeroStress: 0,
      declineAtMaxStress: 0.15,
      noShowAtZeroStress: 0,
      noShowAtMaxStress: 0.02,
      etaRevisionProbability: 0.15,
      cancelGraceMinutes: 10,
      cancelCost: 2,
      holdMinutes: 30,
    }));

    // --- OR: exogenous in Module 1; real simulation in Module 4, same iface ---
    reg('or-room', new StochasticSupply(engine, rng.fork('or'), this.ambient, {
      name: 'or-room',
      capacity: cfg.orRooms,
      baseAvailability: 0.5,
      availabilityAtMaxStress: 0.2,
      baseEta: 40,
      etaAtMaxStress: 2.5,
      etaSpread: 1.7,
      declineAtZeroStress: 0.05,
      declineAtMaxStress: 0.4,
      noShowAtZeroStress: 0,
      noShowAtMaxStress: 0.02,
      etaRevisionProbability: 0.35,
      cancelGraceMinutes: 15,
      cancelCost: 8,
      // Overnight: one room, one team. An emergent case in the room means the
      // next emergent case waits. Daytime rooms are eaten by the elective block.
      hourCurve: (h) => (h >= 19 || h < 7 ? 0.2 : h >= 7 && h < 17 ? 0.45 : 1),
      holdMinutes: 150,
    }));

    this.interruptGen = new InterruptGenerator(
      engine,
      rng.fork('interrupts'),
      this.ambient,
      this.attention,
      DEFAULT_CHANNELS,
      census,
    );
  }

  get<T = unknown>(name: string): SupplyProcess<T> {
    const p = this.supply.get(name);
    if (!p) throw new Error(`ExternalityRegistry: no supply process "${name}"`);
    return p as SupplyProcess<T>;
  }

  has(name: string): boolean {
    return this.supply.has(name);
  }

  /** Noisy peeks across every supply process, for the observation. */
  peekAll(): SupplyPeek[] {
    return [...this.supply.values()].map((p) => p.peek());
  }

  consultFor(service: string): SupplyProcess | null {
    return this.supply.get(`consult-${service}`) ?? null;
  }
}

export type { CareLevel };
