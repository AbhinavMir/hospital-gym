import type { Engine, Minutes } from '../kernel/engine.js';
import type { Rng } from '../kernel/rng.js';
import type { PatientId } from '../domain/types.js';
import type { AmbientState } from './ambient.js';
import { StressResponse } from './ambient.js';
import { StochasticSupply, type StochasticSupplyConfig, type SupplyStatus } from './supply.js';

/**
 * Discharge and inter-facility transport, as SupplyProcesses.
 *
 * The reason this is worth modelling rather than assuming a car always comes:
 * if the fallback ladder bottoms out, the discharge stalls and the bed does not
 * free. Rideshare unavailability propagates directly into boarding. That
 * coupling is the whole point.
 */

export type TransportTier = 'rideshare' | 'nemt' | 'taxi-voucher' | 'family-pickup' | 'bls' | 'als' | 'cct';

/** Mobility and clinical requirements a tier must satisfy. */
export interface TransportNeed {
  patient: PatientId;
  wheelchair: boolean;
  stretcher: boolean;
  /** Continuous monitoring en route. */
  monitored: boolean;
  /** Requires a paramedic-level escort. */
  paramedic: boolean;
  destination: string;
  /** True for a discharge home; false for an inter-facility transfer. */
  discharge: boolean;
}

/**
 * Which tiers can legally and safely carry a given need.
 *
 * Sending a standard car for a WAV-needing patient is a mobility mismatch;
 * sending a rideshare for a monitored patient is an inappropriate transport
 * tier, which is a hard safety floor.
 */
export function tierSatisfies(tier: TransportTier, need: TransportNeed): boolean {
  if (need.paramedic) return tier === 'als' || tier === 'cct';
  if (need.monitored) return tier === 'bls' || tier === 'als' || tier === 'cct';
  if (need.stretcher) return tier === 'nemt' || tier === 'bls' || tier === 'als' || tier === 'cct';
  if (need.wheelchair) return tier !== 'rideshare' && tier !== 'taxi-voucher';
  return true;
}

/** The fallback ladder, in order. Each rung has a different latency and cost. */
export const DISCHARGE_LADDER: TransportTier[] = ['rideshare', 'nemt', 'taxi-voucher', 'family-pickup'];
export const IFT_LADDER: TransportTier[] = ['bls', 'als', 'cct'];

export const TIER_COST: Record<TransportTier, number> = {
  rideshare: 1,
  nemt: 3,
  'taxi-voucher': 2,
  'family-pickup': 0,
  bls: 6,
  als: 10,
  cct: 18,
};

/**
 * Rideshare. Driver supply is time-of-day and geography dependent and degrades
 * with S. Failure modes: long ETA, cancellation, no-show, mobility mismatch,
 * wrong address.
 */
export function rideshareConfig(): StochasticSupplyConfig {
  return {
    name: 'rideshare',
    queueTimeoutMinutes: 30,
    capacity: 40,
    baseAvailability: 0.8,
    availabilityAtMaxStress: 0.35,
    baseEta: 9,
    etaAtMaxStress: 3.2,
    etaSpread: 1.7,
    declineAtZeroStress: 0.02,
    declineAtMaxStress: 0.3,
    noShowAtZeroStress: 0.05,
    noShowAtMaxStress: 0.25,
    etaRevisionProbability: 0.22,
    cancelGraceMinutes: 3,
    cancelCost: 1,
    // Thin overnight and at commuter peaks.
    hourCurve: (h) => (h >= 1 && h <= 5 ? 0.35 : h >= 7 && h <= 9 ? 0.6 : h >= 16 && h <= 19 ? 0.65 : 1),
    holdMinutes: 20,
  };
}

export function nemtConfig(): StochasticSupplyConfig {
  return {
    name: 'nemt',
    queueTimeoutMinutes: 150,
    capacity: 8,
    baseAvailability: 0.7,
    availabilityAtMaxStress: 0.4,
    baseEta: 55,
    etaAtMaxStress: 2.4,
    etaSpread: 1.6,
    declineAtZeroStress: 0.08,
    declineAtMaxStress: 0.45,
    noShowAtZeroStress: 0.04,
    noShowAtMaxStress: 0.18,
    etaRevisionProbability: 0.35,
    cancelGraceMinutes: 15,
    cancelCost: 3,
    hourCurve: (h) => (h >= 17 || h <= 6 ? 0.3 : 1), // NEMT largely business-hours
    holdMinutes: 60,
  };
}

