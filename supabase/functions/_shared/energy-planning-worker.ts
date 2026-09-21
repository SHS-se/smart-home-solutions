import { costCurveStep, type CostCurveProgress } from "./battery-cost-step.ts";
import type { CostCurveInput } from "./battery-cost-curve.ts";
import { energyPlanningStep } from "./energy-planning-step.ts";
import {
  ENERGY_PLANNING_PROTOCOL,
  type EnergyPlanningContinuation,
  type EnergyPlanningInput,
  type EnergyPlanningStep,
} from "./energy-planning-protocol.ts";
import { describeThrown } from "./ha-api-contract.ts";

const MAX_BODY_BYTES = 16_000_000;
/**
 * Supabase ends a request after 2 s of CPU (546 WORKER_RESOURCE_LIMIT). A call
 * works through stages until this much has gone; the transfer and refinement
 * stages pause part-way at it. What the budget cannot interrupt — boot,
 * reading the body, the transfer or trial in progress, serializing the
 * checkpoint — fits in the remainder.
 */
const STAGE_BUDGET_MS = 1_200;
/**
 * An auction's bidding and settlement cannot pause (about 0.5 s on the worker
 * for a 288-quarter home), so a call starts one after finishing another only
 * this early, leaving room for an auction three times that size.
 */
const AUCTION_START_MS = 300;

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
      kind?: "cost_curve";
      progress?: CostCurveProgress;
      input: EnergyPlanningInput;
      continuation?: EnergyPlanningContinuation;
    };
    if (body.protocol !== ENERGY_PLANNING_PROTOCOL) {
      return json({ error: "planning_protocol_mismatch" }, 409);
    }
    const started = performance.now();
    const elapsed = () => performance.now() - received;
    if (body.kind === "cost_curve") {
      const result = await costCurveStep(body.input as CostCurveInput, body.progress, {
        spent: () => elapsed() > STAGE_BUDGET_MS,
        allowsAuction: () => elapsed() < AUCTION_START_MS,
      });
      console.info("[BATTERY-COST-STEP] completed", {request_id:requestId,
        elapsed_ms:Math.round(performance.now()-started), done:result.done,
        evaluations:result.done === true ? result.record.evaluations : result.progress.evaluations.length});
      return json(result);
    }
    const result: EnergyPlanningStep = energyPlanningStep(
      body.input,
      body.continuation,
      {
        spent: () => elapsed() > STAGE_BUDGET_MS,
        allowsAuction: () => elapsed() < AUCTION_START_MS,
      },
    );
    console.info("[ENERGY-PLANNING-STEP] completed", {
      request_id: requestId,
      auction: body.continuation?.completed.length ?? 0,
      stage: body.continuation?.checkpoint?.next ?? "auction",
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
