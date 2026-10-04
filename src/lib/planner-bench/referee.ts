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
// house, where a plan is carried out as a permission and not as a power: in a
// quarter it supplies the house it follows the house, up to the limit the plan
// set; in any quarter it is left to itself it takes the surplus sun there is. A
// grid charge or a sale to the grid is a fixed power and stays as planned. So a
// plan charged for exactly the forecast runs dry on a day that draws more, and
// pays for it at that hour's price. Each quarter's permission is the planner's
// own where its plan states one (`battery_follow`), and otherwise worked out
// from its decisions and what it was told, by the same rule. Whether a plan asks for something the household cannot do is still
// judged against what the planner was told: running dry because the day turned
// out heavier is a cost, not an impossible request.
//
// Bump REFEREE_VERSION whenever the arithmetic changes: stored outcomes are
// then recognised as stale and recomputed from the stored decisions, with no
// planner run.

import { QUARTERS, quarterStarts, publishedQuarters, type BenchCase, type Series, type Targets } from './case';
import {
  carryOut, chargerLevels, electricKwhPerDegree, heatPumpLevels, stepThermalStore, type Level, type Levels,
} from '../../../supabase/functions/_shared/planner/device-models';
import type { Household } from './household';
import type { BenchSeries } from './types';

export const REFEREE_VERSION = 8;
export const HOURS = 0.25;
/** A decision clipped by less than this is rounding, not a violation. */
const CLIP_TOLERANCE_W = 5;
/** A power this close below one of a device's levels is that level; anything further off is between two. */
const STEP_TOLERANCE_W = 1;

/** What the planner chose to do, quarter by quarter, W on the AC side. */
export interface Decisions {
  pool_w: Series;
  ev_w: Series;
  battery_charge_w: Series;
  battery_discharge_w: Series;
  /**
   * Per quarter, how the planner's plan says the battery is to be run, where
   * it says so. A quarter whose decision has since been changed (an alternative
   * the audit tries) is read from the decision instead.
   */
  battery_follow?: BatteryFollow[];
}

export interface BatteryFollow {
  /** False for a quarter at fixed power: a grid charge, a sale to the grid, or switched off. */
  follows: boolean;
  /** The limits the battery follows the house within. */
  charge_limit_w: number;
  discharge_limit_w: number;
  /** The charge and discharge this was stated for. */
  planned: [charge_w: number, discharge_w: number];
}

export type ViolationKind = 'battery_empty' | 'battery_full' | 'battery_power' | 'ev_full' | 'ev_power' | 'ev_step' | 'pool_power' | 'pool_step' | 'grid_limit' | 'negative_request';
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

