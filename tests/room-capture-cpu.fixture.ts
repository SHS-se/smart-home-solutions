import { assert, assertEquals } from "@std/assert";
import { encodeRoomEvidenceCapture } from "../supabase/functions/_shared/device-model-learning/room-evidence-capture.ts";
import { syntheticRoomBandStress } from "../supabase/functions/_shared/device-learning/room/native-mean.fixture.ts";
import { type RoomMeanQuarter } from "../supabase/functions/_shared/device-learning/room/mean-observations.ts";
import { fitMeasuredRoomCell, prepareMeasuredRoomResponse, ROOM_MEASURED_CELL_COUNT, type MeasuredRoomCell } from "../supabase/functions/_shared/device-learning/room/measured-response.ts";
import { ROOM_MEASURED_POLICY } from "../supabase/functions/_shared/planner/models/room/measured-evidence.ts";
import { decodeRoomResponseFitCapture } from "../supabase/functions/_shared/device-model-learning/room-band-fit-capture.ts";
import { roomResponseEvidence, type RoomSharedMetadata } from "../supabase/functions/_shared/device-model-learning/room.ts";
import type { ThermalQuarterRow } from "../supabase/functions/_shared/thermal-training.ts";

const ROWS = 400 * 96;
const TRAINING_ROWS = ROWS * 2 / 3;
const START = Date.UTC(2024, 0, 1);
const at = (index: number) => new Date(START + 900_000 * index).toISOString();
export const ROOM_CAPTURE_NOW = Date.parse(at(ROWS));

/** Independently generated source facts. The replacement room probe first
 * reports a long constant temperature at the end of training. Its normal
 * cadence becomes observable only later, so the two views must differ. */
function syntheticQuarter(i: number, measured?: RoomMeanQuarter): ThermalQuarterRow {
  const replacement = i >= TRAINING_ROWS - 48;
  const frozen = replacement && i < TRAINING_ROWS;
  // Synthetic unmetered heat varies independently of the metered heater.
  const pulse = (i % 149 - 37) / 11;
  const temperature = frozen ? 20 : measured
    ? measured.room_c! + .08 * Math.sin(i * .61) + .7 * Math.exp(-pulse * pulse)
    : 20 + Math.sin(i / 120);
  const key = replacement ? "synthetic-replacement" : "synthetic-probe-0";
  return { room_key: "synthetic", room_name: "Synthetic room", source: "recorder_5minute_mean", start_ts: at(i),
    duration_s: 900, heat_attributed: false, cooling: false, active_power_w: measured ? 800 : 400, temperature_source_key: key,
    room_temperature_c: temperature, heat_w: i % 997 === 0 ? null : measured?.heat_w ?? (i % 12 < 4 ? 400 : 0),
    solar_w_per_m2: measured?.solar_w_per_m2 ?? 200 * Math.max(0, Math.sin(i / 15)),
    outdoor_temperature_c: measured?.outdoor_c ?? 5 * Math.sin(i / 4000),
    house_temperature_c: measured?.house_c ?? null, probe_evidence: Array.from({ length: 12 }, (_, p) => {
      const quiet = p === 0 && replacement ? frozen : i % 30 < 5;
      return { source_key: p === 0 ? key : `synthetic-probe-${p}`, area_key: `synthetic-area-${p}`,
        cohort_key: p === 0 ? null : `synthetic-bridge-${p % 3}`, mean: p === 0 ? temperature : 19 + Math.sin(i / 50 + p),
        unchanged: quiet, joint_unchanged: quiet, unavailable: null, reported: !quiet && i % 6 === 0 ? true : null };
    }) };
}

/** Build transport bytes outside the measured child. No decoded rows or warm
 * codec carry into the measured request. All layouts contain identical facts. */
