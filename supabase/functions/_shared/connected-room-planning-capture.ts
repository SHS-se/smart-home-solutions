import { ROOM_LEARNER_VERSION } from "./room-learner-version.ts";
import type { ModelDatabase, RoomConnectionGraph } from "./device-model-store.ts";
import type { OptimisationSnapshot } from "./planner/planning-contracts.ts";
import { connectedRoomDependencies, type ConnectedRoomPlanningNode } from "./planner/models/room/network.ts";
import { roomPlanClock } from "./planner/models/room/state.ts";
import { filterConnectedRoomExchange, readConnectedRoomResponse, type ConnectedFilterDiagnostics, type ConnectedRoomResponse, type ConnectedProcessBelief, type ExchangePosterior } from "./planner/models/room/connected-exchange.ts";
import { beginConnectedProcessInference, advanceConnectedProcessInference, connectedProcessResponse, type ConnectedProcessProgress } from "./device-learning/room/connected-process.ts";
import { readRoomQuarters, ROOM_RESPONSE_IMPLEMENTATION, ROOM_SOURCE_IMPLEMENTATION } from "./device-model-learning/room.ts";
import { sha256Hex } from "./ha-device-auth.ts";
import { encodeRoomEvidenceCapture, decodeRoomEvidenceCapture, qualifyRoomEvidenceBlocks, type DecodedRoomEvidenceBlock } from "./device-model-learning/room-evidence-capture.ts";
import { encodeRoomResponseFitCapture, decodeRoomResponseFitCapture, ROOM_RESPONSE_CAPTURE_REVISION } from "./device-model-learning/room-band-fit-capture.ts";
import { thermalQuarter } from "./thermal-training.ts";
import { assembleConnectedRoomNodes, finalizeConnectedRoomNodes } from "./room-network-capture.ts";
import { applyConnectedRoomCapture, completeOwnedRoomCapture, type CompletedRoomHeader } from "./room-model-capture.ts";
import { planningWarning, type PlanningWarning } from "./planner/planning-warnings.ts";

import type { OwnedPlanningOwner } from "./owned-planning-contract.ts";
export interface ConnectedPlanningOwner extends OwnedPlanningOwner { customer_id: string }
interface CaptureState {
  version: 1;
  implementation: string;
  runtime: string;
  room: number;
  phase: "source" | "qualify" | "reuse" | "process" | "filter" | "assemble" | "complete";
  from_at: string;
  next_from_at: string;
  policy: string | null;
  row: number;
  posterior?: ExchangePosterior;
  diagnostics?: ConnectedFilterDiagnostics;
  process?: ConnectedProcessProgress;
  process_tail?: boolean;
  cache_identity?: string;
  cache_candidates?: Omit<InferenceCache, "belief">[];
  process_response?: ConnectedRoomResponse;
  nodes?: ConnectedRoomPlanningNode[];
  warnings: PlanningWarning[];
}
interface EncodedBlock { from_at: string; to_at: string; capture: string; sha256: string }
interface StoredCapture {
  cursor: number;
  state: CaptureState | null;
  frozen_model?: unknown;
  completed_headers?: CompletedRoomHeader[];
  blocks?: EncodedBlock[];
  numeric?: { capture: string | null; sha256: string; full_sha256: string; from_at: string; row_from: number; total_rows: number } | null;
}
interface SourceContext { graph: RoomConnectionGraph; binding: string; policy: string; source_revision: number;
  next: { from_at: string; to_at: string } | null }
interface InferenceCache { through_at: string; row_count: number; numeric_sha256: string; current_prefix_sha256?: string; belief: ConnectedProcessBelief }
const HOUR = 3_600_000;
const BLOCK_MS = 10 * 86_400_000;
const FILTER_BUDGET_MS = 600;
const FILTER_ROWS = 128;
// Explicit protocol covers capture/qualification/assembly orchestration outside
// the model digest. Bump on any incompatible derived-state semantic change.
export const CONNECTED_CAPTURE_IMPLEMENTATION = `${ROOM_RESPONSE_IMPLEMENTATION}:${ROOM_LEARNER_VERSION}:planning_capture_v3`;

