import type { OptimisationResult } from "./planner/energy-optimisation.ts";
import {
  ENERGY_PLANNING_PROTOCOL,
  type EnergyPlanningContinuation,
  type EnergyPlanningInput,
  type EnergyPlanningStep,
} from "./energy-planning-protocol.ts";
import { assembleOptimisationPlan } from "./energy-planning-step.ts";
import { describeThrown } from "./ha-api-contract.ts";

/** Only the synchronous fixed-plan caller has a whole-request timeout. */
export const PLANNING_EXECUTION_TIMEOUT_MS = 120_000;
export const PLANNING_BATCH_TIMEOUT_MS = 25_000;
export const PLANNING_BATCH_MAX_CALLS = 8;

export interface PlanningConnection {
  url: string;
  planningSecret: string;
  requestId: string;
  deadline?: number;
}
export interface PlanningBatchBudget {
  deadline: number;
  maxCalls?: number;
  now?: () => number;
}
export interface RemotePlanningBatch {
  done: boolean;
  calls: number;
  continuation: EnergyPlanningContinuation;
}

export class EnergyPlanningError extends Error {
  constructor(message: string, readonly status: 400 | 502 = 502, readonly code = "planning_failed") {
    super(message);
    this.name = "EnergyPlanningError";
  }
}

/** Owns worker transport and continuation validation for both durable and synchronous callers. */
export async function runRemotePlanningBatch(
  input: EnergyPlanningInput,
  continuation: EnergyPlanningContinuation,
  connection: PlanningConnection,
  budget: PlanningBatchBudget,
  fetcher: typeof fetch = fetch,
): Promise<RemotePlanningBatch> {
  if (!connection.url || !connection.planningSecret) {
    throw new EnergyPlanningError("Planning worker is not configured");
  }
  const now = budget.now ?? (() => performance.now());
  const completed = [...continuation.completed];
  const rankings = [...continuation.rankings];
  const completedJson = completed.map(value => JSON.stringify(value));
  const rankingsJson = rankings.map(value => JSON.stringify(value));
  const inputJson = JSON.stringify(input);
  let checkpoint = continuation.checkpoint ?? undefined;
  let rankingCheckpoint = continuation.ranking_checkpoint ?? undefined;
  let calls = 0;
  const result = (done = false): RemotePlanningBatch => ({ done, calls, continuation: {
    completed, rankings,
    ...(checkpoint === undefined ? {} : { checkpoint }),
    ...(rankingCheckpoint === undefined ? {} : { ranking_checkpoint: rankingCheckpoint }),
  } });
  for (let index = 0; index < (budget.maxCalls ?? PLANNING_BATCH_MAX_CALLS); index++) {
    if (now() >= budget.deadline) return result();
    const signal = AbortSignal.timeout(Math.max(1, Math.ceil(budget.deadline - now())));
    let response: Response;
    try {
      response = await fetcher(`${connection.url}/functions/v1/energy-optimisation-plan-step`, {
        method: "POST",
        headers: { "x-shs-planning-secret": connection.planningSecret,
          "content-type": "application/json", "x-request-id": connection.requestId },
        body: `{"protocol":${ENERGY_PLANNING_PROTOCOL},"input":${inputJson},` +
          `"continuation":{"completed":[${completedJson.join(",")}],"rankings":[${rankingsJson.join(",")}]${
            checkpoint ? `,"checkpoint":${JSON.stringify(checkpoint)}` : ""
          }${rankingCheckpoint ? `,"ranking_checkpoint":${JSON.stringify(rankingCheckpoint)}` : ""}}}`,
        signal,
      });
    } catch (error) {
      // A stateless call interrupted by this batch's budget can be replayed from
      // the last validated response. Other worker failures remain real failures.
      if (signal.aborted) return result();
      throw new EnergyPlanningError(`Planning worker could not be reached: ${describeThrown(error)}`);
    }
    let body: EnergyPlanningStep & { protocol: number; request_id: string; error?: string; detail?: string };
    try {
      body = await response.json();
    } catch {
      if (signal.aborted) return result();
      throw new EnergyPlanningError(`Planning worker returned HTTP ${response.status} without a planning response`);
    }
    if (!response.ok) {
      const invalid = response.status === 400 && body.error === "invalid_snapshot";
      throw new EnergyPlanningError(invalid ? body.detail ?? "Invalid planning snapshot"
        : `Planning worker returned HTTP ${response.status}${body.error ? ` (${body.error})` : ""}`,
      invalid ? 400 : 502);
    }
    if (body.protocol !== ENERGY_PLANNING_PROTOCOL || body.request_id !== connection.requestId) {
      throw new EnergyPlanningError("Planning worker response protocol or request ID mismatch");
    }
    if (typeof body.done !== "boolean" || !Array.isArray(body.completed) || !Array.isArray(body.rankings) ||
      (body.checkpoint !== undefined && (body.done || body.checkpoint === null || typeof body.checkpoint !== "object")) ||
      (body.ranking_checkpoint !== undefined && (body.done || body.ranking_checkpoint === null || typeof body.ranking_checkpoint !== "object"))) {
      throw new EnergyPlanningError("Planning worker returned an invalid continuation");
    }
    for (const auction of body.completed) { completed.push(auction); completedJson.push(JSON.stringify(auction)); }
    for (const ranking of body.rankings) { rankings.push(ranking); rankingsJson.push(JSON.stringify(ranking)); }
    checkpoint = body.checkpoint;
    rankingCheckpoint = body.ranking_checkpoint;
    calls++;
    if (body.done) return result(true);
  }
  return result();
}

/** Fixed-plan preflight drains the same protocol, within its synchronous request budget. */
export async function generateRemoteOptimisationPlan(
  input: EnergyPlanningInput,
  connection: PlanningConnection,
  fetcher: typeof fetch = fetch,
): Promise<OptimisationResult> {
  const started = performance.now();
  const deadline = connection.deadline ?? started + PLANNING_EXECUTION_TIMEOUT_MS;
  const checkDeadline = () => {
    if (performance.now() >= deadline) {
      throw new EnergyPlanningError("Replanning exceeded its request deadline", 502, "planning_deadline_exceeded");
    }
  };
  const wireInput: EnergyPlanningInput = JSON.parse(JSON.stringify(input));
  let continuation: EnergyPlanningContinuation = { completed: [], rankings: [] };
  let calls = 0;
  while (calls < 512) {
    checkDeadline();
    const batch = await runRemotePlanningBatch(wireInput, continuation, connection,
      { deadline, maxCalls: Math.min(PLANNING_BATCH_MAX_CALLS, 512 - calls) }, fetcher);
    continuation = batch.continuation;
    calls += batch.calls;
    checkDeadline();
    if (!batch.done) continue;
    const assembling = performance.now();
    let result: OptimisationResult;
    try {
      result = assembleOptimisationPlan(wireInput, continuation.completed, continuation.rankings);
    } catch (error) {
      throw new EnergyPlanningError(`Planning worker's auctions do not assemble into a plan: ${describeThrown(error)}`);
    }
    checkDeadline();
    console.info("[ENERGY-PLANNING] request completed", { request_id: connection.requestId, calls,
      auctions: continuation.completed.length, elapsed_ms: Math.round(performance.now() - started),
      assembly_ms: Math.round(performance.now() - assembling) });
    return result;
  }
  throw new EnergyPlanningError("Planning worker exceeded the stage limit");
}
