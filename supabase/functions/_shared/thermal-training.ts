// Turning stored observations into fitted zones and a plan-side projection.
//
// Refitting on every 15-minute push would burn the same month of history over
// and over for a model that moves imperceptibly between quarters. The fit runs
// only when a plan is generated and the stored model has aged past
// REFIT_INTERVAL_HOURS, so a home refits about once a day.

import {
  fitThermalZoneFromMoments,
  projectZoneTemperature,
  type ThermalFitResult,
  type ThermalMoments,
  type ThermalZoneModel,
} from "./thermal-model.ts";

export const REFIT_INTERVAL_HOURS = 24;
/**
 * How far back a fit reads. Long enough to span several weather regimes so
 * the loss coefficient is identifiable, short enough that a change to the
 * building or its heaters works its way out within weeks.
 */
export const TRAINING_WINDOW_DAYS = 21;

/** One row of `get_energy_thermal_training_moments`. */
export interface ThermalMomentRow extends ThermalMoments {
  room_key: string;
  room_name: string;
  active_power_w: number | null;
}

export interface ZoneFit {
  room_key: string;
  room_name: string;
  result: ThermalFitResult;
}

export const fitZones = (rows: ThermalMomentRow[]): ZoneFit[] =>
  rows.map((row) => ({
    room_key: row.room_key,
    room_name: row.room_name,
    result: fitThermalZoneFromMoments(row, row.active_power_w),
  }));

/** Rows ready for `energy_optimisation_zone_models`. */
export const zoneModelRows = (
  fits: ZoneFit[],
  context: {
    customerId: string;
    homeId: string;
    trainingFrom: string;
    trainingTo: string;
  },
): Record<string, unknown>[] =>
  fits.map(({ room_key, room_name, result }) => {
    if (result.ok === false) {
      return {
        customer_id: context.customerId,
        home_id: context.homeId,
        room_key,
        room_name,
        fitted_at: new Date().toISOString(),
        training_from: context.trainingFrom,
        training_to: context.trainingTo,
        sample_count: result.sample_count,
        trained: false,
        rejection_reason: result.reason,
        gain_c_per_wh: null,
        cooling_constant_per_h: null,
        background_gain_c_per_h: null,
        thermal_capacity_wh_per_c: null,
        heat_loss_w_per_c: null,
        time_constant_h: null,
        heating_rate_c_per_h: null,
        solar_gain_c_per_h_per_wm2: null,
        solar_mean_w_per_m2: null,
        r2: null,
        residual_std_c: null,
      };
    }
    return {
      customer_id: context.customerId,
      home_id: context.homeId,
      room_key,
      room_name,
      fitted_at: new Date().toISOString(),
      training_from: context.trainingFrom,
      training_to: context.trainingTo,
      sample_count: result.model.sample_count,
      trained: true,
      rejection_reason: null,
      gain_c_per_wh: result.model.gain_c_per_wh,
      cooling_constant_per_h: result.model.cooling_constant_per_h,
      background_gain_c_per_h: result.model.background_gain_c_per_h,
      thermal_capacity_wh_per_c: result.model.thermal_capacity_wh_per_c,
      heat_loss_w_per_c: result.model.heat_loss_w_per_c,
      time_constant_h: result.model.time_constant_h,
      heating_rate_c_per_h: result.model.heating_rate_c_per_h,
      // Null on a zone fitted without irradiance, which is how the planner
      // tells the two model shapes apart.
      solar_gain_c_per_h_per_wm2: result.model.solar_gain_c_per_h_per_wm2 ??
        null,
      solar_mean_w_per_m2: result.model.solar_mean_w_per_m2 ?? null,
      r2: result.model.r2,
      residual_std_c: result.model.residual_std_c,
    };
  });

export interface ProjectionZoneInput {
  key: string;
  name: string;
  model: ThermalZoneModel;
  /** Latest observed room temperature, the trajectory's starting point. */
  start_temperature_c: number;
  rated_power_w: number;
  /** Slot-aligned comfort series from the portal-owned weekly routine. */
  comfort_min_c: number[];
  target_c: number[];
  comfort_max_c: number[];
  /** Power the plan places in each slot. */
  planned_power_w: number[];
  /** Power the comfort baseline expects without later price shifting. */
  unplanned_power_w: number[];
}

