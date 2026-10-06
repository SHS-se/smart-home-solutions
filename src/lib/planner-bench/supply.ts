// Source accounting shared by the referee and quarter scorer.
import type { BenchSeries } from './types';

const batteryHouseSupplyW = (s: BenchSeries, i: number) => Math.max(0, s.batteryDischargeW[i] - s.gridExportW[i]);

/** Attribute available battery discharge to flexible demand before counting any of it as a grid purchase. */
export function flexibleGridSupplyW(s: BenchSeries, i: number): number {
  const flexibleW = s.poolW[i] + s.carW[i] + s.batteryChargeW[i];
  const remainingW = Math.max(0, flexibleW - batteryHouseSupplyW(s, i));
  // Stored powers have 0.1 W precision; round subtraction noise before the 500 W boundary.
  return Math.round(Math.min(remainingW, s.gridImportW[i]) * 10) / 10;
}

/**
 * Supply attribution on the shared house bus: allocate battery exports and
 * non-EV demand first. Only the remainder can be attributed to the EV.
 * loadW already includes the pool, hot water and all other household loads.
 * Net simultaneous battery charging out of its discharge before allocating it.
 */
export function evBatterySupplyW(s: BenchSeries, i: number): number {
  const nonEvW = Math.max(0, s.loadW[i] - s.carW[i]);
  const batteryForHouseW = Math.max(0, batteryHouseSupplyW(s, i) - s.batteryChargeW[i]);
  // Stored power has 0.1 W precision; subtraction noise is not battery energy.
  return Math.round(Math.min(s.carW[i], Math.max(0, batteryForHouseW - nonEvW)) * 10) / 10;
}

/** Grid assigned to base load after flexible demand and fixed hot-water demand. */
export function baseLoadGridSupplyW(s: BenchSeries, i: number): number {
  const baseW = Math.max(0, s.loadW[i] - s.poolW[i] - s.carW[i] - s.hotWaterW[i]);
  return Math.round(Math.min(baseW, Math.max(0, s.gridImportW[i] - flexibleGridSupplyW(s, i) - s.hotWaterW[i])) * 10) / 10;
}
