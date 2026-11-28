/** Read-only descriptive evidence, separate from fitted physical parameters. */
import type {MeasuredRoomCalibration, MeasuredRoomAssessment} from "./measured-evidence.ts";

export interface RoomRunDiagnostics {
  kind: "current_training_window";
  response_revision: string;
  from_at: string;
  to_at: string;
  read_at: string;
  calibration: Pick<MeasuredRoomCalibration, "observed_runs" | "heating_runs" | "cooling_runs" |
    "heating_flagged_runs" | "cooling_flagged_runs" | "unmeasured_runs"> & {
      lines: Pick<MeasuredRoomCalibration["lines"], "heating" | "cooling">;
    };
  runs: MeasuredRoomAssessment[];
}
