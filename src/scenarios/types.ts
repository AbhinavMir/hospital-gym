import type { Minutes } from '../kernel/engine.js';
import type { StochasticDownstreamConfig } from '../boundary/downstream.js';
import type { RegistryConfig } from '../externalities/registry.js';
import type { EdConfig } from '../modules/ed.js';
import type { LabConfig } from '../modules/labs.js';
import type { ImagingConfig } from '../modules/imaging.js';
import type { PharmacyConfig } from '../modules/pharmacy.js';
import type { ArrivalConfig } from '../modules/arrivals.js';
import type { RewardWeights } from '../gym/reward.js';

export interface ScenarioSpec {
  name: string;
  description: string;
  /** What this scenario is testing. Shown to the agent — it is not a secret. */
  tests: string;
  durationMinutes: Minutes;
  /** Sim minutes advanced per `step`. */
  tickMinutes: Minutes;
  startHour: number;
  oNegStock: number;
  ed: EdConfig;
  lab: LabConfig;
  imaging: ImagingConfig;
  pharmacy: PharmacyConfig;
  arrivals: ArrivalConfig;
  downstream: StochasticDownstreamConfig;
  registry: RegistryConfig;
  weights?: RewardWeights;
}