export async function syntheticRoomArchive(blockCount: number, measuredPlant = false): Promise<Uint8Array<ArrayBuffer>> {
  if (![40, 400, 9600].includes(blockCount)) throw new Error("Unknown synthetic room archive layout");
  const blocks: { from_at: string; to_at: string; row_count: number; sha256: string; capture: string }[] = [];
  const size = ROWS / blockCount;
  const plant = measuredPlant ? syntheticRoomBandStress(false) : undefined;
  for (let start = 0; start < ROWS; start += size) {
    const from_at = at(start), to_at = at(start + size);
    const rows = Array.from({ length: size }, (_, j) => syntheticQuarter(start + j, plant?.[start + j]));
    const { base64, sha256, row_count } = await encodeRoomEvidenceCapture(rows, from_at, to_at);
    blocks.push({ from_at, to_at, row_count, sha256, capture: base64 });
  }
  return new TextEncoder().encode(JSON.stringify(blocks));
}

export interface RoomNumericCheckpoint {
  capture: string;
  progress: { base_revision: number; cursor: number; cells: MeasuredRoomCell[]; metadata: {
    version: number; runtime: string; capture: RoomSharedMetadata; sha256: string;
    row_count: number; policy_fingerprint?: string; heat_state?: unknown;
  } };
}

export function replayRoomCapture(input: ArrayBuffer | RoomNumericCheckpoint, observeMemory?: () => void) {
  let archive = input instanceof ArrayBuffer ? input : new ArrayBuffer(0);
  let checkpoint = input instanceof ArrayBuffer ? null : input;

  const context = { binding: "synthetic", observed_since: at(0) };
  const claim = { id: "synthetic", home_id: "synthetic-home", customer_id: "synthetic-customer", owner_kind: "room",
    owner_key: "synthetic", generation: 1, fence: 1, input: {}, room_history_to: at(ROWS) };
  let saved = false, released = false, reset = false, published = false;
  return {
    rpc(name: string, args: Record<string, unknown>) {
      let data: unknown;
      switch (name) {
        case "verify_energy_learning_token": data = true; break;
        case "claim_energy_device_learning": data = { ...claim, room_fit_progress: checkpoint?.progress ?? null }; break;
        case "capture_energy_device_models": assert(!checkpoint, "Numerical claims skip bundle discovery"); data = { pool: null, rooms: [], room_heating: { synthetic: context } }; break;
        case "get_energy_room_heating_context": assert(!checkpoint, "Numerical claims skip context discovery"); data = context; break;
        case "get_energy_room_evidence_work": data = { source_revision: 1, policy_fingerprint: "b".repeat(64), next: null }; break;
        case "load_energy_room_evidence_blocks":
          assertEquals([args.p_from_at, args.p_to_at], [at(0), at(ROWS)]);
          data = JSON.parse(new TextDecoder().decode(archive));
          archive = new ArrayBuffer(0);
          observeMemory?.();
          return Promise.resolve({ data, error: null });
        case "checkpoint_energy_room_fit": {
          // The actual checkpoint crosses JSON before the database accepts it.
          const copy = JSON.parse(JSON.stringify(args));
          observeMemory?.();
          assertEquals(copy.p_expected_cursor, -1);
          assertEquals(copy.p_metadata.policy_fingerprint, "b".repeat(64));
          assertEquals(copy.p_metadata.row_count, ROWS);
          assertEquals(copy.p_metadata.version, 5);
          assert(copy.p_metadata.capture.implementation.includes(ROOM_MEASURED_POLICY));
          assertEquals(copy.p_metadata.capture.trainingView.length, TRAINING_ROWS);
          assert(copy.p_metadata.capture.trainingView.temperatures.length > 0);
          assert(copy.p_capture_base64.length > 0 && /^[a-f0-9]{64}$/.test(copy.p_metadata.sha256));
          checkpoint = { capture: copy.p_capture_base64, progress: {
            base_revision: copy.p_revision, cursor: 0, cells: [], metadata: copy.p_metadata,
          } };
          saved = true; data = true; break;
        }
        case "load_energy_room_fit_capture":
          assert(checkpoint);
          data = checkpoint.capture; break;
        case "reset_energy_room_fit":
          assert(checkpoint);
          assertEquals(args.p_expected_cursor, checkpoint.progress.cursor);
          checkpoint = null; reset = true; data = true; break;
        case "checkpoint_energy_room_fit_cells": {
          assert(checkpoint);
          const copy = JSON.parse(JSON.stringify(args));
          const progress = checkpoint.progress;
          assertEquals(copy.p_expected_cursor, progress.cursor);
          assertEquals(copy.p_expected_state, progress.metadata.heat_state ?? null);
          assert(copy.p_cells.length > 0);
          assertEquals(copy.p_heat_state, null, "Measured cells do not resume a latent heat state");
          assertEquals(copy.p_revision, progress.base_revision);
          progress.cells.push(...copy.p_cells);
          progress.cursor = progress.cells.length;
          if (copy.p_heat_state) progress.metadata.heat_state = copy.p_heat_state;
          else delete progress.metadata.heat_state;
          saved = true; data = true; break;
        }
        case "complete_energy_room_fit": {
          assert(checkpoint);
          assertEquals(args.p_expected_cursor, ROOM_MEASURED_CELL_COUNT);
          assertEquals(checkpoint.progress.cursor, ROOM_MEASURED_CELL_COUNT);
          // Keep serialization and the accepted ledger in the measured request.
          const copy = JSON.parse(JSON.stringify(args));
          assertEquals(copy.p_revision, checkpoint.progress.base_revision);
          assert(copy.p_model.trained);
          assert(copy.p_model.heating_bands.reference.learning_evidence.measured_calibration);
          assert(copy.p_run_ledger.runs.length > 0);
          published = true; data = true; break;
        }
        case "release_energy_room_learning_lane": released = true; data = true; break;
        default: throw new Error(`Unexpected room capture RPC: ${name}`);
      }
      return Promise.resolve({ data: JSON.parse(JSON.stringify(data)), error: null });
    },
    check() { assert(saved && released && checkpoint && !reset); return checkpoint; },
    checkReset() { assert(reset && released && !saved && checkpoint === null); },
    checkPublished() { assert(published && released && !saved && !reset); },
  };
}

