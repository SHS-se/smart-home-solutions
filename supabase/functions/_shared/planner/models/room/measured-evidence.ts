/** Published measured-run evidence. These are data contracts, not fitting policy. */
export const ROOM_MEASURED_POLICY = "measured_room_runs_v1" as const;
export const ROOM_MEASUREMENT_METHOD = "native_mean_onset_peak_v1" as const;

export interface MeasuredRoomLine {
  reference_outdoor_c: number;
  intercept: number;
  slope_per_c: number;
  robust_scale: number;
  points: number;
  effective_points: number;
  constraint: "rises" | "falls";
  units: "c_per_kwh" | "c_per_h";
}

export interface MeasuredHeatingPoint {
  on_ms: number;
  peak_ms: number;
  peak_end_ms: number;
  energy_kwh: number;
  hours: number;
  rise_c: number;
  c_per_kwh: number;
  room_start_c: number;
  room_peak_c: number;
  room_mean_c: number;
  outdoor_c: number;
  house_c: number | null;
  native_seconds: number[];
}

export interface MeasuredCoolingPoint {
  from_ms: number;
  to_ms: number;
  hours: number;
  c_per_h: number;
  room_c: number;
  outdoor_c: number;
  house_c: number | null;
  energy_kwh: number;
}

export interface MeasuredRoomRun {
  id: string;
  from_ms: number;
  on_ms: number;
  off_ms: number;
  to_ms: number;
  energy_kwh: number;
  heating: MeasuredHeatingPoint | null;
  cooling: MeasuredCoolingPoint | null;
  reasons: string[];
}

export interface MeasuredRoomAssessment extends MeasuredRoomRun {
  reference_heating_c_per_kwh: number | null;
  reference_cooling_c_per_h: number | null;
  heating_residual: number | null;
  cooling_residual: number | null;
  disposition: "consistent" | "above_line" | "below_line" | "unmeasured";
}

export interface MeasuredRoomCalibration {
  policy: typeof ROOM_MEASURED_POLICY;
  measurement_method: typeof ROOM_MEASUREMENT_METHOD;
  fitted_observations: number;
  residual_degrees_of_freedom: number;
  observed_runs: number;
  heating_runs: number;
  cooling_runs: number;
  flagged_runs: number;
  unmeasured_runs: number;
  reference: { room_c: number; house_c: number };
  lines: {
    heating: MeasuredRoomLine | null;
    cooling: MeasuredRoomLine | null;
    reference_heating: MeasuredRoomLine | null;
    reference_cooling: MeasuredRoomLine | null;
  };
  validation: {
    training_to: string | null;
    observations: number;
    trajectory_mae_c: number | null;
    trajectory_bias_c: number | null;
    /** Future positive uncontrolled heat is excluded, as in the planner. */
    projected_trajectory_mae_c?: number | null;
    projected_trajectory_bias_c?: number | null;
  };
}

export interface MeasuredRoomLedger {
  policy: typeof ROOM_MEASURED_POLICY;
  assessed_against?: string | null;
  assessment_revision?: string | null;
  observed_runs: number;
  runs: MeasuredRoomAssessment[];
}

export const measuredRoomLineAt = (line: MeasuredRoomLine, outdoorC: number): number =>
  line.intercept + line.slope_per_c * (outdoorC - line.reference_outdoor_c);

/** Structural support is distinct from agreement or the number of closed runs. */
export function hasMeasuredRoomSupport(value: unknown): boolean {
  if (!value || typeof value !== "object" || !("measured_runs" in value)) return false;
  const support = value.measured_runs;
  if (!support || typeof support !== "object" || !("policy" in support) || support.policy !== ROOM_MEASURED_POLICY ||
    !("fitted_observations" in support) || !("residual_degrees_of_freedom" in support)) return false;
  return typeof support.fitted_observations === "number" && Number.isSafeInteger(support.fitted_observations) &&
    typeof support.residual_degrees_of_freedom === "number" && Number.isFinite(support.residual_degrees_of_freedom) &&
    support.fitted_observations > 0 && support.residual_degrees_of_freedom > 0 &&
    support.residual_degrees_of_freedom < support.fitted_observations;
}
