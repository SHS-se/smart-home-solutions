// When a comfort miss counts, and how much of it a plan has: shared by the
// comfort score (score.ts) and by the guard that keeps an alternative plan from
// buying its saving with comfort (opportunities.ts).
//
// A level counts only once it was reachable: where full power from the first
// quarter would have got the store there, plus a day to choose the hours.

import type { BenchSeries } from './types';

/** Quarters a planner gets to choose its hours once a comfort level is reachable. */
export const GRACE_QUARTERS = 96;

export type Comfort = NonNullable<BenchSeries['comfort']>;

/** The first quarter from which being below `level` counts; Infinity when it never does. */
export function dueFrom(reachable: readonly number[] | undefined, start: number, level: number): number {
  if (!reachable) return Infinity;
  if (typeof start === 'number' && start >= level) return 0;
  const at = reachable.findIndex(v => v >= level);
  return at < 0 ? Infinity : at + GRACE_QUARTERS;
}

/** How far below target each store's mild and severe levels lie: °C for the pool, km for the car. */
export interface ServiceGuard { pool: [number, number]; ev: [number, number] }
export const DEFAULT_SERVICE_GUARD: ServiceGuard = { pool: [1, 2], ev: [50, 100] };

/** One store's shortage: eligible quarter counts, worst mild deficit, and deficit integrals (°C·h or km·h). */
export interface StoreExposure { mild: number; severe: number; worst: number; mildDeficitHours: number; severeDeficitHours: number }
export interface ServiceExposure { pool: StoreExposure; ev: StoreExposure }

export function storeExposure(
  values: ArrayLike<number | null>, target: number, offsets: [number, number],
  reachable: readonly number[], start: number,
): StoreExposure {
  const out: StoreExposure = { mild: 0, severe: 0, worst: 0, mildDeficitHours: 0, severeDeficitHours: 0 };
  const mild = target - offsets[0], severe = target - offsets[1];
  const mildFrom = dueFrom(reachable, start, mild), severeFrom = dueFrom(reachable, start, severe);
  for (let i = Math.min(mildFrom, severeFrom); i < values.length; i++) {
    const v = values[i];
    if (v === null) continue;
    if (i >= mildFrom && v < mild) { out.mild++; out.mildDeficitHours += (mild - v) * 0.25; out.worst = Math.max(out.worst, mild - v); }
    if (i >= severeFrom && v < severe) { out.severe++; out.severeDeficitHours += (severe - v) * 0.25; }
  }
  return out;
}

export const poolExposure = (comfort: Comfort, poolC: ArrayLike<number | null>, guard: ServiceGuard) =>
  storeExposure(poolC, comfort.pool_target_c, guard.pool, comfort.poolReachableC, comfort.pool_start_c);
export const evExposure = (comfort: Comfort, carKm: ArrayLike<number | null>, guard: ServiceGuard) =>
  storeExposure(carKm, comfort.ev_target_km, guard.ev, comfort.carReachableKm, comfort.ev_start_km);

export function serviceExposure(comfort: Comfort, poolC: ArrayLike<number | null>, carKm: ArrayLike<number | null>, guard: ServiceGuard): ServiceExposure {
  return { pool: poolExposure(comfort, poolC, guard), ev: evExposure(comfort, carKm, guard) };
}

/** One store: no more short quarters, no deeper worst miss, and no larger deficit integral at either level. */
export const storeNotWorse = (before: StoreExposure, after: StoreExposure, tolerance = 1e-9) =>
  after.mild <= before.mild && after.severe <= before.severe && after.worst <= before.worst + tolerance
  && after.mildDeficitHours <= before.mildDeficitHours + tolerance && after.severeDeficitHours <= before.severeDeficitHours + tolerance;

/**
 * Each store on its own, never a total, which would let a warmer pool pay for
 * a shorter car.
 */
export const serviceNotWorse = (before: ServiceExposure, after: ServiceExposure, tolerance = 1e-9) =>
  storeNotWorse(before.pool, after.pool, tolerance) && storeNotWorse(before.ev, after.ev, tolerance);
