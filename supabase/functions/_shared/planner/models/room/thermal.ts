import { roomMeanObservation } from "./observation.ts";
/** Room thermal response only. No fitting, electrical capabilities, prices or policy. */
export const SLOT_HOURS = 0.25;

/** Learned temperature response per electrical watt from an observed appliance. */
export interface PassiveRoomHeat {
  device_key: string;
  direct_c_per_wh: number;
  delayed_c_per_wh: number;
  lag_h: number;
}

export interface DynamicThermalZoneModel {
  response_family?: "finite" | "integrator";
  /** Temperature rise per watt-hour delivered, °C/Wh. */
  gain_c_per_wh: number;
  /** Outdoor exchange, °C/h per °C between outdoor air and this room. */
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
   * Null when irradiance has insufficient coverage or variation. The shared room model supports
   * solar gain alongside both internal and external heat exchange.
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
  thermal_capacity_wh_per_c: number | null;
  /** Derived total internal plus external exchange coefficient, W/°C. */
  heat_loss_w_per_c: number | null;
  /** Derived time constant, hours. */
  time_constant_h: number | null;
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
   * Internal exchange, °C/h per °C between the house and this room.
   * Learned jointly with outdoor exchange; either may empirically be zero.
   */
  house_coupling_per_h?: number | null;
  /** Mean 12-hour prediction error over the fit's own window, °C. */
  prediction_error_c?: number | null;
}

/** Algebraic temperature response; no dynamic capacity or energy gain is identified. */
export interface EquilibriumThermalZoneModel {
  response_family: "equilibrium";
  heater_c_per_w: number;
  outdoor_share: number;
  offset_c: number;
  solar_c_per_wm2: number | null;
  solar_mean_w_per_m2?: number | null;
  heat_lag_h?: number | null;
  r2: number;
  sample_count: number;
  residual_std_c: number;
  prediction_error_c?: number | null;
}
export type ThermalZoneModel = DynamicThermalZoneModel | EquilibriumThermalZoneModel;
export const isEquilibrium = (model: ThermalZoneModel): model is EquilibriumThermalZoneModel => model.response_family === "equilibrium";
export const heaterResponse = (model: ThermalZoneModel): number => isEquilibrium(model) ? model.heater_c_per_w : model.gain_c_per_wh;
/** Scale from delivered heater watts to this response's delayed state. */
export const roomMemoryPerWatt = (model: ThermalZoneModel): number => !(model.heat_lag_h! > 0) ? 0 :
  isEquilibrium(model) ? model.heater_c_per_w : model.gain_c_per_wh * model.heat_lag_h!;
/** Dynamic bands conserve Q. Across an algebraic boundary, preserve delivered
 * heater watts; its response coordinate is not a dynamic heat-capacity estimate. */
export function roomMemoryScale(previous: ThermalZoneModel, next: ThermalZoneModel): number {
  if (!isEquilibrium(previous) && !isEquilibrium(next)) return 1;
  if (previous === next) return 1;
  const before = roomMemoryPerWatt(previous), after = roomMemoryPerWatt(next);
  return before > 0 ? after / before : 0;
}

/** What a room is subject to over one quarter. */
export interface RoomConditions {
  hours: number;
  outdoor_c: number;
  /** Required when the model couples to the house. */
  house_c?: number | null;
  /** Dynamic forcing rate (°C/h), or algebraic equilibrium offset (°C),
   * compiled by backgroundRateForSlot for this same response family. */
  background_c_per_h: number;
}

/** Exact constant-input transition. Dynamic Q is stored temperature-equivalent heat.
 * Equilibrium Q is the delayed heater contribution to algebraic temperature.
 * roomMemoryScale converts once when crossing those response coordinates.
 * next T = decay*T + offset + stored_heat_release*Q + gain_c_per_w*P
 * next Q = carry*Q + stored_heat_gain_c_per_w*P */
export interface RoomTransition {
  decay: number;
  offset_c: number;
  stored_heat_release: number;
  gain_c_per_w: number;
  stored_heat_gain_c_per_w: number;
  carry: number;
}

export const usesHouse = (model: ThermalZoneModel): boolean =>
  isEquilibrium(model) ? model.outdoor_share < 1 :
  typeof model.house_coupling_per_h === "number" && model.house_coupling_per_h > 0;

export function roomTransition(model: ThermalZoneModel, conditions: RoomConditions): RoomTransition {
  const hours = Math.max(0, conditions.hours);
  if (isEquilibrium(model)) {
    if (hours === 0) return { decay: 1, offset_c: 0, stored_heat_release: 0, gain_c_per_w: 0, stored_heat_gain_c_per_w: 0, carry: 1 };
    if (usesHouse(model) && !(typeof conditions.house_c === "number" && Number.isFinite(conditions.house_c))) throw new Error("a house-coupled room needs the house temperature");
    const lag = model.heat_lag_h ?? 0, carry = lag > 0 ? Math.exp(-hours / lag) : 0;
    const gain = model.heater_c_per_w * (1 - carry);
    return { decay: 0, offset_c: model.outdoor_share * conditions.outdoor_c +
      (usesHouse(model) ? (1 - model.outdoor_share) * conditions.house_c! : 0) + conditions.background_c_per_h,
      stored_heat_release: carry, gain_c_per_w: gain,
      stored_heat_gain_c_per_w: lag > 0 ? gain : 0, carry };
  }
  const house = usesHouse(model) ? model.house_coupling_per_h! : 0;
  if (house > 0 && !(typeof conditions.house_c === "number" && Number.isFinite(conditions.house_c))) {
    throw new Error("a house-coupled room needs the house temperature");
  }
  const coupling = model.cooling_constant_per_h + house;
  const lag = Math.max(0, model.heat_lag_h ?? 0);
  const op = roomMeanObservation(coupling, lag, hours);
  const offset_c = (model.cooling_constant_per_h * conditions.outdoor_c +
    (house > 0 ? house * conditions.house_c! : 0) + conditions.background_c_per_h) * op.effect;
  const gain = model.gain_c_per_wh;
  return {
    decay: op.a, offset_c,
    // At zero lag existing stored heat is released at the interval's start.
    // A zero-duration capture is the identity, including at a band boundary.
    stored_heat_release: hours === 0 ? 0 : lag > 0 ? op.B / lag : op.a,
    gain_c_per_w: gain * (op.effect - op.B),
    stored_heat_gain_c_per_w: lag > 0 ? gain * lag * -Math.expm1(-hours / lag) : 0,
    carry: op.C,
  };
}

