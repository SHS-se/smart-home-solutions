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
 * `budgetSpent` lets the transfer and refinement stages stop part-way instead
 * of finishing within this call; the next call resumes from the checkpoint.
 */
export function energyPlanningStep(
  input: EnergyPlanningInput,
  continuation: EnergyPlanningContinuation = { completed: [] },
  budgetSpent?: () => boolean,
): EnergyPlanningStep {
  let index = 0;
  let completed = continuation.completed;
  const pending = new Error("dispatch_stage_pending");
  let problem: Parameters<DispatchAuctionSolver> | undefined;
  const solveAuction: DispatchAuctionSolver = (...args) => {
    if (index < completed.length) {
      // planDispatch adds alternative EV profiles to auction results. Keep the
      // saved stage result pristine for subsequent deterministic reconstruction.
      return structuredClone(completed[index++]);
    }
    problem = args;
    throw pending;
  };
  const assemble = () => generateOptimisationPlanWithBatteryProjection(
      input.snapshot,
      new Date(input.now),
      input.price_archive,
      input.resolved_price_outlook,
      input.fixed_plan,
      solveAuction,
    );
  try {
    const result = assemble();
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
    budgetSpent,
  ).next();
  if (step.done === true) {
    completed = [...completed, step.value];
    index = 0;
    try {
      // Assembly is cheap: avoid another full request just to return the plan.
      const result = assemble();
      return { done: true, ...result };
    } catch (error) {
      if (error !== pending) throw error;
      // Another auction needs its own CPU stage; never start it here.
      return { done: false, continuation: { completed } };
    }
  }
  return { done: false, continuation: { completed, checkpoint: step.value } };
}
