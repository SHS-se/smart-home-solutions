/** Persisted evidence contract; contains no fitting or scheduling algorithm. */
/** Shared response fitted from every eligible contiguous native-interval transition. */
export const ROOM_TRANSITION_POLICY = "shared_interval_transitions_v1";
export interface RoomTransitionCalibration {
  policy: typeof ROOM_TRANSITION_POLICY;
  fitted_transitions: number;
}

/** Historical shared room response fitted on runs drawn from every outdoor stratum. */
export const ROOM_RUN_POLICY = "seasonal_independent_runs_v1";
/** Per-5 °C-band responses fitted on each band's latest ten runs (pre shared response). */
export const LEGACY_ROOM_RUN_POLICY = "recent_independent_runs_v1";
export const MIN_ROOM_HEATING_RUNS = 3;
/** Maximum in historical shared-run records; never limits chronological fitting. */
export const MAX_ROOM_HEATING_RUNS = 24;
const LEGACY_MAX_ROOM_HEATING_RUNS = 10;

export type RoomRunPolicy = typeof ROOM_RUN_POLICY | typeof LEGACY_ROOM_RUN_POLICY;
export const maximumRoomHeatingRuns = (policy: RoomRunPolicy): number =>
  policy === ROOM_RUN_POLICY ? MAX_ROOM_HEATING_RUNS : LEGACY_MAX_ROOM_HEATING_RUNS;

export function hasRoomRunSupport(value: unknown): boolean {
  if (!value || typeof value !== "object" || !("run_calibration" in value)) return false;
  const support = value.run_calibration;
  if (!support || typeof support !== "object" || !("policy" in support) || !("fitted_runs" in support)) return false;
  const policy = support.policy;
  if (policy !== ROOM_RUN_POLICY && policy !== LEGACY_ROOM_RUN_POLICY) return false;
  return Number.isInteger(support.fitted_runs) && Number(support.fitted_runs) >= MIN_ROOM_HEATING_RUNS &&
    Number(support.fitted_runs) <= maximumRoomHeatingRuns(policy);
}

/** A numerical fit certifies the transition count and residual degrees of
 * freedom. Published run diagnostics do not establish transition support. */
export function hasRoomTransitionSupport(value: unknown): boolean {
  if (!value || typeof value !== "object" || !("transition_calibration" in value) ||
    !("residual_degrees_of_freedom" in value)) return false;
  const support = value.transition_calibration;
  if (!support || typeof support !== "object" || !("policy" in support) || support.policy !== ROOM_TRANSITION_POLICY ||
    !("fitted_transitions" in support)) return false;
  const count = support.fitted_transitions, dof = value.residual_degrees_of_freedom;
  return typeof count === "number" && Number.isSafeInteger(count) && typeof dof === "number" &&
    Number.isSafeInteger(dof) && dof > 0 && dof < count;
}
