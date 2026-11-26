import type { OwnedPlanningOwner, OwnedPlanningAction, OwnedPlanningResponse, OwnedPlanningDispatch } from "./owned-planning-contract.ts";
import type { RoomPreparationProgress } from "./rules-room-services.ts";
import { PlanningError, type PlanningFailureDisposition } from "./planning-errors.ts";
import type { OptimisationResult } from "./planner/planning-contracts.ts";
import type { PreparedRulesInput, SolvedRulesInput } from "./rules-planner.ts";
import type { CapturedRulesInput } from "./rules-planning-capture.ts";
import { RULES_MODEL_VERSION, RULES_PLANNING_PROTOCOL } from "./rules-planner-identity.ts";
import { describeThrown } from "./ha-api-contract.ts";
import { ROOM_NETWORK_WORK_REVISION } from "./room-network-contract.ts";

export { RULES_PLANNING_PROTOCOL } from "./rules-planner-identity.ts";
// Room stages have separate CPU limits but share one network deadline.
export const RULES_PLANNING_TIMEOUT_MS = 25_000;
export class EnergyPlanningError extends PlanningError {
  constructor(message: string, status = 502, code = "planning_failed", disposition: PlanningFailureDisposition = "retry", retryAfterMs?: number) {
    super(message, code, status, disposition, retryAfterMs); this.name = "EnergyPlanningError";
  }
}
type Stage = "owned" | "prepare" | "solve" | "assemble";
type WorkerConnection = {url:string;planningSecret:string;requestId:string;deadline?:number};
type WorkerResponse = Partial<OwnedPlanningResponse> & {
  protocol?: number; stage?: Stage; request_id?: string; error?: string; detail?: string;
  prepared?: PreparedRulesInput; room_progress?: RoomPreparationProgress; solved?: SolvedRulesInput; result?: OptimisationResult;
};
export type RemoteRulesProgress =
  | { stage: "prepare"; room_progress?: RoomPreparationProgress }
  | { stage: "solve"; prepared: PreparedRulesInput }
  | { stage: "assemble"; solved: SolvedRulesInput };

/** Only convergence counts are resolved by preparation. Seed, model and source
 * inputs were captured already and cannot be replaced by a worker response. */
export function resolvedRemoteForecastCounts(input: CapturedRulesInput, prepared: PreparedRulesInput) {
  const before = input.snapshot.room_network?.forecast, after = prepared.snapshot.room_network?.forecast;
  if (!before || after?.trajectories === undefined) return null;
  const invalid = () => new EnergyPlanningError("Planning worker changed the captured numerical identity", 502, "invalid_planning_response", "retry");
  if (before.revision !== after.revision || before.accuracy_revision !== after.accuracy_revision ||
    before.replicates !== after.replicates || before.wasm_sha256 !== after.wasm_sha256 || before.runtime !== after.runtime ||
    JSON.stringify(before.seed) !== JSON.stringify(after.seed) ||
    !Number.isSafeInteger(after.trajectories) || after.trajectories < 1 ||
    !Number.isSafeInteger(after.replayed_paths) || after.replayed_paths! < after.trajectories ||
    !Array.isArray(after.replicate_trajectories) || after.replicate_trajectories.length !== before.replicates ||
    after.replicate_trajectories.some(n => !Number.isSafeInteger(n) || n < 0) ||
    after.replicate_trajectories.reduce((sum, n) => sum + n, 0) !== after.trajectories) throw invalid();
  if (before.trajectories !== undefined) {
    if (before.trajectories !== after.trajectories || before.replayed_paths !== after.replayed_paths || JSON.stringify(before.replicate_trajectories) !== JSON.stringify(after.replicate_trajectories)) throw invalid();
    return null;
  }
  return { trajectories: after.trajectories, replayed_paths: after.replayed_paths!, replicate_trajectories: [...after.replicate_trajectories] };
}

