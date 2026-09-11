import type {
  OptimisationPlan,
  OptimisationSnapshot,
} from "./energy-optimisation.ts";
import type { DispatchCheckpoint, DispatchResult } from "./dispatch-plan.ts";
import type { StoredPriceRow } from "./energy-price-shape.ts";
import type { FixedEnergyPlan } from "./fixed-energy-plan.ts";

export const ENERGY_PLANNING_PROTOCOL = 1;

export interface EnergyPlanningInput {
  snapshot: OptimisationSnapshot;
  now: string;
  price_archive: StoredPriceRow[];
  fixed_plan?: FixedEnergyPlan | null;
  resolved_price_outlook?: OptimisationPlan["price_outlook"];
}

export interface EnergyPlanningContinuation {
  completed: DispatchResult[];
  checkpoint?: DispatchCheckpoint;
}

export type EnergyPlanningStep =
  | { done: true; plan: OptimisationPlan }
  | { done: false; continuation: EnergyPlanningContinuation };
