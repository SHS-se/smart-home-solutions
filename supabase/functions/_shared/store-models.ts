// Physical state models for the stores the planner schedules against.
//
// ENERGY_OPTIMISATION_ARCHITECTURE.md §8.2: a deferrable load is never "N kWh
// inside a window". It is a physical state that must satisfy a requirement when
// it is actually used, and run duration is an *output* of the solve. These
// models are what turn a store into that state.
//
// Two things follow from writing them this way rather than as energy budgets.
// A pool that is already warm asks for nothing, whatever last week's median
// daily consumption was; and a pool facing a forecast cloudy day can profitably
// be overheated today, because its stored energy is worth what it saves later
// rather than what it cost. Neither behaviour is expressible against a fixed
// `required_kwh`.

export const SLOT_HOURS = 0.25;
/** Water's specific heat capacity, kWh per m³ per °C. */
export const WATER_KWH_PER_M3_K = 1.163;

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

/**
 * Heat delivered per watt of electricity by an air-to-water pool heat pump.
 *
 * COP falls with air temperature, which is the whole reason pool heating is
 * seasonal (§8.3). Two consequences the planner gets for free once it is
 * modelled rather than assumed constant:
 *
 * - The effective price of pool heat is the electricity price divided by COP.
 *   In spring the COP varies more across a day than the price does, so heating
 *   when the air is warm rather than when power is cheap emerges from the
 *   arithmetic; it is not a seasonal rule anyone writes down.
 * - Below the unit's cut-out the pump delivers nothing at all, so the model
 *   returns zero rather than extrapolating a fictional low COP.
 */
export interface PoolHeatPumpModel {
  /** COP at the rating point, with `rated_air_c` air and `rated_water_c` water. */
  rated_cop: number;
  rated_air_c: number;
  rated_water_c: number;
  /** Fractional COP change per °C of air temperature above the rating point. */
  cop_per_air_c: number;
  /** Fractional COP change per °C of water temperature above the rating point. */
  cop_per_water_c: number;
  /** Air temperature below which the unit cannot run. */
  cutout_air_c: number;
  /** Electrical rating, W. */
  rated_power_w: number;
}

export interface PoolModel {
  volume_m3: number;
  /**
   * Loss coefficient, kW per °C of water-to-air difference.
   *
   * Fitted from history rather than calculated, because a pool's real loss is
   * dominated by evaporation and by whether the cover is on — neither of which
   * a surface-area formula knows about.
   */
  loss_kw_per_k: number;
  /** Solar gain into the water per W/m² of irradiance, in kW. Optional. */
  solar_gain_kw_per_wm2?: number;
  heat_pump: PoolHeatPumpModel;
}

/** Heat output, in W, for one electrical input at one air/water temperature. */
export function poolHeatOutputW(
  model: PoolHeatPumpModel,
  electricalW: number,
  airC: number,
  waterC: number,
): number {
  if (electricalW <= 0) return 0;
  if (airC < model.cutout_air_c) return 0;
  const cop = poolCop(model, airC, waterC);
  return cop > 0 ? electricalW * cop : 0;
}

/** COP at one air and water temperature, floored at 1 (resistive worst case). */
export function poolCop(
  model: PoolHeatPumpModel,
  airC: number,
  waterC: number,
): number {
  if (airC < model.cutout_air_c) return 0;
  const cop = model.rated_cop *
    (1 + model.cop_per_air_c * (airC - model.rated_air_c)) *
    (1 + model.cop_per_water_c * (waterC - model.rated_water_c));
  return Math.max(1, cop);
}

/**
 * Water temperature after one slot.
 *
 * Losses are proportional to the water-to-air difference, so a warm pool on a
 * cold night loses faster than a cool one. That asymmetry is what makes
 * pre-heating before a cloudy day a real trade rather than free storage: some
 * of what is put in early leaks back out before it is wanted.
 */
