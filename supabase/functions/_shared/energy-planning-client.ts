import type { OptimisationResult } from "./energy-optimisation.ts";
import type { DispatchCheckpoint, DispatchResult } from "./dispatch-plan.ts";
import {
  ENERGY_PLANNING_PROTOCOL,
  type EnergyPlanningInput,
  type EnergyPlanningStep,
} from "./energy-planning-protocol.ts";
import { assembleOptimisationPlan } from "./energy-planning-step.ts";
import { describeThrown } from "./ha-api-contract.ts";

const MAX_STEPS = 64;

export class EnergyPlanningError extends Error {
  constructor(message: string, readonly status: 400 | 502 = 502) {
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
  },
  fetcher: typeof fetch = fetch,
): Promise<OptimisationResult> {
  if (
    !connection.url || !connection.planningSecret
  ) {
    throw new EnergyPlanningError("Planning worker is not configured");
  }
  const started = performance.now();
  const signal = AbortSignal.timeout(20_000);
  // The worker plans from the input as JSON delivers it, so the plan is
  // assembled from that same form. Each part is serialized once, not per call.
  const inputJson = JSON.stringify(input);
  const wireInput: EnergyPlanningInput = JSON.parse(inputJson);
  const completed: DispatchResult[] = [];
  const completedJson: string[] = [];
  let checkpoint: DispatchCheckpoint | undefined;
  for (let index = 0; index < MAX_STEPS; index += 1) {
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
            `"continuation":{"completed":[${completedJson.join(",")}]${
              checkpoint ? `,"checkpoint":${JSON.stringify(checkpoint)}` : ""
            }}}`,
          signal,
        },
      );
    } catch {
      throw new EnergyPlanningError(
        signal.aborted
          ? "Planning stages exceeded the 20-second request deadline"
          : "Planning worker could not be reached",
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
    if (
      body.protocol !== ENERGY_PLANNING_PROTOCOL ||
      body.request_id !== connection.requestId
    ) {
      throw new EnergyPlanningError(
        "Planning worker response protocol or request ID mismatch",
      );
    }
    if (
      typeof body.done !== "boolean" || !Array.isArray(body.completed) ||
      (body.checkpoint !== undefined &&
        (body.done || typeof body.checkpoint !== "object"))
    ) {
      throw new EnergyPlanningError(
        "Planning worker returned an invalid continuation",
      );
    }
    for (const auction of body.completed) {
      completed.push(auction);
      completedJson.push(JSON.stringify(auction));
    }
    checkpoint = body.checkpoint;
    if (body.done) {
      const assembling = performance.now();
      let result: OptimisationResult;
      try {
        result = assembleOptimisationPlan(wireInput, completed);
      } catch (error) {
        throw new EnergyPlanningError(
          `Planning worker's auctions do not assemble into a plan: ${
            describeThrown(error)
          }`,
        );
      }
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
