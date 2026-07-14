export { ErEnv, type StepResult } from './gym/env.js';
export { ActionSchema, actionMask, type Action, type ActionMask, type ActionResult } from './gym/actions.js';
export { buildObservation, type Observation, type PatientView, type OrderView, type InterruptView } from './gym/observation.js';
export { collectMetrics, type Metrics } from './gym/metrics.js';
export {
  computeReward,
  DEFAULT_WEIGHTS,
  DOOR_TO_PROVIDER_TARGET,
  type RewardWeights,
  type RewardComponents,
  type RewardTally,
} from './gym/reward.js';

export { SCENARIOS, getScenario, listScenarios, degraded } from './scenarios/index.js';
export type { ScenarioSpec } from './scenarios/types.js';

// The boundary. Module 2+ replaces the implementation, never the interface.
export {
  StochasticDownstream,
  type DownstreamBeds,
  type BedRequestSpec,
  type BedRequestState,
  type CapacityPeek,
  type StochasticDownstreamConfig,
} from './boundary/downstream.js';

// The three externality primitives.
export { StochasticSupply, type SupplyProcess, type SupplyStatus, type SupplyPeek } from './externalities/supply.js';
export {
  AttentionModel,
  type Interrupt,
  type InterruptState,
  type AttentionRole,
  type InterruptSource,
} from './externalities/attention.js';
export { AmbientState, StressResponse, type AmbientConfig } from './externalities/ambient.js';
export { ExternalityRegistry, type RegistryConfig } from './externalities/registry.js';
export { ReportHandoff, type HandoffRequest, type HandoffState } from './externalities/handoff.js';

export { Engine, type Minutes, formatClock, hourOfDay, MINUTE, HOUR, DAY } from './kernel/engine.js';
export { Rng } from './kernel/rng.js';

export * from './domain/types.js';
