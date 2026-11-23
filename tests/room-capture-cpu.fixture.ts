import { assert, assertEquals } from "@std/assert";
import { encodeRoomEvidenceCapture } from "../supabase/functions/_shared/device-model-learning/room-evidence-capture.ts";
import type { ThermalQuarterRow } from "../supabase/functions/_shared/thermal-training.ts";

const ROWS = 400 * 96;
const TRAINING_ROWS = ROWS * 2 / 3;
const START = Date.UTC(2024, 0, 1);
const at = (index: number) => new Date(START + 900_000 * index).toISOString();
export const ROOM_CAPTURE_NOW = Date.parse(at(ROWS));

/** Independently generated source facts. The replacement room probe first
 * reports a long constant temperature at the end of training. Its normal
 * cadence becomes observable only later, so the two views must differ. */
function syntheticQuarter(i: number): ThermalQuarterRow {
  const replacement = i >= TRAINING_ROWS - 48;
  const frozen = replacement && i < TRAINING_ROWS;
  const temperature = frozen ? 20 : 20 + Math.sin(i / 120);
  const key = replacement ? "synthetic-replacement" : "synthetic-probe-0";
  return { room_key: "synthetic", room_name: "Synthetic room", source: "recorder_5minute_mean", start_ts: at(i),
    duration_s: 900, heat_attributed: false, cooling: false, active_power_w: 400, temperature_source_key: key,
    room_temperature_c: temperature, heat_w: i % 997 === 0 ? null : i % 12 < 4 ? 400 : 0,
    solar_w_per_m2: 200 * Math.max(0, Math.sin(i / 15)), outdoor_temperature_c: 5 * Math.sin(i / 4000),
    house_temperature_c: null, probe_evidence: Array.from({ length: 12 }, (_, p) => {
      const quiet = p === 0 && replacement ? frozen : i % 30 < 5;
      return { source_key: p === 0 ? key : `synthetic-probe-${p}`, area_key: `synthetic-area-${p}`,
        cohort_key: p === 0 ? null : `synthetic-bridge-${p % 3}`, mean: p === 0 ? temperature : 19 + Math.sin(i / 50 + p),
        unchanged: quiet, joint_unchanged: quiet, unavailable: null, reported: !quiet && i % 6 === 0 ? true : null };
    }) };
}

/** Build transport bytes outside the measured child. No decoded rows or warm
 * codec carry into the measured request. All layouts contain identical facts. */
export async function syntheticRoomArchive(blockCount: number): Promise<Uint8Array<ArrayBuffer>> {
  if (![40, 400, 9600].includes(blockCount)) throw new Error("Unknown synthetic room archive layout");
  const blocks: { from_at: string; to_at: string; row_count: number; sha256: string; capture: string }[] = [];
  const size = ROWS / blockCount;
  for (let start = 0; start < ROWS; start += size) {
    const from_at = at(start), to_at = at(start + size);
    const rows = Array.from({ length: size }, (_, j) => syntheticQuarter(start + j));
    const { base64, sha256, row_count } = await encodeRoomEvidenceCapture(rows, from_at, to_at);
    blocks.push({ from_at, to_at, row_count, sha256, capture: base64 });
  }
  return new TextEncoder().encode(JSON.stringify(blocks));
}

export function replayRoomCapture(archive: ArrayBuffer, observeMemory?: () => void) {
  const context = { binding: "synthetic", observed_since: at(0) };
  const claim = { id: "synthetic", home_id: "synthetic-home", customer_id: "synthetic-customer", owner_kind: "room",
    owner_key: "synthetic", generation: 1, fence: 1, input: {}, room_history_to: at(ROWS) };
  let saved = false, released = false;
  return {
    rpc(name: string, args: Record<string, unknown>) {
      let data: unknown;
      switch (name) {
        case "verify_energy_learning_token": data = true; break;
        case "claim_energy_device_learning": data = claim; break;
        case "capture_energy_device_models": data = { pool: null, rooms: [], room_heating: { synthetic: context } }; break;
        case "get_energy_room_heating_context": data = context; break;
        case "get_energy_room_evidence_work": data = { source_revision: 1, next: null }; break;
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
          assertEquals(copy.p_metadata.row_count, ROWS);
          assertEquals(copy.p_metadata.capture.trainingView.length, TRAINING_ROWS);
          assert(copy.p_metadata.capture.trainingView.temperatures.length > 0);
          assert(copy.p_capture_base64.length > 0 && /^[a-f0-9]{64}$/.test(copy.p_metadata.sha256));
          saved = true; data = true; break;
        }
        case "release_energy_room_learning_lane": released = true; data = true; break;
        default: throw new Error(`Unexpected room capture RPC: ${name}`);
      }
      return Promise.resolve({ data: JSON.parse(JSON.stringify(data)), error: null });
    },
    check() { assert(saved && released); },
  };
}
