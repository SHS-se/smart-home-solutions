import { generateOptimisationPlanWithBatteryProjection } from "./energy-optimisation.ts";
import {
  type DispatchAuctionSolver,
  dispatchAuctionSteps,
} from "./dispatch-plan.ts";
import type {
  EnergyPlanningContinuation,
  EnergyPlanningInput,
  EnergyPlanningStep,
} from "./energy-planning-protocol.ts";

/**
 * Execute one expensive stage, then hand its numeric state back to ingest.
 * Rebuilding the deterministic planner's inputs is cheap. Completed auctions
 * are reused while rebuilding, so no search is repeated and no functions need
 * serializing. There is no stored job or partial plan to race with a newer push.
 */
export function energyPlanningStep(
  input: EnergyPlanningInput,
  continuation: EnergyPlanningContinuation = { completed: [] },
): EnergyPlanningStep {
  let index = 0;
  const pending = new Error("dispatch_stage_pending");
  let problem: Parameters<DispatchAuctionSolver> | undefined;
  const solveAuction: DispatchAuctionSolver = (...args) => {
    if (index < continuation.completed.length) {
      // planDispatch adds alternative EV profiles to auction results. Keep the
      // saved stage result pristine for subsequent deterministic reconstruction.
      return structuredClone(continuation.completed[index++]);
    }
    problem = args;
    throw pending;
  };
  try {
    const result = generateOptimisationPlanWithBatteryProjection(
      input.snapshot,
      new Date(input.now),
      input.price_archive,
      input.resolved_price_outlook,
      input.fixed_plan,
      solveAuction,
    );
    if (index !== continuation.completed.length || continuation.checkpoint) {
      throw new Error("Planning continuation does not match the input");
    }
    return { done: true, ...result };
  } catch (error) {
    if (error !== pending || !problem) throw error;
  }
  const [slots, stores, limits, options] = problem;
  const step = dispatchAuctionSteps(
    slots,
    stores,
    limits,
    options,
    continuation.checkpoint,
  ).next();
  return {
    done: false,
    continuation: step.done === true
      ? { completed: [...continuation.completed, step.value] }
      : { completed: continuation.completed, checkpoint: step.value },
  };
}
