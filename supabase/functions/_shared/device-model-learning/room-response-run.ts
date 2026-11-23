import { ROOM_RESPONSE_CELL_COUNT, prepareRoomResponse, advanceRoomResponseCells, finalizeRoomResponse } from "../device-learning/room/response-learning.ts";
import type { RoomHeatingContext, StoredDeviceModel } from "../device-model-store.ts";
import {
  parseRoomHeatFitState, parseRoomBandFitCells,
} from "../device-learning/room/mean-observations.ts";
import { decodeRoomResponseFitCapture, encodeRoomResponseFitCapture } from "./room-band-fit-capture.ts";
import {
  ROOM_RESPONSE_IMPLEMENTATION, finalizeStoredRoomResponse, parseRoomSharedMetadata, roomResponseEvidence,
  prepareStoredRoomHeating, type RoomLearningClock,
} from "./room.ts";

interface Database {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}
/** Envelope 4: every chronological transition plus its independently qualified training view. */
export const ROOM_FIT_CAPTURE_VERSION = 4;
/** Total numerical work per request, shared by all cells it completes. */
export const ROOM_FIT_NUMERIC_BUDGET_MS = 500;
export interface RoomLearningClaim {
  id: string; home_id: string; customer_id: string; owner_key: string;
  generation: number; fence: number; room_fit_progress?: unknown;
  input: { location?: { latitude: number; longitude: number } | null };
}
type RoomLearningStep = { kind: "model"; model: Record<string, unknown> }
  | { kind: "handled"; result: { checkpointed?: boolean; published?: boolean; superseded?: boolean } };

export function roomLearningClock(historyTo: string | null, wallNow: number): RoomLearningClock {
  const parsed = typeof historyTo === "string" ? Date.parse(historyTo) : NaN;
  if (!Number.isFinite(parsed)) throw new Error("Room learning claim has no history horizon");
  return { historyTo: parsed, wallNow };
}
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * One request refreshes one canonical evidence block, captures its pinned
 * chronological view, advances bounded numerical cells, or
 * finalizes and publishes. Scratch is private job progress, never an accepted
 * model or measured history.
 */
export async function runRoomHeatingLearning(
  db: Database, claim: RoomLearningClaim, context: RoomHeatingContext,
  previous: StoredDeviceModel | undefined, clock: RoomLearningClock,
): Promise<RoomLearningStep> {
  const revision = previous?.model_revision ?? 0;
  const basis = { p_job_id: claim.id, p_generation: claim.generation, p_fence: claim.fence, p_revision: revision };
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const { data, error } = await db.rpc(name, { ...basis, ...args });
    if (error) throw new Error(`${name}: ${error.message}`);
    return data;
  };
  const reset = async (cursor: number): Promise<RoomLearningStep> => {
    await rpc("reset_energy_room_fit", { p_expected_cursor: cursor });
    return { kind: "handled", result: { superseded: true } };
  };
  const progress = claim.room_fit_progress;
  if (progress == null) {
    const prepared = await prepareStoredRoomHeating(db, claim, context, previous, claim.input.location ?? null, clock);
    if (prepared.kind === "model") return prepared;
    if (prepared.kind === "refreshed") return { kind: "handled", result: { checkpointed: true } };
    if (prepared.kind === "superseded") return { kind: "handled", result: { superseded: true } };
    const { metadata, rows } = prepared.work;
    // Source qualification and numerical fitting use separate requests. The
    // capture stores the full view plus sparse training-only qualification
    // deltas, without retaining household probe vectors in numerical work.
    const capture = await encodeRoomResponseFitCapture(rows, metadata.fromAt);
    const saved = await rpc("checkpoint_energy_room_fit", {
      p_expected_cursor: -1,
      p_metadata: { version: ROOM_FIT_CAPTURE_VERSION, runtime: Deno.version.v8, capture: metadata,
        sha256: capture.sha256, row_count: capture.row_count },
      p_capture_base64: capture.base64, p_cell: null,
    });
    return { kind: "handled", result: { checkpointed: saved === true, ...(saved === true ? {} : { superseded: true }) } };
  }
  if (!object(progress) || !Number.isInteger(progress.cursor) || Number(progress.cursor) < 0) throw new Error("Invalid room fit progress cursor");
  if (Number(progress.cursor) > ROOM_RESPONSE_CELL_COUNT) return await reset(Number(progress.cursor));
  const cursor = Number(progress.cursor), envelope = progress.metadata;
  const metadata = object(envelope) ? parseRoomSharedMetadata(envelope.capture) : null;
  if (!object(envelope) || envelope.version !== ROOM_FIT_CAPTURE_VERSION || envelope.runtime !== Deno.version.v8 || !metadata ||
    metadata.implementation !== ROOM_RESPONSE_IMPLEMENTATION || metadata.binding !== context.binding ||
    metadata.homeId !== claim.home_id || metadata.customerId !== claim.customer_id || metadata.roomKey !== claim.owner_key ||
    metadata.baseRevision !== revision || progress.base_revision !== revision ||
    Date.parse(metadata.historyTo) > clock.historyTo ||
    typeof envelope.sha256 !== "string" || !Number.isSafeInteger(envelope.row_count) || Number(envelope.row_count) < 0 ||
    metadata.trainingView.length > Number(envelope.row_count)) return await reset(cursor);
  let cells;
  try {
    if (!Array.isArray(progress.cells) || progress.cells.length > ROOM_RESPONSE_CELL_COUNT) return await reset(cursor);
    cells = parseRoomBandFitCells(progress.cells);
  }
  catch { return await reset(cursor); }
  if (cells.length !== cursor) return await reset(cursor);
  const encoded = await rpc("load_energy_room_fit_capture", {});
  if (encoded === null) return await reset(cursor);
  if (typeof encoded !== "string") throw new Error("Invalid room fit capture response");
  let rows;
  try { rows = await decodeRoomResponseFitCapture(encoded, metadata.fromAt, envelope.sha256); }
  catch { return await reset(cursor); }
  if (rows.length !== envelope.row_count) return await reset(cursor);
  let prepared;
  try { prepared = prepareRoomResponse(roomResponseEvidence(rows, metadata.trainingView), metadata.ratedPowerW); }
  catch { return await reset(cursor); }
  if (cursor < ROOM_RESPONSE_CELL_COUNT) {
    let heatState;
    try { heatState = parseRoomHeatFitState(envelope.heat_state, cursor); }
    catch { return await reset(cursor); }
    // One bounded numerical budget per request across as many cells as it
    // completes, then one fenced write of them and the next partial state.
    const batch = advanceRoomResponseCells(prepared, cells, heatState, ROOM_FIT_NUMERIC_BUDGET_MS);
    const saved = await rpc("checkpoint_energy_room_fit_cells", {
      p_expected_cursor: cursor, p_expected_state: envelope.heat_state ?? null,
      p_cells: batch.cells, p_heat_state: batch.state,
    });
    return { kind: "handled", result: { checkpointed: saved === true, ...(saved === true ? {} : { superseded: true }) } };
  }
  // The captured view is immutable. Corrections to its source range supersede
  // it; additions beyond its pinned horizon belong to the next ordinary fit.
  const fit = finalizeRoomResponse(prepared, cells);
  const final = finalizeStoredRoomResponse(metadata, rows, fit);
  const published = await rpc("complete_energy_room_fit", { p_expected_cursor: cursor, p_model: final.model, p_run_ledger: final.ledger });
  return { kind: "handled", result: { published: published === true, ...(published === true ? {} : { superseded: true }) } };
}
