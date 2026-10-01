// Which of a pool's devices heat.
//
// A pool is planned as one service drawing the power of all its devices, but
// only the heater makes heat: the pump circulates water past the heat
// exchanger and must run whenever the heater does. Kept apart from the planner
// proper so the ingest function can ask the same question without loading it.

export interface PoolDevice {
  planning_service?: string;
  pool_role?: "heater" | "circulation";
  active_power_w: number | null;
}

/** The pool devices that heat: those declared heaters, else the one drawing the most power. */
export function poolHeaters<M extends PoolDevice>(models: readonly M[]): M[] {
  const pool = models.filter(model => model.planning_service === "pool");
  const declared = pool.filter(model => model.pool_role === "heater");
  if (declared.length || pool.length < 2) return declared.length ? declared : pool;
  return [pool.reduce((a, b) => (b.active_power_w ?? 0) > (a.active_power_w ?? 0) ? b : a)];
}
