// The owner's comfort targets as the planner reads them.
//
// One number per store: the pool's temperature and the car's battery state of
// charge. The planner plans the car in kilometres, so the charge level becomes
// a range through the car's own capacity and consumption. A home that has never
// set them gets the defaults, so it is plannable from the start.

export const DEFAULT_COMFORT_TARGETS = { pool_target_c: 30, ev_target_soc: 80, ev_target_km: 300 } as const;

export interface ComfortTargetRow {
  pool_target_c: number | string | null;
  ev_target_soc: number | string | null;
}

/** The car battery the planner plans with: the snapshot's device model, else the reported EV battery. */
export interface ComfortCar {
  capacity_kwh: number;
  kwh_per_km: number;
}

const within = (value: unknown, low: number, high: number, fallback: number): number => {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number >= low && number <= high ? number : fallback;
};

/** `snapshot.comfort` from a stored row; a missing row or an impossible value falls back to the default. */
export function comfortTargets(row: ComfortTargetRow | null | undefined, car?: ComfortCar | null): { pool: { target_c: number }; ev: { target_km: number } } {
  const soc = within(row?.ev_target_soc, 0, 100, DEFAULT_COMFORT_TARGETS.ev_target_soc);
  return {
    pool: { target_c: within(row?.pool_target_c, 10, 40, DEFAULT_COMFORT_TARGETS.pool_target_c) },
    ev: { target_km: car && car.capacity_kwh > 0 && car.kwh_per_km > 0
      ? soc / 100 * car.capacity_kwh / car.kwh_per_km : DEFAULT_COMFORT_TARGETS.ev_target_km },
  };
}