/** Resume immediately before an expensive weather-dependent finite/full cell
 * at a nonzero lag. Every preceding cell is genuine production output, built
 * outside the measured request; the checkpoint has no latent scratch state. */
export async function resumedRoomCheckpoint(first: RoomNumericCheckpoint, cursor = 21): Promise<RoomNumericCheckpoint> {
  const { metadata } = first.progress, view = metadata.capture;
  const rows = await decodeRoomResponseFitCapture(first.capture, view.fromAt, metadata.sha256);
  const prepared = prepareMeasuredRoomResponse(roomResponseEvidence(rows, view.trainingView), view.ratedPowerW);
  assertEquals(ROOM_MEASURED_CELL_COUNT, 108);
  // lag .5, full partition, weather-dependent finite family.
  const cells = Array.from({ length: cursor }, (_, index) => fitMeasuredRoomCell(prepared, index));
  assertEquals(cells[18].fits[0]?.family, "finite");
  assertEquals(cells[18].fits[0]?.lag, .5);
  return { capture: first.capture, progress: { ...first.progress, cells, cursor, metadata: { ...metadata } } };
}

/** A missing meter every 997 quarters removes the adjacent transitions. Only
 * the full-history freshness check identifies the replacement probe freeze. */
export function syntheticFitTransitions(partition: "full" | "training") {
  const length = partition === "training" ? TRAINING_ROWS : ROWS;
  let count = 0, previous = false;
  for (let i = 0; i < length; i++) {
    const frozen = partition === "full" && i >= TRAINING_ROWS - 48 && i < TRAINING_ROWS;
    const observed = i % 997 !== 0 && !frozen;
    if (previous && observed) count++;
    previous = observed;
  }
  return count;
}