export function taxiVoucherConfig(): StochasticSupplyConfig {
  return {
    name: 'taxi-voucher',
    queueTimeoutMinutes: 60,
    capacity: 12,
    baseAvailability: 0.75,
    availabilityAtMaxStress: 0.5,
    baseEta: 22,
    etaAtMaxStress: 2.0,
    etaSpread: 1.6,
    declineAtZeroStress: 0.05,
    declineAtMaxStress: 0.25,
    noShowAtZeroStress: 0.08,
    noShowAtMaxStress: 0.22,
    etaRevisionProbability: 0.25,
    cancelGraceMinutes: 10,
    cancelCost: 1,
    holdMinutes: 30,
  };
}

export function familyPickupConfig(): StochasticSupplyConfig {
  return {
    name: 'family-pickup',
    queueTimeoutMinutes: 180,
    capacity: 100,
    baseAvailability: 0.45, // family is often unreachable or unable
    availabilityAtMaxStress: 0.35,
    baseEta: 75,
    etaAtMaxStress: 1.6,
    etaSpread: 2.0,
    declineAtZeroStress: 0.3,
    declineAtMaxStress: 0.45,
    noShowAtZeroStress: 0.12,
    noShowAtMaxStress: 0.2,
    etaRevisionProbability: 0.4,
    cancelGraceMinutes: 30,
    cancelCost: 0,
    hourCurve: (h) => (h >= 23 || h <= 5 ? 0.35 : 1),
    holdMinutes: 45,
  };
}

/**
 * EMS / inter-facility transport agency.
 *
 * The key structural fact: the unit pool is SHARED WITH 911 RESPONSE. During a
 * surge, IFT units are pulled to emergency calls, so transport capacity drops
 * exactly when transfer demand rises. This is modelled as an availability curve
 * that collapses under S far harder than a standalone pool would.
 */
export class EmsAgency extends StochasticSupply<TransportNeed & { tier: TransportTier }> {
  constructor(
    engine: Engine,
    rng: Rng,
    ambient: AmbientState,
    private readonly tier: TransportTier,
    capacity: number,
  ) {
    super(engine, rng, ambient, {
      name: `ems-${tier}`,
      capacity,
      baseAvailability: 0.7,
      // Collapses under stress: units are on 911 calls, not moving your boarder.
      availabilityAtMaxStress: 0.15,
      baseEta: tier === 'cct' ? 90 : tier === 'als' ? 45 : 35,
      etaAtMaxStress: 3.5,
      etaSpread: 1.8,
      declineAtZeroStress: 0.06,
      declineAtMaxStress: 0.55,
      noShowAtZeroStress: 0.01,
      noShowAtMaxStress: 0.08,
      etaRevisionProbability: 0.4,
      cancelGraceMinutes: 20,
      cancelCost: 5,
      holdMinutes: 90,
    });
  }

  /**
   * Direct agency call instead of the broker. Costs attention (the caller has
   * to work the phone) but bypasses broker latency and gets a faster, more
   * honest answer. The trade is the agent's to make.
   */
  directCall(spec: TransportNeed & { tier: TransportTier }): { id: string; attentionCost: Minutes } {
    const id = this.request(spec);
    return { id, attentionCost: 4 };
  }

  /**
   * Level-of-care upgrade en route: a BLS transport that becomes ALS mid-route.
   * The agent finds out late and must re-plan.
   */
  maybeUpgrade(id: string): { upgraded: boolean; newTier: TransportTier } | null {
    const st = this.poll(id);
    if (st.status !== 'accepted') return null;
    const s = this.ambient.stress;
    if (this.tier === 'bls' && this.rng.bool(StressResponse.probability(s, 0.03, 0.12))) {
      return { upgraded: true, newTier: 'als' };
    }
    return null;
  }
}

/**
 * The broker. Adds latency and a layer of indirection over the agencies; the
 * alternative is a direct call, which costs attention.
 */
export class TransportBroker {
  constructor(
    private readonly engine: Engine,
    private readonly rng: Rng,
    private readonly agencies: Map<TransportTier, StochasticSupply<TransportNeed & { tier: TransportTier }>>,
  ) {}

  /** Broker request: slower to answer than a direct call. */
  request(spec: TransportNeed & { tier: TransportTier }): { id: string | null; reason?: string } {
    if (!tierSatisfies(spec.tier, spec)) {
      return { id: null, reason: `tier ${spec.tier} cannot carry this patient` };
    }
    const agency = this.agencies.get(spec.tier);
    if (!agency) return { id: null, reason: `no agency for tier ${spec.tier}` };
    return { id: agency.request(spec) };
  }

  poll(tier: TransportTier, id: string): SupplyStatus {
    return this.agencies.get(tier)?.poll(id) ?? { status: 'unknown' };
  }

  cancel(tier: TransportTier, id: string) {
    return this.agencies.get(tier)?.cancel(id) ?? { ok: true as const };
  }

  /**
   * Wrong address — a linkage error, not a supply failure. Surfaces as an
   * arrival that never materialises for this patient.
   */
  wrongAddressProbability(): number {
    return 0.02;
  }
}
