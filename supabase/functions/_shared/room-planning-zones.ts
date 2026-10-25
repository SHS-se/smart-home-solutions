// Each room's planning input, built when a plan is made.
//
// The prepared forecast caches what changes slowly about a room: which
// devices heat it, its fitted model and how much it may draw. What the owner
// wants (the Comfort routine and its temperatures) and where the room is now
// (its temperature, and the heat its floor still holds) are read at planning
// time instead. A cached Comfort temperature planned a bathroom toward 22 °C
// for a plan made seconds after its owner had lowered it to 21 °C.

import {
  buildComfortForecast,
  comfortModesForStarts,
  isZoneComfortSchedule,
  summerHeatingLockoutForStarts,
  temperatureForMode,
  type ZoneComfortSchedule,
} from "./comfort-schedule.ts";
import type { PreparedRoom } from "./prepared-energy-forecasts.ts";
import type { OptimisationSnapshot, ThermalZonePlanningInput } from "./planner/planning-contracts.ts";
import { planningWarning, type PlanningWarning } from "./planner/planning-warnings.ts";
import { deliveredHeat, usesHouse } from "./planner/models/room/thermal.ts";

/** Current preferences and measurements, by room key. */
export interface RoomEvidence {
  schedules: ReadonlyMap<string, unknown>;
  /** Latest measured room temperature. */
  temperature_c: ReadonlyMap<string, number>;
  /** Mean heater power per quarter over the last day, oldest first. */
  recent_heat_w: ReadonlyMap<string, readonly number[]>;
}

const complete = (series: readonly (number | null)[] | null | undefined, length: number): series is number[] =>
  !!series && series.length === length && series.every(v => typeof v === "number" && Number.isFinite(v));

const describe = (error: unknown) => error instanceof Error ? error.message : String(error);

export function roomPlanningZones(
  snapshot: OptimisationSnapshot,
  rooms: readonly PreparedRoom[],
  evidence: RoomEvidence,
): { zones: ThermalZonePlanningInput[]; warnings: PlanningWarning[] } {
  const starts = snapshot.slots.map(slot => slot.start);
  const n = starts.length;
  const lockout = summerHeatingLockoutForStarts(starts, snapshot.timezone);
  const outdoor = complete(snapshot.outdoor_temperature_c, n) ? snapshot.outdoor_temperature_c : null;
  const house = complete(snapshot.house_temperature_c, n) ? snapshot.house_temperature_c : null;
  const zones: ThermalZonePlanningInput[] = [];
  const skipped: { key: string; message: string }[] = [];
  for (const room of rooms) {
    const schedule = evidence.schedules.get(room.key);
    if (!isZoneComfortSchedule(schedule as ZoneComfortSchedule)) {
      skipped.push({ key: room.key, message: `${room.name}: no complete comfort schedule; existing settings are retained` });
      continue;
    }
    const routine = schedule as ZoneComfortSchedule;
    const start = evidence.temperature_c.get(room.key) ?? null;
    let model = room.model;
    if (model && usesHouse(model) && !house) {
      skipped.push({ key: room.key, message: `${room.name}: house temperature unavailable; comfort commands use measured demand` });
      model = null;
    }
    const delivered = model ? deliveredHeat(model, evidence.recent_heat_w.get(room.key) ?? []) : null;
    const targets = comfortModesForStarts(starts, snapshot.timezone, routine).map(mode => temperatureForMode(routine, mode));
    const historical = starts.map((_start, i) => snapshot.device_models
      .filter(device => room.device_keys.includes(device.key))
      .reduce((sum, device) => sum + (device.forecast_w_by_slot[i] ?? 0), 0));
    let forecast = { comfort_min_c: targets, target_c: targets,
      comfort_max_c: targets.map(() => routine.high_temperature_c + .5), power_w: historical };
    let usable = model;
    if (model && start !== null && outdoor && room.rated_power_w > 0) {
      try {
        forecast = buildComfortForecast(starts, snapshot.timezone, routine, model, start, outdoor, room.rated_power_w,
          lockout, snapshot.solar_irradiance_w_per_m2, { house_c: house, start_delivered_w: delivered });
      } catch (error) {
        usable = null;
        skipped.push({ key: room.key, message: `${room.name}: thermal estimate unavailable (${describe(error)}); using measured demand` });
      }
    } else if (model) {
      usable = null;
      skipped.push({ key: room.key, message: `${room.name}: incomplete thermal evidence; comfort commands use measured demand` });
    } else if (!skipped.some(item => item.key === room.key)) {
      skipped.push({ key: room.key, message: `${room.name}: incomplete thermal evidence; comfort commands use measured demand` });
    }
    zones.push({ key: room.key, name: room.name, device_keys: room.device_keys, model: usable,
      start_temperature_c: start, start_delivered_w: usable ? delivered : null, rated_power_w: room.rated_power_w,
      comfort_min_c: forecast.comfort_min_c, target_c: forecast.target_c, comfort_max_c: forecast.comfort_max_c,
      maximum_power_w_by_slot: room.maximum_power_w_by_slot, unplanned_power_w: forecast.power_w });
  }
  return { zones, warnings: skipped.map(item => planningWarning("room_forecast_estimate", item.key, item.message,
    "Household planning and available room comfort commands continue.")) };
}
