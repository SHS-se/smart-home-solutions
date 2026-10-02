// The bench's own account of what a plan does (docs/planner-bench/test-cases.md).
//
// A planner hands back decisions: how much power the pool, the car and the
// battery draw or give in each quarter. Everything else is worked out here,
// the same way for every planner version: the household's physics carry the
// battery, the pool and the car forward, the grid makes up the difference, and
// each quarter is priced at what electricity really cost. So a planner cannot
// look cheaper by guessing low prices, or warmer by assuming a better pool.
//
// A decision the household cannot carry out is clipped to what it can do and
// reported: more power than a device takes, charging a full store, the car past
// its own charge limit, a negative request, or more than the grid connection
// carries. Any of them fails the case (score.ts).
//
// Where the home measured the whole window, the household is carried through
// what it really drew and what the panels really gave, not through the
// forecasts the planner was told. The battery then does what it does in the
// house: a quarter it was planned to supply the house in, it follows the house,
// giving more when more is drawn and less when less is; a quarter it was
// planned to take surplus sun in, it takes the surplus there is. A grid charge
// or an idle quarter stays as planned. So a plan charged for exactly the
// forecast runs dry on a day that draws more, and pays for it at that hour's
// price. Whether a plan asks for something the household cannot do is still
// judged against what the planner was told: running dry because the day turned
// out heavier is a cost, not an impossible request.
//
// Bump REFEREE_VERSION whenever the arithmetic changes: stored outcomes are
// then recognised as stale and recomputed from the stored decisions, with no
// planner run.

import { QUARTERS, quarterStarts, publishedQuarters, type BenchCase, type Series, type Targets } from './case';
import { poolCop, stepPool, WATER_KWH_PER_M3_K, type Household } from './household';
import type { BenchSeries } from './types';

export const REFEREE_VERSION = 4;
export const HOURS = 0.25;
/** A decision clipped by less than this is rounding, not a violation. */
const CLIP_TOLERANCE_W = 5;

/** What the planner chose to do, quarter by quarter, W on the AC side. */
export interface Decisions {
  pool_w: Series;
  ev_w: Series;
  battery_charge_w: Series;
  battery_discharge_w: Series;
}

export type ViolationKind = 'battery_empty' | 'battery_full' | 'battery_power' | 'ev_full' | 'ev_power' | 'pool_power' | 'grid_limit' | 'negative_request';
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

/** The household carried through one set of decisions, unrounded. Stores are at the end of each quarter. */
export interface Simulation {
  poolW: Float64Array; evW: Float64Array; chargeW: Float64Array; dischargeW: Float64Array;
  /** Grid power: import positive, export negative. */
  netW: Float64Array;
  batteryKwh: Float64Array; poolC: Float64Array; evKwh: Float64Array;
  costSek: Float64Array;
  cost: number;
  violations: Violation[];
  start: { batteryKwh: number; poolC: number; evKwh: number };
}

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};
const r1 = (v: number) => Math.round(v * 10) / 10;
const r4 = (v: number) => Math.round(v * 10_000) / 10_000;

export const evMaxW = (h: Household) => h.ev.voltage_v * h.ev.phase_count * h.ev.max_current_a;
/** The car's own charge limit, kWh: charging stops there whatever the plan asks. */
export const evLimitKwh = (c: BenchCase, h: Household) => Math.min(1, Math.max(0, c.start_state.ev.target_soc)) * h.ev.capacity_kwh;

/** The world a plan is carried through: `recorded` where the window was measured, else what the planner was told. */
export type World = 'recorded' | 'told';

/** The household's fixed load and solar in the world the referee uses for a case. */
export function householdSeries(c: BenchCase, world: World = 'recorded'): { baseW: Series; solarW: Series } {
  const actual = world === 'recorded' ? c.recorded.actual : undefined;
  return { baseW: actual?.base_load_w ?? c.base_load_forecast_w, solarW: actual?.solar_w ?? c.solar_forecast_w };
}

