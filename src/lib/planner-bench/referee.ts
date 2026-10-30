import { boilerDemand } from "./household";
import { POOL_START_COST_SEK } from '../../../supabase/functions/_shared/planner-wasm/cost-policy';
import { carPolicy } from '../../../supabase/functions/_shared/planner-wasm/car-policy';
import { chargeAcPower, chargeDcPower, dischargeDcPower, outputPower, refinedBatteryFlow, gridKwhPerStoredKwh } from '../../../supabase/functions/_shared/planner/battery-conversion';
import { proportionalSupply } from '../../../supabase/functions/_shared/battery-supply';
import { projectBoilerTank } from '../../../supabase/functions/_shared/boiler-consumption';
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
// The bill a plan is scored on is made here too (billOf): grid cost and battery
// wear, less the energy the plan leaves in its stores up to their targets.
//
// Bump REFEREE_VERSION whenever the arithmetic changes: stored outcomes are
// then recognised as stale and recomputed from the stored decisions, with no
// planner run.

import { QUARTERS, quarterStarts, publishedQuarters, type BenchCase, type Series, type Targets } from './case';
import {
  carryOut, chargerLevels, electricKwhPerDegree, heatPumpLevels, publishHeater, stepPool, poolInventoryC, type Level, type Levels,
} from '../../../supabase/functions/_shared/planner/device-models';
import type { Household } from './household';
import type { BenchSeries, Bill } from './types';
import { BENCH_DEVICES, BENCH_DEVICE_KEYS } from './devices';
import { endCredit, endCreditTerms } from '../../../supabase/functions/_shared/planner-wasm/end-credit';

export const REFEREE_VERSION = 30;
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
  /**
   * What the plan tells the water heater in each quarter. Absent on a planner
   * that does not plan hot water, whose heater then runs as the house drew it.
   */
  hot_water?: HotWaterCommand[];
  /**
   * The water heating the planner expected under those commands, W. Whether a
   * plan asks for the impossible is judged against what the planner was told,
   * and the heater's timing is part of that: in the told world the heater runs
   * as expected, not as the gate would decide on loads the planner never saw.
   */
  hot_water_expected_w?: number[];
}

/**
 * No instruction, an outright inhibit, or a gate the house applies to its own
 * measured draw (battery charging excluded): the heater may start below the
 * one level and is stopped above the other.
 */
export type HotWaterCommand =
  | { kind: 'free' }
  | { kind: 'inhibit' }
  | { kind: 'permit' };
const FREE: HotWaterCommand = { kind: 'free' };

export interface BatteryFollow {
  /** False for a quarter at fixed power: a grid charge, a sale to the grid, or switched off. */
  follows: boolean;
  /** The limits the battery follows the house within. */
  charge_limit_w: number;
  discharge_limit_w: number;
  /** The charge and discharge this was stated for. */
  planned: [charge_w: number, discharge_w: number];
}

export type ViolationKind = 'battery_supply' | 'battery_empty' | 'battery_full' | 'battery_power' | 'ev_full' | 'ev_power' | 'ev_step' | 'pool_power' | 'pool_step' | 'grid_limit' | 'negative_request';
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
  poolStart: (import('../../../supabase/functions/_shared/planner/device-models').HeaterStart | null)[];
  poolW: Float64Array; compressorW: Float64Array; pumpW: Float64Array; evW: Float64Array; chargeW: Float64Array; dischargeW: Float64Array; batteryIdleW: Float64Array;
  /** The fixed load as carried out: base load with the water heater as it ran. */
  baseW: Float64Array;
  /** The water heater, where the case has one; null otherwise. */
  water: { w: Float64Array; owedKwh: Float64Array; permitted: Uint8Array } | null;
  /** Grid power: import positive, export negative. */
  netW: Float64Array;
  batteryKwh: Float64Array; poolC: Float64Array; poolPendingHeatKwh: Float64Array; poolSourceDepletionKwh: Float64Array; evKwh: Float64Array;
  costSek: Float64Array;
  cost: number;
  violations: Violation[];
  start: { batteryKwh: number; poolC: number; poolPendingHeatKwh: number; poolSourceDepletionKwh: number; evKwh: number };
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
/**
 * The car's levels and breach lines in a case. The bench's car is always
 * connected and is counted as plugged in when the case starts, so each starting
 * charge shows the grace it gets.
 */
