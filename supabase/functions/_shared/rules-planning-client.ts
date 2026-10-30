import { PlanningError, type PlanningFailureDisposition } from "./planning-errors.ts";
import type { OptimisationResult } from "./planner/planning-contracts.ts";
import type { PreparedRulesInput } from "./rules-planner.ts";
import type { CapturedRulesInput } from "./rules-planning-capture.ts";
import { RULES_MODEL_VERSION, RULES_PLANNING_PROTOCOL } from "./rules-planner-identity.ts";
import { describeThrown } from "./ha-api-contract.ts";

export { RULES_PLANNING_PROTOCOL } from "./rules-planner-identity.ts";
export const RULES_PLANNING_TIMEOUT_MS = 8_000;
export class EnergyPlanningError extends PlanningError {
  constructor(message: string, status = 502, code = "planning_failed", disposition: PlanningFailureDisposition = "retry") {
    super(message, code, status, disposition); this.name = "EnergyPlanningError";
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
  if (!connection.url || !connection.planningSecret) throw new EnergyPlanningError("Planning worker is not configured", 503, "planner_not_configured", "terminal");
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
    catch { throw new EnergyPlanningError(`Planning worker returned HTTP ${response.status} without a planning response`,
      response.status, "planning_response_unreadable", response.status >= 500 || response.status === 429 || response.ok ? "retry" : "terminal"); }
    if (!response.ok) {
      const code = typeof body?.error === "string" ? body.error : "planning_failed";
      const disposition = code === "planner_upgraded" || code === "planning_protocol_mismatch" ? "recapture"
        : ["unauthorized", "planner_not_configured", "invalid_snapshot"].includes(code) ? "terminal"
        : response.status >= 500 || response.status === 429 ? "retry" : "terminal";
      throw new EnergyPlanningError(body?.detail ?? `Planning worker returned HTTP ${response.status} (${code})`,
        response.status, disposition === "recapture" ? "planner_upgraded" : code, disposition);
    }
    if (!body || body.protocol !== RULES_PLANNING_PROTOCOL || body.request_id !== connection.requestId || body.stage !== stage) {
      throw new EnergyPlanningError("Planning worker response protocol, stage or request ID mismatch", 502, "invalid_planning_response", "retry");
    }
    return body;
  };
  const { prepared } = await call("prepare", input);
  if (!prepared || prepared.snapshot?.snapshot_id !== input.snapshot.snapshot_id
    || prepared.model_version !== input.model_version || prepared.model_version !== RULES_MODEL_VERSION
    || !prepared.problem?.slots?.length) {
    throw new EnergyPlanningError("Planning worker returned an invalid prepared input", 502, "invalid_planning_response", "retry");
  }
  const { result } = await call("solve", prepared);
  if (!result?.plan || result.plan.snapshot_id !== input.snapshot.snapshot_id
    || result.plan.plan_id !== input.snapshot.snapshot_id || result.plan.model_version !== RULES_MODEL_VERSION
    || !result.plan.plans?.priority?.slots?.length || !result.battery_projection) {
    throw new EnergyPlanningError("Planning worker returned an invalid complete plan", 502, "invalid_planning_response", "retry");
  }
  return result;
}
