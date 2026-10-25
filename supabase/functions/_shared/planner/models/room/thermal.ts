/** Room thermal response only. No fitting, electrical capabilities, prices or policy. */
export const SLOT_HOURS = 0.25;

export interface ThermalZoneModel {
  /** Temperature rise per watt-hour delivered, °C/Wh. */
  gain_c_per_wh: number;
  /** EMHASS cooling constant γ, per hour per °C. */
  cooling_constant_per_h: number;
  /**
   * Steady background gain, °C/h.
   *
   * Appliances, lighting and occupants — and, on a model with no solar term,
   * the sun as well, averaged flat across bright days and dull ones alike.
   */
  background_gain_c_per_h: number;
  /**
   * Temperature rise per hour per W/m² of global horizontal irradiance.
   *
   * Null on a zone fitted without irradiance, which is the only difference
   * between the two model shapes: everything downstream reads the free-heat
   * rate through `backgroundRateForSlot` and neither knows nor cares which it
   * was given.
   */
  solar_gain_c_per_h_per_wm2?: number | null;
  /**
   * Mean irradiance across the window this zone was fitted on, W/m².
   *
   * Kept so a zone with a solar term can still be projected when no forecast
   * is available: at the mean it reproduces exactly the flat background the
   * three-regressor fit would have published, so losing the forecast costs
   * accuracy without changing the model's meaning.
   */
  solar_mean_w_per_m2?: number | null;
  /** Derived lumped heat capacity, Wh/°C. */
  thermal_capacity_wh_per_c: number;
  /** Derived envelope loss coefficient, W/°C. */
  heat_loss_w_per_c: number;
  /** Derived time constant, hours. */
  time_constant_h: number;
  /** EMHASS `heating_rate` at the zone's rated power, °C/h. */
  heating_rate_c_per_h: number | null;
  r2: number;
  sample_count: number;
  residual_std_c: number;
  /**
   * Hours for heater heat to reach the room: a first-order delay, the floor
   * slab between an electric mat and the air. Null or 0 is immediate.
   */
  heat_lag_h?: number | null;
  /**
   * °C/h per °C the room sits below the house. A room fitted against the
   * house's measured temperature carries this and a zero outdoor
   * `cooling_constant_per_h`; null keeps the outdoor-coupled shape.
   */
  house_coupling_per_h?: number | null;
  /** Mean 12-hour prediction error over the fit's own window, °C. */
  prediction_error_c?: number | null;
}

/** What a room is subject to over one quarter. */
export interface RoomConditions {
  hours: number;
  outdoor_c: number;
  /** Required when the model couples to the house. */
  house_c?: number | null;
  /** Free heat this quarter, °C/h: `backgroundRateForSlot`. */
  background_c_per_h: number;
}

/**
 * One quarter's exact transition under constant heater power P:
 *
 *   next T = decay·T + offset_c + delivered_gain_c_per_w·D + gain_c_per_w·P
 *   next D = carry·D + (1 − carry)·P
 *
 * D is the heat already on its way through the delay, in watts. Without a
 * delay `carry` and `delivered_gain_c_per_w` are zero and D plays no part, so
 * every caller can carry it whether or not the room has one.
 */
export interface RoomTransition {
  decay: number;
  offset_c: number;
  delivered_gain_c_per_w: number;
  gain_c_per_w: number;
  carry: number;
}

export const usesHouse = (model: ThermalZoneModel): boolean =>
  typeof model.house_coupling_per_h === "number" && model.house_coupling_per_h > 0;

export function roomTransition(model: ThermalZoneModel, conditions: RoomConditions): RoomTransition {
  const hours = Math.max(0, conditions.hours);
  const house = usesHouse(model) ? model.house_coupling_per_h! : 0;
  if (house > 0 && !(typeof conditions.house_c === "number" && Number.isFinite(conditions.house_c))) {
    throw new Error("a house-coupled room needs the house temperature");
  }
  const coupling = model.cooling_constant_per_h + house;
  const decay = Math.exp(-coupling * hours);
  const effect = coupling > 0 ? -Math.expm1(-coupling * hours) / coupling : hours;
  const offset_c = (model.cooling_constant_per_h * conditions.outdoor_c +
    (house > 0 ? house * conditions.house_c! : 0) + conditions.background_c_per_h) * effect;
  const lag = model.heat_lag_h ?? 0;
  const gain = model.gain_c_per_wh * effect;
  if (!(lag > 0)) return { decay, offset_c, delivered_gain_c_per_w: 0, gain_c_per_w: gain, carry: 0 };
  const carry = Math.exp(-hours / lag);
  // The quarter's mean delivered heat is share·D + (1 − share)·P.
  const share = hours > 0 ? lag / hours * -Math.expm1(-hours / lag) : 1;
  return { decay, offset_c, delivered_gain_c_per_w: gain * share, gain_c_per_w: gain * (1 - share), carry };
}

export interface RoomState {
  temperature_c: number;
  /** Heat on its way through the delay, W. */
  delivered_w: number;
}

export const stepRoom = (transition: RoomTransition, state: RoomState, watts: number): RoomState => ({
  temperature_c: transition.decay * state.temperature_c + transition.offset_c +
    transition.delivered_gain_c_per_w * state.delivered_w + transition.gain_c_per_w * watts,
  delivered_w: transition.carry * state.delivered_w + (1 - transition.carry) * watts,
});

/** The delayed heat a room's recent power has built up, oldest quarter first. */
export function deliveredHeat(model: ThermalZoneModel, recentQuarterW: readonly number[]): number {
  const lag = model.heat_lag_h ?? 0;
  if (!(lag > 0)) return 0;
  const carry = Math.exp(-SLOT_HOURS / lag);
  return recentQuarterW.reduce((delivered, watts) =>
    carry * delivered + (1 - carry) * (Number.isFinite(watts) ? Math.max(0, watts) : 0), 0);
}

export function backgroundRateForSlot(
  model: ThermalZoneModel,
  index: number,
  solarWPerM2?: (number | null)[] | null,
): number {
  const coefficient = model.solar_gain_c_per_h_per_wm2;
  if (typeof coefficient !== "number" || !Number.isFinite(coefficient)) {
    return model.background_gain_c_per_h;
  }
  const forecast = solarWPerM2?.[index];
  const irradiance = typeof forecast === "number" && Number.isFinite(forecast)
    ? forecast
    : model.solar_mean_w_per_m2 ?? 0;
  return model.background_gain_c_per_h + coefficient * irradiance;
}

export function projectZoneTemperature(
  model: ThermalZoneModel,
  startTemperatureC: number,
  outdoorC: number[],
  heatInputW: number[],
  solarWPerM2?: (number | null)[] | null,
  durationHours?: number[],
  context: { house_c?: (number | null)[] | null; start_delivered_w?: number | null } = {},
): number[] {
  const projection: number[] = [];
  let state: RoomState = { temperature_c: startTemperatureC, delivered_w: context.start_delivered_w ?? 0 };
  for (let index = 0; index < outdoorC.length; index += 1) {
    projection.push(Math.round(state.temperature_c * 1000) / 1000);
    state = stepRoom(roomTransition(model, {
      hours: durationHours?.[index] ?? SLOT_HOURS, outdoor_c: outdoorC[index],
      house_c: context.house_c?.[index], background_c_per_h: backgroundRateForSlot(model, index, solarWPerM2),
    }), state, heatInputW[index] ?? 0);
  }
  return projection;
}

/** Convert a quarter's metered energy into the mean power it represents. */
export const quarterEnergyToWatts = (kwh: number): number =>
  (kwh * 1000) / SLOT_HOURS;
