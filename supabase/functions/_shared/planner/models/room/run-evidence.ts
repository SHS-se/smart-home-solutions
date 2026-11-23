/** Persisted evidence contract; contains no fitting or scheduling algorithm. */
/** One shared room response fitted on runs drawn from every outdoor stratum. */
export const ROOM_RUN_POLICY = "seasonal_independent_runs_v1";
/** Per-5 °C-band responses fitted on each band's latest ten runs (pre shared response). */
export const LEGACY_ROOM_RUN_POLICY = "recent_independent_runs_v1";
export const MIN_ROOM_HEATING_RUNS = 3;
/** Newest runs harvested per 5 °C outdoor stratum; strata only sample evidence.
 * The working set then takes them round-robin, so a one-season room keeps all
 * its runs and a multi-season room keeps every season. */
export const RUNS_PER_OUTDOOR_BAND = 24;
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