export function stepPoolTemperature(
  model: PoolModel,
  waterC: number,
  airC: number,
  electricalW: number,
  irradianceWm2 = 0,
  durationHours = SLOT_HOURS,
): number {
  const capacityKwhPerK = model.volume_m3 * WATER_KWH_PER_M3_K;
  if (capacityKwhPerK <= 0) return waterC;
  const heatKw = poolHeatOutputW(model.heat_pump, electricalW, airC, waterC) /
    1_000;
  const lossKw = model.loss_kw_per_k * (waterC - airC);
  const solarKw = (model.solar_gain_kw_per_wm2 ?? 0) * irradianceWm2;
  const netKwh = (heatKw - lossKw + solarKw) * durationHours;
  return waterC + netKwh / capacityKwhPerK;
}

/**
 * Electrical energy needed to reach `targetC` by the end of the horizon.
 *
 * Deliberately *not* the planner's demand — it is the feasibility question
 * only. The planner decides how much of it is worth buying by comparing the
 * pool's marginal utility against price, which is why a cloudy day can
 * correctly end with the pool below target and no error raised.
 *
 * Returns null when the pump cannot get there at all, which is the honest
 * answer through a Swedish winter and the reason pool heating stops being
 * scheduled at all rather than being scheduled and silently failing.
 */
export function poolEnergyToTargetKwh(
  model: PoolModel,
  waterC: number,
  targetC: number,
  airBySlot: number[],
): number | null {
  if (waterC >= targetC) return 0;
  let temperature = waterC;
  let electricalKwh = 0;
  for (const airC of airBySlot) {
    if (temperature >= targetC) return electricalKwh;
    const next = stepPoolTemperature(
      model,
      temperature,
      airC,
      model.heat_pump.rated_power_w,
    );
    if (next > temperature) {
      electricalKwh += model.heat_pump.rated_power_w / 1_000 * SLOT_HOURS;
    }
    temperature = next;
  }
  return temperature >= targetC ? electricalKwh : null;
}

// ---------------------------------------------------------------------------
// Electric vehicle
// ---------------------------------------------------------------------------

/**
 * A vehicle's usable range, which is what the utility curve is defined over.
 *
 * Stating the curve in kilometres rather than percent makes winter automatic
 * (§8.3): consumption per kilometre rises as temperature falls, so the same
 * state of charge is worth more in January than in July without any seasonal
 * parameter. Sweden's roughly 40% winter range loss is then a property of the
 * fitted efficiency curve rather than a number anyone maintains.
 */
export interface VehicleModel {
  capacity_kwh: number;
  /** Consumption at `rated_temperature_c`, kWh per km. */
  rated_kwh_per_km: number;
  rated_temperature_c: number;
  /**
   * Fractional consumption increase per °C below the rating point. Cabin
   * heating and battery conditioning dominate, so the penalty is one-sided:
   * warmer than the rating point does not make a car meaningfully better.
   */
  cold_penalty_per_c: number;
  /** Ceiling on that penalty, so an extreme forecast cannot run away. */
  max_cold_multiplier: number;
  charge_efficiency: number;
}

/** Consumption per km at one ambient temperature. */
export function vehicleKwhPerKm(
  model: VehicleModel,
  temperatureC: number,
): number {
  const colder = Math.max(0, model.rated_temperature_c - temperatureC);
  const multiplier = Math.min(
    model.max_cold_multiplier,
    1 + model.cold_penalty_per_c * colder,
  );
  return model.rated_kwh_per_km * multiplier;
}

/** Usable range, in km, at one state of charge and ambient temperature. */
export function vehicleRangeKm(
  model: VehicleModel,
  soc: number,
  temperatureC: number,
): number {
  const perKm = vehicleKwhPerKm(model, temperatureC);
  if (perKm <= 0) return 0;
  return Math.max(0, soc) * model.capacity_kwh / perKm;
}

/** Grid energy needed to move from one range to another, including losses. */
export function vehicleEnergyForRangeKwh(
  model: VehicleModel,
  fromKm: number,
  toKm: number,
  temperatureC: number,
): number {
  if (toKm <= fromKm) return 0;
  const efficiency = Math.max(0.05, model.charge_efficiency);
  return (toKm - fromKm) * vehicleKwhPerKm(model, temperatureC) / efficiency;
}