export function completedRemoteCapture(input: CapturedRulesInput, prepared: PreparedRulesInput): CapturedRulesInput {
  const counts = resolvedRemoteForecastCounts(input, prepared);
  if (!counts) return input;
  const completed = structuredClone(input);
  Object.assign(completed.snapshot.room_network!.forecast, counts);
  return completed;
}

/** Ordered proposals advance rooms; final joint replay advances its own cursor. */
export function validRoomPreparationAdvance(input: CapturedRulesInput, previous: RoomPreparationProgress | null,
  progress: RoomPreparationProgress): boolean {
  const count = input.snapshot.thermal_zones?.length ?? 0, before = previous?.next_room ?? 0;
  if (progress.snapshot_id !== input.snapshot.snapshot_id || !Number.isSafeInteger(progress.next_room) ||
    progress.next_room < 0 || progress.next_room > count) return false;
  const work = progress.network_work;
  if (progress.forecast_pending !== undefined && progress.forecast_pending !== true) return false;
  if (progress.forecast_pending) {
    return !work && !previous?.network_work && !previous?.forecast_pending &&
      progress.next_room === count && before === count - 1;
  }
  if (work) {
    if (progress.next_room !== count || work.revision !== ROOM_NETWORK_WORK_REVISION ||
      !Number.isSafeInteger(work.cursor) || work.cursor <= (previous?.network_work?.cursor ?? 0) ||
      !Number.isSafeInteger(work.target_trajectories) || work.target_trajectories < 1 ||
      work.target_trajectories < (previous?.network_work?.target_trajectories ?? 0) ||
      !Array.isArray(work.replicas) || work.replicas.length !== 4 || work.replicas.some(replica => replica !== null && (!replica || typeof replica !== "object"))) return false;
    return previous?.network_work ? before === count :
      (previous?.forecast_pending === true && before === count) || count === 0;
  }
  return !previous?.network_work && !previous?.forecast_pending && progress.next_room === before + 1 && progress.next_room < count;
}

async function callPlanningWorker(stage: Stage,
  stageInput: undefined | CapturedRulesInput | PreparedRulesInput | SolvedRulesInput,
  connection: WorkerConnection, extra: { room_progress?: RoomPreparationProgress; owner?: OwnedPlanningOwner; action?: OwnedPlanningAction },
  fetcher: typeof fetch): Promise<WorkerResponse> {
  if (!connection.url || !connection.planningSecret) throw new EnergyPlanningError("Planning worker is not configured", 503, "planner_not_configured", "terminal");
  const deadline = connection.deadline ?? performance.now() + RULES_PLANNING_TIMEOUT_MS;
  const left = deadline - performance.now();
  if (left <= 0) throw new EnergyPlanningError("Replanning exceeded its request deadline", 502, "planning_deadline_exceeded");
  const signal = AbortSignal.timeout(Math.ceil(left));
  let response: Response;
  try {
    response = await fetcher(`${connection.url}/functions/v1/energy-optimisation-plan-step`, {
      method:"POST",headers:{"x-shs-planning-secret":connection.planningSecret,
        "content-type":"application/json","x-request-id":connection.requestId},
      body:JSON.stringify({protocol:RULES_PLANNING_PROTOCOL,stage,input:stageInput,...extra}),signal,
    });
  } catch (error) {
    // Hosted fetch throws before any Response exists. Preserve the provider's
    // retry clock; ordinary HTTP429 handling alone cannot catch this condition.
    const limited = error as { name?: string; retryAfterMs?: unknown } | null;
    if (limited?.name === "RateLimitError" && typeof limited.retryAfterMs === "number" &&
      Number.isFinite(limited.retryAfterMs) && limited.retryAfterMs >= 0) {
      throw new EnergyPlanningError("Planning worker call allowance is temporarily exhausted",429,
        "planning_worker_rate_limited","retry",Math.ceil(limited.retryAfterMs));
    }
    throw new EnergyPlanningError(signal.aborted ? "Replanning exceeded its request deadline"
      : `Planning worker could not be reached: ${describeThrown(error)}`, 502,
      signal.aborted ? "planning_deadline_exceeded" : "planning_failed");
  }
  let body: WorkerResponse;
  try { body = await response.json(); }
  catch { throw new EnergyPlanningError(`Planning worker returned HTTP ${response.status} during ${stage} without a planning response`,
    response.status, "planning_response_unreadable", response.status >= 500 || response.status === 429 || response.ok ? "retry" : "terminal"); }
  if (!response.ok) {
    const code = typeof body?.error === "string" ? body.error : "planning_failed";
    const disposition = code === "planner_upgraded" || code === "planning_protocol_mismatch" ? "recapture"
      : ["unauthorized", "planner_not_configured", "invalid_snapshot"].includes(code) ? "terminal"
      : response.status >= 500 || response.status === 429 ? "retry" : "terminal";
    throw new EnergyPlanningError(body?.detail ?? `Planning worker returned HTTP ${response.status} during ${stage} (${code})`,
      response.status, disposition === "recapture" ? "planner_upgraded" : code, disposition);
  }
  if (!body || body.protocol !== RULES_PLANNING_PROTOCOL || body.request_id !== connection.requestId || body.stage !== stage) {
    throw new EnergyPlanningError("Planning worker response protocol, stage or request ID mismatch", 502, "invalid_planning_response", "retry");
  }
  return body;
}

