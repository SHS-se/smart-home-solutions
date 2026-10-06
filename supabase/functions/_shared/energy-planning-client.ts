import type { OptimisationResult } from "./planner/energy-optimisation.ts";
import type { DispatchCheckpoint, DispatchResult, ResponsiveRankingCheckpoint } from "./planner/dispatch-plan.ts";
import {
  ENERGY_PLANNING_PROTOCOL,
  type EnergyPlanningInput,
  type EnergyPlanningStep,
} from "./energy-planning-protocol.ts";
import { assembleOptimisationPlan } from "./energy-planning-step.ts";
import { describeThrown } from "./ha-api-contract.ts";

const MAX_STEPS = 512;
/** Resource bound, separate from the measured website completion target. */
export const PLANNING_EXECUTION_TIMEOUT_MS = 120_000;

export class EnergyPlanningError extends Error {
  constructor(message: string, readonly status: 400 | 502 = 502, readonly code = "planning_failed") {
    super(message);
    this.name = "EnergyPlanningError";
  }
}

/**
 * Network waits do not consume ingest's CPU budget, so every auction is solved
 * by the planning worker; never solve inline. The worker returns each finished
 * auction once and ingest assembles the plan from them, which is replay rather
 * than search: the multi-megabyte plan never crosses the worker boundary.
 */
export async function generateRemoteOptimisationPlan(
  input: EnergyPlanningInput,
  connection: {
    url: string;
    planningSecret: string;
    requestId: string;
    /** Absolute monotonic deadline supplied by the household request owner. */
    deadline?: number;
  },
  fetcher: typeof fetch = fetch,
): Promise<OptimisationResult> {
  if (
    !connection.url || !connection.planningSecret
  ) {
    throw new EnergyPlanningError("Planning worker is not configured");
  }
  const started = performance.now();
  // A price arrival also runs the bounded daily curve search. Individual
  // worker calls retain their existing CPU budget.
  const deadline = connection.deadline ?? started + PLANNING_EXECUTION_TIMEOUT_MS;
  const checkDeadline = () => {
    if (performance.now() >= deadline) {
      throw new EnergyPlanningError("Replanning exceeded its request deadline", 502, "planning_deadline_exceeded");
    }
  };
  checkDeadline();
  const signal = AbortSignal.timeout(Math.max(1, Math.ceil(deadline - performance.now())));
  // The worker plans from the input as JSON delivers it, so the plan is
  // assembled from that same form. Each part is serialized once, not per call.
  const inputJson = JSON.stringify(input);
  const wireInput: EnergyPlanningInput = JSON.parse(inputJson);
  const completed: DispatchResult[] = [];
  const completedJson: string[] = [];
  const rankings: NonNullable<EnergyPlanningStep["rankings"]> = [];
  const rankingsJson: string[] = [];
  let checkpoint: DispatchCheckpoint | undefined;
  let rankingCheckpoint: ResponsiveRankingCheckpoint | undefined;
  for (let index = 0; index < MAX_STEPS; index += 1) {
    checkDeadline();
    let response: Response;
    try {
      response = await fetcher(
        `${connection.url}/functions/v1/energy-optimisation-plan-step`,
        {
          method: "POST",
          headers: {
            "x-shs-planning-secret": connection.planningSecret,
            "content-type": "application/json",
            "x-request-id": connection.requestId,
          },
          body: `{"protocol":${ENERGY_PLANNING_PROTOCOL},"input":${inputJson},` +
            `"continuation":{"completed":[${completedJson.join(",")}],"rankings":[${rankingsJson.join(",")}]${
              checkpoint ? `,"checkpoint":${JSON.stringify(checkpoint)}` : ""
            }${rankingCheckpoint ? `,"ranking_checkpoint":${JSON.stringify(rankingCheckpoint)}` : ""}}}`,
          signal,
        },
      );
    } catch (error) {
      console.error("[ENERGY-PLANNING] worker transport failed", {
        request_id: connection.requestId,
        name: error instanceof Error ? error.name : null,
        detail: describeThrown(error),
        retry_after_ms: error && typeof error === "object" && "retryAfterMs" in error
          ? error.retryAfterMs : null,
      });
      if (signal.aborted) checkDeadline();
      throw new EnergyPlanningError(
        signal.aborted
          ? "Planning stages exceeded the request deadline"
          : `Planning worker could not be reached: ${describeThrown(error)}`,
      );
    }
    let body: EnergyPlanningStep & {
      protocol: number;
      request_id: string;
      error?: string;
      detail?: string;
    };
    try {
      body = await response.json();
    } catch {
      throw new EnergyPlanningError(
        `Planning worker returned HTTP ${response.status} without a planning response`,
      );
    }
    if (!response.ok) {
      const invalid = response.status === 400 &&
        body.error === "invalid_snapshot";
      throw new EnergyPlanningError(
        invalid
          ? body.detail ?? "Invalid planning snapshot"
          : `Planning worker returned HTTP ${response.status}${
            body.error ? ` (${body.error})` : ""
          }`,
        invalid ? 400 : 502,
      );
    }
    checkDeadline();
    if (
      body.protocol !== ENERGY_PLANNING_PROTOCOL ||
      body.request_id !== connection.requestId
    ) {
      throw new EnergyPlanningError(
        "Planning worker response protocol or request ID mismatch",
      );
    }
    if (
      typeof body.done !== "boolean" || !Array.isArray(body.completed) || !Array.isArray(body.rankings) ||
      (body.checkpoint !== undefined &&
        (body.done || typeof body.checkpoint !== "object")) ||
      (body.ranking_checkpoint !== undefined &&
        (body.done || typeof body.ranking_checkpoint !== "object"))
    ) {
      throw new EnergyPlanningError(
        "Planning worker returned an invalid continuation",
      );
    }
    for (const auction of body.completed) {
      completed.push(auction);
      completedJson.push(JSON.stringify(auction));
    }
    for (const ranking of body.rankings) {
      rankings.push(ranking);
      rankingsJson.push(JSON.stringify(ranking));
    }
    checkpoint = body.checkpoint;
    rankingCheckpoint = body.ranking_checkpoint;
    if (body.done) {
      const assembling = performance.now();
      checkDeadline();
      let result: OptimisationResult;
      try {
        result = assembleOptimisationPlan(wireInput, completed, rankings);
      } catch (error) {
        throw new EnergyPlanningError(
          `Planning worker's auctions do not assemble into a plan: ${
            describeThrown(error)
          }`,
        );
      }
      checkDeadline();
      console.info("[ENERGY-PLANNING] request completed", {
        request_id: connection.requestId,
        calls: index + 1,
        auctions: completed.length,
        elapsed_ms: Math.round(performance.now() - started),
        assembly_ms: Math.round(performance.now() - assembling),
      });
      return result;
    }
  }
  throw new EnergyPlanningError("Planning worker exceeded the stage limit");
}