export interface RoomState {
  temperature_c: number;
  /** Dynamic unreleased heat or equilibrium delayed contribution, °C.
   * Dynamic band changes conserve it; algebraic boundaries convert via delivered watts. */
  stored_heat_c: number;
}

export const stepRoom = (transition: RoomTransition, state: RoomState, watts: number): RoomState => ({
  temperature_c: transition.decay * state.temperature_c + transition.offset_c +
    transition.stored_heat_release * state.stored_heat_c + transition.gain_c_per_w * watts,
  stored_heat_c: transition.carry * state.stored_heat_c + transition.stored_heat_gain_c_per_w * watts,
});

/** The delayed heat a room's recent power has built up, oldest quarter first. */
export function storedHeat(model: ThermalZoneModel, recentQuarterW: readonly number[]): number {
  const lag = model.heat_lag_h ?? 0;
  if (!(lag > 0)) return 0;
  return roomMemoryPerWatt(model) * deliveredHeatAtLag(lag, recentQuarterW);
}

function deliveredHeatAtLag(lag: number, recentQuarterW: readonly number[]): number {
  const carry = Math.exp(-SLOT_HOURS / lag);
  return recentQuarterW.reduce((delivered, watts) =>
    carry * delivered + (1 - carry) * (Number.isFinite(watts) ? Math.max(0, watts) : 0), 0);
}

/** Only stored heat from measured electricity contributes to the future.
 * Any immediate gain is already present in the starting room temperature. */
export function passiveHeatRates(
  model: PassiveRoomHeat, recentWatts: readonly number[], historyEndMs: number,
  capturedMs: number, starts: readonly string[],
): number[] {
  const rate = model.delayed_c_per_wh * deliveredHeatAtLag(model.lag_h, recentWatts);
  return starts.map(start => {
    const begin = Date.parse(start);
    const from = Math.max(begin, capturedMs, historyEndMs);
    const hours = (begin + SLOT_HOURS * 3_600_000 - from) / 3_600_000;
    if (!(hours > 0)) return 0;
    const delay = (from - historyEndMs) / 3_600_000;
    return rate * Math.exp(-delay / model.lag_h) * (-Math.expm1(-hours / model.lag_h)) * model.lag_h / hours;
  });
}

export interface RoomProjectionContext {
  house_c?: (number | null)[] | null;
  start_stored_heat_c?: number | null;
  passive_heat_c_per_h?: readonly number[];
  model_by_quarter?: readonly ThermalZoneModel[];
}

export function backgroundRateForSlot(
  model: ThermalZoneModel,
  index: number,
  solarWPerM2?: (number | null)[] | null,
  passiveHeatCPerH?: readonly number[],
): number {
  // A finite rate has zero algebraic equilibrium contribution. Do not relabel it as °C.
  const background = isEquilibrium(model) ? model.offset_c : model.background_gain_c_per_h + (passiveHeatCPerH?.[index] ?? 0);
  const coefficient = isEquilibrium(model) ? model.solar_c_per_wm2 : model.solar_gain_c_per_h_per_wm2;
  if (typeof coefficient !== "number" || !Number.isFinite(coefficient)) {
    return background;
  }
  const forecast = solarWPerM2?.[index];
  const irradiance = typeof forecast === "number" && Number.isFinite(forecast)
    ? forecast
    : model.solar_mean_w_per_m2 ?? 0;
  return background + coefficient * irradiance;
}

export function projectZoneTemperature(
  model: ThermalZoneModel,
  startTemperatureC: number,
  outdoorC: number[],
  heatInputW: number[],
  solarWPerM2?: (number | null)[] | null,
  durationHours?: number[],
  context: RoomProjectionContext = {},
): number[] {
  const projection: number[] = [];
  let state: RoomState = { temperature_c: startTemperatureC, stored_heat_c: context.start_stored_heat_c ?? 0 };
  let previous = context.model_by_quarter?.[0] ?? model;
  for (let index = 0; index < outdoorC.length; index += 1) {
    const physics = context.model_by_quarter?.[index] ?? model;
    if ((durationHours?.[index] ?? SLOT_HOURS) > 0) {
      state.stored_heat_c *= roomMemoryScale(previous, physics);
      previous = physics;
    }
    projection.push(Math.round(state.temperature_c * 1000) / 1000);
    state = stepRoom(roomTransition(physics, {
      hours: durationHours?.[index] ?? SLOT_HOURS, outdoor_c: outdoorC[index],
      house_c: context.house_c?.[index], background_c_per_h: backgroundRateForSlot(physics, index, solarWPerM2, context.passive_heat_c_per_h),
    }), state, heatInputW[index] ?? 0);
  }
  return projection;
}

/** Convert a quarter's metered energy into the mean power it represents. */
export const quarterEnergyToWatts = (kwh: number): number =>
  (kwh * 1000) / SLOT_HOURS;