/**
 * The one physical simulation. The stored account of a plan and every
 * alternative the opportunity audit tries (opportunities.ts) step the
 * household here, so an alternative is held to the physics the plan was.
 */
export function simulate(c: BenchCase, h: Household, d: Decisions, world: World = 'recorded'): Simulation {
  const violations: Violation[] = [];
  const { baseW, solarW } = householdSeries(c, world);
  // Only a measured window differs from what the planner was told.
  const measured = world === 'recorded' && c.recorded.actual !== undefined;
  const clip = (quarter: number, kind: ViolationKind, wanted: number, allowed: number, report = true) => {
    if (report && wanted - allowed > CLIP_TOLERANCE_W) violations.push({ quarter, kind, clipped_w: r1(wanted - allowed) });
    return Math.min(wanted, allowed);
  };
  // A negative request is not a smaller one: it is reported, and nothing is done.
  const asked = (quarter: number, wanted: number) => {
    if (wanted < -CLIP_TOLERANCE_W) violations.push({ quarter, kind: 'negative_request', clipped_w: r1(-wanted) });
    return Math.max(0, wanted);
  };

  const batteryMinKwh = h.battery.min_soc * h.battery.capacity_kwh;
  const batteryMaxKwh = h.battery.max_soc * h.battery.capacity_kwh;
  const carMaxW = evMaxW(h), carLimitKwh = evLimitKwh(c, h);
  const poolMaxW = h.pool.pump_w + h.pool.heater_w;
  // The start state is what was read, also where it lies outside a device's limits.
  let batteryKwh = c.start_state.battery_soc * h.battery.capacity_kwh;
  let poolC = c.start_state.pool_water_c;
  let evKwh = c.start_state.ev.soc * h.ev.capacity_kwh;
  const buy = c.recorded.prices.import_sek_per_kwh, sell = c.recorded.prices.export_sek_per_kwh;
  const air = c.recorded.outdoor_temperature_c;

  const out: Simulation = {
    poolW: new Float64Array(QUARTERS), evW: new Float64Array(QUARTERS), chargeW: new Float64Array(QUARTERS), dischargeW: new Float64Array(QUARTERS),
    netW: new Float64Array(QUARTERS), batteryKwh: new Float64Array(QUARTERS), poolC: new Float64Array(QUARTERS), evKwh: new Float64Array(QUARTERS),
    costSek: new Float64Array(QUARTERS), cost: 0, violations, start: { batteryKwh, poolC, evKwh },
  };

  for (let i = 0; i < QUARTERS; i++) {
    const poolW = clip(i, 'pool_power', asked(i, d.pool_w[i]), poolMaxW);
    let evW = clip(i, 'ev_power', asked(i, d.ev_w[i]), carMaxW);
    evW = clip(i, 'ev_full', evW, Math.max(0, (carLimitKwh - evKwh) / (h.ev.charge_efficiency * HOURS) * 1_000));
    let chargeW = clip(i, 'battery_power', asked(i, d.battery_charge_w[i]), h.battery.charge_max_w);
    let dischargeW = clip(i, 'battery_power', asked(i, d.battery_discharge_w[i]), h.battery.discharge_max_w);
    if (measured) {
      // How much more the house needs from elsewhere than the planner was told.
      const shiftW = (baseW[i] - solarW[i]) - (c.base_load_forecast_w[i] - c.solar_forecast_w[i]);
      const plannedImportW = c.base_load_forecast_w[i] + poolW + evW + chargeW - c.solar_forecast_w[i];
      if (dischargeW > CLIP_TOLERANCE_W) dischargeW = Math.min(h.battery.discharge_max_w, Math.max(0, dischargeW + shiftW));
      else if (chargeW > CLIP_TOLERANCE_W && plannedImportW <= CLIP_TOLERANCE_W) chargeW = Math.min(h.battery.charge_max_w, Math.max(0, chargeW - shiftW));
    }
    // A pack that ran dry or filled because the day differed from its forecast is not an impossible request.
    chargeW = clip(i, 'battery_full', chargeW, Math.max(0, (Math.max(batteryMaxKwh, batteryKwh) - batteryKwh) / (h.battery.charge_efficiency * HOURS) * 1_000 + dischargeW / (h.battery.charge_efficiency * h.battery.discharge_efficiency)), !measured);
    dischargeW = clip(i, 'battery_empty', dischargeW, Math.max(0, (batteryKwh - Math.min(batteryMinKwh, batteryKwh)) * h.battery.discharge_efficiency / HOURS * 1_000 + chargeW * h.battery.charge_efficiency * h.battery.discharge_efficiency), !measured);

    batteryKwh += (chargeW * h.battery.charge_efficiency - dischargeW / h.battery.discharge_efficiency) * HOURS / 1_000;
    poolC = stepPool(h.pool, poolC, air[i], poolW, HOURS);
    evKwh += evW * h.ev.charge_efficiency * HOURS / 1_000;

    const netW = baseW[i] + poolW + evW + chargeW - dischargeW - solarW[i];
    if (!measured && netW - h.site.import_limit_w > CLIP_TOLERANCE_W) violations.push({ quarter: i, kind: 'grid_limit', clipped_w: r1(netW - h.site.import_limit_w) });
    if (!measured && -netW - h.site.export_limit_w > CLIP_TOLERANCE_W) violations.push({ quarter: i, kind: 'grid_limit', clipped_w: r1(-netW - h.site.export_limit_w) });
    const quarterCost = (netW > 0 ? netW * buy[i] : netW * sell[i]) * HOURS / 1_000;
    out.cost += quarterCost;

    out.poolW[i] = poolW; out.evW[i] = evW; out.chargeW[i] = chargeW; out.dischargeW[i] = dischargeW;
    out.netW[i] = netW; out.batteryKwh[i] = batteryKwh; out.poolC[i] = poolC; out.evKwh[i] = evKwh;
    out.costSek[i] = quarterCost;
  }
  return out;
}

