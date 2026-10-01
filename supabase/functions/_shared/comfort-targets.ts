// The owner's comfort targets as the planner reads them.
//
// One number per store: the pool's temperature and the car's range. A home
// that has never set them gets the defaults, so it is plannable from the start.

export const DEFAULT_COMFORT_TARGETS = { pool_target_c: 30, ev_target_km: 300 } as const;

export interface ComfortTargetRow {
  pool_target_c: number | string | null;
  ev_target_km: number | string | null;
}

const within = (value: unknown, low: number, high: number, fallback: number): number => {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number >= low && number <= high ? number : fallback;
};

/** `snapshot.comfort` from a stored row; a missing row or an impossible value falls back to the default. */
export function comfortTargets(row: ComfortTargetRow | null | undefined): { pool: { target_c: number }; ev: { target_km: number } } {
  return {
    pool: { target_c: within(row?.pool_target_c, 10, 40, DEFAULT_COMFORT_TARGETS.pool_target_c) },
    ev: { target_km: within(row?.ev_target_km, 0, 1000, DEFAULT_COMFORT_TARGETS.ev_target_km) },
  };
}
