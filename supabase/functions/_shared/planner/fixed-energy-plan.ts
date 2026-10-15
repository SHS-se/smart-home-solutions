import type { OptimisationSnapshot, OptimisationPlan, FixedEnergyPlan, EnergyPlanningInput } from "./planning-contracts.ts";
export type { FixedEnergyPlan, EnergyPlanningInput } from "./planning-contracts.ts";
export const QUARTER_MS = 900_000;
/**
 * What activation asks the planner to materialise. Preflight is judged at the
 * reviewed snapshot's own capture time and against the prices the household
 * reviewed; HA receives a later generation from fresh measurements.
 */
export function fixedPlanPreflightInput(
  snapshot: OptimisationSnapshot,
  priceOutlook: OptimisationPlan["price_outlook"],
  fixed: FixedEnergyPlan,
): EnergyPlanningInput {
  return {
    snapshot,
    now: snapshot.captured_at,
    price_archive: [],
    resolved_price_outlook: priceOutlook,
    fixed_plan: fixed,
  };
}
