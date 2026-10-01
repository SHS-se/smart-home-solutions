// The bench's own account of what a plan does (docs/planner-bench/test-cases.md).
//
// A planner hands back decisions: how much power the pool, the car and the
// battery draw or give in each quarter. Everything else is worked out here,
// the same way for every planner version: the household's physics carry the
// battery, the pool and the car forward, the grid makes up the difference, and
// each quarter is priced at what electricity really cost. So a planner cannot
// look cheaper by guessing low prices, or warmer by assuming a better pool.
//
// Bump REFEREE_VERSION whenever the arithmetic changes: stored outcomes are
// then recognised as stale and recomputed from the stored decisions, with no
// planner run.

import { QUARTERS, quarterStarts, publishedQuarters, type BenchCase, type Series, type Targets } from './case';
import { poolCop, stepPool, WATER_KWH_PER_M3_K, type Household } from './household';
import type { BenchSeries } from './types';

export const REFEREE_VERSION = 2;
const HOURS = 0.25;
/** A decision clipped by less than this is rounding, not a violation. */
const CLIP_TOLERANCE_W = 5;

/** What the planner chose to do, quarter by quarter, W on the AC side. */
export interface Decisions {
  pool_w: Series;
  ev_w: Series;
  battery_charge_w: Series;
  battery_discharge_w: Series;
}

export type ViolationKind = 'battery_empty' | 'battery_full' | 'battery_power' | 'ev_full' | 'ev_power' | 'pool_power' | 'grid_limit';
export interface Violation { quarter: number; kind: ViolationKind; clipped_w: number }

export interface Outcome {
  series: BenchSeries;
  /** Decisions the household could not carry out as given; each was clipped to what it can do. */
  violations: Violation[];
  /** Net grid cost at real prices over the 72 hours, SEK. */
  cost_sek: number;
  /** The part of it in quarters whose price was published at the start. */
  published_cost_sek: number;
  /** Energy left in the stores at the end, beyond what they started with. */
  terminal: {
    battery_kwh: number; pool_c: number; ev_kwh: number;
    /** What that energy would cost to buy from the grid at the window's median real price, SEK. */
    credit_sek: number;
    reference_sek_per_kwh: number;
  };
}

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};
const r1 = (v: number) => Math.round(v * 10) / 10;
const r4 = (v: number) => Math.round(v * 10_000) / 10_000;

