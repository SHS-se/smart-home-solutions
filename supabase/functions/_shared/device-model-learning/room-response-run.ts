import { roomFitContext, usesConnectedRoomFit } from "../device-learning/room/fit-policy.ts";
import { ROOM_MEASURED_CELL_COUNT, prepareMeasuredRoomResponse, fitMeasuredRoomCell, parseMeasuredRoomCells, finalizeMeasuredRoomResponse } from "../device-learning/room/measured-response.ts";
import { captureDeviceModels, type ModelDatabase, type RoomHeatingContext } from "../device-model-store.ts";
import { connectedFitContext, connectedFitEvidence } from "./room-fit-input.ts";
import { decodeRoomResponseFitCapture, encodeRoomResponseFitCapture } from "./room-band-fit-capture.ts";
import { advanceConnectedRoomFit, beginConnectedRoomFit, parseConnectedFitProgress } from "../device-learning/room/connected-response.ts";
import { ROOM_LEARNER_VERSION } from "../room-learner-version.ts";
import {
  ROOM_RESPONSE_IMPLEMENTATION, finalizeStoredRoomResponse, finalizeStoredConnectedRoomResponse, parseRoomSharedMetadata, roomResponseEvidence,
  fitStoredRoom, isRoomPolicyFingerprint, prepareStoredRoomHeating, type RoomLearningClock, type RoomLearningOwner,
} from "./room.ts";

import { ROOM_FIT_CAPTURE_VERSION } from "../room-learning-worker-capabilities.ts";
export { ROOM_FIT_CAPTURE_VERSION };
/** Total numerical work per request, shared by all cells it completes. */
export const ROOM_FIT_NUMERIC_BUDGET_MS = 650;
export interface RoomLearningClaim extends RoomLearningOwner {
  room_history_to: string | null;
  work_class: "source" | "numerical" | "finalization";
  room_fit_progress?: unknown;
  input: { learner_version?: string; location?: { latitude: number; longitude: number } | null };
}
type RoomLearningStep = { kind: "model"; model: Record<string, unknown>; revision: number }
  | { kind: "handled"; result: { checkpointed?: boolean; published?: boolean; superseded?: boolean; incompatible?: boolean } };

export interface RoomSliceTrace {
  stage?: string;
  next_stage?: string;
  cursor?: number;
  next_cursor?: number;
  sweep?: number;
  process_row?: number;
  rows?: number;
  decode_ms?: number;
  prepare_ms?: number;
  source_ms?: number;
  encode_ms?: number;
  finalize_ms?: number;
  numerical_ms?: number;
  rpc_ms?: Record<string, number>;
}

function roomLearningClock(historyTo: string | null, wallNow: number): RoomLearningClock {
  const parsed = typeof historyTo === "string" ? Date.parse(historyTo) : NaN;
  if (!Number.isFinite(parsed)) throw new Error("Room learning claim has no history horizon");
  return { historyTo: parsed, wallNow };
}
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function roomFitRpc(db: ModelDatabase, claim: RoomLearningClaim, revision: number, trace: RoomSliceTrace) {
  const basis = { p_job_id: claim.id, p_generation: claim.generation, p_fence: claim.fence, p_revision: revision };
  return async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const started = performance.now();
    const { data, error } = await db.rpc(name, { ...basis, ...args });
    (trace.rpc_ms ??= {})[name] = Math.round(performance.now() - started);
    if (error) throw new Error(`${name}: ${error.message}`);
    return data;
  };
}

/** The claim transaction has checked progress against the live room binding
 * and model revision. Each numerical RPC repeats the write fence. Fresh
 * acquisition alone needs household model discovery and historical context. */
