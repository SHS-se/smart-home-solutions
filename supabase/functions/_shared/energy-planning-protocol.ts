import type { DispatchCheckpoint, DispatchResult, ResponsiveRanking, ResponsiveRankingCheckpoint } from "./planner/dispatch-plan.ts";

export const ENERGY_PLANNING_PROTOCOL = 8;

export type { EnergyPlanningInput } from "./planner/fixed-energy-plan.ts";

/** Everything the planning chain has produced so far; its caller holds it. */
export interface EnergyPlanningContinuation {
  completed: DispatchResult[];
  checkpoint?: DispatchCheckpoint;
  ranking_checkpoint?: ResponsiveRankingCheckpoint;
  /** Ordered response rankings, computed once for this immutable planning input. */
  rankings: ResponsiveRanking[];
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
  ranking_checkpoint?: ResponsiveRankingCheckpoint;
  /** Ordered response rankings, computed once for this immutable planning input. */
  rankings: ResponsiveRanking[];
}
