import { roomPlanClock } from "./planner/models/room/state.ts";
// Each room's planning input joins one captured model revision to current
// equipment, comfort settings, measured temperature and retained heat. Forecast
// caches supply weather and house forcing; they never choose a room model.

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
import { isEquilibrium, storedHeat, usesHouse } from "./planner/models/room/thermal.ts";
import { roomResponseEvidenceLimited } from "./planner/room-response.ts";
import { heatingWatts } from "./planner/weather-heating.ts";

/** Current preferences and measurements, by room key. */
export interface RoomEvidence {
  schedules: ReadonlyMap<string, unknown>;
  /** Latest measured room temperature. */
  temperature_c: ReadonlyMap<string, number>;
  temperature_observation?: ReadonlyMap<string, { start_ms: number; end_ms: number; mean_c: number }>;
  /** Mean heater power per quarter over the last day, oldest first. */
  recent_heat_w: ReadonlyMap<string, readonly number[]>;
  stored_heat_c?: ReadonlyMap<string, number>;
  passive_heat_c_per_h?: ReadonlyMap<string, number[]>;
  doorway_boundary_c?: ReadonlyMap<string, number[]>;
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
  const notes: PlanningWarning[] = [];
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
    if (model && isEquilibrium(model)) {
      skipped.push({ key: room.key, message: `${room.name}: the algebraic response has no measured room storage; comfort commands use measured demand while a causal response is fitted` });
      model = null;
    } else if (model && roomResponseEvidenceLimited(room.model_warnings)) {
      skipped.push({ key: room.key, message: `${room.name}: too few measured heating observations to plan preheating; comfort commands use measured demand` });
      model = null;
    } else if (model && usesHouse(model) && !house) {
      skipped.push({ key: room.key, message: `${room.name}: house temperature unavailable; comfort commands use measured demand` });
      model = null;
    }
    const delivered = model ? evidence.stored_heat_c?.get(room.key) ??
      (room.model ? storedHeat(room.model, evidence.recent_heat_w.get(room.key) ?? []) : 0) : null;
    const passive = evidence.passive_heat_c_per_h?.get(room.key);
    const doorway = evidence.doorway_boundary_c?.get(room.key);
    const targets = comfortModesForStarts(starts, snapshot.timezone, routine).map(mode => temperatureForMode(routine, mode));
    const members = snapshot.device_models.filter(device => room.device_keys.includes(device.key));
    const historical = starts.map((_start, i) => members
      .reduce((sum, device) => sum + (device.forecast_w_by_slot[i] ?? 0), 0));
    let forecast = { comfort_min_c: targets, target_c: targets,
      comfort_max_c: targets.map(() => routine.high_temperature_c + .5), power_w: historical };
    let usable = model;
    const weatherPower = room.model_source && members.some(member => member.weather_heating) && outdoor
      ? outdoor.map(c => members.reduce((sum, member) => sum + (
        (member.weather_heating ? heatingWatts(member.weather_heating, c) : null) ?? member.active_power_w ?? 0), 0))
      : undefined;
    if (model && room.connected_exchange && start !== null && outdoor && room.rated_power_w > 0) {
      // Current named exchange is projected jointly by the native room owner.
      // This layer contributes comfort targets, never an independent trajectory.
    } else if (model && start !== null && outdoor && room.rated_power_w > 0) {
      try {
        forecast = buildComfortForecast(starts, snapshot.timezone, routine, model, start, outdoor, room.rated_power_w,
          lockout, snapshot.solar_irradiance_w_per_m2, { house_c: doorway ?? house, start_stored_heat_c: delivered, passive_heat_c_per_h: passive, duration_hours: roomPlanClock(snapshot).hours },
          weatherPower);
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
      ...(room.model_source ? { model_source: room.model_source } : {}),
      ...(room.model_warnings ? { model_warnings: room.model_warnings } : {}),
      ...(evidence.temperature_observation?.has(room.key) ? { temperature_observation: evidence.temperature_observation.get(room.key)! } : {}),
      start_temperature_c: start, start_stored_heat_c: usable ? delivered : null, rated_power_w: room.rated_power_w,
      ...(usable && passive ? { passive_heat_c_per_h: passive } : {}),
      ...(usable && doorway ? { doorway_boundary_c: doorway } : {}),
      comfort_min_c: forecast.comfort_min_c, target_c: forecast.target_c, comfort_max_c: forecast.comfort_max_c,
      maximum_power_w_by_slot: room.maximum_power_w_by_slot, unplanned_power_w: forecast.power_w });
  }
  return { zones, warnings: [...notes, ...skipped.map(item => planningWarning("room_forecast_estimate", item.key, item.message,
    "Household planning and available room comfort commands continue."))] };
}
