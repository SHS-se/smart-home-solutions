import { heatingWatts, isWeatherHeatingBinding, readWeatherHeating } from "./planner/weather-heating.ts";
/** Joins current room evidence with one model capture; never learns or schedules. */
import type { DeviceControlType, OptimisationSnapshot } from "./planner/planning-contracts.ts";
import type { DeviceModelBundle } from "./device-model-store.ts";
import type { PreparedRoom } from "./prepared-energy-forecasts.ts";
import type { ThermalQuarterRow } from "./thermal-training.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { passiveHeatRates } from "./planner/models/room/thermal.ts";
import { readPassiveHeatModel, readRoomPassiveHeat } from "./room-passive-heat-evidence.ts";
import { readThermalModel } from "./planner/models/room/read-model.ts";
import { roomPlanningZones } from "./room-planning-zones.ts";
import { summerHeatingLockoutForStarts } from "./comfort-schedule.ts";
import { classifyOutdoorSeries } from "./outdoor-forecast.ts";
import { mergePlanningWarnings, planningWarning } from "./planner/planning-warnings.ts";

/** Mapping has already been parsed at the transport boundary. */
export interface RoomDeviceMapping {
  key: string;
  control_type_override: DeviceControlType | null;
  room: { key: string; name: string } | null;
}
type RoomEvidenceDatabase = Pick<SupabaseClient, "rpc" | "from">;
const SLOT_MS = 900_000;
/** A day of recorded heat supplies the existing delayed-heat initial condition. */
const RECENT_HEAT_HOURS = 24;
/** The newest completed quarters that may still be on their way. */
const LATE_HEAT_QUARTERS = 2;

export interface PreparedThermalPlanning {
  snapshot: OptimisationSnapshot;
  rooms: PreparedRoom[];
}


/**
 * Plan every load on its own recent history, with no room comfort forecast.
 * This is what the home did before comfort forecasting existed, and it is the
 * right answer whenever the forecast cannot be built: comfort is one term of
 * the plan, not a precondition for having one.
 */
const withoutComfortForecast = (
  snapshot: OptimisationSnapshot,
): PreparedThermalPlanning => ({
  snapshot: {
    ...snapshot,
    device_models: snapshot.device_models.map((model) => ({
      ...model,
      forecast_method: model.forecast_method ?? "empirical_recent_history",
    })),
    thermal_zones: [],
  },
  rooms: [],
});


