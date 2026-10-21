import { generateRulesPlan, type PreparedRulesInput } from "./rules-planner.ts";
import { RULES_PLANNING_PROTOCOL } from "./rules-planning-client.ts";
import { describeThrown } from "./ha-api-contract.ts";
import { PlanningTrace } from "./planning-trace.ts";

const MAX_BODY_BYTES = 16_000_000;
/** Internal endpoint: a dedicated secret authorizes one complete rules solve. */
export async function handleEnergyPlanningStep(request: Request, planningSecret: string): Promise<Response> {
  const requestId = request.headers.get("x-request-id");
  const json = (body: object, status = 200) => Response.json({protocol:RULES_PLANNING_PROTOCOL,request_id:requestId,...body},{status});
  if (request.method !== "POST") return json({error:"method_not_allowed"},405);
  if (!planningSecret) return json({error:"planner_not_configured"},503);
  if (request.headers.get("x-shs-planning-secret") !== planningSecret) return json({error:"unauthorized"},401);
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) return json({error:"request_too_large"},413);
  const trace = new PlanningTrace(requestId ?? crypto.randomUUID());
  try {
    const read = trace.start("request_read");
    const raw = await request.text();
    read();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return json({error:"request_too_large"},413);
    const body = trace.run("request_parse", () => JSON.parse(raw) as {protocol:number;input:PreparedRulesInput});
    if (body.protocol !== RULES_PLANNING_PROTOCOL) return json({error:"planning_protocol_mismatch"},409);
    const started = performance.now();
    const result = trace.run("plan_generation", () => generateRulesPlan(body.input, trace), {
      model_version: body.input.model_version, slots: body.input.problem.slots.length,
    });
    console.info("[ENERGY-PLANNING-STEP] rules plan completed", {
      request_id:requestId, model_version:result.plan.model_version,
      elapsed_ms:Math.round(performance.now()-started), slots:result.plan.plans.priority.slots.length,
    });
    return trace.run("response_encode", () => json({result}));
  } catch (error) {
    const detail = describeThrown(error);
    trace.failed(detail);
    return json({error:"invalid_snapshot",detail},400);
  }
}