export function caseCarPolicy(c: BenchCase, h: Household, targets: Targets) {
  return carPolicy({ battery: h.car.battery, limitSoc: c.start_state.ev.target_soc, floorSetting: targets.ev_floor_soc,
    connection: { kind: 'plugged', sinceMs: 0 } },
    c.recorded.prices.import_sek_per_kwh.map((_, i) => ({ start_seconds: i * 900, hours: HOURS, ev_available: true })), 0);
}
/** The range below which each quarter counts as below the floor: the same comparison as a charge at or below the line. */
export const carFloorKm = (c: BenchCase, h: Household, targets: Targets) => caseCarPolicy(c, h, targets).breach_permille.map(line =>
  line === null ? null : (line + 0.5) / 1000 * h.car.battery.capacity_kwh / h.car.battery.kwh_per_km);

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
 * What the house drew from its water heater inside the base load, in the same
 * world; null where the case does not say, and the heater then stays part of
 * the fixed load. A measured window needs the heater measured too.
 */
export function hotWaterNeed(c: BenchCase, h: Household, world: World = 'recorded'): Series | null {
  const actual = world === 'recorded' ? c.recorded.actual : undefined;
  return boilerDemand(actual ? actual.other_devices_w : c.other_devices_w, h.hot_water);
}

/**
 * The one physical simulation. The stored account of a plan and every
 * alternative the opportunity audit tries (opportunities.ts) step the
 * household here, so an alternative is held to the physics the plan was.
 */
