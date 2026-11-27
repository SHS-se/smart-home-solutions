import { OwnedPlanningArtifactError, ownedPlanningBase64, packOwnedPlanningValue, unpackOwnedPlanningValue } from "./owned-planning-codec.ts";
import type { ModelDatabase } from "./device-model-store.ts";
import { advanceConnectedPlanningCapture, CONNECTED_CAPTURE_IMPLEMENTATION } from "./connected-room-planning-capture.ts";
import { prepareOwnedRulesProposals, applyCapturedConnectedForecast } from "./rules-planning-execution.ts";
import { solveRulesPlan, assembleRulesPlan, type PreparedRulesInput, type SolvedRulesInput } from "./rules-planner.ts";
import type { CapturedRulesInput } from "./rules-planning-capture.ts";
import type { RoomPreparationProgress } from "./rules-room-services.ts";
import { compileConnectedNodeBelief, type ConnectedRoomCatalog, type ConnectedRoomProposalNetwork } from "./rules-connected-room-services.ts";
import { resolvedForecastCounts } from "./rules-planning-client.ts";
import { encodeForecastCatalogPages } from "./room-forecast-catalog.ts";
import { nativePlanner } from "./planner-wasm/runtime.ts";
import { connectedForecastTarget, type NativeRoomNetworkNodeHeader, type NativeRoomNetworkInput, type NativeRoomNetworkOutput,
  type NativeRoomNetworkReplicaWork, type NativeRoomNetworkSelectedHypothesis } from "./room-network-contract.ts";
import { OWNED_PLANNING_REVISION, type OwnedPlanningAction, type OwnedPlanningDispatch,
  type OwnedPlanningOwner, type OwnedPlanningResponse } from "./owned-planning-contract.ts";
import { hashOwnedSnapshot, type OwnedSnapshotHashHeader } from "./owned-snapshot-hash.ts";
import { RULES_MODEL_VERSION } from "./rules-planner-identity.ts";
import { PlanningError } from "./planning-errors.ts";
import type { ConnectedRoomForecastIdentity, ConnectedRoomPlanningNode } from "./planner/models/room/network.ts";
import type { PlanningTrace } from "./planning-trace.ts";