/** One bounded action in the existing planning attempt. Standalone checkpoints
 * release their lease; the owned worker retains it for the parent's bounded wave.
 * Source qualification sees the complete frozen population for one receiver.
 * Filtering carries its posterior across requests without refitting parameters. */
export async function advanceConnectedPlanningCapture(db: ModelDatabase, owner: ConnectedPlanningOwner,
  snapshot: OptimisationSnapshot, options: { retainParentLease?: boolean } = {}): Promise<{ pending: boolean; snapshot?: OptimisationSnapshot; completed_node_keys?: string[]; receipt?: unknown }> {
  const pending = snapshot.room_network_capture;
  if (!pending?.rooms.length) return { pending: false, snapshot };
  const rpc = async <T>(name: string, body: Record<string, unknown>): Promise<T> => {
    const { data, error } = await db.rpc(name, body);
    if (error) throw new Error(`${name}: ${error.message}`);
    return data as T;
  };
  const identity = { p_home_id: owner.home_id, p_job_id: owner.job_id, p_fence: owner.fence };
  const saved = await rpc<StoredCapture | null>("load_energy_planning_room_capture", { ...identity, p_node_delta: true, ...(options.retainParentLease && {p_project_completed:true}) });
  if (!saved) return { pending: true };
  const through = roomPlanClock(snapshot).start_ms, toAt = new Date(through).toISOString();
  const startRoom = (index: number, warnings: PlanningWarning[]): CaptureState => {
    const model = pending.rooms[index]?.connected_exchange;
    const from_at = new Date(Math.min(Date.parse(model?.basis.history_from ?? toAt), through)).toISOString();
    return { version: 1, implementation: CONNECTED_CAPTURE_IMPLEMENTATION, runtime: Deno.version.v8, room: index, phase: index < pending.rooms.length ? "source" : "complete",
      from_at, next_from_at: from_at, policy: null, row: 0, warnings };
  };
  const checkpoint = async (next: CaptureState & { completed_nodes?: ConnectedRoomPlanningNode[] }, raw: unknown = null, numeric: unknown = null, proof: unknown = null) => ({ pending: true,
    receipt: await rpc(options.retainParentLease ? "checkpoint_energy_owned_room_capture" : "checkpoint_energy_planning_room_capture", { ...identity, p_expected_cursor: saved.cursor,
      p_state: next, p_raw: raw, p_numeric: numeric, p_source_proof: proof }) });
  const state = saved.state ?? startRoom(0, []);
  // Optimizer coordinates and covariance are executable state. A deployment
  // restarts this derived preparation inside the same admitted attempt.
  if (state.version !== 1 || state.implementation !== CONNECTED_CAPTURE_IMPLEMENTATION || state.runtime !== Deno.version.v8 ||
    !Number.isSafeInteger(state.room) || state.room < 0 || state.room > pending.rooms.length) {
    return checkpoint({ ...startRoom(0, []), nodes: [] });
  }
  if (state.phase === "complete") {
    if (options.retainParentLease) {
      const network = finalizeConnectedRoomNodes(saved.completed_headers!, node => node.required_peers);
      return { pending: false, ...completeOwnedRoomCapture(snapshot, network.nodes, [...state.warnings, ...network.warnings]) };
    }
    const network = finalizeConnectedRoomNodes(state.nodes!, connectedRoomDependencies);
    return { pending: false, snapshot: applyConnectedRoomCapture(snapshot, network.nodes, [...state.warnings, ...network.warnings]) };
  }
  const room = pending.rooms[state.room];
  let model = state.process_response ?? room.connected_exchange;
  const skipRoom = (error: unknown) => checkpoint(startRoom(state.room + 1, [...state.warnings,
    planningWarning("room_evidence_unavailable", room.key, `${room.name}: connected-room evidence could not be captured.`,
      "Existing comfort instructions and measured electrical demand remain active.", { reason: error instanceof Error ? error.message : String(error) })]));
  // Only qualification and assembly without a newly inferred response consume
  // the accepted population. All other phases need its small physical body.
  if (room.connected_reference && (state.phase === "qualify" || state.phase === "assemble" && !state.process_response)) {
    const frozen = readConnectedRoomResponse(saved.frozen_model);
    if (!frozen?.process_belief) return await skipRoom(new Error("Missing or invalid frozen room exchange population"));
    model = frozen;
  }
  if (!model) return skipRoom(new Error("Missing captured receiving response"));

  if (state.phase === "source") {
    if (Date.parse(state.next_from_at) >= through) return checkpoint({ ...state, phase: "qualify" });
    let context: SourceContext | null;
    let encoded: Awaited<ReturnType<typeof encodeRoomEvidenceCapture>>;
    let blockFrom: string, blockTo: string;
    try {
      context = await rpc<SourceContext | null>("freeze_energy_connected_planning_sources", {
        ...identity, p_room: state.room, p_from: state.from_at, p_to: toAt,
        p_implementation: ROOM_SOURCE_IMPLEMENTATION, p_policy: state.policy,
      });
      if (!context) return { pending: true };
      if (context.graph.owner !== model.basis.graph_owner || context.graph.revision !== model.basis.graph_revision ||
        context.graph.topology_hash !== model.basis.topology_hash || state.policy !== null && state.policy !== context.policy) {
        throw new Error("Room source assignments or connection map changed during capture");
      }
      if (!context.next) return checkpoint({ ...state, policy: context.policy, phase: "qualify" });
      blockFrom = context.next.from_at; blockTo = context.next.to_at;
      const from = Date.parse(blockFrom), to = Date.parse(blockTo);
      const rows = (await readRoomQuarters(db, owner.home_id, owner.customer_id, room.key,
        new Date(from - HOUR).toISOString(), new Date(Math.min(through, to + HOUR)).toISOString(), true))
        .filter(row => Date.parse(row.start_ts) >= from && Date.parse(row.start_ts) < to);
      encoded = await encodeRoomEvidenceCapture(rows, blockFrom, blockTo);
    } catch (error) { return await skipRoom(error); }
    return checkpoint({ ...state, policy: context.policy, next_from_at: blockTo, phase: Date.parse(blockTo) === through ? "qualify" : "source" },
      { room: state.room, from_at: blockFrom, to_at: blockTo, ...encoded }, null,
      { room_key: room.key, from_at: state.from_at, to_at: toAt, binding: context.binding, policy: context.policy,
        source_revision: context.source_revision, implementation: ROOM_SOURCE_IMPLEMENTATION });
  }
  if (state.phase === "qualify") {
    let numeric, candidates: Omit<InferenceCache, "belief">[] | undefined, cacheIdentity: string | undefined;
    let process: ConnectedProcessProgress | undefined, row = 0;
    try {
      const blocks: DecodedRoomEvidenceBlock[] = [];
      for (const block of saved.blocks ?? []) blocks.push({ ...block,
        rows: await decodeRoomEvidenceCapture(block.capture, block.from_at, block.to_at, block.sha256) });
      const proof = model.evidence.process_source_prefix as { numeric_sha256: string; rows: number; through_ms: number;
        from_at: string; codec_revision: string; peer_keys?: string[] } | undefined;
      const peers = [...new Set([...model.incoming.map(edge => edge.from), ...(proof?.peer_keys ?? [])])].sort();
      const qualified = qualifyRoomEvidenceBlocks(blocks, room.key, state.from_at, toAt, peers);
      const rows = qualified.quarters.map(thermalQuarter);
      numeric = await encodeRoomResponseFitCapture(rows, state.from_at);
      if (model.incoming.length) {
        cacheIdentity = await sha256Hex(JSON.stringify({ model, implementation: CONNECTED_CAPTURE_IMPLEMENTATION, runtime: Deno.version.v8 }));
        if (proof?.codec_revision === ROOM_RESPONSE_CAPTURE_REVISION && proof.from_at === state.from_at &&
          Number.isSafeInteger(proof.rows) && proof.rows > 0 && proof.rows <= rows.length &&
          model.process_belief?.hypotheses.every(h => h.posterior.through_ms === proof.through_ms) &&
          rows[proof.rows - 1].start_ms + (rows[proof.rows - 1].duration_s ?? 900) * 1000 === proof.through_ms &&
          (await encodeRoomResponseFitCapture(rows.slice(0, proof.rows), state.from_at)).sha256 === proof.numeric_sha256) {
          process = beginConnectedProcessInference(model, [], model.process_belief); row = proof.rows;
        } else {
          // The proper cold prior uses the full native population's cadence.
          process = beginConnectedProcessInference(model, rows);
        }
        candidates = await rpc<Omit<InferenceCache, "belief">[]>("load_energy_connected_inference", { ...identity, p_room: state.room, p_identity: cacheIdentity });
        candidates = candidates.filter(candidate => candidate.row_count > row && Date.parse(candidate.through_at) <= through);
      }
    } catch (error) { return await skipRoom(error); }
    return checkpoint({ ...state, phase: candidates?.length ? "reuse" : "process", cache_candidates: candidates,
      cache_identity: cacheIdentity, process, row }, null, { ...numeric, from_at: state.from_at });
  }
  if (!saved.numeric) return await skipRoom(new Error("Missing immutable connected planning observations"));
  const started = performance.now();
  if (state.phase === "reuse") {
    const [candidate, ...rest] = state.cache_candidates ?? [];
    let previous: ConnectedProcessBelief | undefined;
    if (candidate) {
      const cached = await rpc<InferenceCache | null>("load_energy_connected_inference", { ...identity, p_room: state.room,
        p_identity: state.cache_identity, p_through_at: candidate.through_at });
      if (cached?.numeric_sha256 === cached?.current_prefix_sha256 && cached) previous = cached.belief;
    }
    return checkpoint({ ...state, cache_candidates: rest,
      phase: previous || !rest.length ? "process" : "reuse",
      ...(previous ? { process: beginConnectedProcessInference(model, [], previous), row: candidate.row_count } : {}) });
  }
  let rows;
  try { rows = await decodeRoomResponseFitCapture(saved.numeric.capture!, saved.numeric.from_at, saved.numeric.sha256); }
  catch (error) { return await skipRoom(error); }
  if (state.phase === "process") {
    if (!model.incoming.length) return checkpoint({ ...state, phase: "filter" });
    const retainProcess = (reason: string) => {
      const { process: _process, ...retained } = state;
      return checkpoint({ ...retained, process_tail: undefined, row: 0, posterior: undefined, diagnostics: undefined, phase: "filter", warnings: [...state.warnings,
        planningWarning("room_state_boundary_estimate", room.key, `${room.name}: recent exchange parameters could not be identified.`,
          "The accepted exchange response is filtered through the captured observations.", { reason })] });
    };
    let progress: ConnectedProcessProgress;
    try { progress = state.process ?? beginConnectedProcessInference(model, rows); }
    catch (error) { return retainProcess(error instanceof Error ? error.message : String(error)); }
    let advanced: ConnectedProcessProgress = progress;
    const offset = saved.numeric.row_from, total = saved.numeric.total_rows;
    const finishProcess = (complete: ConnectedProcessProgress) => {
      const { process: _process, process_tail: _tail, ...retained } = state;
      const derived = connectedProcessResponse(complete);
      derived.evidence = { ...derived.evidence, planning_capture: { from_at: state.from_at, to_at: toAt,
        numeric_sha256: saved.numeric!.full_sha256, source_policy: state.policy } };
      const filtered = filterConnectedRoomExchange(derived, [], derived.reference_state.through_ms, derived.reference_state,
        derived.evidence.thermal_state_identified === true);
      filtered.diagnostics.observed_intervals = derived.reference_state.observations;
      filtered.diagnostics.unavailable_intervals = Math.max(0, total - derived.reference_state.observations);
      return checkpoint({ ...retained, phase: "assemble", process_response: derived,
        row: total, posterior: filtered.posterior, diagnostics: filtered.diagnostics });
    };
    if (state.process_tail) {
      try {
        advanced = advanceConnectedProcessInference([], progress, through,
          Math.max(1, FILTER_BUDGET_MS - (performance.now() - started)));
        return advanced.complete ? finishProcess(advanced) : checkpoint({ ...state, process: advanced });
      } catch (error) { return retainProcess(error instanceof Error ? error.message : String(error)); }
    }
    const continueProcess = (next: ConnectedProcessProgress) => checkpoint({ ...state, row: offset + next.cursor,
      process: { ...next, cursor: 0, complete: false } });
    for (let blocks = 0; blocks < 8; blocks++) {
      let prefixLength = rows.length;
      try {
        // Prefix checkpoints retain every old observation. Empty spans do not
        // force one request per missing block or change the numerical clock.
        const at = progress.work ? rows[progress.cursor].start_ms : progress.belief.hypotheses[0].posterior.through_ms;
        let boundary = Date.parse(state.from_at) + (Math.floor((at - Date.parse(state.from_at)) / BLOCK_MS) + 1) * BLOCK_MS;
        for (;;) {
          const beyond = rows.findIndex(row => row.start_ms + (row.duration_s ?? 900) * 1000 > boundary);
          prefixLength = beyond < 0 ? rows.length : beyond;
          if (prefixLength > progress.cursor || prefixLength === rows.length) break;
          boundary += BLOCK_MS;
        }
        const prefix = rows.slice(0, prefixLength);
        const observedThrough = prefix.length ? prefix.at(-1)!.start_ms + (prefix.at(-1)!.duration_s ?? 900) * 1000 : Date.parse(state.from_at);
        advanced = advanceConnectedProcessInference(prefix, progress, observedThrough,
          Math.max(1, FILTER_BUDGET_MS - (performance.now() - started)));
      } catch (error) { return retainProcess(error instanceof Error ? error.message : String(error)); }
      if (!advanced.complete) return continueProcess(advanced);
      const prefixThrough = advanced.belief.hypotheses[0].posterior.through_ms;
      if (state.cache_identity) await rpc("save_energy_connected_inference", { ...identity, p_room: state.room, p_identity: state.cache_identity,
        p_through_at: new Date(prefixThrough).toISOString(), p_row_count: offset + prefixLength,
        p_numeric_sha256: null, p_belief: advanced.belief,
        p_block_boundary: prefixLength < rows.length || (prefixThrough - Date.parse(state.from_at)) % BLOCK_MS === 0 });
      if (prefixLength === rows.length) {
        if (offset + prefixLength < total) return continueProcess(advanced);
        break;
      }
      progress = { ...advanced, complete: false };
      if (blocks === 7 || performance.now() - started >= FILTER_BUDGET_MS) return continueProcess(progress);
    }
    // Only the observed prefix was cached above. Tail prediction gets its own
    // bounded receipt work and can never become a measured source checkpoint.
    if (advanced.belief.hypotheses[0].posterior.through_ms < through) {
      return checkpoint({ ...state, row: total, process_tail: true,
        process: beginConnectedProcessInference(connectedProcessResponse(advanced), [], advanced.belief) });
    }
    return finishProcess(advanced);
  }
  if (state.phase === "filter") {
    let row = state.row, posterior = state.posterior, diagnostics = state.diagnostics;
    do {
      const end = Math.min(rows.length, row + FILTER_ROWS), final = end === rows.length;
      const endMs = final ? through : rows[end - 1].start_ms + (rows[end - 1].duration_s ?? 900) * 1000;
      const filtered = filterConnectedRoomExchange(model, rows.slice(row, end), endMs, posterior, diagnostics?.thermal_state_identified ?? false);
      posterior = filtered.posterior;
      const previous = diagnostics;
      diagnostics = { ...filtered.diagnostics };
      if (previous) for (const key of ["observed_intervals", "unavailable_intervals", "reinitializations", "numerical_failures",
        "negative_log_likelihood", "squared_error_c2"] as const) diagnostics[key] += previous[key];
      row = end;
    } while (row < rows.length && performance.now() - started < FILTER_BUDGET_MS);
    return checkpoint({ ...state, row, posterior, diagnostics, phase: row === rows.length ? "assemble" : "filter" });
  }
  if (state.phase !== "assemble" || !state.posterior || !state.diagnostics) throw new Error("Invalid connected planning assembly");
  const assembled = assembleConnectedRoomNodes(snapshot, [{ room, model, rows, filtered: { posterior: state.posterior, diagnostics: state.diagnostics } }],
    new Map(pending.observations), pending.rooms.flatMap(room => room.connected_exchange ? [room.connected_exchange] : []));
  return checkpoint({ ...startRoom(state.room + 1, [...state.warnings, ...assembled.warnings]), completed_nodes: assembled.nodes });
}