export function referee(c: BenchCase, h: Household, targets: Targets, d: Decisions, believedImportPrice: readonly number[] | null = null): Outcome {
  for (const [name, values] of Object.entries(d)) {
    if (!Array.isArray(values) || values.length !== QUARTERS || !values.every(Number.isFinite)) {
      throw new Error(`Plan decisions are incomplete: ${name} needs ${QUARTERS} finite quarters.`);
    }
  }
  const starts = quarterStarts(c.start);
  const published = publishedQuarters(c);
  const violations: Violation[] = [];
  const clip = (quarter: number, kind: ViolationKind, wanted: number, allowed: number) => {
    if (wanted - allowed > CLIP_TOLERANCE_W) violations.push({ quarter, kind, clipped_w: r1(wanted - allowed) });
    return Math.min(wanted, allowed);
  };

  const batteryMinKwh = h.battery.min_soc * h.battery.capacity_kwh;
  const batteryMaxKwh = h.battery.max_soc * h.battery.capacity_kwh;
  const evMaxW = h.ev.voltage_v * h.ev.phase_count * h.ev.max_current_a;
  const poolMaxW = h.pool.pump_w + h.pool.heater_w;
  let batteryKwh = Math.min(batteryMaxKwh, Math.max(batteryMinKwh, c.start_state.battery_soc * h.battery.capacity_kwh));
  let poolC = c.start_state.pool_water_c;
  let evKwh = c.start_state.ev.soc * h.ev.capacity_kwh;
  const startBatteryKwh = batteryKwh, startPoolC = poolC, startEvKwh = evKwh;

  const series: BenchSeries = {
    start: [], hours: [], published: [], importPrice: [], exportPrice: [], believedImportPrice: [],
    solarW: [], loadW: [], poolW: [], hotWaterW: [], carW: [],
    gridImportW: [], gridExportW: [], batteryChargeW: [], batteryDischargeW: [],
    homeSoc: [], carSoc: [], carKm: [], carConnected: [], poolC: [], costSek: [],
    comfort: {
      pool_target_c: targets.pool_c, ev_target_km: targets.ev_km,
      pool_start_c: poolC, ev_start_km: r1(evKwh / h.ev.kwh_per_km),
      poolReachableC: [], carReachableKm: [],
    },
  };
  let cost = 0, publishedCost = 0;
  // Where each store could be at best: full power from the first quarter.
  let reachPoolC = poolC, reachEvKwh = evKwh;

  for (let i = 0; i < QUARTERS; i++) {
    const poolW = clip(i, 'pool_power', Math.max(0, d.pool_w[i]), poolMaxW);
    let evW = clip(i, 'ev_power', Math.max(0, d.ev_w[i]), evMaxW);
    evW = clip(i, 'ev_full', evW, Math.max(0, (h.ev.capacity_kwh - evKwh) / (h.ev.charge_efficiency * HOURS) * 1_000));
    let chargeW = clip(i, 'battery_power', Math.max(0, d.battery_charge_w[i]), h.battery.charge_max_w);
    let dischargeW = clip(i, 'battery_power', Math.max(0, d.battery_discharge_w[i]), h.battery.discharge_max_w);
    chargeW = clip(i, 'battery_full', chargeW, Math.max(0, (batteryMaxKwh - batteryKwh) / (h.battery.charge_efficiency * HOURS) * 1_000 + dischargeW / (h.battery.charge_efficiency * h.battery.discharge_efficiency)));
    dischargeW = clip(i, 'battery_empty', dischargeW, Math.max(0, (batteryKwh - batteryMinKwh) * h.battery.discharge_efficiency / HOURS * 1_000 + chargeW * h.battery.charge_efficiency * h.battery.discharge_efficiency));

    batteryKwh += (chargeW * h.battery.charge_efficiency - dischargeW / h.battery.discharge_efficiency) * HOURS / 1_000;
    poolC = stepPool(h.pool, poolC, c.recorded.outdoor_temperature_c[i], poolW, HOURS);
    evKwh += evW * h.ev.charge_efficiency * HOURS / 1_000;

    const loadW = c.base_load_forecast_w[i] + poolW + evW;
    const netW = loadW + chargeW - dischargeW - c.solar_forecast_w[i];
    const importW = Math.max(0, netW), exportW = Math.max(0, -netW);
    if (importW - h.site.import_limit_w > CLIP_TOLERANCE_W) violations.push({ quarter: i, kind: 'grid_limit', clipped_w: r1(importW - h.site.import_limit_w) });
    if (exportW - h.site.export_limit_w > CLIP_TOLERANCE_W) violations.push({ quarter: i, kind: 'grid_limit', clipped_w: r1(exportW - h.site.export_limit_w) });
    const buy = c.recorded.prices.import_sek_per_kwh[i], sell = c.recorded.prices.export_sek_per_kwh[i];
    const quarterCost = (importW * buy - exportW * sell) * HOURS / 1_000;
    cost += quarterCost;
    if (i < published) publishedCost += quarterCost;

    series.start.push(starts[i]);
    series.hours.push(HOURS);
    series.published.push(i < published ? 1 : 0);
    series.importPrice.push(r4(buy));
    series.exportPrice.push(r4(sell));
    series.believedImportPrice!.push(believedImportPrice && Number.isFinite(believedImportPrice[i]) ? r4(believedImportPrice[i]) : null);
    series.solarW.push(r1(c.solar_forecast_w[i]));
    series.loadW.push(r1(loadW));
    series.poolW.push(r1(poolW));
    series.hotWaterW.push(0);
    series.carW.push(r1(evW));
    series.gridImportW.push(r1(importW));
    series.gridExportW.push(r1(exportW));
    series.batteryChargeW.push(r1(chargeW));
    series.batteryDischargeW.push(r1(dischargeW));
    series.homeSoc.push(r1(batteryKwh / h.battery.capacity_kwh * 100));
    series.carSoc.push(r1(evKwh / h.ev.capacity_kwh * 100));
    series.carKm!.push(r1(evKwh / h.ev.kwh_per_km));
    // The car is planned whether plugged in or not; the bench lets it charge whenever the plan says.
    series.carConnected.push(1);
    reachPoolC = stepPool(h.pool, reachPoolC, c.recorded.outdoor_temperature_c[i], poolMaxW, HOURS);
    reachEvKwh = Math.min(h.ev.capacity_kwh, reachEvKwh + evMaxW * h.ev.charge_efficiency * HOURS / 1_000);
    series.comfort!.poolReachableC.push(Math.round(reachPoolC * 100) / 100);
    series.comfort!.carReachableKm.push(r1(reachEvKwh / h.ev.kwh_per_km));
    series.poolC.push(Math.round(poolC * 1000) / 1000);
    series.costSek.push(r4(quarterCost));
  }

  // What the plan leaves behind, as the grid electricity it would take to put it there.
  const reference = median(c.recorded.prices.import_sek_per_kwh);
  const meanAir = c.recorded.outdoor_temperature_c.reduce((a, b) => a + b, 0) / QUARTERS;
  // A degree of pool water costs its heat over the COP, plus the pump that must run with the heater.
  const poolKwhPerDegree = h.pool.volume_m3 * WATER_KWH_PER_M3_K / poolCop(h.pool, meanAir, poolC) * (h.pool.pump_w + h.pool.heater_w) / h.pool.heater_w;
  const terminalGridKwh = (batteryKwh - startBatteryKwh) * h.battery.discharge_efficiency
    + (poolC - startPoolC) * poolKwhPerDegree
    + (evKwh - startEvKwh) / h.ev.charge_efficiency;
  return {
    series, violations,
    cost_sek: r4(cost), published_cost_sek: r4(publishedCost),
    terminal: {
      battery_kwh: r4(batteryKwh - startBatteryKwh), pool_c: r4(poolC - startPoolC), ev_kwh: r4(evKwh - startEvKwh),
      credit_sek: r4(terminalGridKwh * reference), reference_sek_per_kwh: r4(reference),
    },
  };
}
