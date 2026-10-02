// The pool temperature a plan expects, quarter by quarter.
//
// A plan does not carry the pool's temperature as a series. It carries what
// fixes one: the water temperature it started from, the temperature before and
// after every quarter it heats in (the pool store's allocations), and the
// temperature it ends the horizon at. Between two heated runs the pool only
// cools, and the plan says from what to what, so the quarters in between are
// drawn on the straight line between them. Cooling is in truth a slow
// exponential; over the hours between two runs the difference is far below
// what the chart can show.

/** What the projection reads of a plan slot. */
export interface PoolPlanSlot {
  decision?: {
    store_allocations?: readonly { store_key: string; state_unit?: string; state_before: number; state_after: number }[];
  } | null;
}

/** How far above the owner's target the planner may heat the pool (energy-optimisation.ts POOL_OVERSHOOT_C). */
const POOL_OVERSHOOT_C = 2;

/**
 * The pool temperature at the end of each planned quarter, °C; null for every
 * quarter when the plan has no pool or does not say where the pool ends.
 */
export function plannedPoolTemperature(
  slots: readonly PoolPlanSlot[],
  startC: number | null | undefined,
  endC: number | null | undefined,
): (number | null)[] {
  const n = slots.length;
  if (n === 0 || startC == null || !Number.isFinite(startC)) return slots.map(() => null);
  // Temperatures at quarter boundaries: index i is the start of quarter i, n the end of the horizon.
  const known = new Map<number, number>([[0, startC]]);
  slots.forEach((slot, index) => {
    const heated = slot.decision?.store_allocations?.find(a => a.store_key === 'pool' && Number.isFinite(a.state_after));
    if (!heated) return;
    if (!known.has(index)) known.set(index, heated.state_before);
    known.set(index + 1, heated.state_after);
  });
  if (endC != null && Number.isFinite(endC)) known.set(n, endC);
  const boundaries = [...known.keys()].sort((a, b) => a - b);
  const out: (number | null)[] = slots.map(() => null);
  for (let k = 0; k + 1 < boundaries.length; k++) {
    const from = boundaries[k], to = boundaries[k + 1];
    const a = known.get(from)!, b = known.get(to)!;
    for (let end = from + 1; end <= to; end++) out[end - 1] = a + (b - a) * (end - from) / (to - from);
  }
  return out;
}

/** What the projection reads of a plan. */
export interface PoolPlan {
  pool?: { water_temperature_c?: number | null; stop_temperature_c?: number | null } | null;
  resolved_value_stores?: readonly { key: string; derivation?: unknown }[] | null;
}

/**
 * The owner's pool target, °C, or null when the plan was not made from one.
 * A plan made from a target stops heating a fixed margin above it, and says
 * where it stops; older plans stop where a hand-drawn curve ends, which is not
 * a target.
 */
export function plannedPoolTarget(plan: PoolPlan): number | null {
  const stop = plan.pool?.stop_temperature_c;
  const fromTarget = plan.resolved_value_stores?.some(store => store.key === 'pool' && store.derivation != null);
  return fromTarget && stop != null && Number.isFinite(stop) ? stop - POOL_OVERSHOOT_C : null;
}