/** Where each store could be at best, at the end of every quarter: full power from the first. */
export function reachability(c: BenchCase, h: Household): { poolC: number[]; carKm: number[] } {
  const poolMaxW = h.pool.pump_w + h.pool.heater_w, carMaxW = evMaxW(h);
  let poolC = c.start_state.pool_water_c, evKwh = c.start_state.ev.soc * h.ev.capacity_kwh;
  // A car already past its charge limit stays where it is: it cannot be charged further.
  const ceilingKwh = Math.max(evKwh, evLimitKwh(c, h));
  const out = { poolC: [] as number[], carKm: [] as number[] };
  for (let i = 0; i < QUARTERS; i++) {
    poolC = stepPool(h.pool, poolC, c.recorded.outdoor_temperature_c[i], poolMaxW, HOURS);
    evKwh = Math.min(ceilingKwh, evKwh + carMaxW * h.ev.charge_efficiency * HOURS / 1_000);
    out.poolC.push(Math.round(poolC * 100) / 100);
    out.carKm.push(r1(evKwh / h.ev.kwh_per_km));
  }
  return out;
}

export function assertDecisions(d: Decisions): void {
  for (const name of ['pool_w', 'ev_w', 'battery_charge_w', 'battery_discharge_w'] as const) {
    const values = d?.[name];
    if (!Array.isArray(values) || values.length !== QUARTERS || !values.every(Number.isFinite)) {
      throw new Error(`Plan decisions are incomplete: ${name} needs ${QUARTERS} finite quarters.`);
    }
  }
}