export function prepareRoomModels(
  snapshot: OptimisationSnapshot,
  storedDevices: readonly RoomDeviceMapping[],
  bundle: DeviceModelBundle | null,
): PreparedThermalPlanning {
  const storedByKey = new Map(
    storedDevices.map((device) => [device.key, device]),
  );
  const scope = snapshot.operating_scope;
  const weatherByDevice = new Map((bundle?.devices ?? []).map(row => [row.device_key, row]));
  snapshot = { ...snapshot, device_models: snapshot.device_models.map(model => {
    // Only server-owned, versioned calibration can enter the planner.
    const { weather_heating: _supplied, ...device } = model;
    const binding = device.weather_heating_binding;
    if (device.control_type !== "setpoint" || device.planning_service === "pool" ||
      scope?.modes[scope.device_owners[device.key]] !== "control_verification" ||
      !isWeatherHeatingBinding(binding)) return device;
    const row = weatherByDevice.get(device.key);
    const profile = row && readWeatherHeating(row.operating_points, binding);
    return profile && row ? { ...device, weather_heating: { ...profile, revision: row.model_revision } } : device;
  }) };
  const roomModels = snapshot.device_models.filter((model) => {
    if (model.planning_role !== "controllable" || model.planning_service === "pool") return false;
    if (model.control_type === "setpoint") return true;
    if (model.control_type !== "switch_schedule") return false;
    const stored = storedByKey.get(model.key);
    return stored?.control_type_override === model.control_type &&
      stored.room !== null;
  });
  if (roomModels.length === 0) {
    return withoutComfortForecast(snapshot);
  }

  const rooms = new Map<string, {
    key: string;
    name: string;
    models: typeof roomModels;
  }>();
  for (const model of roomModels) {
    const stored = storedByKey.get(model.key);
    const room = stored?.room ?? null;
    if (!stored || !room) {
      // Commissioning is not finished for this control. Its own profile still
      // plans; only its comfort forecast is unavailable.
      continue;
    }
    const grouped = rooms.get(room.key) ?? {
      key: room.key,
      name: room.name,
      models: [],
    };
    if (grouped.name !== room.name) {
      // Two names for one key is a mapping inconsistency to surface in the
      // portal, not a reason to leave the house unplanned.
      continue;
    }
    grouped.models.push(model);
    rooms.set(room.key, grouped);
  }

  const starts = snapshot.slots.map((slot) => slot.start);
  const summerLockout = summerHeatingLockoutForStarts(
    starts,
    snapshot.timezone,
  );
  if (summerLockout.every(Boolean)) {
    const lockedKeys = new Set(roomModels.map((model) => model.key));
    return {
      snapshot: {
        ...snapshot,
        device_models: snapshot.device_models.map((model) => ({
          ...model,
          forecast_method: lockedKeys.has(model.key)
            ? "seasonal_heating_lockout_v1"
            : model.forecast_method ?? "empirical_recent_history",
          forecast_w_by_slot: lockedKeys.has(model.key)
            ? starts.map(() => 0)
            : model.forecast_w_by_slot,
        })),
        thermal_zones: [],
      },
      rooms: [],
    };
  }

  const classified = classifyOutdoorSeries(
    snapshot.outdoor_temperature_c,
    snapshot.slots.length,
  );
  const outdoor = classified.status === "complete" ? classified.series : null;
  if (!outdoor) snapshot.planning_warnings = mergePlanningWarnings(snapshot.planning_warnings, [planningWarning(
    "outdoor_estimate", "rooms", "Outdoor forecast coverage is incomplete.",
    "Room comfort commands remain active; electrical demand uses observed history where thermal projection is unavailable.")]);

  const trainedByRoom = new Map((bundle?.rooms ?? []).filter(model => model.trained)
    .map(model => [String(model.room_key), model]));

  // Current equipment joins the atomically captured model bundle. No device
  // capability or calibration is selected by the weather/price cache.
  const prepared: PreparedRoom[] = [];
  for (const room of rooms.values()) {
    const fitted = trainedByRoom.get(room.key);
    const ratedPowerW = room.models.reduce((sum, model) => sum + Number(model.active_power_w ?? 0), 0);
    const historical = starts.map((_start, i) => room.models.reduce((sum, m) => sum + m.forecast_w_by_slot[i], 0));
    const baselineCapW = Math.max(ratedPowerW, ...historical);
    const weather = outdoor && room.models.some(model => model.weather_heating)
      ? outdoor.map(temperature => room.models.reduce((sum, model) => sum + (
        (model.weather_heating ? heatingWatts(model.weather_heating, temperature) : null) ?? model.active_power_w ?? 0
      ), 0))
      : null;
    for (const member of room.models) {
      const profile = member.weather_heating;
      if (!profile && isWeatherHeatingBinding(member.weather_heating_binding) &&
        scope?.modes[scope.device_owners[member.key]] === "control_verification") {
        snapshot.planning_warnings = mergePlanningWarnings(snapshot.planning_warnings, [planningWarning(
          "weather_heating_draw_learning", member.key, `${member.name}: heating draw across outdoor temperatures is still being learned.`,
          "Verification uses the existing running-power estimate until a weather profile is available.")]);
      }
      if (profile && outdoor?.some(temperature => heatingWatts(profile, temperature) === null)) {
        snapshot.planning_warnings = mergePlanningWarnings(snapshot.planning_warnings, [planningWarning(
          "weather_heating_draw_estimated", member.key, `${member.name}: forecast temperatures extend beyond observed heating draw.`,
          "Verification uses the existing running-power estimate for quarters outside the learned temperature range.")]);
      }
    }
    const attempt = fitted?.last_fit_attempt as { issues?: string[]; passive_heat?: { status?: string } } | undefined;
    const passive = readPassiveHeatModel(fitted?.passive_heat);
    if (!passive && attempt?.passive_heat?.status === "awaiting_validation") {
      snapshot.planning_warnings = mergePlanningWarnings(snapshot.planning_warnings, [planningWarning(
        "room_passive_heat_learning", room.key, `${room.name}: monitored appliance heat is still being learned.`,
        "The room forecast uses the regular heater and temperature model until appliance heat is validated.")]);
    }
    if (attempt?.issues?.length) snapshot.planning_warnings = mergePlanningWarnings(snapshot.planning_warnings, [planningWarning(
      "room_model_quality", room.key, `${room.name}: ${attempt.issues.join(", ")}.`,
      "The latest usable thermal parameters remain available; comfort service continues.")]);
    prepared.push({ key: room.key, name: room.name, device_keys: room.models.map(m => m.key),
      model: readThermalModel(fitted), rated_power_w: ratedPowerW,
      ...(passive ? { passive_heat: passive } : {}),
      maximum_power_w_by_slot: summerLockout.map((locked, i) => locked ? 0 : Math.max(baselineCapW, weather?.[i] ?? 0)) });
  }
  return { snapshot, rooms: prepared };
}

