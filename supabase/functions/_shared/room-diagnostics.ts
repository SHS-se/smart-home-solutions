/** Read-only descriptive diagnostics. Neither this operation nor its curves
 * participate in physical fitting, model publication or planning. */
import { measureRoomRuns } from "./device-learning/room/run-measurements.ts";
import { assessMeasuredRuns } from "./device-learning/room/measured-lines.ts";
import { qualifyProbeFreshness } from "./device-learning/room/source-freshness.ts";
import { readRoomQuarters } from "./device-model-learning/room.ts";
import { thermalQuarter } from "./thermal-training.ts";
import type { RoomMeanQuarter } from "./device-learning/room/mean-observations.ts";
import type { RoomRunDiagnostics } from "./planner/models/room/run-diagnostics.ts";


export function describeRoomRuns(rows: readonly RoomMeanQuarter[]): Pick<RoomRunDiagnostics, "calibration" | "runs"> {
  const { runs, calibration } = assessMeasuredRuns(measureRoomRuns(rows), null);
  return { runs, calibration: {
    observed_runs: calibration.observed_runs, heating_runs: calibration.heating_runs,
    cooling_runs: calibration.cooling_runs, heating_flagged_runs: calibration.heating_flagged_runs,
    cooling_flagged_runs: calibration.cooling_flagged_runs, unmeasured_runs: calibration.unmeasured_runs,
    lines: { heating: calibration.lines.heating, cooling: calibration.lines.cooling },
  } };
}

interface DiagnosticEvidence {
  response: null | {revision: string; binding: string; training_from: string; training_to: string;
    connected_exchange?: {incoming: {from: string}[]} | null};
}
export class RoomDiagnosticRevisionChanged extends Error {}

/** Caller RPC performs the same customer/staff authorization as the Model tab.
 * Service-only canonical history is read only after that authorization. */
export async function readRoomDiagnostics(
  // deno-lint-ignore no-explicit-any
  caller: any,
  // deno-lint-ignore no-explicit-any
  service: any,
  homeId: string, roomKey: string,
) {
  const read = async () => {
    const { data, error } = await caller.rpc("get_energy_room_response_evidence", {p_home_id: homeId, p_room_key: roomKey});
    if (error) throw new Error(`Room access: ${error.message}`);
    return data as DiagnosticEvidence;
  };
  const evidence = await read(), response = evidence.response;
  if (!response?.connected_exchange) return evidence;
  const from = Date.parse(response.training_from), to = Date.parse(response.training_to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to || to - from > 30 * 86_400_000) {
    throw new Error("Invalid accepted room diagnostic window");
  }
  const { data: home, error } = await service.from("homes").select("customer_id").eq("id", homeId).single();
  if (error || !home) throw new Error("Room home unavailable");
  const peers = response.connected_exchange.incoming.map(edge => edge.from);
  const raw = await readRoomQuarters(service, homeId, home.customer_id, roomKey, response.training_from, response.training_to, true);
  const rows = qualifyProbeFreshness(raw, peers).rows.map(thermalQuarter);
  const diagnostic = describeRoomRuns(rows);
  const latest = await read();
  if (latest.response?.revision !== response.revision || latest.response?.binding !== response.binding) {
    throw new RoomDiagnosticRevisionChanged("Room response changed during the diagnostic read");
  }
  return {...evidence, diagnostics: {kind: "current_training_window", response_revision: response.revision,
    from_at: response.training_from, to_at: response.training_to, read_at: new Date().toISOString(), ...diagnostic} satisfies RoomRunDiagnostics};
}
