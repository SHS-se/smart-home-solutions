// Independent equal-comfort guards: pool cold exposure with a linear tail and the car floor.
import type { BenchSeries } from './types';
import { poolComfortExposure } from '../../../supabase/functions/_shared/planner-wasm/pool-comfort';

export type Comfort = NonNullable<BenchSeries['comfort']>;
export interface ServiceGuard { pool: 'linear_tail_shortfall' }
export const DEFAULT_SERVICE_GUARD: ServiceGuard = { pool: 'linear_tail_shortfall' };
export interface StoreExposure { mild: number; severe: number; worst: number; mildDeficitHours: number; severeDeficitHours: number }
export interface ServiceExposure { pool: number; ev: StoreExposure }

/** Integrated quadratic/linear cold exposure, with actual interval durations and no renewed recovery grace. */
export function poolExposure(comfort: Comfort, values: ArrayLike<number | null>, _guard: ServiceGuard, hours?: ArrayLike<number>): number {
  let exposure = 0, before: number | null = comfort.pool_start_c;
  for (let i = 0; i < values.length; i++) {
    const after = values[i];
    if (before !== null && after !== null) exposure += poolComfortExposure(comfort.pool_target_c, before, after, hours?.[i] ?? .25);
    before = after;
  }
  return exposure;
}

export function evExposure(comfort: Comfort, carKm: ArrayLike<number | null>): StoreExposure {
  const out: StoreExposure = { mild: 0, severe: 0, worst: 0, mildDeficitHours: 0, severeDeficitHours: 0 };
  comfort.carFloorKm?.forEach((line, i) => {
    const km = carKm[i];
    if (line === null || km === null || km === undefined || km >= line) return;
    out.mild++; out.mildDeficitHours += (line - km) * .25; out.worst = Math.max(out.worst, line-km);
  });
  return out;
}
export function serviceExposure(comfort: Comfort, poolC: ArrayLike<number | null>, carKm: ArrayLike<number | null>, guard: ServiceGuard): ServiceExposure {
  return { pool: poolExposure(comfort, poolC, guard), ev: evExposure(comfort, carKm) };
}
export const storeNotWorse = (before: StoreExposure, after: StoreExposure, tolerance = 1e-9) =>
  after.mild <= before.mild && after.severe <= before.severe && after.worst <= before.worst + tolerance
  && after.mildDeficitHours <= before.mildDeficitHours + tolerance && after.severeDeficitHours <= before.severeDeficitHours + tolerance;
export const serviceNotWorse = (before: ServiceExposure, after: ServiceExposure, tolerance = 1e-9) =>
  after.pool <= before.pool + tolerance && storeNotWorse(before.ev, after.ev, tolerance);