export interface ThermalProjectionOutput {
  source: "comfort_schedule_model";
  season: null;
  slot_minutes: 15;
  starts: string[];
  outdoor_temperature_c: number[];
  planned_total_power_w: number[];
  unplanned_total_power_w: number[];
  zones: {
    key: string;
    name: string;
    control_type: "setpoint";
    load_type: "duty_cycle";
    priority: number;
    rated_power_w: number;
    comfort_min_c: number[];
    target_c: number[];
    comfort_max_c: number[];
    planned_temperature_c: number[];
    unplanned_temperature_c: number[];
    planned_power_w: number[];
    unplanned_power_w: number[];
  }[];
}

/**
 * Roll every fitted zone forward over the plan horizon.
 *
 * Returns null when no zone can be projected, so the plan simply carries no
 * thermal projection rather than an empty chart implying zero degrees.
 *
 * Planned and unplanned power are currently identical because this first
 * version fixes demand realism before attempting price-led heat shifting. The
 * two temperature curves will separate when thermal flexibility is added.
 */
export function buildThermalProjection(
  starts: string[],
  outdoorTemperatureC: (number | null)[],
  zones: ProjectionZoneInput[],
  solarWPerM2?: (number | null)[] | null,
): ThermalProjectionOutput | null {
  if (starts.length === 0 || zones.length === 0) return null;
  // A zone cannot be rolled forward through quarters with no outdoor
  // temperature, so a partial weather horizon truncates the projection
  // instead of substituting a guess.
  const covered = outdoorTemperatureC.findIndex((value) =>
    value === null || !Number.isFinite(value)
  );
  const length = covered === -1 ? starts.length : covered;
  if (length === 0) return null;

  const outdoor = outdoorTemperatureC.slice(0, length) as number[];
  // Irradiance is optional here in a way outdoor temperature is not: a zone
  // with a solar term falls back to the mean sun it was fitted on, so a
  // missing forecast shortens no horizon.
  const solar = solarWPerM2
    ? solarWPerM2.slice(0, length).map((value) =>
      typeof value === "number" && Number.isFinite(value) ? value : null
    )
    : null;
  if (
    zones.some((zone) =>
      zone.comfort_min_c.length < length || zone.target_c.length < length ||
      zone.comfort_max_c.length < length ||
      zone.planned_power_w.length < length ||
      zone.unplanned_power_w.length < length
    )
  ) {
    throw new Error(
      "thermal projection series do not cover the weather horizon",
    );
  }
  const projectedZones = zones.map((zone, index) => {
    const planned = zone.planned_power_w.slice(0, length);
    const unplanned = zone.unplanned_power_w.slice(0, length);
    return {
      key: zone.key,
      name: zone.name,
      control_type: "setpoint" as const,
      load_type: "duty_cycle" as const,
      priority: index + 1,
      rated_power_w: zone.rated_power_w,
      comfort_min_c: zone.comfort_min_c.slice(0, length),
      target_c: zone.target_c.slice(0, length),
      comfort_max_c: zone.comfort_max_c.slice(0, length),
      planned_temperature_c: projectZoneTemperature(
        zone.model,
        zone.start_temperature_c,
        outdoor,
        planned,
        solar,
      ),
      unplanned_temperature_c: projectZoneTemperature(
        zone.model,
        zone.start_temperature_c,
        outdoor,
        unplanned,
        solar,
      ),
      planned_power_w: planned,
      unplanned_power_w: unplanned,
    };
  });

  const total = (pick: (zone: typeof projectedZones[number]) => number[]) =>
    Array.from({ length }, (_unused, slot) =>
      projectedZones.reduce(
        (sum, zone) => sum + (pick(zone)[slot] ?? 0),
        0,
      ));

  return {
    source: "comfort_schedule_model",
    season: null,
    slot_minutes: 15,
    starts: starts.slice(0, length),
    outdoor_temperature_c: outdoor,
    planned_total_power_w: total((zone) => zone.planned_power_w),
    unplanned_total_power_w: total((zone) => zone.unplanned_power_w),
    zones: projectedZones,
  };
}
