// The household every bench test case is planned for, and the comfort its
// owner wants (docs/planner-bench/test-cases.md).
//
// Devices and their physics only: no money and no value curves. A planner
// works its curves out from a case's prices, solar, temperature and history
// together with the comfort below. The referee (referee.ts) steps the same
// physics, so no planner version brings its own.
//
// Changing either constant changes every result's input, so every result is
// run again. Adding a test case changes neither.

import type { Comfort } from './case';

export interface Household {
  site: {
    /** Nord Pool bidding zone the home buys in. */
    market_area: string;
    import_limit_w: number;
    export_limit_w: number;
    battery_export_enabled: boolean;
    battery_export_reserve_soc: number;
    battery_export_min_price_sek_per_kwh: number;
    battery_degradation_sek_per_kwh: number;
    /** State of charge the battery should not end the horizon below. */
    battery_terminal_soc_min: number;
  };
  battery: {
    capacity_kwh: number; min_soc: number; max_soc: number;
    charge_max_w: number; discharge_max_w: number; charge_efficiency: number; discharge_efficiency: number;
  };
  ev: {
    capacity_kwh: number; kwh_per_km: number; charge_efficiency: number;
    voltage_v: number; phase_count: number; min_current_a: number; max_current_a: number; current_step_a: number;
  };
  pool: {
    volume_m3: number; pump_w: number; heater_w: number;
    /** Heat lost per degree the water is above the air, kW/K. */
    loss_kw_per_k: number;
    /** Heat pump: COP at the rating point and how it moves with air and water temperature. */
    rated_cop: number; rated_air_c: number; rated_water_c: number; cop_per_air_c: number; cop_per_water_c: number;
    heater_minimum_run_s: number;
  };
}

export const HOUSEHOLD: Household = {
  site: {
    market_area: "SE3", import_limit_w: 13_200, export_limit_w: 13_200,
    battery_export_enabled: true, battery_export_reserve_soc: 0.8, battery_export_min_price_sek_per_kwh: 2.5,
    battery_degradation_sek_per_kwh: 0.05, battery_terminal_soc_min: 0.2,
  },
  battery: {
    capacity_kwh: 18.08, min_soc: 0.05, max_soc: 1,
    charge_max_w: 8_800, discharge_max_w: 9_600, charge_efficiency: 0.95, discharge_efficiency: 0.95,
  },
  ev: {
    capacity_kwh: 75.6, kwh_per_km: 0.16, charge_efficiency: 0.92,
    voltage_v: 230, phase_count: 3, min_current_a: 5, max_current_a: 16, current_step_a: 1,
  },
  pool: {
    volume_m3: 55, pump_w: 764, heater_w: 2_314, loss_kw_per_k: 0.13,
    rated_cop: 4.5, rated_air_c: 20, rated_water_c: 27, cop_per_air_c: 0.045, cop_per_water_c: -0.02,
    heater_minimum_run_s: 4 * 3600,
  },
};

/**
 * What the owner wants, in each store's own unit, plus how much more an
 * urgently wanted unit is worth than an ordinary one. A case may override it.
 */
export interface ComfortProfile extends Comfort {
  pool_urgency: number;
  ev_urgency: number;
}

export const COMFORT: ComfortProfile = {
  pool_c: { urgent_below: 28, comfortable: 30, indifferent_above: 32 },
  ev_km: { urgent_below: 100, comfortable: 300, indifferent_above: 400 },
  pool_urgency: 1.8,
  ev_urgency: 3,
};

export const WATER_KWH_PER_M3_K = 1.163;

/** Heat delivered per watt of electricity by the pool's heat pump. */
export function poolCop(pool: Household['pool'], airC: number, waterC: number): number {
  const cop = pool.rated_cop * (1 + pool.cop_per_air_c * (airC - pool.rated_air_c)) * (1 + pool.cop_per_water_c * (waterC - pool.rated_water_c));
  return Math.max(1, cop);
}

/** Pool water temperature after `hours` with `electricalW` drawn by the pool. */
export function stepPool(pool: Household['pool'], waterC: number, airC: number, electricalW: number, hours: number): number {
  const capacityKwhPerK = pool.volume_m3 * WATER_KWH_PER_M3_K;
  const heatKw = electricalW > 0 ? electricalW * poolCop(pool, airC, waterC) / 1_000 : 0;
  const lossKw = pool.loss_kw_per_k * (waterC - airC);
  return waterC + (heatKw - lossKw) * hours / capacityKwhPerK;
}
