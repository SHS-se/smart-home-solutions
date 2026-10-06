import {
  generateOptimisationPlanWithBatteryProjection,
  type OptimisationResult,
} from "./planner/energy-optimisation.ts";
import {
  type DispatchAuctionSolver,
  dispatchAuctionSteps,
  type DispatchResult,
  type ResponsiveRanking,
  type ResponsiveRankingCheckpoint,
} from "./planner/dispatch-plan.ts";
import type {
  EnergyPlanningContinuation,
  EnergyPlanningInput,
  EnergyPlanningStep,
} from "./energy-planning-protocol.ts";

/** A slice limit affects execution boundaries, never the planner's search budget. */
export interface PlanningBudget {
  spent: () => boolean;
  allowsAuction: () => boolean;
}

/** Leave CPU headroom for reconstruction, checkpoint encoding and storage. */
export function createPlanningBudget(durationMs = 900, primitiveLimit = 2_000_000): PlanningBudget {
  if (!(durationMs > 0) || !Number.isSafeInteger(primitiveLimit) || primitiveLimit < 1) {
    throw new Error("Planning slice budget must be positive");
  }
  const started = performance.now();
  let primitives = 0;
  const spent = () => ++primitives > primitiveLimit || performance.now() - started >= durationMs;
  return {
    spent,
    allowsAuction: () => primitives < primitiveLimit && performance.now() - started < durationMs,
  };
}

type Replay =
  | { done: true; result: OptimisationResult }
  | { done: false; problem: Parameters<DispatchAuctionSolver> }
  | { done: false; pause: true };

/**
 * Rebuild the deterministic planner's inputs, reusing completed auctions, up
 * to the first auction still missing. Device-response profile selection is
 * reconstructed deterministically; completed scalar searches are not repeated.
 * No functions need serializing.
 */
function replay(
  input: EnergyPlanningInput,
  completed: DispatchResult[],
  rankings: ResponsiveRanking[],
  budget?: PlanningBudget,
  allowNewRankings = true,
  rankingState: { checkpoint?: ResponsiveRankingCheckpoint } = {},
): Replay {
  let index = 0;
  let rankIndex = 0;
  let pausedRanking = false;
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
      (context, compute) => {
        const saved = rankings[rankIndex++];
        if (saved) {
          if (saved.context !== context) throw new Error("Planning ranking does not match the input");
          return saved.commands;
        }
        if (!allowNewRankings) throw new Error("Planning continuation is missing a ranking");
        if (rankingState.checkpoint && rankingState.checkpoint.context !== context) {
          throw new Error("Planning ranking checkpoint does not match the input");
        }
        const search = compute(rankingState.checkpoint?.cursor, budget?.spent);
        const step = search.next();
        if (step.done !== true) {
          rankingState.checkpoint = { context, cursor: step.value };
          pausedRanking = true;
          throw pending;
        }
        rankingState.checkpoint = undefined;
        const commands = step.value;
        rankings.push({ context, commands });
        if (budget && !budget.allowsAuction()) {
          pausedRanking = true;
          throw pending;
        }
        return commands;
      },
    );
    if (index !== completed.length || rankIndex !== rankings.length) {
      throw new Error("Planning continuation does not match the input");
    }
    return { done: true, result };
  } catch (error) {
    if (error !== pending) throw error;
    if (pausedRanking) return { done: false, pause: true };
    if (!problem) throw error;
    return { done: false, problem };
  }
}

/**
 * The plan from a finished chain's auctions. This reconstructs profile selection:
 * a missing scalar auction is an error, not work to do here.
 */
export function assembleOptimisationPlan(
  input: EnergyPlanningInput,
  completed: DispatchResult[],
  rankings: ResponsiveRanking[],
): OptimisationResult {
  const replayed = replay(input, completed, rankings, undefined, false);
  if (replayed.done !== true) {
    throw new Error("Planning continuation is missing an auction");
  }
  return replayed.result;
}

/**
 * Advance immutable planning input as far as `budget` allows. The caller owns
 * durable storage, fencing and publication; this module returns only additions
 * and the active numeric cursor.
 *
 * A call ranks a responsive neighborhood, starts an auction, or resumes one.
 * Rankings cross the wire once, so their reconstruction never spends CPU again.
 * Within the budget it carries on across stage boundaries and into the next auction;
 * each boundary a call does not stop at is a checkpoint that never crosses the
 * wire. Without a budget it runs exactly one stage.
 */
export function energyPlanningStep(
  input: EnergyPlanningInput,
  continuation: EnergyPlanningContinuation = { completed: [], rankings: [] },
  budget?: PlanningBudget,
): EnergyPlanningStep {
  if (continuation.checkpoint && continuation.ranking_checkpoint) {
    throw new Error("Planning continuation cannot resume an auction and ranking together");
  }
  const rankings = [...continuation.rankings];
  const previous = rankings.length;
  const rankingState = { checkpoint: continuation.ranking_checkpoint };
  const step = advanceAuctions(completed => replay(input, completed, rankings, budget, true, rankingState), continuation, budget);
  return { ...step, rankings: rankings.slice(previous), ranking_checkpoint: rankingState.checkpoint };
}

/** Shared resumable auction driver; callers own their final result and scoring. */
export function advanceAuctions(
  resolve: (completed: DispatchResult[]) => {done: true} | {done: false; problem: Parameters<DispatchAuctionSolver>} | {done: false; pause: true},
  continuation: Pick<EnergyPlanningContinuation, "completed" | "checkpoint"> = {completed: []},
  budget?: PlanningBudget,
): Omit<EnergyPlanningStep, "rankings"> {
  let completed = continuation.completed;
  let checkpoint = continuation.checkpoint;
  const finished: DispatchResult[] = [];
  for (;;) {
    // Rebuilding a response neighborhood can itself be expensive. Do not
    // reconstruct the next auction after this request has spent its allowance.
    if (finished.length > 0 && !budget?.allowsAuction()) {
      return { done: false, completed: finished };
    }
    const replayed = resolve(completed);
    if (replayed.done === true) {
      if (checkpoint) {
        throw new Error("Planning continuation does not match the input");
      }
      return { done: true, completed: finished };
    }
    if ("pause" in replayed) return { done: false, completed: finished };
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
