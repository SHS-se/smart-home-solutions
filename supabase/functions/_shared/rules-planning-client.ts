import type { OptimisationResult } from "./planner/planning-contracts.ts";
import type { PreparedRulesInput } from "./rules-planner.ts";
import type { CapturedRulesInput } from "./rules-planning-capture.ts";
import { RULES_MODEL_VERSION, RULES_PLANNING_PROTOCOL } from "./rules-planner-identity.ts";
import { describeThrown } from "./ha-api-contract.ts";

export { RULES_PLANNING_PROTOCOL } from "./rules-planner-identity.ts";
export const RULES_PLANNING_TIMEOUT_MS = 8_000;
export class EnergyPlanningError extends Error {
  constructor(message: string, readonly status: 400 | 502 = 502, readonly code = "planning_failed") {
    super(message); this.name = "EnergyPlanningError";
  }
}
type Stage = "prepare" | "solve";
type WorkerResponse = {
  protocol?: number; stage?: Stage; request_id?: string; error?: string; detail?: string;
  prepared?: PreparedRulesInput; result?: OptimisationResult;
};
/** One owner coordinates two isolated CPU requests over the same captured basis. */
export async function generateRemoteRulesPlan(input: CapturedRulesInput,
  connection: {url:string;planningSecret:string;requestId:string;deadline?:number},
  fetcher: typeof fetch = fetch): Promise<OptimisationResult> {
  if (!connection.url || !connection.planningSecret) throw new EnergyPlanningError("Planning worker is not configured");
  const deadline = connection.deadline ?? performance.now() + RULES_PLANNING_TIMEOUT_MS;
  const call = async (stage: Stage, stageInput: CapturedRulesInput | PreparedRulesInput): Promise<WorkerResponse> => {
    const left = deadline - performance.now();
    if (left <= 0) throw new EnergyPlanningError("Replanning exceeded its request deadline", 502, "planning_deadline_exceeded");
    const signal = AbortSignal.timeout(Math.ceil(left));
    let response: Response;
    try {
      response = await fetcher(`${connection.url}/functions/v1/energy-optimisation-plan-step`, {
        method:"POST",headers:{"x-shs-planning-secret":connection.planningSecret,
          "content-type":"application/json","x-request-id":connection.requestId},
        body:JSON.stringify({protocol:RULES_PLANNING_PROTOCOL,stage,input:stageInput}),signal,
      });
    } catch (error) {
      throw new EnergyPlanningError(signal.aborted ? "Replanning exceeded its request deadline"
        : `Planning worker could not be reached: ${describeThrown(error)}`, 502,
        signal.aborted ? "planning_deadline_exceeded" : "planning_failed");
    }
    let body: WorkerResponse;
    try { body = await response.json(); }
    catch { throw new EnergyPlanningError(`Planning worker returned HTTP ${response.status} without a planning response`); }
    if (!response.ok) {
      const invalid = response.status === 400 && body.error === "invalid_snapshot";
      throw new EnergyPlanningError(invalid ? body.detail ?? "Invalid planning snapshot"
        : `Planning worker returned HTTP ${response.status}${body.error ? ` (${body.error})` : ""}`, invalid ? 400 : 502);
    }
    if (!body || body.protocol !== RULES_PLANNING_PROTOCOL || body.request_id !== connection.requestId || body.stage !== stage) {
      throw new EnergyPlanningError("Planning worker response protocol, stage or request ID mismatch");
    }
    return body;
  };
  const { prepared } = await call("prepare", input);
  if (!prepared || prepared.snapshot?.snapshot_id !== input.snapshot.snapshot_id
    || prepared.model_version !== input.model_version || prepared.model_version !== RULES_MODEL_VERSION
    || !prepared.problem?.slots?.length) {
    throw new EnergyPlanningError("Planning worker returned an invalid prepared input");
  }
  const { result } = await call("solve", prepared);
  if (!result?.plan || result.plan.snapshot_id !== input.snapshot.snapshot_id
    || result.plan.plan_id !== input.snapshot.snapshot_id || result.plan.model_version !== RULES_MODEL_VERSION
    || !result.plan.plans?.priority?.slots?.length || !result.battery_projection) {
    throw new EnergyPlanningError("Planning worker returned an invalid complete plan");
  }
  return result;
}
