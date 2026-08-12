// Turning stored observations into fitted zones and a plan-side projection.
//
// Refitting on every 15-minute push would burn the same month of history over
// and over for a model that moves imperceptibly between quarters. The fit runs
// only when a plan is generated and the stored model has aged past
// REFIT_INTERVAL_HOURS, so a home refits about once a day.

import {
  fitThermalZoneFromMoments,
  type ThermalFitResult,
  type ThermalMoments,
  projectZoneTemperature,
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
  device_id: string;
  device_key: string;
  active_power_w: number | null;
}

export interface ZoneFit {
  device_id: string;
  device_key: string;
  result: ThermalFitResult;
}

export const fitZones = (rows: ThermalMomentRow[]): ZoneFit[] =>
  rows.map((row) => ({
    device_id: row.device_id,
    device_key: row.device_key,
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
  fits.map(({ device_id, result }) => ({
    customer_id: context.customerId,
    home_id: context.homeId,
    device_id,
    fitted_at: new Date().toISOString(),
    training_from: context.trainingFrom,
    training_to: context.trainingTo,
    sample_count: result.ok ? result.model.sample_count : result.sample_count,
    trained: result.ok,
    rejection_reason: result.ok ? null : result.reason,
    gain_c_per_wh: result.ok ? result.model.gain_c_per_wh : null,
    cooling_constant_per_h: result.ok
      ? result.model.cooling_constant_per_h
      : null,
    background_gain_c_per_h: result.ok
      ? result.model.background_gain_c_per_h
      : null,
    thermal_capacity_wh_per_c: result.ok
      ? result.model.thermal_capacity_wh_per_c
      : null,
    heat_loss_w_per_c: result.ok ? result.model.heat_loss_w_per_c : null,
    time_constant_h: result.ok ? result.model.time_constant_h : null,
    heating_rate_c_per_h: result.ok ? result.model.heating_rate_c_per_h : null,
    r2: result.ok ? result.model.r2 : null,
    residual_std_c: result.ok ? result.model.residual_std_c : null,
  }));

export interface ProjectionZoneInput {
  key: string;
  name: string;
  model: ThermalZoneModel;
  /** Latest observed room temperature, the trajectory's starting point. */
  start_temperature_c: number;
  rated_power_w: number;
  /** Most recently observed comfort edges, when the home reported any. */
  comfort_min_c: number | null;
  comfort_max_c: number | null;
  /** Power the plan places in each slot. */
  planned_power_w: number[];
  /** Power the empirical forecast expected without planning. */
  unplanned_power_w: number[];
}

export interface ThermalProjectionOutput {
  source: "home_assistant_history";
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
 * Until the planner takes thermal constraints into account, the planned and
 * unplanned power series for a setpoint zone are usually identical, and the
 * two temperature curves will coincide. That is the honest picture: the model
 * predicts what the current schedule produces, and the curves will separate
 * exactly when the planner starts shifting heat.
 */
export function buildThermalProjection(
  starts: string[],
  outdoorTemperatureC: (number | null)[],
  zones: ProjectionZoneInput[],
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
  const projectedZones = zones.map((zone, index) => {
    const planned = zone.planned_power_w.slice(0, length);
    const unplanned = zone.unplanned_power_w.slice(0, length);
    const comfortMin = zone.comfort_min_c;
    const comfortMax = zone.comfort_max_c;
    return {
      key: zone.key,
      name: zone.name,
      control_type: "setpoint" as const,
      load_type: "duty_cycle" as const,
      priority: index + 1,
      rated_power_w: zone.rated_power_w,
      comfort_min_c: new Array(length).fill(comfortMin ?? 0),
      target_c: new Array(length).fill(
        comfortMin !== null && comfortMax !== null
          ? (comfortMin + comfortMax) / 2
          : zone.start_temperature_c,
      ),
      comfort_max_c: new Array(length).fill(comfortMax ?? 0),
      planned_temperature_c: projectZoneTemperature(
        zone.model,
        zone.start_temperature_c,
        outdoor,
        planned,
      ),
      unplanned_temperature_c: projectZoneTemperature(
        zone.model,
        zone.start_temperature_c,
        outdoor,
        unplanned,
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
    source: "home_assistant_history",
    season: null,
    slot_minutes: 15,
    starts: starts.slice(0, length),
    outdoor_temperature_c: outdoor,
    planned_total_power_w: total((zone) => zone.planned_power_w),
    unplanned_total_power_w: total((zone) => zone.unplanned_power_w),
    zones: projectedZones,
  };
}