/** What the charger can be told: off, or a whole number of amps between its limits (the planner's device model). */
export const evLevels = (h: Household) => chargerLevels(h.car.charger);
export const evMaxW = (h: Household) => evLevels(h).at(-1)!.draw_w;
/** The car's own charge limit, kWh: charging stops there whatever the plan asks. */
export const evLimitKwh = (c: BenchCase, h: Household) => Math.min(1, Math.max(0, c.start_state.ev.target_soc)) * h.car.battery.capacity_kwh;
/** What the pool's heat pump can be told: off, or on at its setting, the circulation pump with it. */
export const poolLevels = (h: Household) => heatPumpLevels(h.pool.heater);

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
  const carLevels = evLevels(h), carMaxW = evMaxW(h), carLimitKwh = evLimitKwh(c, h);
  const heatLevels = poolLevels(h), poolMaxW = heatLevels.at(-1)!.draw_w;
  /** A device runs at one of its levels: a power between two is carried out at the lower and reported. */
  const onLevel = <L extends Level>(quarter: number, kind: ViolationKind, levels: Levels<L>, wanted: number): L => {
    const carried = carryOut(levels, wanted, STEP_TOLERANCE_W);
    if (carried.refused_w > STEP_TOLERANCE_W) violations.push({ quarter, kind, clipped_w: r1(carried.refused_w) });
    return carried.run;
  };
  // The start state is what was read, also where it lies outside a device's limits.
  let batteryKwh = c.start_state.battery_soc * h.battery.capacity_kwh;
  let poolC = c.start_state.pool_water_c;
  let evKwh = c.start_state.ev.soc * h.car.battery.capacity_kwh;
  const buy = c.recorded.prices.import_sek_per_kwh, sell = c.recorded.prices.export_sek_per_kwh;
  const air = c.recorded.outdoor_temperature_c;

  const out: Simulation = {
    poolW: new Float64Array(QUARTERS), evW: new Float64Array(QUARTERS), chargeW: new Float64Array(QUARTERS), dischargeW: new Float64Array(QUARTERS),
    netW: new Float64Array(QUARTERS), batteryKwh: new Float64Array(QUARTERS), poolC: new Float64Array(QUARTERS), evKwh: new Float64Array(QUARTERS),
    costSek: new Float64Array(QUARTERS), cost: 0, violations, start: { batteryKwh, poolC, evKwh },
  };

  for (let i = 0; i < QUARTERS; i++) {
    // The heat pump is on at its setting or off; the charger holds whole amps, below the lowest not at all.
    const heating = onLevel(i, 'pool_step', heatLevels, clip(i, 'pool_power', asked(i, d.pool_w[i]), poolMaxW));
    const poolW = heating.draw_w;
    let evW = onLevel(i, 'ev_step', carLevels, clip(i, 'ev_power', asked(i, d.ev_w[i]), carMaxW)).draw_w;
    evW = clip(i, 'ev_full', evW, Math.max(0, (carLimitKwh - evKwh) / (h.car.battery.charge_efficiency * HOURS) * 1_000));
    let chargeW = clip(i, 'battery_power', asked(i, d.battery_charge_w[i]), h.battery.charge_max_w);
    let dischargeW = clip(i, 'battery_power', asked(i, d.battery_discharge_w[i]), h.battery.discharge_max_w);
    if (measured) {
      const follow = followLimits(c, h, d, i, poolW, evW, chargeW, dischargeW);
      if (follow) {
        const houseW = baseW[i] + poolW + evW - solarW[i];
        chargeW = Math.min(follow.charge_limit_w, h.battery.charge_max_w, Math.max(0, -houseW));
        dischargeW = Math.min(follow.discharge_limit_w, h.battery.discharge_max_w, Math.max(0, houseW));
      }
    }
    // A pack that ran dry or filled because the day differed from its forecast is not an impossible request.
    chargeW = clip(i, 'battery_full', chargeW, Math.max(0, (Math.max(batteryMaxKwh, batteryKwh) - batteryKwh) / (h.battery.charge_efficiency * HOURS) * 1_000 + dischargeW / (h.battery.charge_efficiency * h.battery.discharge_efficiency)), !measured);
    dischargeW = clip(i, 'battery_empty', dischargeW, Math.max(0, (batteryKwh - Math.min(batteryMinKwh, batteryKwh)) * h.battery.discharge_efficiency / HOURS * 1_000 + chargeW * h.battery.charge_efficiency * h.battery.discharge_efficiency), !measured);

    batteryKwh += (chargeW * h.battery.charge_efficiency - dischargeW / h.battery.discharge_efficiency) * HOURS / 1_000;
    poolC = stepThermalStore(h.pool.store, poolC, heating.heat_w, air[i], HOURS);
    evKwh += evW * h.car.battery.charge_efficiency * HOURS / 1_000;

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

/**
 * The limits the battery follows the house within in one quarter, or null when
 * it runs at the fixed power the plan gives. The planner's own statement where
 * it made one for this decision; otherwise what its decision amounts to against
 * the household it was told about: charging on no more than the surplus, or
 * doing nothing, leaves the battery free to take surplus; discharging no more
 * than the house needs is supplying the house, all of it when it covers the
 * whole need and up to the planned power when it covers a part.
 */
function followLimits(c: BenchCase, h: Household, d: Decisions, i: number, poolW: number, evW: number, chargeW: number, dischargeW: number): Pick<BatteryFollow, 'charge_limit_w' | 'discharge_limit_w'> | null {
  const stated = d.battery_follow?.[i];
  if (stated && Math.abs(stated.planned[0] - d.battery_charge_w[i]) <= CLIP_TOLERANCE_W
    && Math.abs(stated.planned[1] - d.battery_discharge_w[i]) <= CLIP_TOLERANCE_W) {
    return stated.follows ? stated : null;
  }
  const toldHouseW = c.base_load_forecast_w[i] + poolW + evW - c.solar_forecast_w[i];
  if (chargeW > CLIP_TOLERANCE_W) {
    return chargeW <= Math.max(0, -toldHouseW) + CLIP_TOLERANCE_W ? { charge_limit_w: h.battery.charge_max_w, discharge_limit_w: 0 } : null;
  }
  if (dischargeW > CLIP_TOLERANCE_W) {
    const needW = Math.max(0, toldHouseW);
    if (dischargeW > needW + CLIP_TOLERANCE_W) return null;
    return { charge_limit_w: h.battery.charge_max_w, discharge_limit_w: dischargeW + CLIP_TOLERANCE_W >= needW ? h.battery.discharge_max_w : dischargeW };
  }
  return { charge_limit_w: h.battery.charge_max_w, discharge_limit_w: 0 };
}

/** Where each store could be at best, at the end of every quarter: full power from the first. */
export function reachability(c: BenchCase, h: Household): { poolC: number[]; carKm: number[] } {
  const poolMax = poolLevels(h).at(-1)!, carMaxW = evMaxW(h);
  let poolC = c.start_state.pool_water_c, evKwh = c.start_state.ev.soc * h.car.battery.capacity_kwh;
  // A car already past its charge limit stays where it is: it cannot be charged further.
  const ceilingKwh = Math.max(evKwh, evLimitKwh(c, h));
  const out = { poolC: [] as number[], carKm: [] as number[] };
  for (let i = 0; i < QUARTERS; i++) {
    poolC = stepThermalStore(h.pool.store, poolC, poolMax.heat_w, c.recorded.outdoor_temperature_c[i], HOURS);
    evKwh = Math.min(ceilingKwh, evKwh + carMaxW * h.car.battery.charge_efficiency * HOURS / 1_000);
    out.poolC.push(Math.round(poolC * 100) / 100);
    out.carKm.push(r1(evKwh / h.car.battery.kwh_per_km));
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
      pool_start_c: sim.start.poolC, ev_start_km: r1(sim.start.evKwh / h.car.battery.kwh_per_km),
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
    series.carSoc.push(r1(sim.evKwh[i] / h.car.battery.capacity_kwh * 100));
    series.carKm!.push(r1(sim.evKwh[i] / h.car.battery.kwh_per_km));
    // The car is planned whether plugged in or not; the bench lets it charge whenever the plan says.
    series.carConnected.push(1);
    series.poolC.push(Math.round(sim.poolC[i] * 1000) / 1000);
    series.costSek.push(r4(sim.costSek[i]));
  }

  // What the plan leaves behind, as the grid electricity it would take to put it there.
  const batteryKwh = sim.batteryKwh[QUARTERS - 1], poolC = sim.poolC[QUARTERS - 1], evKwh = sim.evKwh[QUARTERS - 1];
  const reference = median(c.recorded.prices.import_sek_per_kwh);
  // A degree of pool water costs its heat over the heat pump's COP, the pump that must run with it included.
  const poolKwhPerDegree = electricKwhPerDegree(h.pool.store, poolLevels(h).at(-1)!);
  const terminalGridKwh = (batteryKwh - sim.start.batteryKwh) * h.battery.discharge_efficiency
    + (poolC - sim.start.poolC) * poolKwhPerDegree
    + (evKwh - sim.start.evKwh) / h.car.battery.charge_efficiency;
  return {
    series, violations,
    cost_sek: r4(sim.cost), published_cost_sek: r4(publishedCost),
    terminal: {
      battery_kwh: r4(batteryKwh - sim.start.batteryKwh), pool_c: r4(poolC - sim.start.poolC), ev_kwh: r4(evKwh - sim.start.evKwh),
      credit_sek: r4(terminalGridKwh * reference), reference_sek_per_kwh: r4(reference),
    },
  };
}