export function referee(c: BenchCase, h: Household, targets: Targets, d: Decisions, believedImportPrice: readonly number[] | null = null): Outcome {
  assertDecisions(d);
  const starts = quarterStarts(c.start);
  const published = publishedQuarters(c);
  const sim = simulate(c, h, d);
  // What the household cannot do is judged on what the planner was told.
  const violations = c.recorded.actual ? simulate(c, h, d, 'told').violations : sim.violations;
  const { baseW, solarW } = householdSeries(c);
  const reach = reachability(c, h);

  const series: BenchSeries = {
    start: [], hours: [], published: [], importPrice: [], exportPrice: [], believedImportPrice: [],
    solarW: [], loadW: [], poolW: [], hotWaterW: [], carW: [],
    gridImportW: [], gridExportW: [], batteryChargeW: [], batteryDischargeW: [],
    homeSoc: [], carSoc: [], carKm: [], carConnected: [], poolC: [], costSek: [],
    comfort: {
      pool_target_c: targets.pool_c, ev_target_km: targets.ev_km,
      pool_start_c: sim.start.poolC, ev_start_km: r1(sim.start.evKwh / h.ev.kwh_per_km),
      poolReachableC: reach.poolC, carReachableKm: reach.carKm,
    },
  };
  let publishedCost = 0;

  for (let i = 0; i < QUARTERS; i++) {
    if (i < published) publishedCost += sim.costSek[i];
    series.start.push(starts[i]);
    series.hours.push(HOURS);
    series.published.push(i < published ? 1 : 0);
    series.importPrice.push(r4(c.recorded.prices.import_sek_per_kwh[i]));
    series.exportPrice.push(r4(c.recorded.prices.export_sek_per_kwh[i]));
    series.believedImportPrice!.push(believedImportPrice && Number.isFinite(believedImportPrice[i]) ? r4(believedImportPrice[i]) : null);
    series.solarW.push(r1(solarW[i]));
    series.loadW.push(r1(baseW[i] + sim.poolW[i] + sim.evW[i]));
    series.poolW.push(r1(sim.poolW[i]));
    series.hotWaterW.push(0);
    series.carW.push(r1(sim.evW[i]));
    series.gridImportW.push(r1(Math.max(0, sim.netW[i])));
    series.gridExportW.push(r1(Math.max(0, -sim.netW[i])));
    series.batteryChargeW.push(r1(sim.chargeW[i]));
    series.batteryDischargeW.push(r1(sim.dischargeW[i]));
    series.homeSoc.push(r1(sim.batteryKwh[i] / h.battery.capacity_kwh * 100));
    series.carSoc.push(r1(sim.evKwh[i] / h.ev.capacity_kwh * 100));
    series.carKm!.push(r1(sim.evKwh[i] / h.ev.kwh_per_km));
    // The car is planned whether plugged in or not; the bench lets it charge whenever the plan says.
    series.carConnected.push(1);
    series.poolC.push(Math.round(sim.poolC[i] * 1000) / 1000);
    series.costSek.push(r4(sim.costSek[i]));
  }

  // What the plan leaves behind, as the grid electricity it would take to put it there.
  const batteryKwh = sim.batteryKwh[QUARTERS - 1], poolC = sim.poolC[QUARTERS - 1], evKwh = sim.evKwh[QUARTERS - 1];
  const reference = median(c.recorded.prices.import_sek_per_kwh);
  const meanAir = c.recorded.outdoor_temperature_c.reduce((a, b) => a + b, 0) / QUARTERS;
  // A degree of pool water costs its heat over the COP, plus the pump that must run with the heater.
  const poolKwhPerDegree = h.pool.volume_m3 * WATER_KWH_PER_M3_K / poolCop(h.pool, meanAir, poolC) * (h.pool.pump_w + h.pool.heater_w) / h.pool.heater_w;
  const terminalGridKwh = (batteryKwh - sim.start.batteryKwh) * h.battery.discharge_efficiency
    + (poolC - sim.start.poolC) * poolKwhPerDegree
    + (evKwh - sim.start.evKwh) / h.ev.charge_efficiency;
  return {
    series, violations,
    cost_sek: r4(sim.cost), published_cost_sek: r4(publishedCost),
    terminal: {
      battery_kwh: r4(batteryKwh - sim.start.batteryKwh), pool_c: r4(poolC - sim.start.poolC), ev_kwh: r4(evKwh - sim.start.evKwh),
      credit_sek: r4(terminalGridKwh * reference), reference_sek_per_kwh: r4(reference),
    },
  };
}
