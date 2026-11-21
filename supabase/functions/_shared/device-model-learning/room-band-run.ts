import type { RoomHeatingContext, StoredDeviceModel } from "../device-model-store.ts";
import { heatingBand } from "../planner/heating-bands.ts";
import type { ProbeFreshnessReport } from "../device-learning/room/source-freshness.ts";
import {
  ROOM_BAND_FIT_CELL_COUNT, advanceIndependentRoomBandCell, parseRoomHeatFitState, finalizeIndependentRoomBand,
  fitIndependentRoomBand, parseRoomBandFitCells, prepareIndependentRoomBand,
} from "../device-learning/room/mean-observations.ts";
import { decodeRoomBandFitCapture, encodeRoomBandFitCapture } from "./room-band-fit-capture.ts";
import {
  ROOM_WINDOW_IMPLEMENTATION, finalizeStoredRoomBand, parseRoomBandMetadata,
  prepareStoredRoomHeating, recaptureStoredRoomBand, type RoomLearningClock,
} from "./room.ts";

interface Database {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}
export interface RoomLearningClaim {
  id: string; home_id: string; customer_id: string; owner_key: string;
  generation: number; fence: number; room_fit_progress?: unknown; room_window_visits?: unknown;
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
const sameFreshness = (a: ProbeFreshnessReport | null, b: ProbeFreshnessReport | null) =>
  a === null || b === null ? a === b : (["room", "house"] as const).every(scope =>
    (["inferred", "unavailable", "unverified"] as const).every(kind => a[scope][kind] === b[scope][kind]));

/** One immutable learning capture, eighteen bounded cells, one atomic result.
 * Scratch is private job progress, never an accepted model or measured history. */
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
    const prepared = await prepareStoredRoomHeating(db, claim.home_id, claim.customer_id, claim.owner_key,
      context, previous, claim.input.location ?? null, clock, claim.room_window_visits);
    if (prepared.kind === "model") return prepared;
    const { metadata, rows } = prepared.work;
    if (!rows.length) return { kind: "model", model: finalizeStoredRoomBand(metadata, rows,
      fitIndependentRoomBand(rows, outdoor => heatingBand(outdoor) === metadata.window.band_c, metadata.ratedPowerW)) };
    const capture = await encodeRoomBandFitCapture(rows, metadata.window.from_at);
    const saved = await rpc("checkpoint_energy_room_fit", {
      p_expected_cursor: -1,
      p_metadata: { version: 1, runtime: Deno.version.v8, capture: metadata,
        sha256: capture.sha256, row_count: capture.row_count },
      p_capture_base64: capture.base64, p_cell: null,
    });
    return { kind: "handled", result: { checkpointed: saved === true, ...(saved === true ? {} : { superseded: true }) } };
  }
  if (!object(progress) || !Number.isInteger(progress.cursor) || Number(progress.cursor) < 0 ||
    Number(progress.cursor) > ROOM_BAND_FIT_CELL_COUNT) throw new Error("Invalid room fit progress cursor");
  const cursor = Number(progress.cursor), envelope = progress.metadata;
  const metadata = object(envelope) ? parseRoomBandMetadata(envelope.capture) : null;
  if (!object(envelope) || envelope.version !== 1 || envelope.runtime !== Deno.version.v8 || !metadata ||
    metadata.implementation !== ROOM_WINDOW_IMPLEMENTATION || metadata.binding !== context.binding ||
    metadata.homeId !== claim.home_id || metadata.customerId !== claim.customer_id || metadata.roomKey !== claim.owner_key ||
    metadata.baseRevision !== revision || progress.base_revision !== revision ||
    Date.parse(metadata.window.to_at) > clock.historyTo ||
    typeof envelope.sha256 !== "string" || !Number.isInteger(envelope.row_count)) return await reset(cursor);
  let cells;
  try { cells = parseRoomBandFitCells(progress.cells); }
  catch { return await reset(cursor); }
  if (cells.length !== cursor) return await reset(cursor);
  if (cursor < ROOM_BAND_FIT_CELL_COUNT) {
    const encoded = await rpc("load_energy_room_fit_capture", {});
    if (encoded === null) return await reset(cursor);
    if (typeof encoded !== "string") throw new Error("Invalid room fit capture response");
    let rows;
    try { rows = await decodeRoomBandFitCapture(encoded, metadata.window.from_at, envelope.sha256); }
    catch { return await reset(cursor); }
    if (rows.length !== envelope.row_count) return await reset(cursor);
    const prepared = prepareIndependentRoomBand(rows, outdoor => heatingBand(outdoor) === metadata.window.band_c,
      metadata.ratedPowerW);
    let heatState;
    try { heatState = parseRoomHeatFitState(envelope.heat_state, cursor); }
    catch { return await reset(cursor); }
    const step = advanceIndependentRoomBandCell(prepared, cursor, heatState);
    const saved = step.cell ? await rpc("checkpoint_energy_room_fit", {
      p_expected_cursor: cursor, p_metadata: null, p_capture_base64: null, p_cell: step.cell,
    }) : await rpc("checkpoint_energy_room_heat_iteration", {
      p_expected_cursor: cursor, p_expected_state: envelope.heat_state ?? null, p_heat_state: step.state,
    });
    return { kind: "handled", result: { checkpointed: saved === true, ...(saved === true ? {} : { superseded: true }) } };
  }
  // Revalidate the actual qualified inputs, including passive/doorway forcing.
  // New readings beyond the fixed capture end belong to a subsequent attempt.
  const current = await recaptureStoredRoomBand(db, claim.home_id, claim.customer_id, claim.owner_key, metadata);
  if (current.kind === "superseded") return await reset(cursor);
  const refreshed = await encodeRoomBandFitCapture(current.work.rows, metadata.window.from_at);
  if (refreshed.sha256 !== envelope.sha256 ||
    !sameFreshness(current.work.metadata.sourceFreshness, metadata.sourceFreshness)) return await reset(cursor);
  const rows = current.work.rows;
  const prepared = prepareIndependentRoomBand(rows, outdoor => heatingBand(outdoor) === metadata.window.band_c,
    metadata.ratedPowerW);
  const fit = finalizeIndependentRoomBand(prepared, cells);
  const model = finalizeStoredRoomBand(metadata, rows, fit);
  const published = await rpc("complete_energy_room_fit", { p_expected_cursor: cursor, p_model: model });
  return { kind: "handled", result: { published: published === true, ...(published === true ? {} : { superseded: true }) } };
}
