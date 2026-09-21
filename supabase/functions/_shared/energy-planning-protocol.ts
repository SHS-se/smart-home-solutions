import type { OptimisationPlan, OptimisationSnapshot } from "./energy-optimisation.ts";
import type { DispatchCheckpoint, DispatchResult } from "./dispatch-plan.ts";
import type { StoredPriceRow } from "./energy-price-shape.ts";
import type { FixedEnergyPlan } from "./fixed-energy-plan.ts";

export const ENERGY_PLANNING_PROTOCOL = 6;

export interface EnergyPlanningInput {
  snapshot: OptimisationSnapshot;
  now: string;
  price_archive: StoredPriceRow[];
  fixed_plan?: FixedEnergyPlan | null;
  resolved_price_outlook?: OptimisationPlan["price_outlook"];
}

/** Everything the planning chain has produced so far; its caller holds it. */
export interface EnergyPlanningContinuation {
  completed: DispatchResult[];
  checkpoint?: DispatchCheckpoint;
}

/**
 * What one worker call adds to its caller's continuation. Each auction result
 * crosses the wire once, and the plan not at all: the caller assembles it from
 * the completed auctions, which is replay rather than search.
 */
export interface EnergyPlanningStep {
  /** Every auction the plan needs is complete. */
  done: boolean;
  /** Auctions this call finished, in order, to append to `completed`. */
  completed: DispatchResult[];
  /** Where the pending auction resumes; absent at an auction boundary. */
  checkpoint?: DispatchCheckpoint;
}