export async function runRoomLearning(db: ModelDatabase, claim: RoomLearningClaim, wallNow: number, trace: RoomSliceTrace = {}): Promise<RoomLearningStep> {
  if (claim.input.learner_version !== ROOM_LEARNER_VERSION) {
    trace.stage = "incompatible_target";
    return { kind: "handled", result: { incompatible: true } };
  }
  const clock = roomLearningClock(claim.room_history_to, wallNow);
  if (claim.room_fit_progress != null) return await resumeRoomFit(db, claim, clock, claim.room_fit_progress, trace);
  if (claim.work_class !== "source") {
    trace.stage = "missing_checkpoint";
    return { kind: "handled", result: { superseded: true } };
  }
  trace.stage = "source";
  const sourceStarted = performance.now();
  const models = await captureDeviceModels(db, claim.home_id);
  const previous = models.rooms.find(model => model.room_key === claim.owner_key);
  const revision = previous?.model_revision ?? 0;
  const captured = roomFitContext(models, claim.owner_key);
  const location = claim.input.location ?? null;
  if (!captured) {
    const model = await fitStoredRoom(db, claim.home_id, claim.customer_id, claim.owner_key, location, clock);
    trace.source_ms = Math.round(performance.now() - sourceStarted);
    return { kind: "model", model, revision };
  }
  const history = await db.rpc("get_energy_room_heating_context", { p_home_id: claim.home_id, p_room_key: claim.owner_key });
  if (history.error) throw new Error(history.error.message);
  const context: RoomHeatingContext = history.data ?? captured;
  const prepared = await prepareStoredRoomHeating(db, claim, context, previous, location, clock);
  trace.source_ms = Math.round(performance.now() - sourceStarted);
  if (prepared.kind === "model") return { ...prepared, revision };
  if (prepared.kind === "refreshed") return { kind: "handled", result: { checkpointed: true } };
  if (prepared.kind === "superseded") return { kind: "handled", result: { superseded: true } };
  const { metadata, rows, policyFingerprint } = prepared.work;
  const encodeStarted = performance.now();
  const capture = await encodeRoomResponseFitCapture(rows, metadata.fromAt);
  trace.encode_ms = Math.round(performance.now() - encodeStarted);
  trace.rows = rows.length;
  const rpc = roomFitRpc(db, claim, revision, trace);
  const saved = await rpc("checkpoint_energy_room_fit", {
    p_expected_cursor: -1,
    p_metadata: { version: ROOM_FIT_CAPTURE_VERSION, runtime: Deno.version.v8, learner_version: ROOM_LEARNER_VERSION, capture: metadata,
      sha256: capture.sha256, row_count: capture.row_count, policy_fingerprint: policyFingerprint },
    p_capture_base64: capture.base64, p_cell: null,
  });
  return { kind: "handled", result: { checkpointed: saved === true, ...(saved === true ? {} : { superseded: true }) } };
}

