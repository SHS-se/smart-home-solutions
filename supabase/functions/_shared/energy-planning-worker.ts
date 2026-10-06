import { createPlanningBudget, energyPlanningStep } from "./energy-planning-step.ts";
import {
  ENERGY_PLANNING_PROTOCOL,
  type EnergyPlanningContinuation,
  type EnergyPlanningInput,
  type EnergyPlanningStep,
} from "./energy-planning-protocol.ts";
import { describeThrown } from "./ha-api-contract.ts";

const MAX_BODY_BYTES = 16_000_000;
/** Internal endpoint: requires a dedicated secret, never a device token or user JWT. */
export async function handleEnergyPlanningStep(
  request: Request,
  planningSecret: string,
): Promise<Response> {
  const requestId = request.headers.get("x-request-id");
  const json = (body: object, status = 200) =>
    Response.json({
      protocol: ENERGY_PLANNING_PROTOCOL,
      request_id: requestId,
      ...body,
    }, { status });
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }
  if (!planningSecret) return json({ error: "planner_not_configured" }, 503);
  if (request.headers.get("x-shs-planning-secret") !== planningSecret) {
    return json({ error: "unauthorized" }, 401);
  }
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) {
    return json({ error: "request_too_large" }, 413);
  }
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return json({ error: "request_too_large" }, 413);
    }
    const received = performance.now();
    const body = JSON.parse(raw) as {
      protocol: number;
      input: EnergyPlanningInput;
      continuation?: EnergyPlanningContinuation;
    };
    if (body.protocol !== ENERGY_PLANNING_PROTOCOL) {
      return json({ error: "planning_protocol_mismatch" }, 409);
    }
    const started = performance.now();
    const budget = createPlanningBudget(Math.max(1, 900 - (performance.now() - received)));
    const result: EnergyPlanningStep = energyPlanningStep(
      body.input,
      body.continuation,
      budget,
    );
    console.info("[ENERGY-PLANNING-STEP] completed", {
      request_id: requestId,
      auction: body.continuation?.completed.length ?? 0,
      stage: body.continuation?.ranking_checkpoint ? "ranking" : body.continuation?.checkpoint?.next ?? "auction",
      elapsed_ms: Math.round(performance.now() - started),
      done: result.done,
      finished: result.completed.length,
      next: result.checkpoint?.next ?? null,
    });
    return json(result);
  } catch (error) {
    return json(
      { error: "invalid_snapshot", detail: describeThrown(error) },
      400,
    );
  }
}