interface Header {
  network: NativeRoomNetworkInput; node_headers: NativeRoomNetworkNodeHeader[];
  seed: [number, number]; target: number;
}
interface Context { progress: RoomPreparationProgress; forecast: ConnectedRoomCatalog["context"] }
interface QualifiedForecast { output: NativeRoomNetworkOutput; counts: { trajectories: number; replayed_paths: number; replicates: Array<{trajectories:number}> } }
interface Stage extends OwnedPlanningResponse {
  slice_fence?: number; customer_id: string; identity: string | null;
  catalog_next: number; node_count: number; input?: CapturedRulesInput;
  use_admitted_input?: boolean; model_version?: string;
  qualified?: string | null;
  proposal_network?: ConnectedRoomProposalNetwork; forecast?: ConnectedRoomForecastIdentity;
  catalog_source?: { key: string; node: ConnectedRoomPlanningNode | null };
  payload: string | null; context: string | null; header: string | null;
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
    const planner = nativePlanner(trace);
    let hypotheses: NativeRoomNetworkSelectedHypothesis[] | null = [];
    // An in-flight path owns its sampled processes. Native yields at the next draw if it needs records.
    if (work?.path == null) {
      const first = work?.statistics.trajectories ?? 0;
      const draws = Array.from({ length: Math.min(4, saved.target_local_draws - first) }, (_, i) => first + i);
      const selected = planner.roomNetworkSelect({ node_headers: header.node_headers, seed: header.seed,
        replica: action.replica, local_draws: draws }, trace);
      const records = new Map<string, { node: number; index: number }>();
      for (const draw of selected) draw.hypothesis_indexes.forEach((index, node) => {
        if (index !== null) records.set(`${node}:${index}`, { node, index });
      });
      hypotheses = await rpc<NativeRoomNetworkSelectedHypothesis[] | null>("read_energy_forecast_records", {
        p_replica: action.replica, p_slice_fence: saved.slice_fence, p_identity: saved.identity, p_records: [...records.values()],
      });
      if (!hypotheses) return { dispatch: null };
    }
    const advanced = planner.roomNetworkReplicaAdvance({ ...header, identity: saved.identity, replica: action.replica,
      target_local_draws: saved.target_local_draws,
      // A warm Edge execution may serve another replica before retiring. Leave
      // CPU for that action and the compressed checkpoint after each native slice.
      max_work: Math.max(1, Math.min(131072, Math.floor(24576 * (9 / header.network.nodes.length) ** 2))),
      work, selected_hypotheses: hypotheses }, trace);
    const dispatch = await rpc<OwnedPlanningDispatch | null>("checkpoint_energy_forecast_replica", {
      p_replica: action.replica, p_slice_fence: saved.slice_fence, p_cursor: saved.cursor,
      p_identity: saved.identity, p_round: saved.round, p_next_cursor: advanced.work.cursor,
      p_completed: advanced.work.statistics.trajectories, p_work: await packOwnedPlanningValue(advanced.work),
    });
    return { dispatch };
  }
  const version = { p_revision: `${OWNED_PLANNING_REVISION}:${CONNECTED_CAPTURE_IMPLEMENTATION}:${RULES_MODEL_VERSION}`, p_runtime: Deno.version.v8 };
  const saved = await rpc<Stage | null>("load_energy_owned_planning_stage", { ...version, p_project_rooms: true });
  if (!saved?.dispatch) return { dispatch: null };
  if (saved.dispatch.phase === "seal") {
    const cursor = { p_cursor: saved.dispatch.cursor };
    const header = await rpc<OwnedSnapshotHashHeader | null>("read_energy_owned_snapshot_for_hash", { ...cursor, p_node: null });
    if (!header) return { dispatch: null };
    const digest = await hashOwnedSnapshot(header, (p_node) => rpc("read_energy_owned_snapshot_for_hash", { ...cursor, p_node }));
    if (digest === null) return { dispatch: null };
    return { dispatch: await rpc<OwnedPlanningDispatch | null>("seal_energy_owned_planning_snapshot", {
      ...cursor, ...version, p_snapshot_hash: digest,
    }) };
  }
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
    return await checkpoint({ phase: "prepare", input: { ...input, snapshot: captured.snapshot }, completed_node_keys: captured.completed_node_keys, payload: null });
  }
  if (phase === "prepare") {
    const progress = saved.payload ? await unpackOwnedPlanningValue<RoomPreparationProgress>(saved.payload) : null;
    const next = prepareOwnedRulesProposals(saved.input!, saved.proposal_network, progress, trace);
    if (next.catalog) {
      const { network, context } = next.catalog, { forecast } = context;
      const identityPrefix = JSON.stringify({snapshot: saved.input!.snapshot.snapshot_id, forecast, network, beliefs: []}).slice(0, -2);
      return await checkpoint({ phase: "catalog", node_keys: network.nodes.map(node => node.key), identity_prefix: identityPrefix, payload: null,
        context: await packOwnedPlanningValue({ progress: next.progress, forecast: context } satisfies Context),
        header: await packOwnedPlanningValue({ network, seed: forecast.seed, node_headers: [], target: connectedForecastTarget(forecast) } satisfies Header) });
    }
    if (next.progress) return await checkpoint({ phase: "prepare", payload: await packOwnedPlanningValue(next.progress) });
    return await checkpoint({ phase: "solve", forecast_counts: null, payload: await packOwnedPlanningValue(next.prepared) });
  }
  if (phase === "catalog") {
    const header = await unpackOwnedPlanningValue<Header>(saved.header!);
    const source = saved.catalog_source, key = header.network.nodes[saved.catalog_next]?.key;
    if (!source || !key || source.key !== key || source.node && source.node.key !== key) {
      throw new OwnedPlanningArtifactError("Missing active forecast catalogue source");
    }
    const belief = compileConnectedNodeBelief(source.node, header.network);
    // The empty thermal-only entry and fitted entry have different JSON field order.
    const framing = JSON.stringify({ ...belief, hypotheses: [] });
    const start = framing.indexOf('"hypotheses":[]') + '"hypotheses":['.length;
    header.node_headers.push(nativePlanner(trace).roomNetworkHeader({ belief }, trace));
    const pages = encodeForecastCatalogPages(belief.hypotheses).map(page => ({ ...page, bytes: ownedPlanningBase64(page.bytes) }));
    const complete = saved.catalog_next + 1 === saved.node_count;
    const deterministic = complete && header.node_headers.every(node => node.deterministic);
    return await checkpoint({ phase: complete ? "integrate" : "catalog", node: saved.catalog_next,
      count: belief.hypotheses.length, pages, identity_before_records: framing.slice(0, start), identity_after_records: framing.slice(start),
      header: await packOwnedPlanningValue(header),
      ...(complete ? { replica_count: deterministic ? 1 : 4, target: deterministic ? 1 : header.target } : {}) });
  }
  if (phase === "qualify") {
    if (saved.qualified == null) {
      const result = await qualifyOwnedRoomForecast(saved, trace);
      return await checkpoint({ phase: "qualify", qualified: await packOwnedPlanningValue(result) });
    }
    const qualified = await unpackOwnedPlanningValue<QualifiedForecast>(saved.qualified);
    const context = await unpackOwnedPlanningValue<Context>(saved.context!);
    const prepared = applyCapturedConnectedForecast(saved.input!, context.progress, context.forecast, qualified.output, qualified.counts, trace);
    return await checkpoint({ phase: "solve", forecast_counts: resolvedForecastCounts(saved.forecast, prepared.rooms.network_forecast), payload: await packOwnedPlanningValue(prepared) });
  }
  if (phase === "solve") {
    const prepared = await unpackOwnedPlanningValue<PreparedRulesInput>(saved.payload!);
    return await checkpoint({ phase: "assemble", payload: await packOwnedPlanningValue(solveRulesPlan(prepared, trace)) });
  }
  const solved = await unpackOwnedPlanningValue<SolvedRulesInput>(saved.payload!);
  return await checkpoint({ phase: "ready", payload: await packOwnedPlanningValue(assembleRulesPlan(solved, trace)) });
}

/** The merge consumes replica statistics. Only the final command output and counts reach household preparation. */
async function qualifyOwnedRoomForecast(saved: Stage, trace?: PlanningTrace) {
  const header = await unpackOwnedPlanningValue<Header>(saved.header!);
  const replicas: NativeRoomNetworkReplicaWork[] = [];
  for (const row of saved.replicas!) replicas.push(await unpackOwnedPlanningValue<NativeRoomNetworkReplicaWork>(row.work));
  const planner = nativePlanner(trace);
  const merged = planner.roomNetworkMerge({ network: header.network, seed: header.seed, identity: saved.identity!, replicas }, trace);
  const { trajectories, replayed_paths, replicates } = merged.statistics;
  const counts = { trajectories, replayed_paths, replicates: replicates.map(({trajectories}) => ({trajectories})) };
  return { output: planner.roomNetworkFinalize({ network: header.network, work: merged.work }, trace), counts };
}
