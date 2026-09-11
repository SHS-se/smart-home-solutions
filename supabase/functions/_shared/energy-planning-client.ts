import type { OptimisationPlan } from "./energy-optimisation.ts";
import {
  ENERGY_PLANNING_PROTOCOL,
  type EnergyPlanningContinuation,
  type EnergyPlanningInput,
  type EnergyPlanningStep,
} from "./energy-planning-protocol.ts";

const MAX_STEPS = 64;

export class EnergyPlanningError extends Error {
  constructor(message: string, readonly status: 400 | 502 = 502) {
    super(message);
    this.name = "EnergyPlanningError";
  }
}

/** Network waits do not consume ingest's CPU budget. Never solve inline. */
export async function generateRemoteOptimisationPlan(
  input: EnergyPlanningInput,
  connection: {
    url: string;
    planningSecret: string;
    requestId: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<OptimisationPlan> {
  if (
    !connection.url || !connection.planningSecret
  ) {
    throw new EnergyPlanningError("Planning worker is not configured");
  }
  const signal = AbortSignal.timeout(20_000);
  let continuation: EnergyPlanningContinuation | undefined;
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
          body: JSON.stringify({
            protocol: ENERGY_PLANNING_PROTOCOL,
            input,
            continuation,
          }),
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
    if (body.done === true) {
      if (
        body.plan?.snapshot_id !== input.snapshot.snapshot_id ||
        body.plan.schema_version !== input.snapshot.schema_version
      ) {
        throw new EnergyPlanningError(
          "Planning worker returned a plan for a different snapshot",
        );
      }
      return body.plan;
    }
    if (body.done !== false || !Array.isArray(body.continuation?.completed)) {
      throw new EnergyPlanningError(
        "Planning worker returned an invalid continuation",
      );
    }
    continuation = body.continuation;
  }
  throw new EnergyPlanningError("Planning worker exceeded the stage limit");
}
