import { OwnedPlanningArtifactError, ownedPlanningBase64, packOwnedPlanningValue, unpackOwnedPlanningValue } from "./owned-planning-codec.ts";
import type { ModelDatabase } from "./device-model-store.ts";
import { advanceConnectedPlanningCapture, CONNECTED_CAPTURE_IMPLEMENTATION } from "./connected-room-planning-capture.ts";
import { prepareCapturedRoomProposals, applyCapturedConnectedForecast } from "./rules-planning-execution.ts";
import { solveRulesPlan, assembleRulesPlan, type PreparedRulesInput, type SolvedRulesInput } from "./rules-planner.ts";
import type { CapturedRulesInput } from "./rules-planning-capture.ts";
import type { RoomPreparationProgress } from "./rules-room-services.ts";
import type { ConnectedRoomForecastContext } from "./rules-connected-room-services.ts";
import { resolvedRemoteForecastCounts } from "./rules-planning-client.ts";
import { encodeForecastCatalogPages } from "./room-forecast-catalog.ts";
import { nativePlanner } from "./planner-wasm/runtime.ts";
import { connectedIntegrationAccuracy } from "./planner/models/room/ensemble-accuracy.ts";
import type { NativeRoomNetworkBelief, NativeRoomNetworkNodeHeader, NativeRoomNetworkInput,
  NativeRoomNetworkReplicaWork, NativeRoomNetworkSelectedHypothesis } from "./room-network-contract.ts";
import { OWNED_PLANNING_REVISION, type OwnedPlanningAction, type OwnedPlanningDispatch,
  type OwnedPlanningOwner, type OwnedPlanningResponse } from "./owned-planning-contract.ts";
import { RULES_MODEL_VERSION } from "./rules-planner-identity.ts";
import { PlanningError } from "./planning-errors.ts";
import type { PlanningTrace } from "./planning-trace.ts";

interface Header {
  network: NativeRoomNetworkInput; node_headers: NativeRoomNetworkNodeHeader[];
  seed: [number, number]; identity: string; captured_target?: number;
}
interface Context { progress: RoomPreparationProgress; forecast: ConnectedRoomForecastContext }
interface Stage extends OwnedPlanningResponse {
  slice_fence?: number; customer_id: string; identity: string | null;
  catalog_next: number; node_count: number; input?: CapturedRulesInput;
  use_admitted_input?: boolean; model_version?: string;
  payload: string | null; context: string | null; header: string | null; node: string | null;
  replicas?: Array<{ replica: number; work: string }>;
}
interface Replica extends OwnedPlanningResponse {
  cursor: number; slice_fence?: number; identity: string; round: number;
  target_local_draws: number; header: string; work: string | null;
}

/** One authenticated request performs one bounded job-owned action. All reads
 * and writes retain the parent fence; the parent only sees dispatch metadata. */
