import {
  generateOptimisationPlanWithBatteryProjection,
  type OptimisationResult,
} from "./energy-optimisation.ts";
import {
  type DispatchAuctionSolver,
  dispatchAuctionSteps,
  type DispatchResult,
} from "./dispatch-plan.ts";
import type {
  EnergyPlanningContinuation,
  EnergyPlanningInput,
  EnergyPlanningStep,
} from "./energy-planning-protocol.ts";

/** How much of a worker call's CPU the planning chain may still use. */
export interface PlanningBudget {
  /** Once true, the transfer and refinement stages pause part-way. */
  spent: () => boolean;
  /** Whether an auction, whose bidding and settlement cannot pause, may start. */
  allowsAuction: () => boolean;
}

type Replay =
  | { done: true; result: OptimisationResult }
  | { done: false; problem: Parameters<DispatchAuctionSolver> };

/**
 * Rebuild the deterministic planner's inputs, reusing completed auctions, up
 * to the first auction still missing. Rebuilding is cheap, no search is
 * repeated, and no functions need serializing.
 */
function replay(
  input: EnergyPlanningInput,
  completed: DispatchResult[],
): Replay {
  let index = 0;
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
  try {
    const result = generateOptimisationPlanWithBatteryProjection(
      input.snapshot,
      new Date(input.now),
      input.price_archive,
      input.resolved_price_outlook,
      input.fixed_plan,
      solveAuction,
    );
    if (index !== completed.length) {
      throw new Error("Planning continuation does not match the input");
    }
    return { done: true, result };
  } catch (error) {
    if (error !== pending || !problem) throw error;
    return { done: false, problem };
  }
}

/**
 * The plan from a finished chain's auctions. This replays, it never searches:
 * a missing auction is an error, not work to do here.
 */
export function assembleOptimisationPlan(
  input: EnergyPlanningInput,
  completed: DispatchResult[],
): OptimisationResult {
  const replayed = replay(input, completed);
  if (replayed.done !== true) {
    throw new Error("Planning continuation is missing an auction");
  }
  return replayed.result;
}

/**
 * Advance the planning chain as far as `budget` allows, then hand back what
 * this call added. There is no stored job or partial plan to race with a newer
 * push.
 *
 * Every call starts or resumes an auction. Within the budget it carries on
 * across stage boundaries and, while `allowsAuction`, into the next auction;
 * each boundary a call does not stop at is a checkpoint that never crosses the
 * wire. Without a budget it runs exactly one stage.
 */
export function energyPlanningStep(
  input: EnergyPlanningInput,
  continuation: EnergyPlanningContinuation = { completed: [] },
  budget?: PlanningBudget,
): EnergyPlanningStep {
  let completed = continuation.completed;
  let checkpoint = continuation.checkpoint;
  const finished: DispatchResult[] = [];
  for (;;) {
    const replayed = replay(input, completed);
    if (replayed.done === true) {
      if (checkpoint) {
        throw new Error("Planning continuation does not match the input");
      }
      return { done: true, completed: finished };
    }
    if (finished.length > 0 && !budget?.allowsAuction()) {
      return { done: false, completed: finished };
    }
    const [slots, stores, limits, options] = replayed.problem;
    const steps = dispatchAuctionSteps(
      slots,
      stores,
      limits,
      options,
      checkpoint,
      budget?.spent,
    );
    let step = steps.next();
    while (step.done !== true) {
      if (!budget || budget.spent()) {
        return { done: false, completed: finished, checkpoint: step.value };
      }
      step = steps.next();
    }
    finished.push(step.value);
    completed = [...completed, step.value];
    checkpoint = undefined;
  }
}
