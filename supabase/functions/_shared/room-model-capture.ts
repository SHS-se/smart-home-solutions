import { estimateRoomState, roomPlanClock, type RoomStateReading } from "./planner/models/room/state.ts";
import { readDoorwayProbes, type DoorwayProbeRow } from "./room-doorway-probes.ts";
import { doorwayBoundary, readRoomDoorwayModel, type RoomDoorwayModel } from "./planner/models/room/doorway-boundary.ts";
import { heatingWatts, isWeatherHeatingBinding, readWeatherHeating } from "./planner/weather-heating.ts";
/** Joins current room evidence with one model capture; never learns or schedules. */
import type { DeviceControlType, OptimisationSnapshot } from "./planner/planning-contracts.ts";
import type { DeviceModelBundle } from "./device-model-store.ts";
import type { PreparedRoom } from "./prepared-energy-forecasts.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { isEquilibrium, passiveHeatRates, storedRoomHeat, excludeUncontrolledRoomHeat } from "./planner/models/room/thermal.ts";
import { readPassiveHeatModel, readRoomPassiveHeat } from "./room-passive-heat-evidence.ts";
import { ROOM_HISTORY_QUARTER_MS as SLOT_MS, roomHistoryWarning } from "./room-history-warnings.ts";
import { readThermalModel } from "./planner/models/room/read-model.ts";
import { roomPlanningZones } from "./room-planning-zones.ts";
import { summerHeatingLockoutForStarts } from "./comfort-schedule.ts";
import { classifyOutdoorSeries } from "./outdoor-forecast.ts";
import { mergePlanningWarnings, planningWarning } from "./planner/planning-warnings.ts";
import { generalRoomFitWarnings, readRoomHeatingBands } from "./planner/heating-bands.ts";
import { roomResponse } from "./planner/room-response.ts";

/** Mapping has already been parsed at the transport boundary. */
export interface RoomDeviceMapping {
  key: string;
  control_type_override: DeviceControlType | null;
  room: { key: string; name: string } | null;
}
type RoomEvidenceDatabase = Pick<SupabaseClient, "rpc" | "from">;
/** A day of recorded heat supplies the existing delayed-heat initial condition. */
const RECENT_HEAT_QUARTERS = 24 * 4;

type CapturedRoom = PreparedRoom & { doorway?: RoomDoorwayModel };

interface RoomPlanningHistory {
  room_key: string;
  temperature_starts: number[];
  heater_quarters: [start: number, watts: number][];
  outdoor_quarters?: [start: number, temperature_c: number][];
}

const recentQuarterStarts = (end: number): number[] => Array.from(
  { length: RECENT_HEAT_QUARTERS }, (_, index) => end - (RECENT_HEAT_QUARTERS - index) * SLOT_MS,
);

export interface PreparedThermalPlanning {
  snapshot: OptimisationSnapshot;
  rooms: CapturedRoom[];
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
    if (device.control_type !== "setpoint" || device.planning_service === "pool" || !isWeatherHeatingBinding(binding)) return device;
    const mode = scope?.modes[scope.device_owners[device.key]];
    const row = weatherByDevice.get(device.key);
    const profile = row && readWeatherHeating(row.operating_points, binding);
    if (profile?.versioned && device.category !== "heating") return device;
    const useBand = device.category === "heating" && profile?.versioned && mode === "controlling";
    return profile && row && (useBand || mode === "control_verification")
      ? { ...device, weather_heating: { method: profile.method, binding: profile.binding, points: profile.points,
        ...(profile.reference ? { reference: profile.reference } : {}),
        ...(profile.versioned ? { banded: true } : {}), revision: row.model_revision } } : device;
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

  const fittedByRoom = new Map((bundle?.rooms ?? [])
    .map(model => [String(model.room_key), model]));

