import { generateRulesPlan, type PreparedRulesInput } from "./rules-planner.ts";
import { RULES_PLANNING_PROTOCOL } from "./rules-planner-identity.ts";
import { prepareCapturedRulesInput } from "./rules-planning-execution.ts";
import type { CapturedRulesInput } from "./rules-planning-capture.ts";
import { describeThrown } from "./ha-api-contract.ts";
import { PlanningTrace } from "./planning-trace.ts";

export const MAX_PLANNING_BODY_BYTES = 16_000_000;
/** Internal endpoint: each explicit stage receives a fresh hosted CPU budget. */
export async function handleEnergyPlanningStep(request: Request, planningSecret: string): Promise<Response> {
  const requestId = request.headers.get("x-request-id");
  const json = (body: object, status = 200) => Response.json({protocol:RULES_PLANNING_PROTOCOL,request_id:requestId,...body},{status});
  if (request.method !== "POST") return json({error:"method_not_allowed"},405);
  if (!planningSecret) return json({error:"planner_not_configured"},503);
  if (request.headers.get("x-shs-planning-secret") !== planningSecret) return json({error:"unauthorized"},401);
  if (Number(request.headers.get("content-length")) > MAX_PLANNING_BODY_BYTES) return json({error:"request_too_large"},413);
  const trace = new PlanningTrace(requestId ?? crypto.randomUUID());
  try {
    const read = trace.start("request_read");
    const raw = await request.text();
    read();
    if (new TextEncoder().encode(raw).byteLength > MAX_PLANNING_BODY_BYTES) return json({error:"request_too_large"},413);
    const body = trace.run("request_parse", () => JSON.parse(raw) as {protocol:number} & ({stage:"prepare";input:CapturedRulesInput} | {stage:"solve";input:PreparedRulesInput}));
    if (body.protocol !== RULES_PLANNING_PROTOCOL) return json({error:"planning_protocol_mismatch"},409);
    if (body.stage !== "prepare" && body.stage !== "solve") return json({error:"planning_stage_required"},400);
    if (body.stage === "prepare") {
      const prepared = trace.run("plan_preparation", () => prepareCapturedRulesInput(body.input, trace), {
        model_version: body.input.model_version, slots: body.input.snapshot.slots.length,
      });
      return trace.run("response_encode", () => json({stage:"prepare",prepared}));
    }
    const started = performance.now();
    const result = trace.run("plan_generation", () => generateRulesPlan(body.input, trace), {
      model_version: body.input.model_version, slots: body.input.problem.slots.length,
    });
    console.info("[ENERGY-PLANNING-STEP] rules plan completed", {
      request_id:requestId, model_version:result.plan.model_version,
      elapsed_ms:Math.round(performance.now()-started), slots:result.plan.plans.priority.slots.length,
    });
    return trace.run("response_encode", () => json({stage:"solve",result}));
  } catch (error) {
    const detail = describeThrown(error);
    trace.failed(detail);
    return json({error:"invalid_snapshot",detail},400);
  }
}