/** Execute exactly one authenticated native stage on an immutable capture. */
export async function advanceRemoteRulesPlan(input: CapturedRulesInput,
  connection: {url:string;planningSecret:string;requestId:string;deadline?:number},
  previous: RemoteRulesProgress | null = null,
  fetcher: typeof fetch = fetch): Promise<{ progress: RemoteRulesProgress; completed_capture?: CapturedRulesInput } | { result: OptimisationResult }> {
  const deadline = connection.deadline ?? performance.now() + RULES_PLANNING_TIMEOUT_MS;
  const call = (stage: Stage, stageInput: CapturedRulesInput | PreparedRulesInput | SolvedRulesInput, roomProgress?: RoomPreparationProgress) =>
    callPlanningWorker(stage, stageInput, {...connection, deadline}, {room_progress:roomProgress}, fetcher);
  if (!previous || previous.stage === "prepare") {
    const preparation = await call("prepare", input, previous?.room_progress);
    if (preparation.room_progress) {
      const progress = preparation.room_progress;
      if (preparation.prepared || !validRoomPreparationAdvance(input, previous?.room_progress ?? null, progress)) {
        throw new EnergyPlanningError("Planning worker returned invalid room progress", 502, "invalid_planning_response", "retry");
      }
      return { progress: { stage: "prepare", room_progress: progress } };
    }
    const { prepared } = preparation;
    if (!prepared || prepared.snapshot?.snapshot_id !== input.snapshot.snapshot_id
      || prepared.model_version !== input.model_version || prepared.model_version !== RULES_MODEL_VERSION
      || !prepared.problem?.slots?.length) {
      throw new EnergyPlanningError("Planning worker returned an invalid prepared input", 502, "invalid_planning_response", "retry");
    }
    return { progress: { stage: "solve", prepared }, completed_capture: completedRemoteCapture(input, prepared) };
  }
  if (previous.stage === "solve") {
    const prepared = previous.prepared;
    const { solved } = await call("solve", prepared);
    if (!solved || solved.input?.snapshot?.snapshot_id !== prepared.snapshot.snapshot_id
      || solved.input?.model_version !== prepared.model_version
      || solved.selection?.commands?.length !== prepared.problem.slots.length) {
      throw new EnergyPlanningError("Planning worker returned an invalid native selection", 502, "invalid_planning_response", "retry");
    }
    return { progress: { stage: "assemble", solved } };
  }
  const solved = previous.solved;
  const { result } = await call("assemble", solved);
  if (!result?.plan || result.plan.snapshot_id !== input.snapshot.snapshot_id
    || result.plan.plan_id !== input.snapshot.snapshot_id || result.plan.model_version !== RULES_MODEL_VERSION
    || !result.plan.plans?.priority?.slots?.length || !result.battery_projection) {
    throw new EnergyPlanningError("Planning worker returned an invalid complete plan", 502, "invalid_planning_response", "retry");
  }
  return { result };
}