  // Current equipment joins the atomically captured model bundle. No device
  // capability or calibration is selected by the weather/price cache.
  const prepared: CapturedRoom[] = [];
  for (const room of rooms.values()) {
    const fitted = fittedByRoom.get(room.key);
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
        "The plan uses the running-power estimate for quarters outside the learned temperature range.")]);
      }
    }
    const attempt = fitted?.last_fit_attempt as { issues?: string[]; passive_heat?: { status?: string } } | undefined;
    const heatingContext = bundle?.roomHeating?.[room.key];
    const library = readRoomHeatingBands(fitted?.heating_bands);
    const compatible = !!heatingContext && library?.binding === heatingContext.binding;
    // One response for the whole forecast; a band never becomes a general
    // response unless it is a room's only accepted response during rollout.
    const response = compatible ? roomResponse(library!, outdoor) : null;
    // Without a response for the current binding, the trained scalar row is the
    // previous general response (a narrow band never becomes a general one).
    const legacyScalar = !response && library?.reference?.scope?.kind !== "band" && fitted?.trained
      ? readThermalModel(fitted) : null;
    const boundary = response?.legacy ? response : undefined;
    const passive = heatingContext ? undefined : readPassiveHeatModel(boundary ? boundary.passive_heat : fitted?.passive_heat);
    if (!passive && attempt?.passive_heat?.status === "awaiting_validation") {
      snapshot.planning_warnings = mergePlanningWarnings(snapshot.planning_warnings, [planningWarning(
        "room_passive_heat_learning", room.key, `${room.name}: monitored appliance heat is still being learned.`,
        "The room forecast uses the regular heater and temperature model until appliance heat is validated.")]);
    }
    if (attempt?.issues?.length) snapshot.planning_warnings = mergePlanningWarnings(snapshot.planning_warnings, [planningWarning(
      "room_model_quality", room.key, `${room.name}: ${attempt.issues.join(", ")}.`,
      "The latest usable thermal parameters remain available; comfort service continues.")]);
    const fittedModel = response?.model ?? legacyScalar;
    const model = fittedModel && heatingContext ? excludeUncontrolledRoomHeat(fittedModel) : fittedModel;
    if (response?.legacy) snapshot.planning_warnings = mergePlanningWarnings(snapshot.planning_warnings, [planningWarning(
      "room_heating_response_learning", room.key, `${room.name}: the shared room response is still being learned.`,
      "A previously accepted response is used at every forecast temperature until it publishes. Positive uncontrolled background heat is excluded.")]);
    else if (response && !response.supported) snapshot.planning_warnings = mergePlanningWarnings(snapshot.planning_warnings, [planningWarning(
      "room_heating_response_learning", room.key, `${room.name}: the shared room response is awaiting calibration evidence.`,
      "The accepted response remains available while learning continues. Positive uncontrolled background heat is excluded.")]);
    const modelWarnings = response ? response.warnings : generalRoomFitWarnings(attempt);
    if (heatingContext && library && !compatible && model) {
      snapshot.planning_warnings = mergePlanningWarnings(snapshot.planning_warnings, [planningWarning(
        "room_heating_response_learning", room.key, `${room.name}: heating sources changed.`,
        "The previous room response is used while the new heating setup is measured.")]);
    }
    const doorway = readRoomDoorwayModel(boundary ? boundary.doorway_exchange : heatingContext ? undefined : fitted?.doorway_exchange,
      model && !isEquilibrium(model) ? model.house_coupling_per_h ?? 0 : 0);
    prepared.push({ key: room.key, name: room.name, device_keys: room.models.map(m => m.key),
      model, rated_power_w: ratedPowerW,
      ...(model && modelWarnings?.length ? { model_warnings: modelWarnings } : {}),
      ...(model && response ? { model_source: response.source } : {}),
      ...(doorway ? { doorway } : {}),
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
  snapshot: OptimisationSnapshot, rooms: CapturedRoom[],
): Promise<OptimisationSnapshot> {
  if (rooms.length === 0) return { ...snapshot, thermal_zones: [] };
  const recentEnd = Math.floor(Date.parse(snapshot.captured_at) / SLOT_MS) * SLOT_MS;
  const quarters = recentQuarterStarts(recentEnd);
  const delayedRooms = rooms.filter(room => (room.model?.heat_lag_h ?? 0) > 0);
  const dynamicRooms = rooms.filter(room => room.model && !isEquilibrium(room.model));
  const captured = Date.parse(snapshot.captured_at);
  const passiveEnd = Math.floor(captured / SLOT_MS) * SLOT_MS;
  const passiveQuarters = recentQuarterStarts(passiveEnd);
  const passiveRooms = rooms.filter(room => room.passive_heat);
  const doorwayRooms = rooms.filter(room => room.doorway);
  const [latestResult, scheduleResult, recentResult, passiveSources, doorwayProbes] = await Promise.all([
    // Available observations remain evidence independently of their report age.
    supabase.rpc("get_energy_latest_room_temperatures", {
      p_customer_id: customerId, p_home_id: homeId, p_from: "1970-01-01T00:00:00.000Z",
    }),
    supabase
      .from("energy_optimisation_comfort_schedules")
      .select("room_key, weekday_modes, weekend_modes, off_temperature_c, low_temperature_c, high_temperature_c")
      .eq("home_id", homeId),
    // Every dynamic room needs the observation interval and elapsed inputs.
    dynamicRooms.length
      ? supabase.rpc("get_energy_room_planning_history", {
        p_customer_id: customerId, p_home_id: homeId,
        p_room_keys: dynamicRooms.map(room => room.key),
        p_from: new Date(quarters[0]).toISOString(), p_to: new Date(recentEnd).toISOString(),
      })
      : Promise.resolve({ data: [], error: null }),
    passiveRooms.length
      ? readRoomPassiveHeat(supabase, customerId, homeId, passiveRooms.map(room => room.key),
        new Date(passiveQuarters[0]).toISOString(), new Date(passiveEnd).toISOString()).catch(error => {
          console.error("[ENERGY-OPTIMISATION] monitored room heat unavailable", error);
          return null;
        })
      : null,
    doorwayRooms.length
      ? readDoorwayProbes(supabase, homeId, doorwayRooms.map(room => room.key), null, new Date(passiveEnd).toISOString()).catch(error => {
          console.error("[ENERGY-OPTIMISATION] doorway probe evidence unavailable", error);
          return null;
        })
      : Promise.resolve<DoorwayProbeRow[]>([]),
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
  const observations = new Map<string, RoomStateReading>();
  for (const row of latestResult.data ?? []) {
    const value = Number(row.room_temperature_c);
    if (!temperature.has(row.room_key) && row.room_temperature_c !== null && Number.isFinite(value)) {
      temperature.set(row.room_key, value);
      const start = Date.parse(row.start_ts);
      if (Number.isFinite(start)) observations.set(row.room_key, { start_ms: start, end_ms: start + SLOT_MS, mean_c: value });
    }
  }
  const schedules = new Map<string, unknown>((scheduleResult.data ?? []).map((row: Record<string, unknown>) => [row.room_key as string, {
    weekday_modes: row.weekday_modes, weekend_modes: row.weekend_modes,
    off_temperature_c: Number(row.off_temperature_c), low_temperature_c: Number(row.low_temperature_c),
    high_temperature_c: Number(row.high_temperature_c),
  }]));
  let history = (recentResult.data ?? []) as RoomPlanningHistory[];
  // A stale thermometer is still evidence. Extend only when its observation is
  // outside the normal read; age never disqualifies a room or means idle time.
  const oldest = Math.min(quarters[0], ...dynamicRooms.flatMap(room => {
    const reading = observations.get(room.key);
    return reading && reading.start_ms < quarters[0] ? [reading.start_ms - RECENT_HEAT_QUARTERS * SLOT_MS] : [];
  }));
  if (oldest < quarters[0]) {
    const extended = await supabase.rpc("get_energy_room_planning_history", {
      p_customer_id: customerId, p_home_id: homeId, p_room_keys: dynamicRooms.map(room => room.key),
      p_from: new Date(oldest).toISOString(), p_to: new Date(recentEnd).toISOString(),
    });
    if (!extended.error) history = extended.data ?? [];
    else snapshot.planning_warnings = mergePlanningWarnings(snapshot.planning_warnings, [planningWarning(
      "room_evidence_unavailable", "rooms", "Some elapsed room inputs could not be read.",
      "Room state estimates retain received inputs and exclude unobserved heater warmth.")]);
  }
  const historyByRoom = new Map(history.map(row => [row.room_key, row]));
  const recent = new Map<string, number[]>();
  const stored = new Map<string, number>();
  const historyWarnings: ReturnType<typeof planningWarning>[] = [];
  for (const room of delayedRooms) {
    const readings = historyByRoom.get(room.key);
    // A failed read already has its database warning; an empty successful read
    // is missing observation coverage and still needs the room-specific note.
    if (!readings && recentResult.error) continue;
    const temperatureStarts = new Set(readings?.temperature_starts ?? []);
    const heaterWatts = new Map(readings?.heater_quarters ?? []);
    const outdoor = new Map(readings?.outdoor_quarters ?? []);
    recent.set(room.key, quarters.map(start => heaterWatts.get(start) ?? 0));
    const heat = room.model ? storedRoomHeat(room.model, quarters.map(start => ({
      watts: heaterWatts.get(start) ?? null, outdoor_c: outdoor.get(start) ?? null,
    }))) : 0;
    stored.set(room.key, heat);

    const warning = roomHistoryWarning(room, "room_heat_history_missing", quarters, [
      { label: "Room temperature", observed: temperatureStarts },
      { label: "Heater energy", observed: heaterWatts },
      ...((room.model?.gain_outdoor_slope_per_c ?? 0) !== 0 ? [{ label: "Outdoor temperature", observed: outdoor }] : []),
    ], "The forecast counts measured heater energy and bounds remaining warmth where room or weather readings are missing.", snapshot.timezone);
    if (warning) historyWarnings.push(warning);
  }
  const clock = roomPlanClock(snapshot);
  const initializedRooms = rooms.map(room => {
    if (!room.model || isEquilibrium(room.model)) return room;
    const reading = observations.get(room.key);
    const outdoor = snapshot.outdoor_temperature_c?.find((v): v is number => typeof v === "number" && Number.isFinite(v));
    const house = snapshot.house_temperature_c?.find((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (!reading || outdoor === undefined || ((room.model.house_coupling_per_h ?? 0) > 0 && house === undefined)) {
      return { ...room, model: null };
    }
    try {
      const source = historyByRoom.get(room.key);
      const power = new Map(source?.heater_quarters ?? []);
      const weather = new Map(source?.outdoor_quarters ?? []);
      const starts = [...new Set([...power.keys(), ...weather.keys()])].sort((a, b) => a - b);
      const state = estimateRoomState(room.model, { reading,
        intervals: starts.map(start => ({ start_ms: start, end_ms: start + SLOT_MS,
          heater_w: power.get(start) ?? null, outdoor_c: weather.get(start) ?? null })),
        fallback: { outdoor_c: outdoor, house_c: house ?? 0, solar_w_per_m2: 0 },
      }, clock.start_ms);
      temperature.set(room.key, state.temperature_c);
      stored.set(room.key, state.stored_heat_c);
      if (state.missing_power.length && !historyWarnings.some(w => w.scope === room.key && (w.code === "room_heat_history_missing" || w.code === "room_heat_history_late"))) {
        const older = state.missing_power.some(span => span.start_ms < recentEnd - 2 * SLOT_MS);
        historyWarnings.push(planningWarning(older ? "room_heat_history_missing" : "room_heat_history_late", room.key,
          `${room.name}: the capture temperature is estimated from its latest measured interval.`,
          "Received heater energy is retained; unreceived energy contributes no assumed warmth.",
          { observed_through: new Date(state.observed_through).toISOString(), intervals: JSON.stringify(state.missing_power) }));
      }
      if (state.estimated_boundary.length) historyWarnings.push(planningWarning(state.estimated_boundary.some(span => span.start_ms < recentEnd - 2 * SLOT_MS) ? "room_state_boundary_estimate" : "room_state_boundary_late", room.key,
        `${room.name}: elapsed room conditions are estimated.`,
        "The capture state uses received outdoor history and available forecast boundaries; unmeasured solar heat receives no credit.",
        { observed_through: new Date(state.observed_through).toISOString(), intervals: JSON.stringify(state.estimated_boundary) }));
      return room;
    } catch (error) {
      historyWarnings.push(planningWarning("room_evidence_unavailable", room.key,
        `${room.name}: the capture state could not be estimated from its room evidence.`,
        "Comfort commands and measured electrical demand remain active.",
        { reason: error instanceof Error ? error.message : String(error) }));
      return { ...room, model: null };
    }
  });
  const passiveRates = new Map<string, number[]>();
  for (const room of passiveRooms) {
    const source = passiveSources?.get(room.key);
    const model = room.passive_heat!;
    if (passiveSources && source?.device_key !== model.device_key) continue;
    if (!source) {
      historyWarnings.push(planningWarning("room_evidence_unavailable", room.key,
        `Monitored appliance energy for ${room.name} could not be read.`,
        "The forecast only counts appliance heat supported by received readings."));
      continue;
    }
    const warning = roomHistoryWarning(room, "room_passive_heat_history_missing", passiveQuarters, [
      { label: "Monitored appliance energy", observed: source.watts },
    ], "The forecast only counts appliance heat supported by received readings.", snapshot.timezone);
    if (warning) historyWarnings.push(warning);
    passiveRates.set(room.key, passiveHeatRates(model, passiveQuarters.map(start => source.watts.get(start) ?? 0),
      passiveEnd, captured, snapshot.slots.map(slot => slot.start)));
  }
  const doorwayBoundaries = new Map<string, number[]>();
  const houseForecast = snapshot.house_temperature_c;
  if (houseForecast?.length === snapshot.slots.length &&
      houseForecast.every((c): c is number => typeof c === "number" && Number.isFinite(c))) {
    const slots = snapshot.slots.map(slot => Date.parse(slot.start));
    for (const room of doorwayRooms) {
      const result = doorwayProbes && room.model && !isEquilibrium(room.model) && doorwayBoundary(room.doorway!, room.model.house_coupling_per_h!,
        doorwayProbes.filter(probe => probe.room_key === room.key), houseForecast, slots, captured);
      if (result && result.temperatures) doorwayBoundaries.set(room.key, result.temperatures);
      if (!result || result.incomplete) historyWarnings.push(planningWarning("room_evidence_unavailable", room.key,
        `Some connected-room measurements for ${room.name} are unavailable.`,
        "The forecast estimates exchange from the available room and house temperatures."));
    }
  }
  const { zones, warnings } = roomPlanningZones(snapshot, initializedRooms, {
    schedules, temperature_c: temperature, temperature_observation: observations, recent_heat_w: recent, stored_heat_c: stored, passive_heat_c_per_h: passiveRates, doorway_boundary_c: doorwayBoundaries,
  });
  // Silent degradation is worse than none, so what was skipped is said out loud.
  if (warnings.length > 0) {
    console.info(`[ENERGY-OPTIMISATION] ${warnings.length} of ${rooms.length} rooms not comfort-forecast: ` +
      warnings.map(warning => warning.message).join("; "));
  }
  return { ...snapshot, thermal_zones: zones, planning_warnings: mergePlanningWarnings(snapshot.planning_warnings, historyWarnings, warnings) };
}