export function simulate(c: BenchCase, h: Household, d: Decisions, world: World = 'recorded'): Simulation {
  const violations: Violation[] = [];
  const { baseW, solarW } = householdSeries(c, world);
  // Each world's evidence goes through the same tank model as production:
  // the measured heater draw is the water used, heat only replaces it, and a
  // block leaves it owed. Recorded future demand belongs only in this evaluation.
  const needW = hotWaterNeed(c, h, world);
  const waterW = new Float64Array(QUARTERS), waterRemaining = new Float64Array(QUARTERS);
  if (needW) {
    const need = Array.from({ length: QUARTERS }, (_, i) => Math.min(needW[i], Math.max(0, baseW[i])));
    const controlled = d.hot_water?.some(command => command.kind !== 'free') ?? false;
    const expected = world === 'told' ? d.hot_water_expected_w : undefined;
    const tank = projectBoilerTank({ draw_w: need, running_w: need.map(() => h.hot_water.rated_w), hours: need.map(() => HOURS),
      permitted: need.map((_w, i) => d.hot_water?.[i]?.kind !== 'inhibit') });
    for (let i = 0; i < QUARTERS; i++) {
      waterW[i] = expected ? expected[i] : controlled ? tank.expected_w[i] : need[i];
      waterRemaining[i] = controlled && !expected ? tank.deficit_wh[i] / 1000 : 0;
    }
  }
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
  if (h.pool.heater.source && (typeof c.start_state.pool_source_depletion_kwh !== 'number' || !Number.isFinite(c.start_state.pool_source_depletion_kwh) || c.start_state.pool_source_depletion_kwh < 0 || h.pool.heater.source.heat_loss_per_kwh * c.start_state.pool_source_depletion_kwh >= 1)) throw new Error('Measured source model requires initial depletion');
  let poolC = c.start_state.pool_water_c, poolPendingHeatKwh = 0, poolSourceDepletionKwh = c.start_state.pool_source_depletion_kwh ?? 0;
  const heater = publishHeater(h.pool.heater);
  let heaterState = c.start_state.pool_heater;
  let evKwh = c.start_state.ev.soc * h.car.battery.capacity_kwh;
  const buy = c.recorded.prices.import_sek_per_kwh, sell = c.recorded.prices.export_sek_per_kwh;
  const air = c.recorded.outdoor_temperature_c;

  const out: Simulation = {
    compressorW: new Float64Array(QUARTERS), pumpW: new Float64Array(QUARTERS),
    poolStart: [],
    poolW: new Float64Array(QUARTERS), evW: new Float64Array(QUARTERS), chargeW: new Float64Array(QUARTERS), dischargeW: new Float64Array(QUARTERS), batteryIdleW: new Float64Array(QUARTERS),
    netW: new Float64Array(QUARTERS), batteryKwh: new Float64Array(QUARTERS), poolC: new Float64Array(QUARTERS), poolPendingHeatKwh: new Float64Array(QUARTERS), poolSourceDepletionKwh: new Float64Array(QUARTERS), evKwh: new Float64Array(QUARTERS),
    baseW: new Float64Array(QUARTERS),
    water: needW && { w: new Float64Array(QUARTERS), owedKwh: new Float64Array(QUARTERS), permitted: new Uint8Array(QUARTERS) },
    costSek: new Float64Array(QUARTERS), cost: 0, violations, start: { batteryKwh, poolC, poolPendingHeatKwh, poolSourceDepletionKwh, evKwh },
  };

  for (let i = 0; i < QUARTERS; i++) {
    // The heat pump is on at its setting or off; the charger holds whole amps, below the lowest not at all.
    const heating = onLevel(i, 'pool_step', heatLevels, clip(i, 'pool_power', asked(i, d.pool_w[i]), poolMaxW));
    const projected = stepPool(h.pool.store, heater, heaterState, heating.draw_w > 0, { water_c: poolC, pending_heat_kwh: poolPendingHeatKwh, source_depletion_kwh: poolSourceDepletionKwh, outdoor_c: air[i], seconds: HOURS * 3600, stop_c: null });
    heaterState = projected.next;
    const poolW = projected.electric_w;
    out.compressorW[i] = projected.compressor_w;
    out.pumpW[i] = projected.auxiliary_w;
    out.poolStart.push(projected.start);
    let evW = onLevel(i, 'ev_step', carLevels, clip(i, 'ev_power', asked(i, d.ev_w[i]), carMaxW)).draw_w;
    evW = clip(i, 'ev_full', evW, Math.max(0, (carLimitKwh - evKwh) / (h.car.battery.charge_efficiency * HOURS) * 1_000));
    // Binary allowance with completion of an active heating run.
    let fixedW = baseW[i];
    if (needW && out.water) {
      // A heater meter reading more than the house drew in all is a mismatch between meters: the house's own reading holds.
      const need = Math.min(needW[i], Math.max(0, baseW[i]));
      const otherW = baseW[i] - need;
      fixedW = otherW + waterW[i];
      out.water.w[i] = waterW[i]; out.water.owedKwh[i] = waterRemaining[i];
      out.water.permitted[i] = d.hot_water?.[i]?.kind !== 'inhibit' || waterW[i] > 0 ? 1 : 0;
    }
    const grossW = fixedW + poolW + evW;
    const chargeMaxAc = chargeAcPower(h.battery.conversion, h.battery.charge_max_w, solarW[i], grossW);
    const dischargeMaxAc = outputPower(h.battery.conversion.discharge, h.battery.discharge_max_w);
    let chargeW = clip(i, 'battery_power', asked(i, d.battery_charge_w[i]), chargeMaxAc);
    let dischargeW = clip(i, 'battery_power', asked(i, d.battery_discharge_w[i]), dischargeMaxAc);
    if (measured) {
      const follow = followLimits(c, h, d, i, poolW, evW, chargeW, dischargeW);
      if (follow) {
        const houseW = fixedW + poolW + evW - solarW[i];
        chargeW = Math.min(follow.charge_limit_w, chargeMaxAc, Math.max(0, -houseW));
        const eligibleW = h.site.ev_battery_supply_allowed ? grossW : grossW - evW;
        dischargeW = Math.min(follow.discharge_limit_w, dischargeMaxAc,
          proportionalSupply(grossW, solarW[i], eligibleW).houseSupplyBoundW);
      }
    }
    // All fixed and demand-following modes share the permission, including export.
    // If excluded demand remains on the bus, battery export cannot bypass it.
    const eligibleW = h.site.ev_battery_supply_allowed ? grossW : grossW - evW;
    const supplyW = proportionalSupply(grossW, solarW[i], eligibleW).houseSupplyBoundW;
    if (Math.max(0, grossW - solarW[i]) > supplyW + 1e-6) {
      dischargeW = clip(i, 'battery_supply', dischargeW, supplyW, !measured);
    }

    const battery = refinedBatteryFlow(h.battery, { stored_kwh: batteryKwh, hours: HOURS,
      charge_w: chargeW, discharge_w: dischargeW, pv_w: solarW[i], house_w: grossW });
    // Diagnose stored saturation separately from an unused converter activation
    // budget: the latter is ordinary physical execution, not a full/empty pack.
    const requestedChargeDc = chargeDcPower(h.battery.conversion, chargeW, solarW[i], grossW);
    const requestedDischargeDc = dischargeDcPower(h.battery.conversion, dischargeW);
    clip(i, 'battery_full', chargeW, battery.charge_w, !measured && requestedChargeDc > battery.charge_dc_w + 1e-7);
    clip(i, 'battery_empty', dischargeW, battery.discharge_w, !measured && requestedDischargeDc > battery.discharge_dc_w + 1e-7);
    chargeW = battery.charge_w; dischargeW = battery.discharge_w;
    batteryKwh = battery.battery_kwh;
    poolC = projected.water_c;
    poolPendingHeatKwh = projected.pending_heat_kwh;
    poolSourceDepletionKwh = projected.source_depletion_kwh ?? 0;
    evKwh += evW * h.car.battery.charge_efficiency * HOURS / 1_000;

    const netW = grossW + chargeW - dischargeW + battery.battery_idle_w - solarW[i];
    if (!measured && netW - h.site.import_limit_w > CLIP_TOLERANCE_W) violations.push({ quarter: i, kind: 'grid_limit', clipped_w: r1(netW - h.site.import_limit_w) });
    if (!measured && -netW - h.site.export_limit_w > CLIP_TOLERANCE_W) violations.push({ quarter: i, kind: 'grid_limit', clipped_w: r1(-netW - h.site.export_limit_w) });
    const quarterCost = (netW > 0 ? netW * buy[i] : netW * sell[i]) * HOURS / 1_000;
    out.cost += quarterCost;

    out.poolW[i] = poolW; out.evW[i] = evW; out.chargeW[i] = chargeW; out.dischargeW[i] = dischargeW; out.batteryIdleW[i] = battery.battery_idle_w;
    out.netW[i] = netW; out.batteryKwh[i] = batteryKwh; out.poolC[i] = poolC; out.poolPendingHeatKwh[i] = poolPendingHeatKwh; out.poolSourceDepletionKwh[i] = poolSourceDepletionKwh; out.evKwh[i] = evKwh; out.baseW[i] = fixedW;
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
  const gross = c.base_load_forecast_w[i] + poolW + evW;
  const chargeMax = chargeAcPower(h.battery.conversion, h.battery.charge_max_w, c.solar_forecast_w[i], gross);
  const dischargeMax = outputPower(h.battery.conversion.discharge, h.battery.discharge_max_w);
  const toldHouseW = gross - c.solar_forecast_w[i];
  if (chargeW > CLIP_TOLERANCE_W) {
    return chargeW <= Math.max(0, -toldHouseW) + CLIP_TOLERANCE_W ? { charge_limit_w: chargeMax, discharge_limit_w: 0 } : null;
  }
  if (dischargeW > CLIP_TOLERANCE_W) {
    const needW = Math.max(0, toldHouseW);
    if (dischargeW > needW + CLIP_TOLERANCE_W) return null;
    return { charge_limit_w: chargeMax, discharge_limit_w: dischargeW + CLIP_TOLERANCE_W >= needW ? dischargeMax : dischargeW };
  }
  return { charge_limit_w: chargeMax, discharge_limit_w: 0 };
}

/** Mechanical wear shared by the bill and alternative-schedule audits. */
export function wearOf(h: Household, sim: Simulation): number {
  return sim.dischargeW.reduce((sum, w) => sum + w, 0) * HOURS / 1_000 * h.site.battery_degradation_sek_per_kwh
    + sim.poolStart.filter(start => start !== null).length * POOL_START_COST_SEK;
}

/**
 * A carried-out plan's bill: what it bought and sold at real prices, the wear
 * on what its battery discharged, once per pool-heater start, and the credit for what it leaves in the
 * stores (end-credit.ts).
 */
export function billOf(c: BenchCase, h: Household, targets: Targets, sim: Simulation): Bill {
  const last = QUARTERS - 1, level = poolLevels(h).at(-1)!;
  const terms = endCreditTerms({
    battery: h.battery,
    pool: { store: h.pool.store, draw_w: level.draw_w, heat_w: level.heat_w, target_c: targets.pool_c },
    car: { battery: h.car.battery, floor_kwh: caseCarPolicy(c, h, targets).floor_kwh, limit_kwh: evLimitKwh(c, h) },
    import_sek_per_kwh: c.recorded.prices.import_sek_per_kwh,
  });
  const credit = endCredit(terms,
    { battery_kwh: sim.start.batteryKwh, pool_c: poolInventoryC(h.pool.store, sim.start.poolC, sim.start.poolPendingHeatKwh), ev_kwh: sim.start.evKwh },
    { battery_kwh: sim.batteryKwh[last], pool_c: poolInventoryC(h.pool.store, sim.poolC[last], sim.poolPendingHeatKwh[last]), ev_kwh: sim.evKwh[last] });
  const wear = wearOf(h, sim);
  const round = (store: typeof credit.battery) => store && {
    start: r4(store.start), end: r4(store.end), cap: r4(store.cap), counted: r4(store.counted), grid_kwh: r4(store.grid_kwh), credit_sek: r4(store.credit_sek),
  };
  return {
    grid_sek: r4(sim.cost), wear_sek: r4(wear),
    credit: { reference_sek_per_kwh: r4(credit.reference_sek_per_kwh), battery: round(credit.battery), pool: round(credit.pool), ev: round(credit.ev), credit_sek: r4(credit.credit_sek) },
    net_sek: r4(sim.cost + wear - credit.credit_sek),
  };
}

/** Where each store could be at best, at the end of every quarter: full power from the first. */
export function reachability(c: BenchCase, h: Household): { poolC: number[]; carKm: number[] } {
  const carMaxW = evMaxW(h);
  const heater = publishHeater(h.pool.heater);
  let heaterState = c.start_state.pool_heater;
  if (h.pool.heater.source && (typeof c.start_state.pool_source_depletion_kwh !== 'number' || !Number.isFinite(c.start_state.pool_source_depletion_kwh) || c.start_state.pool_source_depletion_kwh < 0 || h.pool.heater.source.heat_loss_per_kwh * c.start_state.pool_source_depletion_kwh >= 1)) throw new Error('Measured source model requires initial depletion');
  let poolC = c.start_state.pool_water_c, poolPendingHeatKwh = 0, poolSourceDepletionKwh = c.start_state.pool_source_depletion_kwh ?? 0, evKwh = c.start_state.ev.soc * h.car.battery.capacity_kwh;
  // A car already past its charge limit stays where it is: it cannot be charged further.
  const ceilingKwh = Math.max(evKwh, evLimitKwh(c, h));
  const out = { poolC: [] as number[], carKm: [] as number[] };
  for (let i = 0; i < QUARTERS; i++) {
    const projected = stepPool(h.pool.store, heater, heaterState, true, { water_c: poolC, pending_heat_kwh: poolPendingHeatKwh, source_depletion_kwh: poolSourceDepletionKwh, outdoor_c: c.recorded.outdoor_temperature_c[i], seconds: HOURS * 3600, stop_c: null });
    heaterState = projected.next;
    poolC = projected.water_c;
    poolPendingHeatKwh = projected.pending_heat_kwh;
    poolSourceDepletionKwh = projected.source_depletion_kwh ?? 0;
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
  const { solarW } = householdSeries(c);
  const reach = reachability(c, h);

  const series: BenchSeries = {
    devices: BENCH_DEVICES.map(d => ({ ...d })),
    deviceW: {
      [BENCH_DEVICE_KEYS.poolPump]: Array.from(sim.pumpW, r1),
      [BENCH_DEVICE_KEYS.poolHeater]: Array.from(sim.compressorW, r1),
      [BENCH_DEVICE_KEYS.ev]: Array.from(sim.evW, r1),
    },
    start: [], hours: [], published: [], importPrice: [], exportPrice: [], believedImportPrice: [],
    poolStart: sim.poolStart,
    solarW: [], loadW: [], poolW: [], hotWaterW: [], carW: [],
    gridImportW: [], gridExportW: [], batteryChargeW: [], batteryDischargeW: [], batteryIdleW: [],
    homeSoc: [], homeStartSoc: sim.start.batteryKwh / h.battery.capacity_kwh * 100,
    carSoc: [], carKm: [], carConnected: [], poolC: [], poolPendingHeatKwh: [], poolSourceDepletionKwh: [], costSek: [], wearSek: [],
    comfort: {
      pool_target_c: targets.pool_c, ev_target_km: evLimitKwh(c, h) / h.car.battery.kwh_per_km, carFloorKm: carFloorKm(c, h, targets),
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
    series.loadW.push(r1(sim.baseW[i] + sim.poolW[i] + sim.evW[i] + sim.batteryIdleW[i]));
    series.poolW.push(r1(sim.poolW[i]));
    series.hotWaterW.push(r1(sim.water?.w[i] ?? 0));
    series.carW.push(r1(sim.evW[i]));
    series.gridImportW.push(r1(Math.max(0, sim.netW[i])));
    series.gridExportW.push(r1(Math.max(0, -sim.netW[i])));
    series.batteryChargeW.push(r1(sim.chargeW[i]));
    series.batteryDischargeW.push(r1(sim.dischargeW[i]));
    series.batteryIdleW!.push(r1(sim.batteryIdleW[i]));
    series.homeSoc.push(r1(sim.batteryKwh[i] / h.battery.capacity_kwh * 100));
    series.carSoc.push(r1(sim.evKwh[i] / h.car.battery.capacity_kwh * 100));
    series.carKm!.push(r1(sim.evKwh[i] / h.car.battery.kwh_per_km));
    // The car is planned whether plugged in or not; the bench lets it charge whenever the plan says.
    series.carConnected.push(1);
    series.poolC.push(Math.round(sim.poolC[i] * 1000) / 1000);
    series.poolPendingHeatKwh.push(sim.poolPendingHeatKwh[i]);
    series.poolSourceDepletionKwh.push(h.pool.heater.source ? sim.poolSourceDepletionKwh[i] : null);
    series.costSek.push(r4(sim.costSek[i]));
    series.wearSek!.push(r4(sim.dischargeW[i] * HOURS / 1_000 * h.site.battery_degradation_sek_per_kwh));
  }
  if (sim.water || d.hot_water) {
    const commands = Array.from({ length: QUARTERS }, (_, i) => d.hot_water?.[i] ?? FREE);
    series.hotWater = {
      demandKnown: sim.water !== null,
      owedKwh: sim.water ? Array.from(sim.water.owedKwh, r4) : [],
      permitted: sim.water ? Array.from(sim.water.permitted) : commands.map(command => command.kind !== 'inhibit' ? 1 : 0),
      command: commands.map(command => command.kind),
    };
  }
  series.bill = billOf(c, h, targets, sim);

  // What the plan leaves behind, as the grid electricity it would take to put it there.
  const batteryKwh = sim.batteryKwh[QUARTERS - 1], poolC = sim.poolC[QUARTERS - 1], evKwh = sim.evKwh[QUARTERS - 1];
  const reference = median(c.recorded.prices.import_sek_per_kwh);
  // A degree of pool water costs its heat over the heat pump's COP, the pump that must run with it included.
  const poolKwhPerDegree = electricKwhPerDegree(h.pool.store, poolLevels(h).at(-1)!);
  const terminalGridKwh = (batteryKwh - sim.start.batteryKwh) * gridKwhPerStoredKwh(h.battery)
    + (poolInventoryC(h.pool.store, poolC, sim.poolPendingHeatKwh[QUARTERS - 1]) - poolInventoryC(h.pool.store, sim.start.poolC, sim.start.poolPendingHeatKwh)) * poolKwhPerDegree
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
