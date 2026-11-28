import type { OptimisationSnapshot } from "./planner/planning-contracts.ts";

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Room-only weather. Keep provider values; missing slots take the cold side of
 * the available forecast and observed capture basis, never zero or indoor heat.
 * This is a conditional estimate, not a bound on future meteorology. */
export function roomOutdoorSeries(snapshot: Pick<OptimisationSnapshot,
  "slots" | "outdoor_temperature_c" | "room_outdoor_estimate_c">): number[] | null {
  const source = snapshot.outdoor_temperature_c;
  const values = source?.slice(0, snapshot.slots.length).filter(finite) ?? [];
  if (finite(snapshot.room_outdoor_estimate_c)) values.push(snapshot.room_outdoor_estimate_c);
  if (!values.length) return null;
  const cold = Math.min(...values);
  return snapshot.slots.map((_, i) => finite(source?.[i]) ? source![i]! : cold);
}
