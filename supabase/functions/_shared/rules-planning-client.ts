import type { OptimisationResult } from "./planner/energy-optimisation.ts";
import type { PreparedRulesInput } from "./rules-planner.ts";
import { RULES_MODEL_VERSION } from "./rules-planner.ts";
import { describeThrown } from "./ha-api-contract.ts";

export const RULES_PLANNING_PROTOCOL = 9;
export const RULES_PLANNING_TIMEOUT_MS = 8_000;
export class EnergyPlanningError extends Error {
  constructor(message: string, readonly status: 400 | 502 = 502, readonly code = "planning_failed") {
    super(message); this.name = "EnergyPlanningError";
  }
}
/** A single authenticated, complete solve. No auction ledger or local solver replay. */
export async function generateRemoteRulesPlan(input: PreparedRulesInput,
  connection: {url:string;planningSecret:string;requestId:string;deadline?:number},
  fetcher: typeof fetch = fetch): Promise<OptimisationResult> {
  if (!connection.url || !connection.planningSecret) throw new EnergyPlanningError("Planning worker is not configured");
  const left = (connection.deadline ?? performance.now() + RULES_PLANNING_TIMEOUT_MS) - performance.now();
  if (left <= 0) throw new EnergyPlanningError("Replanning exceeded its request deadline", 502, "planning_deadline_exceeded");
  const signal = AbortSignal.timeout(Math.ceil(left));
  let response: Response;
  try {
    response = await fetcher(`${connection.url}/functions/v1/energy-optimisation-plan-step`, {
      method:"POST",headers:{"x-shs-planning-secret":connection.planningSecret,
        "content-type":"application/json","x-request-id":connection.requestId},
      body:JSON.stringify({protocol:RULES_PLANNING_PROTOCOL,input}),signal,
    });
  } catch (error) {
    throw new EnergyPlanningError(signal.aborted ? "Replanning exceeded its request deadline"
      : `Planning worker could not be reached: ${describeThrown(error)}`, 502,
      signal.aborted ? "planning_deadline_exceeded" : "planning_failed");
  }
  let body: {protocol?:number;request_id?:string;error?:string;detail?:string;result?:OptimisationResult};
  try { body = await response.json(); }
  catch { throw new EnergyPlanningError(`Planning worker returned HTTP ${response.status} without a planning response`); }
  if (!response.ok) {
    const invalid = response.status === 400 && body.error === "invalid_snapshot";
    throw new EnergyPlanningError(invalid ? body.detail ?? "Invalid planning snapshot"
      : `Planning worker returned HTTP ${response.status}${body.error ? ` (${body.error})` : ""}`, invalid ? 400 : 502);
  }
  if (body.protocol !== RULES_PLANNING_PROTOCOL || body.request_id !== connection.requestId) {
    throw new EnergyPlanningError("Planning worker response protocol or request ID mismatch");
  }
  const result = body.result;
  if (!result?.plan || result.plan.snapshot_id !== input.snapshot.snapshot_id
    || result.plan.plan_id !== input.snapshot.snapshot_id || result.plan.model_version !== RULES_MODEL_VERSION
    || !result.plan.plans?.priority?.slots?.length || !result.battery_projection) {
    throw new EnergyPlanningError("Planning worker returned an invalid complete plan");
  }
  return result;
}
