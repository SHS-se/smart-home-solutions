// What the energy a plan leaves in its stores is worth, in kronor.
//
// A case's score is its net bill and its deductions, one point to the krona
// (src/lib/planner-bench/score.ts). The net bill credits each store for the
// energy it ends with beyond what it started with, as the grid electricity it
// would take to put that energy there, at one reference price: the upper
// median of the case's import prices, never below zero.
//
// A store counts up to its target and no further. The pool's is the comfort
// temperature, the home battery's a full charge. Energy above a target is worth
// nothing either way: a store that starts above it and coasts down to it is
// credited nothing, and one that ends below where it started, under the
// target, is debited.
//
// The car is priced in tiers instead (car-policy.ts): up to the middle of its
// range at the 75th percentile of the same prices, from there to its own charge
// limit at the 25th, and nothing above the limit.
//
// This is the only definition of those caps, conversions and the price. The
// bench referee applies it at real prices; the planner's problem producers
// hand the planner the same terms from the prices it was told.

import type { BatteryModel, CarBatteryModel, ThermalStoreModel } from "../planner/device-models.ts";
import type { ReadyProblem } from "./ready-problem.ts";
import { gridKwhPerStoredKwh } from '../planner/battery-conversion.ts';

/** One store's credit terms. The unit is kWh stored, or °C for the pool. */
export interface StoreTerm {
  /** The level the store counts up to. */
  cap: number;
  /** Grid electricity one unit takes to put there, kWh. */
  grid_kwh_per_unit: number;
}
/** The car's terms: each tier prices the energy from the previous level up to its own. */
export interface CarTerm {
  grid_kwh_per_unit: number;
  tiers: { up_to: number; sek_per_kwh: number }[];
}
export interface EndCreditTerms {
  reference_sek_per_kwh: number;
  battery: StoreTerm | null;
  pool: StoreTerm | null;
  ev: CarTerm | null;
}
export interface StoreLevels { battery_kwh: number | null; pool_c: number | null; ev_kwh: number | null }
export interface StoreCredit {
  start: number;
  end: number;
  cap: number;
  /** Change in the level that counts: min(end, cap) − min(start, cap). */
  counted: number;
  grid_kwh: number;
  credit_sek: number;
}
export interface EndCredit {
  reference_sek_per_kwh: number;
  battery: StoreCredit | null;
  pool: StoreCredit | null;
  ev: StoreCredit | null;
  credit_sek: number;
}

/** A percentile of the import prices, never below zero: stored energy is not worth less than nothing. */
export function pricePercentile(importSekPerKwh: readonly number[], share: number): number {
  if (!importSekPerKwh.length) return 0;
  const sorted = [...importSekPerKwh].sort((a, b) => a - b);
  return Math.max(0, sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))]);
}
/** The upper median of the import prices. */
export const referencePrice = (importSekPerKwh: readonly number[]) => pricePercentile(importSekPerKwh, 0.5);

export function endCreditTerms(input: {
  battery: BatteryModel | null;
  /** The heat pump at the level it runs at, the pump that must run with it included. */
  pool: { store: ThermalStoreModel; draw_w: number; heat_w: number; target_c: number } | null;
  car: { battery: CarBatteryModel; floor_kwh: number; limit_kwh: number } | null;
  import_sek_per_kwh: readonly number[];
}): EndCreditTerms {
  const { battery, pool, car } = input;
  return {
    reference_sek_per_kwh: referencePrice(input.import_sek_per_kwh),
    battery: battery && { cap: battery.max_soc * battery.capacity_kwh, grid_kwh_per_unit: gridKwhPerStoredKwh(battery) },
    // A degree of water costs its heat over what the heat pump gives per watt drawn (electricKwhPerDegree, device-models.ts).
    pool: pool && { cap: pool.target_c, grid_kwh_per_unit: pool.store.capacity_kwh_per_c * pool.draw_w / pool.heat_w },
    ev: car && {
      grid_kwh_per_unit: 1 / car.battery.charge_efficiency,
      tiers: [
        { up_to: (car.floor_kwh + car.limit_kwh) / 2, sek_per_kwh: pricePercentile(input.import_sek_per_kwh, 0.75) },
        { up_to: car.limit_kwh, sek_per_kwh: pricePercentile(input.import_sek_per_kwh, 0.25) },
      ],
    },
  };
}

/** The terms a prepared planner problem carries: the same caps and conversions, at the prices the planner is told. */
export function problemEndCredit(p: Pick<ReadyProblem, "battery" | "car" | "car_policy" | "pool_store" | "heater" | "targets" | "slots">): EndCreditTerms {
  return endCreditTerms({
    battery: p.battery,
    pool: p.pool_store && p.heater && p.targets.pool_c !== null
      ? { store: p.pool_store, draw_w: p.heater.compressor_w + p.heater.auxiliary_w, heat_w: p.heater.heat_w, target_c: p.targets.pool_c } : null,
    car: p.car && p.car_policy ? { battery: p.car, floor_kwh: p.car_policy.floor_kwh, limit_kwh: p.car_policy.limit_kwh } : null,
    import_sek_per_kwh: p.slots.map(slot => slot.import_price),
  });
}

/** The level of a store that counts: no further than its cap. */
export const countedChange = (start: number, end: number, cap: number) => Math.min(end, cap) - Math.min(start, cap);

/** What a level of car energy is worth, in kronor. Rising, flat above the limit. */
export function carValue(term: CarTerm, kwh: number): number {
  let value = 0, from = 0;
  for (const tier of term.tiers) {
    value += tier.sek_per_kwh * (Math.min(kwh, tier.up_to) - Math.min(kwh, from));
    from = tier.up_to;
  }
  return value * term.grid_kwh_per_unit;
}

export function endCredit(terms: EndCreditTerms, start: StoreLevels, end: StoreLevels): EndCredit {
  const store = (term: StoreTerm | null, from: number | null, to: number | null): StoreCredit | null => {
    if (!term || from === null || to === null) return null;
    const counted = countedChange(from, to, term.cap);
    const grid_kwh = counted * term.grid_kwh_per_unit;
    return { start: from, end: to, cap: term.cap, counted, grid_kwh, credit_sek: grid_kwh * terms.reference_sek_per_kwh };
  };
  const battery = store(terms.battery, start.battery_kwh, end.battery_kwh);
  const pool = store(terms.pool, start.pool_c, end.pool_c);
  const ev = terms.ev && start.ev_kwh !== null && end.ev_kwh !== null ? {
    start: start.ev_kwh, end: end.ev_kwh, cap: terms.ev.tiers.at(-1)!.up_to,
    counted: countedChange(start.ev_kwh, end.ev_kwh, terms.ev.tiers.at(-1)!.up_to),
    grid_kwh: countedChange(start.ev_kwh, end.ev_kwh, terms.ev.tiers.at(-1)!.up_to) * terms.ev.grid_kwh_per_unit,
    credit_sek: carValue(terms.ev, end.ev_kwh) - carValue(terms.ev, start.ev_kwh),
  } : null;
  return {
    reference_sek_per_kwh: terms.reference_sek_per_kwh, battery, pool, ev,
    credit_sek: (battery?.credit_sek ?? 0) + (pool?.credit_sek ?? 0) + (ev?.credit_sek ?? 0),
  };
}
