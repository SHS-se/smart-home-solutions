/** Persisted evidence contract; contains no fitting or scheduling algorithm. */
export const ROOM_RUN_POLICY = "recent_independent_runs_v1";
export const MIN_ROOM_HEATING_RUNS = 3;
export const MAX_ROOM_HEATING_RUNS = 10;

export function hasRoomRunSupport(value: unknown): boolean {
  if (!value || typeof value !== "object" || !("run_calibration" in value)) return false;
  const support = value.run_calibration;
  return !!support && typeof support === "object" && "policy" in support && support.policy === ROOM_RUN_POLICY &&
    "fitted_runs" in support && Number.isInteger(support.fitted_runs) &&
    Number(support.fitted_runs) >= MIN_ROOM_HEATING_RUNS && Number(support.fitted_runs) <= MAX_ROOM_HEATING_RUNS;
}
