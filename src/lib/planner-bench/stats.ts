// Totals for one plan, and for a whole test run.
//
// Everything is over the full 72-hour plan, including the quarters priced by
// the planner's own estimate: that is the horizon the planner optimised, so it
// is the horizon two planners are compared on.

import type { BenchSeries, BenchStats } from './types';

/**
 * Bump whenever a total is added or changes meaning: stored totals from an
 * older version are then recomputed from the stored decisions, with no planner
 * run and no change to the score.
 */
export const STATS_VERSION = 2;
export const statsCurrent = (stats: BenchStats | null | undefined): stats is BenchStats => stats?.version === STATS_VERSION;

/** A pool quarter counts as heating above this, so standby noise does not. */
const POOL_HEATING_W = 50;

const kwh = (watts: number, hours: number) => watts * hours / 1_000;

export function planStats(series: BenchSeries): BenchStats {
  const n = series.start.length;
  const publishedPrices = series.importPrice.filter((_, i) => series.published[i]).sort((a, b) => a - b);
  const cheapLimit = publishedPrices.length
    ? publishedPrices[Math.max(0, Math.ceil(publishedPrices.length * 0.25) - 1)]
    : -Infinity;

  const s: BenchStats = {
    version: STATS_VERSION,
    kwh_used: 0, grid_import_kwh: 0, grid_export_kwh: 0, grid_cost_sek: 0, grid_import_sek: 0, export_revenue_sek: 0,
    solar_export_revenue_sek: 0,
    pool_kwh: 0, pool_cost_sek: 0, pool_published_kwh: 0, pool_estimated_kwh: 0, pool_cheap_kwh: 0, pool_heating_hours: 0,
    pool_min_c: null, pool_max_c: null, pool_end_c: null,
    battery_charge_kwh: 0, battery_discharge_kwh: 0, battery_wear_sek: 0, ev_kwh: 0, ev_unplugged_kwh: 0, ev_unplugged_quarters: 0,
    solar_kwh: 0, solar_used_kwh: 0, solar_exported_kwh: 0,
    import_price_paid: null, import_price_mean: 0,
  };
  let hoursTotal = 0, priceHours = 0;
  for (let i = 0; i < n; i++) {
    const h = series.hours[i];
    hoursTotal += h;
    priceHours += series.importPrice[i] * h;
    s.kwh_used += kwh(series.loadW[i], h);
    const imported = kwh(series.gridImportW[i], h);
    const exported = kwh(series.gridExportW[i], h);
    s.grid_import_kwh += imported;
    s.grid_export_kwh += exported;
    s.grid_import_sek += imported * series.importPrice[i];
    s.export_revenue_sek += exported * series.exportPrice[i];
    s.grid_cost_sek += series.costSek[i];

    const pool = kwh(series.poolW[i], h);
    s.pool_kwh += pool;
    s.pool_cost_sek += pool * series.importPrice[i];
    if (series.published[i]) s.pool_published_kwh += pool; else s.pool_estimated_kwh += pool;
    if (series.published[i] && series.importPrice[i] <= cheapLimit) s.pool_cheap_kwh += pool;
    if (series.poolW[i] > POOL_HEATING_W) s.pool_heating_hours += h;

    s.battery_charge_kwh += kwh(series.batteryChargeW[i], h);
    s.battery_discharge_kwh += kwh(series.batteryDischargeW[i], h);
    s.battery_wear_sek += series.wearSek?.[i] ?? 0;
    const car = kwh(series.carW[i], h);
    s.ev_kwh += car;
    if (!series.carConnected[i]) { s.ev_unplugged_quarters++; s.ev_unplugged_kwh += car; }

    const solar = kwh(series.solarW[i], h);
    const solarExported = Math.min(solar, exported);
    s.solar_kwh += solar;
    s.solar_exported_kwh += solarExported;
    s.solar_export_revenue_sek += solarExported * series.exportPrice[i];
    s.solar_used_kwh += solar - solarExported;
  }
  const temps = series.poolC.filter((t): t is number => t !== null && Number.isFinite(t));
  if (temps.length) {
    s.pool_min_c = Math.min(...temps);
    s.pool_max_c = Math.max(...temps);
    s.pool_end_c = temps[temps.length - 1];
  }
  s.import_price_paid = s.grid_import_kwh > 0 ? s.grid_import_sek / s.grid_import_kwh : null;
  s.import_price_mean = hoursTotal > 0 ? priceHours / hoursTotal : 0;
  return s;
}

/** The figures on the run summary, summed or extremed over every case. Averages are weighted by the energy they price. */
export interface SuiteStats {
  cases: number;
  /** Everything the house drew, whatever supplied it: grid, solar or battery. */
  kwh_used: number;
  grid_import_kwh: number;
  grid_export_kwh: number;
  /** Purchases less export revenue. */
  grid_cost_sek: number;
  grid_import_sek: number;
  export_revenue_sek: number;
  /** What a bought kWh cost. */
  import_price: number | null;
  /** What a sold kWh earned, the battery's sales included. */
  export_price: number | null;
  pool_heating_hours: number;
  pool_kwh: number;
  /** The import price of the quarters the pool ran in, per kWh it drew. */
  pool_price: number | null;
  pool_min_c: number | null;
  pool_max_c: number | null;
  battery_charge_kwh: number;
  battery_discharge_kwh: number;
  battery_wear_sek: number;
  ev_kwh: number;
  solar_used_kwh: number;
  solar_exported_kwh: number;
  /** What a kWh of solar sent straight out earned. */
  solar_export_price: number | null;
}

export function suiteStats(all: readonly BenchStats[]): SuiteStats {
  const sum = (pick: (s: BenchStats) => number) => all.reduce((total, s) => total + pick(s), 0);
  const temps = (pick: (s: BenchStats) => number | null) =>
    all.map(pick).filter((t): t is number => t !== null);
  const per = (sek: number, energy: number) => energy > 0 ? sek / energy : null;
  const mins = temps(s => s.pool_min_c), maxs = temps(s => s.pool_max_c);
  const s = {
    kwh_used: sum(s => s.kwh_used),
    grid_import_kwh: sum(s => s.grid_import_kwh),
    grid_export_kwh: sum(s => s.grid_export_kwh),
    grid_cost_sek: sum(s => s.grid_cost_sek),
    grid_import_sek: sum(s => s.grid_import_sek),
    export_revenue_sek: sum(s => s.export_revenue_sek),
    pool_heating_hours: sum(s => s.pool_heating_hours),
    pool_kwh: sum(s => s.pool_kwh),
    battery_charge_kwh: sum(s => s.battery_charge_kwh),
    battery_discharge_kwh: sum(s => s.battery_discharge_kwh),
    battery_wear_sek: sum(s => s.battery_wear_sek),
    ev_kwh: sum(s => s.ev_kwh),
    solar_used_kwh: sum(s => s.solar_used_kwh),
    solar_exported_kwh: sum(s => s.solar_exported_kwh),
  };
  return {
    cases: all.length,
    ...s,
    import_price: per(s.grid_import_sek, s.grid_import_kwh),
    export_price: per(s.export_revenue_sek, s.grid_export_kwh),
    pool_price: per(sum(s => s.pool_cost_sek), s.pool_kwh),
    pool_min_c: mins.length ? Math.min(...mins) : null,
    pool_max_c: maxs.length ? Math.max(...maxs) : null,
    solar_export_price: per(sum(s => s.solar_export_revenue_sek), s.solar_exported_kwh),
  };
}