/**
 * Each room's planning input, from its prepared evidence and what is true now:
 * the owner's current Comfort routine, the room's latest temperature and the
 * heat its last day of heating still has on the way.
 */
export async function captureRoomPlanningState(
  supabase: RoomEvidenceDatabase, customerId: string, homeId: string,
  snapshot: OptimisationSnapshot, rooms: PreparedRoom[],
): Promise<OptimisationSnapshot> {
  if (rooms.length === 0) return { ...snapshot, thermal_zones: [] };
  const now = Date.now();
  const captured = Date.parse(snapshot.captured_at);
  const passiveEnd = Math.floor(captured / SLOT_MS) * SLOT_MS;
  const passiveStart = passiveEnd - RECENT_HEAT_HOURS * 3_600_000;
  const passiveRooms = rooms.filter(room => room.passive_heat);
  const [latestResult, scheduleResult, recentResult, passiveSources] = await Promise.all([
    // Available observations remain evidence independently of their report age.
    supabase.rpc("get_energy_latest_room_temperatures", {
      p_customer_id: customerId, p_home_id: homeId, p_from: "1970-01-01T00:00:00.000Z",
    }),
    supabase
      .from("energy_optimisation_comfort_schedules")
      .select("room_key, weekday_modes, weekend_modes, off_temperature_c, low_temperature_c, high_temperature_c")
      .eq("home_id", homeId),
    // A delayed room starts with the heat its last hours already put on the way.
    rooms.some(room => (room.model?.heat_lag_h ?? 0) > 0)
      ? supabase.rpc("get_energy_thermal_training_quarters", {
        p_customer_id: customerId, p_home_id: homeId,
        p_from: new Date(now - RECENT_HEAT_HOURS * 3_600_000).toISOString(), p_to: new Date(now).toISOString(),
      })
      : Promise.resolve({ data: [], error: null }),
    passiveRooms.length
      ? readRoomPassiveHeat(supabase, customerId, homeId, passiveRooms.map(room => room.key),
        new Date(passiveStart).toISOString(), new Date(passiveEnd).toISOString()).catch(error => {
          console.error("[ENERGY-OPTIMISATION] monitored room heat unavailable", error);
          return null;
        })
      : null,
  ]);
  for (const result of [latestResult, scheduleResult, recentResult]) {
    if (result.error) {
      console.error("[ENERGY-OPTIMISATION] room evidence unavailable", result.error);
      snapshot.planning_warnings = mergePlanningWarnings(snapshot.planning_warnings, [planningWarning(
        "room_evidence_unavailable", "rooms", "Some room evidence could not be read.",
        "Planning continues using the available room evidence and measured demand profiles.")]);
    }
  }
  const temperature = new Map<string, number>();
  for (const row of latestResult.data ?? []) {
    const value = Number(row.room_temperature_c);
    if (!temperature.has(row.room_key) && row.room_temperature_c !== null && Number.isFinite(value)) temperature.set(row.room_key, value);
  }
  const schedules = new Map<string, unknown>((scheduleResult.data ?? []).map((row: Record<string, unknown>) => [row.room_key as string, {
    weekday_modes: row.weekday_modes, weekend_modes: row.weekend_modes,
    off_temperature_c: Number(row.off_temperature_c), low_temperature_c: Number(row.low_temperature_c),
    high_temperature_c: Number(row.high_temperature_c),
  }]));
  const heatByStart = new Map<string, Map<number, number>>();
  for (const row of (recentResult.data ?? []) as ThermalQuarterRow[]) {
    const byStart = heatByStart.get(row.room_key) ?? new Map<number, number>();
    byStart.set(Date.parse(row.start_ts), Number(row.heat_w ?? 0));
    heatByStart.set(row.room_key, byStart);
  }
  const quarters = Array.from({ length: RECENT_HEAT_HOURS * 4 }, (_v, i) =>
    Math.floor(now / SLOT_MS) * SLOT_MS - (RECENT_HEAT_HOURS * 4 - i) * SLOT_MS);
  // Heat that has not been reported counts as none, the lower bound on what is
  // still on its way into the room. Say so for rooms that carry delayed heat
  // and do report: the newest quarters still arriving are routine, an older
  // hole is shown. A room that never reports heat has no metering to wait for.
  const reported = new Map<string, Set<number>>();
  for (const row of (recentResult.data ?? []) as ThermalQuarterRow[]) {
    if (row.heat_w === null || row.heat_w === undefined || !Number.isFinite(Number(row.heat_w))) continue;
    const starts = reported.get(row.room_key) ?? new Set<number>();
    starts.add(Date.parse(row.start_ts)); reported.set(row.room_key, starts);
  }
  const delayed = rooms.filter(room => (room.model?.heat_lag_h ?? 0) > 0 && reported.get(room.key)?.size)
    .map(room => ({ key: room.key, missing: quarters.filter(start => !reported.get(room.key)!.has(start)) }))
    .filter(room => room.missing.length);
  const holes = delayed.filter(room => room.missing.some(start => start < quarters.at(-LATE_HEAT_QUARTERS)!));
  for (const [code, group, message] of [
    ["room_heat_history_late", delayed.filter(room => !holes.includes(room)), "The latest room heating energy has not arrived yet."],
    ["room_heat_history_missing", holes, "Some room heating energy is missing."],
  ] as const) if (group.length) {
    snapshot.planning_warnings = mergePlanningWarnings(snapshot.planning_warnings, [planningWarning(code, "rooms", message,
      "Heat that has not been reported counts as none, so these rooms may be planned slightly colder than they are.",
      { rooms: group.map(room => room.key).sort().join(","), quarters: Math.max(...group.map(room => room.missing.length)) })]);
  }
  const recent = new Map(rooms.map(room => [room.key, quarters.map(start => heatByStart.get(room.key)?.get(start) ?? 0)]));
  const passiveRates = new Map<string, number[]>();
  for (const room of passiveRooms) {
    const source = passiveSources?.get(room.key);
    const model = room.passive_heat!;
    if (passiveSources && source?.device_key !== model.device_key) continue;
    const starts = quarters.map((_, i) => passiveStart + i * SLOT_MS);
    const missing = starts.filter(start => !source?.watts.has(start));
    if (missing.length) {
      const late = missing[0] >= passiveEnd - LATE_HEAT_QUARTERS * SLOT_MS;
      snapshot.planning_warnings = mergePlanningWarnings(snapshot.planning_warnings, [planningWarning(
        late ? "room_heat_history_late" : "room_passive_heat_history_missing", room.key,
        late ? `${room.name}: the latest monitored appliance readings have not arrived yet.` :
          `${room.name}: some monitored appliance readings are missing.`,
        "The forecast only counts appliance heat supported by received readings.", { quarters: missing.length })]);
    }
    if (source) passiveRates.set(room.key, passiveHeatRates(model, starts.map(start => source.watts.get(start) ?? 0),
      passiveEnd, captured, snapshot.slots.map(slot => slot.start)));
  }
  const { zones, warnings } = roomPlanningZones(snapshot, rooms, {
    schedules, temperature_c: temperature, recent_heat_w: recent, passive_heat_c_per_h: passiveRates,
  });
  // Silent degradation is worse than none, so what was skipped is said out loud.
  if (warnings.length > 0) {
    console.info(`[ENERGY-OPTIMISATION] ${warnings.length} of ${rooms.length} rooms not comfort-forecast: ` +
      warnings.map(warning => warning.message).join("; "));
  }
  return { ...snapshot, thermal_zones: zones, planning_warnings: mergePlanningWarnings(snapshot.planning_warnings, warnings) };
}