interface ArtifactGuard { cursor: number; identity: string | null; phase: OwnedPlanningDispatch["phase"] }
export async function advanceOwnedPlanningWorker(db: ModelDatabase, owner: OwnedPlanningOwner,
  action: OwnedPlanningAction, trace?: PlanningTrace): Promise<OwnedPlanningResponse> {
  const state: { guard?: ArtifactGuard } = {};
  try { return await advanceOwnedPlanningAction(db, owner, action, state, trace); }
  catch (error) {
    if (!(error instanceof OwnedPlanningArtifactError) || !state.guard) throw error;
    const { error: storageError } = await db.rpc("reset_energy_owned_planning_runtime", {
      p_home_id: owner.home_id, p_job_id: owner.job_id, p_fence: owner.fence,
      p_cursor: state.guard.cursor, p_identity: state.guard.identity, p_phase: state.guard.phase,
    });
    if (storageError) throw new Error(`reset_energy_owned_planning_runtime: ${storageError.message}`);
    console.warn("[OWNED-PLANNING] rebuilding unreadable derived artifact", { job_id: owner.job_id, phase: state.guard.phase });
    return { dispatch: null };
  }
}
async function advanceOwnedPlanningAction(db: ModelDatabase, owner: OwnedPlanningOwner,
  action: OwnedPlanningAction, state: { guard?: ArtifactGuard }, trace?: PlanningTrace): Promise<OwnedPlanningResponse> {
  const scope = { p_home_id: owner.home_id, p_job_id: owner.job_id, p_fence: owner.fence };
  const rpc = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const { data, error } = await db.rpc(name, { ...scope, ...args });
    if (error) {
      if (name === "read_energy_forecast_records" && error.message.includes("Missing forecast catalog record")) {
        throw new OwnedPlanningArtifactError("Missing derived forecast catalog record");
      }
      throw new Error(`${name}: ${error.message}`);
    }
    return data as T;
  };
  if (action.kind === "replica") {
    const saved = await rpc<Replica | null>("claim_energy_forecast_replica", { p_replica: action.replica });
    if (!saved?.slice_fence) return { dispatch: saved?.dispatch ?? null, busy: saved?.busy };
    state.guard = { cursor: saved.dispatch!.cursor, identity: saved.identity, phase: saved.dispatch!.phase };
    const header = await unpackOwnedPlanningValue<Header>(saved.header);
    const work = saved.work ? await unpackOwnedPlanningValue<NativeRoomNetworkReplicaWork>(saved.work) : undefined;
    const planner = nativePlanner(trace), first = work?.statistics.trajectories ?? 0;
    const draws = Array.from({ length: Math.min(4, saved.target_local_draws - first) }, (_, i) => first + i);
    const selected = planner.roomNetworkSelect({ node_headers: header.node_headers, seed: header.seed,
      replica: action.replica, local_draws: draws }, trace);
    const records = new Map<string, { node: number; index: number }>();
    for (const draw of selected) draw.hypothesis_indexes.forEach((index, node) => {
      if (index !== null) records.set(`${node}:${index}`, { node, index });
    });
    const hypotheses = await rpc<NativeRoomNetworkSelectedHypothesis[] | null>("read_energy_forecast_records", {
      p_replica: action.replica, p_slice_fence: saved.slice_fence, p_identity: saved.identity, p_records: [...records.values()],
    });
    if (!hypotheses) return { dispatch: null };
    const advanced = planner.roomNetworkReplicaAdvance({ ...header, replica: action.replica,
      target_local_draws: saved.target_local_draws,
      // A warm Edge execution may serve another replica before retiring. Leave
      // CPU for that action and the compressed checkpoint after each native slice.
      max_work: Math.max(1, Math.min(131072, Math.floor(12288 * (9 / header.network.nodes.length) ** 2))),
      work, selected_hypotheses: hypotheses }, trace);
    const dispatch = await rpc<OwnedPlanningDispatch | null>("checkpoint_energy_forecast_replica", {
      p_replica: action.replica, p_slice_fence: saved.slice_fence, p_cursor: saved.cursor,
      p_identity: saved.identity, p_round: saved.round, p_next_cursor: advanced.work.cursor,
      p_completed: advanced.work.statistics.trajectories, p_work: await packOwnedPlanningValue(advanced.work),
    });
    return { dispatch };
  }
  const saved = await rpc<Stage | null>("load_energy_owned_planning_stage", {
    p_revision: `${OWNED_PLANNING_REVISION}:${CONNECTED_CAPTURE_IMPLEMENTATION}:${RULES_MODEL_VERSION}`, p_runtime: Deno.version.v8,
  });
  if (!saved?.dispatch) return { dispatch: null };
  if (saved.dispatch.phase === "integrate") {
    return { dispatch: await rpc<OwnedPlanningDispatch | null>("advance_energy_forecast_barrier") };
  }
  if (!saved.slice_fence || saved.dispatch.phase === "ready") return { dispatch: saved.dispatch, busy: saved.busy };
  const checkpoint = async (update: Record<string, unknown>): Promise<OwnedPlanningResponse> => ({
    dispatch: await rpc<OwnedPlanningDispatch | null>("checkpoint_energy_owned_planning_stage", {
      p_cursor: saved.dispatch!.cursor, p_slice_fence: saved.slice_fence, p_update: update,
    }),
  });
  const phase = saved.dispatch.phase;
  state.guard = { cursor: saved.dispatch.cursor, identity: saved.identity, phase };
  if ((saved.use_admitted_input && saved.model_version !== RULES_MODEL_VERSION) ||
    (saved.input && saved.input.model_version !== RULES_MODEL_VERSION)) {
    throw new PlanningError("Captured rules planner version changed", "planner_upgraded", 409, "recapture");
  }
  if (phase === "capture") {
    if (saved.use_admitted_input) return await checkpoint({ phase: "prepare", use_admitted_input: true, payload: null });
    const input = saved.input!;
    const captured = await advanceConnectedPlanningCapture(db, { ...owner, customer_id: saved.customer_id }, input.snapshot,
      { retainParentLease: true });
    if (captured.pending) return await checkpoint({ phase: "capture" });
    return await checkpoint({ phase: "prepare", input: { ...input, snapshot: captured.snapshot }, payload: null });
  }
  if (phase === "prepare") {
    const progress = saved.payload ? await unpackOwnedPlanningValue<RoomPreparationProgress>(saved.payload) : null;
    const next = prepareCapturedRoomProposals(saved.input!, progress, trace);
    if (next.forecast) {
      const { nativeInput, context } = next.forecast;
      const nodes: string[] = [];
      for (const belief of nativeInput.beliefs) nodes.push(await packOwnedPlanningValue(belief));
      return await checkpoint({ phase: "catalog", identity: nativeInput.identity, nodes, payload: null,
        context: await packOwnedPlanningValue({ progress: next.room_progress, forecast: context } satisfies Context),
        header: await packOwnedPlanningValue({ network: nativeInput.network, seed: nativeInput.seed,
          identity: nativeInput.identity, node_headers: [], captured_target: context.forecast.trajectories } satisfies Header) });
    }
    if (next.room_progress) return await checkpoint({ phase: "prepare", payload: await packOwnedPlanningValue(next.room_progress) });
    return await checkpoint({ phase: "solve", forecast_counts: resolvedRemoteForecastCounts(saved.input!, next.prepared!),
      payload: await packOwnedPlanningValue(next.prepared) });
  }
  if (phase === "catalog") {
    const header = await unpackOwnedPlanningValue<Header>(saved.header!);
    const belief = await unpackOwnedPlanningValue<NativeRoomNetworkBelief>(saved.node!);
    header.node_headers.push(nativePlanner(trace).roomNetworkHeader({ belief }, trace));
    const pages = encodeForecastCatalogPages(belief.hypotheses).map(page => ({ ...page, bytes: ownedPlanningBase64(page.bytes) }));
    const complete = saved.catalog_next + 1 === saved.node_count;
    const deterministic = complete && header.node_headers.every(node => node.deterministic);
    return await checkpoint({ phase: complete ? "integrate" : "catalog", node: saved.catalog_next,
      count: belief.hypotheses.length, pages, header: await packOwnedPlanningValue(header),
      ...(complete ? { replica_count: deterministic ? 1 : 4, target: deterministic ? 1 : header.captured_target ?? 64 } : {}) });
  }
  if (phase === "qualify") {
    const header = await unpackOwnedPlanningValue<Header>(saved.header!);
    const context = await unpackOwnedPlanningValue<Context>(saved.context!);
    const replicas: NativeRoomNetworkReplicaWork[] = [];
    for (const row of saved.replicas!) replicas.push(await unpackOwnedPlanningValue<NativeRoomNetworkReplicaWork>(row.work));
    const planner = nativePlanner(trace), merged = planner.roomNetworkMerge({ ...header, replicas }, trace);
    const accuracy = merged.work.deterministic ? null : connectedIntegrationAccuracy(merged.statistics, {
      ...context.forecast.layout, proposalRejected: merged.assessment.proposal_rejection !== null,
      deadlineResolved: merged.assessment.deadline_resolved,
    });
    if (!merged.work.deterministic && header.captured_target === undefined && !accuracy?.converged) {
      return await checkpoint({ phase: "integrate", target: accuracy!.next_trajectories, replica_count: 4 });
    }
    const output = planner.roomNetworkFinalize({ network: header.network, work: merged.work }, trace);
    const prepared = applyCapturedConnectedForecast(saved.input!, context.progress, context.forecast, output, merged.statistics, trace);
    return await checkpoint({ phase: "solve", forecast_counts: resolvedRemoteForecastCounts(saved.input!, prepared), payload: await packOwnedPlanningValue(prepared) });
  }
  if (phase === "solve") {
    const prepared = await unpackOwnedPlanningValue<PreparedRulesInput>(saved.payload!);
    return await checkpoint({ phase: "assemble", payload: await packOwnedPlanningValue(solveRulesPlan(prepared, trace)) });
  }
  const solved = await unpackOwnedPlanningValue<SolvedRulesInput>(saved.payload!);
  return await checkpoint({ phase: "ready", payload: await packOwnedPlanningValue(assembleRulesPlan(solved, trace)) });
}