/** Local callers drain the same bounded stages within one network deadline. */
export async function generateRemoteRulesPlan(input: CapturedRulesInput,
  connection: {url:string;planningSecret:string;requestId:string;deadline?:number},
  fetcher: typeof fetch = fetch): Promise<OptimisationResult> {
  const bounded = { ...connection, deadline: connection.deadline ?? performance.now() + RULES_PLANNING_TIMEOUT_MS };
  let progress: RemoteRulesProgress | null = null;
  let capture = input;
  for (;;) {
    const next = await advanceRemoteRulesPlan(capture, bounded, progress, fetcher);
    if ("result" in next) return next.result;
    capture = next.completed_capture ?? capture;
    progress = next.progress;
  }
}

// Supabase allows30 Edge-to-Edge fetches per trace/60seconds, including fan-out.
// Reserve6 for upstream portal/ingest hops and shared request-chain overhead.
// This is a transport allowance, never a numerical/model completion limit.
export const OWNED_WORKER_CALLS_PER_EXCHANGE = 24;
/** Drain bounded compact waves within the existing exchange deadline. Failed
 * siblings do not discard successful SQL checkpoints; the next owner resumes. */
export async function advanceOwnedPlanning(owner: OwnedPlanningOwner, connection: WorkerConnection,
  fetcher: typeof fetch = fetch): Promise<OwnedPlanningResponse> {
  const bounded = { ...connection, deadline: connection.deadline ?? performance.now() + RULES_PLANNING_TIMEOUT_MS };
  let callsRemaining = OWNED_WORKER_CALLS_PER_EXCHANGE;
  const call = async (action: OwnedPlanningAction): Promise<OwnedPlanningResponse> => {
    callsRemaining--;
    const body = await callPlanningWorker("owned", undefined, bounded, { owner, action }, fetcher);
    const d = body.dispatch;
    if (d !== null && (!d || !["capture","prepare","catalog","integrate","qualify","solve","assemble","ready"].includes(d.phase) ||
      !Number.isSafeInteger(d.cursor) || d.cursor < 0 || !Number.isSafeInteger(d.round) || d.round < 0 ||
      !Number.isSafeInteger(d.target) || d.target < 1 || !Array.isArray(d.replicas) ||
      d.replicas.some(r => !Number.isInteger(r) || r < 0 || r > 3) || new Set(d.replicas).size !== d.replicas.length)) {
      throw new EnergyPlanningError("Invalid owned planning dispatch",502,"invalid_planning_response");
    }
    return { dispatch: d ?? null, busy: body.busy };
  };
  let current = await call({ kind: "advance" });
  while (current.dispatch && current.dispatch.phase !== "ready" && !current.busy &&
    bounded.deadline - performance.now() > 1500 && callsRemaining > 0) {
    if (current.dispatch.phase === "integrate" && current.dispatch.replicas.length) {
      if (callsRemaining < current.dispatch.replicas.length + 1) break;
      const wave = await Promise.allSettled(current.dispatch.replicas.map(replica => call({ kind: "replica", replica })));
      let failure: unknown;
      let latest: OwnedPlanningDispatch | null = current.dispatch;
      let busy = false;
      for (const result of wave) {
        if (result.status === "rejected") { failure ??= result.reason; continue; }
        busy ||= result.value.busy === true;
        if (!result.value.dispatch) latest = null;
      }
      if (failure) throw failure;
      if (!latest || busy) return { dispatch: latest, busy };
      // Read compact canonical counts once after all writers returned. No large
      // statistics are fetched until the balanced barrier is complete.
    }
    if (bounded.deadline - performance.now() <= 1500 || callsRemaining < 1) break;
    current = await call({ kind: "advance" });
  }
  return current;
}