async function resumeRoomFit(db: ModelDatabase, claim: RoomLearningClaim, clock: RoomLearningClock,
  progress: unknown, trace: RoomSliceTrace): Promise<RoomLearningStep> {
  const started = performance.now();
  if (!object(progress) || !Number.isInteger(progress.cursor) || Number(progress.cursor) < 0) throw new Error("Invalid room fit progress cursor");
  const revision = progress.base_revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) throw new Error("Invalid room fit base revision");
  const rpc = roomFitRpc(db, claim, revision, trace);
  const reset = async (cursor: number): Promise<RoomLearningStep> => {
    trace.stage = "reset";
    await rpc("reset_energy_room_fit", { p_expected_cursor: cursor });
    return { kind: "handled", result: { superseded: true } };
  };
  const cursor = Number(progress.cursor), envelope = progress.metadata;
  trace.cursor = cursor;
  const metadata = object(envelope) ? parseRoomSharedMetadata(envelope.capture) : null;
  if (!object(envelope) || envelope.version !== ROOM_FIT_CAPTURE_VERSION || envelope.runtime !== Deno.version.v8 || envelope.learner_version !== ROOM_LEARNER_VERSION || !metadata ||
    metadata.implementation !== ROOM_RESPONSE_IMPLEMENTATION || !isRoomPolicyFingerprint(envelope.policy_fingerprint) ||
    metadata.homeId !== claim.home_id || metadata.customerId !== claim.customer_id || metadata.roomKey !== claim.owner_key ||
    metadata.baseRevision !== revision ||
    Date.parse(metadata.historyTo) > clock.historyTo ||
    typeof envelope.sha256 !== "string" || !Number.isSafeInteger(envelope.row_count) || Number(envelope.row_count) < 0 ||
    metadata.trainingView.length > Number(envelope.row_count)) return await reset(cursor);
  const adaptive = usesConnectedRoomFit(metadata.connected);
  if (!adaptive && cursor > ROOM_MEASURED_CELL_COUNT) return await reset(cursor);
  let cells;
  try {
    if (!Array.isArray(progress.cells) || progress.cells.length > ROOM_MEASURED_CELL_COUNT || adaptive && progress.cells.length !== 0) return await reset(cursor);
    cells = parseMeasuredRoomCells(progress.cells);
  }
  catch { return await reset(cursor); }
  if (!adaptive && cells.length !== cursor) return await reset(cursor);
  const encoded = await rpc("load_energy_room_fit_capture", {});
  if (encoded === null) return await reset(cursor);
  if (typeof encoded !== "string") throw new Error("Invalid room fit capture response");
  let rows;
  const decodeStarted = performance.now();
  try { rows = await decodeRoomResponseFitCapture(encoded, metadata.fromAt, envelope.sha256); }
  catch { return await reset(cursor); }
  trace.decode_ms = Math.round(performance.now() - decodeStarted);
  trace.rows = rows.length;
  const preparationStarted = performance.now();
  if (rows.length !== envelope.row_count) return await reset(cursor);
  if (adaptive) {
    const evidence = roomResponseEvidence(rows, metadata.trainingView);
    const current = envelope.heat_state == null ? beginConnectedRoomFit(evidence, connectedFitContext(metadata)) : parseConnectedFitProgress(envelope.heat_state);
    if (!current) return await reset(cursor);
    trace.prepare_ms = Math.round(performance.now() - preparationStarted);
    trace.stage = current.stage;
    if (current.stage === "complete" && envelope.heat_state != null) {
      if (claim.work_class === "numerical") return { kind: "handled", result: { superseded: true } };
      if (!current.result) return await reset(cursor);
      if (current.result.response) current.result.response.evidence = connectedFitEvidence(
        current.result.response.evidence, metadata, rows, envelope.sha256);
      const finalizeStarted = performance.now();
      const final = finalizeStoredConnectedRoomResponse(metadata, rows, current.result);
      trace.finalize_ms = Math.round(performance.now() - finalizeStarted);
      const published = await rpc("complete_energy_room_fit", { p_expected_cursor: cursor, p_model: final.model, p_run_ledger: null });
      return { kind: "handled", result: { published: published === true, ...(published === true ? {} : { superseded: true }) } };
    }
    const numericStarted = performance.now();
    const next = advanceConnectedRoomFit(evidence, current, Math.max(1, ROOM_FIT_NUMERIC_BUDGET_MS - (performance.now() - started)));
    trace.numerical_ms = Math.round(performance.now() - numericStarted);
    trace.next_stage = next.stage;
    trace.sweep = next.optimizer.sweep;
    trace.process_row = next.processPosterior?.cursor;
    const saved = await rpc("checkpoint_energy_room_adaptive_fit", { p_expected_cursor: cursor,
      p_expected_state: envelope.heat_state ?? null, p_state: next });
    return { kind: "handled", result: { checkpointed: saved === true, ...(saved === true ? {} : { superseded: true }) } };
  }
  let prepared;
  try { prepared = prepareMeasuredRoomResponse(roomResponseEvidence(rows, metadata.trainingView), metadata.ratedPowerW); }
  catch { return await reset(cursor); }
  if (cursor < ROOM_MEASURED_CELL_COUNT) {
    trace.stage = "measured_cells";
    trace.prepare_ms = Math.round(performance.now() - preparationStarted);
    const numericStarted = performance.now();
    // Cells are independently resumable; completed cells share one numerical
    // budget and one fenced checkpoint. No latent-state search is resumed.
    const batch: ReturnType<typeof fitMeasuredRoomCell>[] = [];
    do { batch.push(fitMeasuredRoomCell(prepared, cursor + batch.length)); }
    while (cursor + batch.length < ROOM_MEASURED_CELL_COUNT && performance.now() - started < ROOM_FIT_NUMERIC_BUDGET_MS);
    trace.numerical_ms = Math.round(performance.now() - numericStarted);
    trace.next_cursor = cursor + batch.length;
    const saved = await rpc("checkpoint_energy_room_fit_cells", {
      p_expected_cursor: cursor, p_expected_state: envelope.heat_state ?? null,
      p_cells: batch, p_heat_state: null,
    });
    return { kind: "handled", result: { checkpointed: saved === true, ...(saved === true ? {} : { superseded: true }) } };
  }
  trace.stage = "finalization";
  if (claim.work_class === "numerical") return { kind: "handled", result: { superseded: true } };
  // Publication checks the captured policy, binding and model revision.
  // Ordinary observation corrections remain queued for the next fit.
  const finalizeStarted = performance.now();
  const fit = finalizeMeasuredRoomResponse(prepared, cells);
  const final = finalizeStoredRoomResponse(metadata, rows, fit);
  trace.finalize_ms = Math.round(performance.now() - finalizeStarted);
  const published = await rpc("complete_energy_room_fit", { p_expected_cursor: cursor, p_model: final.model, p_run_ledger: final.ledger });
  return { kind: "handled", result: { published: published === true, ...(published === true ? {} : { superseded: true }) } };
}
