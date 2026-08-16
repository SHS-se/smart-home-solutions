// Device-authenticated exchange for the live 15-minute energy model.
//
// Home Assistant sends only completed quarter-hour aggregates and, at most
// hourly, one rolling forecast snapshot. Raw recorder samples never cross this
// boundary. The large plan is overwritten per home; only compact run summaries
// are appended and both histories have explicit retention.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { authenticateDevice, sha256Hex } from "../_shared/ha-device-auth.ts";
import {
  type DeviceControlType,
  type DeviceLoadType,
  type DevicePlanningRole,
  generateOptimisationPlan,
  type OptimisationSnapshotV5,
} from "../_shared/energy-optimisation.ts";
import {
  buildPriceShape,
  type PriceShape,
} from "../_shared/energy-price-shape.ts";
import {
  buildThermalProjection,
  fitZones,
  type ProjectionZoneInput,
  REFIT_INTERVAL_HOURS,
  type ThermalMomentRow,
  TRAINING_WINDOW_DAYS,
  zoneModelRows,
} from "../_shared/thermal-training.ts";
import {
  buildComfortForecast,
  isZoneComfortSchedule,
  summerHeatingLockoutForStarts,
  type ZoneComfortSchedule,
} from "../_shared/comfort-schedule.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const MAX_ACTUAL_SLOTS_PER_PUSH = 288;
const MAX_THERMAL_SLOTS_PER_PUSH = 288;
// A price row is four numbers, so a backfill sweeping weeks of history costs
// far less per slot than an actual does. The cap is what keeps one push inside
// MAX_REQUEST_BYTES, not a statement about how much history is reasonable.
const MAX_PRICE_SLOTS_PER_PUSH = 2_880;
const MAX_DEVICES_PER_PUSH = 100;
const MAX_QUARTER_KWH = 100;
// No published Swedish tariff reaches this. The bound rejects a unit error —
// öre sent as SEK, say — while leaving the negative spot prices that genuinely
// occur alone.
const MAX_PRICE_SEK_PER_KWH = 100;
// How much archive the price shape is fitted over. Long enough to average out
// weather and single-day spikes, short enough that a tariff or supplier change
// works its way out within a season.
const PRICE_SHAPE_WINDOW_DAYS = 60;
const MAX_REQUEST_BYTES = 2_000_000;
const SLOT_MS = 15 * 60_000;
const ACTUAL_AGGREGATION = "sum_of_recorder_5minute_changes";
// Physically possible room and outdoor extremes. These reject a sensor
// reporting in Fahrenheit or a unit-less counter, not merely odd weather.
const MIN_ROOM_C = -50;
const MAX_ROOM_C = 80;
type DeviceMappingStatus = "not_configured" | "ready" | "invalid";

interface IncomingZoneObservation {
  room_temperature_c: number;
  actuator_duty: number;
  cooling_duty?: number | null;
  comfort_min_c?: number | null;
  comfort_max_c?: number | null;
  setpoint_c?: number | null;
}

interface IncomingThermalSlot {
  start: string;
  outdoor_temperature_c?: number | null;
  zone_observations: Record<string, IncomingZoneObservation>;
  quality?: Record<string, unknown>;
}

interface IncomingActualSlot {
  start: string;
  total_load_kwh?: number | null;
  solar_production_kwh?: number | null;
  grid_import_kwh?: number | null;
  grid_export_kwh?: number | null;
  pool_heating_kwh?: number | null;
  hot_water_kwh?: number | null;
  ev_charging_kwh?: number | null;
  battery_charge_kwh?: number | null;
  battery_discharge_kwh?: number | null;
  device_energy_kwh?: Record<string, number>;
  quality?: Record<string, unknown>;
}

/**
 * All-in marginal price for one quarter (ENERGY_OPTIMISATION_ARCHITECTURE.md
 * §1.3.7.2). Separate from the actual slot because a price exists for future
 * quarters that have no measurement, and because a backfill reaches far further
 * back than the eight days the actual-slot watermark allows.
 */
interface IncomingPriceSlot {
  start: string;
  import_price_sek_per_kwh: number;
  export_price_sek_per_kwh: number;
}

interface IncomingDevice {
  key: string;
  statistic_id: string;
  name: string;
  category: string;
  suggested_load_type: DeviceLoadType;
  suggested_planning_role: DevicePlanningRole;
  suggested_control_type: DeviceControlType | null;
  active_power_w: number | null;
  profile_sample_count: number;
  inference: Record<string, unknown>;
  mapping_status: DeviceMappingStatus;
  mapped_control_type: DeviceControlType | null;
  mapping_error: string | null;
  mapping_summary: Record<string, unknown>;
}

interface StoredDevice extends IncomingDevice {
  id: string;
  load_type_override: DeviceLoadType;
  planning_role_override: DevicePlanningRole;
  control_type_override: DeviceControlType | null;
}

interface RoomMapping {
  key: string;
  name: string;
  controlled_devices: string[];
}

const hasRoomMappingMetadata = (
  device: Pick<IncomingDevice, "mapping_summary">,
) => {
  const summary = device.mapping_summary;
  return !!summary && typeof summary === "object" && !Array.isArray(summary) &&
    ["room_key", "room_name", "controlled_devices"].some((key) =>
      Object.prototype.hasOwnProperty.call(summary, key)
    );
};

const roomMapping = (
  device: Pick<IncomingDevice, "mapping_status" | "mapped_control_type" | "mapping_summary">,
): RoomMapping | null => {
  if (
    device.mapping_status !== "ready" ||
    !["setpoint", "switch_schedule"].includes(device.mapped_control_type ?? "")
  ) return null;
  const key = device.mapping_summary.room_key;
  const name = device.mapping_summary.room_name;
  const controlled = device.mapping_summary.controlled_devices;
  if (
    typeof key !== "string" || key.length < 1 || key.length > 255 ||
    typeof name !== "string" || name.length < 1 || name.length > 255 ||
    !Array.isArray(controlled) || controlled.length === 0 ||
    controlled.some((value) =>
      typeof value !== "string" || value.length < 1 || value.length > 255
    )
  ) return null;
  return { key, name, controlled_devices: [...new Set(controlled)] };
};

const effectivePlanning = (device: StoredDevice) => ({
  planning_role: device.planning_role_override,
  control_type: device.control_type_override,
});

const STORED_DEVICE_COLUMNS =
  "id, device_key, statistic_id, name, category, suggested_load_type, load_type_override, suggested_planning_role, planning_role_override, suggested_control_type, control_type_override, active_power_w, profile_sample_count, inference, mapping_status, mapped_control_type, mapping_error, mapping_summary";

const storedDeviceFromRow = (row: Record<string, unknown>): StoredDevice => ({
  id: row.id as string,
  key: row.device_key as string,
  statistic_id: row.statistic_id as string,
  name: row.name as string,
  category: row.category as string,
  suggested_load_type: row.suggested_load_type as DeviceLoadType,
  load_type_override: row.load_type_override as DeviceLoadType,
  suggested_planning_role: row.suggested_planning_role as DevicePlanningRole,
  planning_role_override: row.planning_role_override as DevicePlanningRole,
  suggested_control_type: row.suggested_control_type as DeviceControlType | null,
  control_type_override: row.control_type_override as DeviceControlType | null,
  active_power_w: row.active_power_w === null
    ? null
    : Number(row.active_power_w),
  profile_sample_count: Number(row.profile_sample_count),
  inference: row.inference as Record<string, unknown>,
  mapping_status: row.mapping_status as DeviceMappingStatus,
  mapped_control_type: row.mapped_control_type as DeviceControlType | null,
  mapping_error: row.mapping_error as string | null,
  mapping_summary: row.mapping_summary as Record<string, unknown>,
});

const ENERGY_FIELDS = [
  "total_load_kwh",
  "solar_production_kwh",
  "grid_import_kwh",
  "grid_export_kwh",
  "pool_heating_kwh",
  "hot_water_kwh",
  "ev_charging_kwh",
  "battery_charge_kwh",
  "battery_discharge_kwh",
] as const;

// Measured state of charge, sent as fractions. Kept apart from the energy
// fields because they are levels rather than quantities: they are bounded 0..1
// and a slot carrying only a battery level has measured no energy at all.
const FRACTION_FIELDS = ["battery_soc", "ev_soc"] as const;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const round = (value: number, decimals = 6) => {
  const multiplier = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
};

const compactPlanSummary = (
  plan: ReturnType<typeof generateOptimisationPlan>,
) => ({
  binding_until: plan.binding_until,
  valid_until: plan.valid_until,
  policy: plan.policy,
  sources: plan.sources,
  pv_calibration: plan.pv_calibration,
  battery: plan.battery,
  grid: plan.grid,
  services: plan.services,
  device_models: plan.device_models.map((model) => ({
    key: model.key,
    name: model.name,
    statistic_id: model.statistic_id,
    category: model.category,
    suggested_load_type: model.suggested_load_type,
    load_type: model.load_type,
    planning_role: model.planning_role,
    control_type: model.control_type,
    active_power_w: model.active_power_w,
    profile_sample_count: model.profile_sample_count,
    forecast_method: model.forecast_method,
  })),
  service_requirement_sample_days: plan.service_requirement_sample_days,
  plans: Object.fromEntries(
    Object.entries(plan.plans).map(([key, value]) => [key, {
      status: value.status,
      validation_errors: value.validation_errors,
      summary: value.summary,
      service_slots: value.service_slots,
      service_currents_a: value.service_currents_a,
      service_inhibited_slots: value.service_inhibited_slots,
    }]),
  ),
});

interface PreparedThermalPlanning {
  snapshot: OptimisationSnapshotV5;
  zones: ProjectionZoneInput[];
}

/**
 * Replace every mapped room control's recent-history profile with the demand
 * implied by its portal comfort routine, season, outdoor forecast, latest
 * measured temperature and fitted 1R1C model.
 *
 * This is deliberately fail-fast. Once a device is opted into room
 * planning, an empirical Tuesday cannot silently take over when any thermal
 * input is missing; that was the unsafe behaviour this model replaces.
 */
async function prepareThermalPlanning(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  customerId: string,
  homeId: string,
  snapshot: OptimisationSnapshotV5,
  storedDevices: StoredDevice[],
): Promise<PreparedThermalPlanning> {
  const storedByKey = new Map(storedDevices.map((device) => [device.key, device]));
  const roomModels = snapshot.device_models.filter((model) => {
    if (model.control_type === "setpoint") return true;
    if (model.control_type !== "switch_schedule") return false;
    const stored = storedByKey.get(model.key);
    return stored?.control_type_override === model.control_type &&
      roomMapping(stored) !== null;
  });
  if (roomModels.length === 0) {
    return {
      snapshot: {
        ...snapshot,
        device_models: snapshot.device_models.map((model) => ({
          ...model,
          forecast_method: model.forecast_method ?? "empirical_recent_history",
        })),
        thermal_zones: [],
      },
      zones: [],
    };
  }

  const rooms = new Map<string, {
    key: string;
    name: string;
    models: typeof roomModels;
  }>();
  for (const model of roomModels) {
    const stored = storedByKey.get(model.key);
    const room = stored ? roomMapping(stored) : null;
    if (!stored || !room) {
      throw new Error(`${model.name}: a ready Home Assistant room mapping is required`);
    }
    const grouped = rooms.get(room.key) ?? {
      key: room.key,
      name: room.name,
      models: [],
    };
    if (grouped.name !== room.name) {
      throw new Error(`${room.key}: Home Assistant reported two room names`);
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
      zones: [],
    };
  }

  const outdoor = snapshot.outdoor_temperature_c;
  if (
    !outdoor || outdoor.length !== snapshot.slots.length ||
    outdoor.some((value) => value === null || !Number.isFinite(value))
  ) {
    throw new Error(
      "room comfort forecasting needs outdoor temperature for every slot",
    );
  }

  const now = Date.now();
  const { data: existing } = await supabase
    .from("energy_optimisation_zone_models")
    .select("room_key, fitted_at")
    .eq("home_id", homeId)
    .order("fitted_at", { ascending: false })
    .limit(1);
  const lastFit = existing?.[0]?.fitted_at
    ? Date.parse(existing[0].fitted_at)
    : 0;

  if (now - lastFit > REFIT_INTERVAL_HOURS * 3_600_000) {
    const trainingFrom = new Date(
      now - TRAINING_WINDOW_DAYS * 86_400_000,
    ).toISOString();
    const trainingTo = new Date(now).toISOString();
    const { data: moments, error } = await supabase.rpc(
      "get_energy_thermal_training_moments",
      {
        p_customer_id: customerId,
        p_home_id: homeId,
        p_from: trainingFrom,
        p_to: trainingTo,
      },
    );
    if (error) throw error;
    const fits = fitZones((moments ?? []) as ThermalMomentRow[]);
    if (fits.length > 0) {
      const { error: upsertError } = await supabase
        .from("energy_optimisation_zone_models")
        .upsert(
          zoneModelRows(fits, { customerId, homeId, trainingFrom, trainingTo }),
          { onConflict: "home_id,room_key" },
        );
      if (upsertError) throw upsertError;
    }
  }

  const [trainedResult, latestResult, scheduleResult] = await Promise.all([
    supabase
      .from("energy_optimisation_zone_models")
      .select(
        "room_key, room_name, gain_c_per_wh, cooling_constant_per_h, background_gain_c_per_h, thermal_capacity_wh_per_c, heat_loss_w_per_c, time_constant_h, heating_rate_c_per_h, r2, residual_std_c, sample_count",
      )
      .eq("home_id", homeId)
      .eq("trained", true),
    // The trajectory starts from a real room reading no more than six hours
    // old. A guessed midpoint would describe a different house.
    supabase
      .from("energy_optimisation_thermal_slots")
      .select("room_key, room_temperature_c, start_ts")
      .eq("home_id", homeId)
      .gte("start_ts", new Date(now - 6 * 3_600_000).toISOString())
      .order("start_ts", { ascending: false }),
    supabase
      .from("energy_optimisation_comfort_schedules")
      .select(
        "room_key, room_name, weekday_modes, weekend_modes, off_temperature_c, low_temperature_c, high_temperature_c",
      )
      .eq("home_id", homeId),
  ]);
  for (const result of [
    trainedResult,
    latestResult,
    scheduleResult,
  ]) {
    if (result.error) throw result.error;
  }

  const trainedByRoom = new Map<string, Record<string, unknown>>(
    (trainedResult.data ?? []).map((model: Record<string, unknown>) => [
      model.room_key as string,
      model,
    ] as const),
  );
  const latestByRoom = new Map<string, Record<string, unknown>>();
  for (const row of latestResult.data ?? []) {
    if (!latestByRoom.has(row.room_key)) latestByRoom.set(row.room_key, row);
  }
  const scheduleByRoom = new Map<string, Record<string, unknown>>(
    (scheduleResult.data ?? []).map((schedule: Record<string, unknown>) => [
      schedule.room_key as string,
      schedule,
    ] as const),
  );
  const forecasts = new Map<string, number[]>();

  const zones: ProjectionZoneInput[] = [];
  const planningZones: NonNullable<OptimisationSnapshotV5["thermal_zones"]> = [];
  for (const room of rooms.values()) {
    const fitted = trainedByRoom.get(room.key);
    if (!fitted) {
      throw new Error(`${room.name}: no trained thermal model is available`);
    }
    const observation = latestByRoom.get(room.key);
    if (!observation || !Number.isFinite(Number(observation.room_temperature_c))) {
      throw new Error(`${room.name}: no recent room temperature is available`);
    }
    const rawSchedule = scheduleByRoom.get(room.key);
    const schedule: ZoneComfortSchedule | null = rawSchedule
      ? {
        weekday_modes: rawSchedule.weekday_modes as ZoneComfortSchedule["weekday_modes"],
        weekend_modes: rawSchedule.weekend_modes as ZoneComfortSchedule["weekend_modes"],
        off_temperature_c: Number(rawSchedule.off_temperature_c),
        low_temperature_c: Number(rawSchedule.low_temperature_c),
        high_temperature_c: Number(rawSchedule.high_temperature_c),
      }
      : null;
    if (!isZoneComfortSchedule(schedule)) {
      throw new Error(`${room.name}: comfort schedule is missing or invalid`);
    }
    const ratedPowerW = room.models.reduce(
      (sum, model) => sum + Number(model.active_power_w ?? 0),
      0,
    );
    if (!Number.isFinite(ratedPowerW) || ratedPowerW <= 0) {
      throw new Error(`${room.name}: rated power is unavailable`);
    }
    const thermalModel = {
      gain_c_per_wh: Number(fitted.gain_c_per_wh),
      cooling_constant_per_h: Number(fitted.cooling_constant_per_h),
      background_gain_c_per_h: Number(fitted.background_gain_c_per_h),
      thermal_capacity_wh_per_c: Number(fitted.thermal_capacity_wh_per_c),
      heat_loss_w_per_c: Number(fitted.heat_loss_w_per_c),
      time_constant_h: Number(fitted.time_constant_h),
      heating_rate_c_per_h: fitted.heating_rate_c_per_h === null
        ? null
        : Number(fitted.heating_rate_c_per_h),
      r2: Number(fitted.r2),
      sample_count: Number(fitted.sample_count),
      residual_std_c: Number(fitted.residual_std_c),
    };
    if (Object.entries(thermalModel).some(([key, value]) =>
      key !== "heating_rate_c_per_h" && !Number.isFinite(value)
    )) {
      throw new Error(`${room.name}: fitted thermal model is incomplete`);
    }
    const forecast = buildComfortForecast(
      starts,
      snapshot.timezone,
      schedule,
      thermalModel,
      Number(observation.room_temperature_c),
      outdoor as number[],
      ratedPowerW,
      summerLockout,
    );
    for (const model of room.models) {
      const share = (model.active_power_w ?? 0) / ratedPowerW;
      forecasts.set(model.key, forecast.power_w.map((watts) => watts * share));
    }
    zones.push({
      key: room.key,
      name: room.name,
      model: thermalModel,
      start_temperature_c: Number(observation.room_temperature_c),
      rated_power_w: ratedPowerW,
      comfort_min_c: forecast.comfort_min_c,
      target_c: forecast.target_c,
      comfort_max_c: forecast.comfort_max_c,
      planned_power_w: forecast.power_w,
      unplanned_power_w: forecast.power_w,
    });
    planningZones.push({
      key: room.key,
      name: room.name,
      device_keys: room.models.map((model) => model.key),
      model: thermalModel,
      start_temperature_c: Number(observation.room_temperature_c),
      rated_power_w: ratedPowerW,
      comfort_min_c: forecast.comfort_min_c,
      target_c: forecast.target_c,
      comfort_max_c: forecast.comfort_max_c,
      maximum_power_w_by_slot: summerLockout.map((locked) =>
        locked ? 0 : ratedPowerW
      ),
      unplanned_power_w: forecast.power_w,
    });
  }

  return {
    snapshot: {
      ...snapshot,
      device_models: snapshot.device_models.map((model) => ({
        ...model,
        forecast_method: forecasts.has(model.key)
          ? "thermal_comfort_schedule_v1"
          : model.forecast_method ?? "empirical_recent_history",
        forecast_w_by_slot: forecasts.get(model.key) ?? model.forecast_w_by_slot,
      })),
      thermal_zones: planningZones,
    },
    zones,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  try {
    const auth = await authenticateDevice(supabase, req);
    if (auth.ok === false) return json({ error: auth.error }, auth.status);
    if (!auth.subscriptionActive) {
      return json({ error: "subscription_inactive" }, 402);
    }

    let actuals: IncomingActualSlot[] = [];
    let prices: IncomingPriceSlot[] = [];
    let devices: IncomingDevice[] = [];
    let thermals: IncomingThermalSlot[] = [];
    let snapshot: OptimisationSnapshotV5 | null = null;
    let deviceInventoryComplete = false;
    try {
      const declaredLength = Number(req.headers.get("content-length") ?? 0);
      if (declaredLength > MAX_REQUEST_BYTES) {
        return json({ error: "request_too_large" }, 413);
      }
      const rawBody = await req.text();
      if (new TextEncoder().encode(rawBody).byteLength > MAX_REQUEST_BYTES) {
        return json({ error: "request_too_large" }, 413);
      }
      const body = JSON.parse(rawBody);
      if (!body || typeof body !== "object") throw new Error("body");
      if (
        body.actual_slots !== undefined && !Array.isArray(body.actual_slots)
      ) {
        throw new Error("actual_slots");
      }
      if (
        body.snapshot !== undefined &&
        (body.snapshot === null || typeof body.snapshot !== "object")
      ) {
        throw new Error("snapshot");
      }
      if (body.devices !== undefined && !Array.isArray(body.devices)) {
        throw new Error("devices");
      }
      if (
        body.thermal_slots !== undefined && !Array.isArray(body.thermal_slots)
      ) {
        throw new Error("thermal_slots");
      }
      if (body.price_slots !== undefined && !Array.isArray(body.price_slots)) {
        throw new Error("price_slots");
      }
      if (
        body.device_inventory_complete !== undefined &&
        typeof body.device_inventory_complete !== "boolean"
      ) {
        throw new Error("device_inventory_complete");
      }
      actuals = body.actual_slots ?? [];
      prices = body.price_slots ?? [];
      devices = body.devices ?? [];
      thermals = body.thermal_slots ?? [];
      snapshot = body.snapshot ?? null;
      deviceInventoryComplete = body.device_inventory_complete ?? false;
    } catch {
      return json({ error: "invalid_body" }, 400);
    }
    if (
      actuals.length === 0 && snapshot === null && devices.length === 0 &&
      thermals.length === 0 && prices.length === 0 && !deviceInventoryComplete
    ) {
      return json({ error: "empty_body" }, 400);
    }
    if (thermals.length > MAX_THERMAL_SLOTS_PER_PUSH) {
      return json({ error: "too_many_thermal_slots" }, 400);
    }
    if (actuals.length > MAX_ACTUAL_SLOTS_PER_PUSH) {
      return json({ error: "too_many_actual_slots" }, 400);
    }
    if (prices.length > MAX_PRICE_SLOTS_PER_PUSH) {
      return json({ error: "too_many_price_slots" }, 400);
    }
    if (devices.length > MAX_DEVICES_PER_PUSH) {
      return json({ error: "too_many_devices" }, 400);
    }

    const loadTypes = new Set<DeviceLoadType>([
      "fixed_full_load",
      "variable_full_load",
      "duty_cycle",
      "inverter",
    ]);
    const planningRoles = new Set<DevicePlanningRole>([
      "base_load",
      "controllable",
    ]);
    const controlTypes = new Set<DeviceControlType>([
      "switch_schedule",
      "variable_power",
      "permit_inhibit",
      "setpoint",
    ]);
    const mappingStatuses = new Set<DeviceMappingStatus>([
      "not_configured",
      "ready",
      "invalid",
    ]);
    const deviceCategories = new Set([
      "heating",
      "hot_water",
      "cooling",
      "property_energy",
      "pool_heating",
      "ev_charging",
      "household",
    ]);
    const deviceKeys = new Set<string>();
    const deviceRows: Record<string, unknown>[] = [];
    for (const [index, device] of devices.entries()) {
      if (
        typeof device?.key !== "string" || device.key.length < 1 ||
        device.key.length > 255 || deviceKeys.has(device.key) ||
        typeof device.statistic_id !== "string" ||
        device.statistic_id.length < 1 || device.statistic_id.length > 255 ||
        typeof device.name !== "string" || device.name.length < 1 ||
        device.name.length > 255 || !deviceCategories.has(device.category) ||
        !loadTypes.has(device.suggested_load_type) ||
        !planningRoles.has(device.suggested_planning_role) ||
        (device.suggested_planning_role === "base_load"
          ? device.suggested_control_type !== null
          : !controlTypes.has(
            device.suggested_control_type as DeviceControlType,
          )) ||
        (device.active_power_w !== null &&
          (typeof device.active_power_w !== "number" ||
            !Number.isFinite(device.active_power_w) ||
            device.active_power_w < 0 || device.active_power_w > 100_000)) ||
        !Number.isInteger(device.profile_sample_count) ||
        device.profile_sample_count < 0 ||
        !device.inference || typeof device.inference !== "object" ||
        Array.isArray(device.inference) ||
        !mappingStatuses.has(device.mapping_status) ||
        (device.mapping_status === "not_configured" &&
          (device.mapped_control_type !== null ||
            device.mapping_error !== null)) ||
        (device.mapping_status === "ready" &&
          (!controlTypes.has(device.mapped_control_type as DeviceControlType) ||
            device.mapping_error !== null ||
            ((device.mapped_control_type === "setpoint" ||
                hasRoomMappingMetadata(device)) &&
              roomMapping(device) === null))) ||
        (device.mapping_status === "invalid" &&
          (!controlTypes.has(device.mapped_control_type as DeviceControlType) ||
            typeof device.mapping_error !== "string" ||
            device.mapping_error.length < 1 ||
            device.mapping_error.length > 1000)) ||
        !device.mapping_summary || typeof device.mapping_summary !== "object" ||
        Array.isArray(device.mapping_summary)
      ) {
        return json(
          { error: "invalid_device", detail: `devices[${index}]` },
          400,
        );
      }
      deviceKeys.add(device.key);
      deviceRows.push({
        customer_id: auth.customerId,
        home_id: auth.homeId,
        device_key: device.key,
        statistic_id: device.statistic_id,
        name: device.name,
        category: device.category,
        suggested_load_type: device.suggested_load_type,
        suggested_planning_role: device.suggested_planning_role,
        suggested_control_type: device.suggested_control_type,
        active_power_w: device.active_power_w,
        profile_sample_count: device.profile_sample_count,
        inference: device.inference,
        mapping_status: device.mapping_status,
        mapped_control_type: device.mapped_control_type,
        mapping_error: device.mapping_error,
        mapping_summary: device.mapping_summary,
        mapping_reported_at: new Date().toISOString(),
        device_token_id: auth.tokenId,
        last_seen_at: new Date().toISOString(),
        retired_at: null,
      });
    }

    if (deviceRows.length > 0) {
      const { error } = await supabase
        .from("energy_optimisation_devices")
        .upsert(deviceRows, { onConflict: "home_id,device_key" })
        .select("id");
      if (error) {
        console.error("[ENERGY-OPTIMISATION] device upsert failed", error);
        return json({ error: "storage_failed" }, 500);
      }
    }
    if (deviceInventoryComplete) {
      const { data: activeRows, error: activeError } = await supabase
        .from("energy_optimisation_devices")
        .select("id, device_key")
        .eq("customer_id", auth.customerId)
        .eq("home_id", auth.homeId)
        .is("retired_at", null);
      if (activeError) {
        console.error("[ENERGY-OPTIMISATION] device inventory read failed", activeError);
        return json({ error: "storage_failed" }, 500);
      }
      const staleIds = (activeRows ?? [])
        .filter((row: Record<string, unknown>) =>
          !deviceKeys.has(row.device_key as string)
        )
        .map((row: Record<string, unknown>) => row.id as string);
      if (staleIds.length > 0) {
        const { error: retireError } = await supabase
          .from("energy_optimisation_devices")
          .update({ retired_at: new Date().toISOString() })
          .in("id", staleIds);
        if (retireError) {
          console.error("[ENERGY-OPTIMISATION] device retirement failed", retireError);
          return json({ error: "storage_failed" }, 500);
        }
      }
    }
    const { data: storedRows, error: storedError } = await supabase
      .from("energy_optimisation_devices")
      .select(STORED_DEVICE_COLUMNS)
      .eq("customer_id", auth.customerId)
      .eq("home_id", auth.homeId)
      .is("retired_at", null);
    if (storedError) {
      console.error("[ENERGY-OPTIMISATION] device inventory load failed", storedError);
      return json({ error: "storage_failed" }, 500);
    }
    const storedDevices = (storedRows ?? []).map(storedDeviceFromRow);
    const storedDeviceByKey = new Map(
      storedDevices.map((device) => [device.key, device]),
    );
    const storedRoomByKey = new Map<string, RoomMapping>();
    for (const device of storedDevices) {
      const room = roomMapping(device);
      if (!room) continue;
      const existing = storedRoomByKey.get(room.key);
      if (existing && existing.name !== room.name) {
        return json({
          error: "invalid_device_room_mapping",
          detail: `${room.key} has more than one name`,
        }, 400);
      }
      storedRoomByKey.set(room.key, room);
    }

    const now = Date.now();
    const latestCompleteStart = Math.floor(now / SLOT_MS) * SLOT_MS - SLOT_MS;
    const earliestAcceptedStart = latestCompleteStart - 8 * 24 * 60 * 60_000;
    const actualRows: Record<string, unknown>[] = [];
    const deviceSlotRows: Record<string, unknown>[] = [];
    const starts = new Set<number>();
    for (const [index, actual] of actuals.entries()) {
      const start = Date.parse(String(actual?.start ?? ""));
      if (
        !Number.isFinite(start) || start % SLOT_MS !== 0 ||
        start < earliestAcceptedStart || start > latestCompleteStart
      ) {
        return json({
          error: "invalid_actual_start",
          detail: `actual_slots[${index}]`,
        }, 400);
      }
      if (starts.has(start)) {
        return json(
          { error: "duplicate_actual_start", detail: actual.start },
          400,
        );
      }
      starts.add(start);
      if (
        actual.quality?.aggregation !== ACTUAL_AGGREGATION ||
        actual.quality?.duration_seconds !== 900
      ) {
        return json({
          error: "invalid_actual_quality",
          detail: `actual_slots[${index}]`,
        }, 400);
      }
      const row: Record<string, unknown> = {
        customer_id: auth.customerId,
        home_id: auth.homeId,
        start_ts: new Date(start).toISOString(),
        device_token_id: auth.tokenId,
        quality: {
          aggregation: ACTUAL_AGGREGATION,
          duration_seconds: 900,
        },
      };
      let populated = 0;
      for (const field of ENERGY_FIELDS) {
        const value = actual[field];
        if (value === undefined || value === null) {
          row[field] = null;
          continue;
        }
        if (
          typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
          value > MAX_QUARTER_KWH
        ) {
          return json({
            error: "invalid_actual_energy",
            detail: `actual_slots[${index}].${field}`,
          }, 400);
        }
        row[field] = round(value);
        populated += 1;
      }
      for (const field of FRACTION_FIELDS) {
        const value = actual[field];
        if (value === undefined || value === null) {
          row[field] = null;
          continue;
        }
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
          return json({
            error: "invalid_actual_soc",
            detail: `actual_slots[${index}].${field}`,
          }, 400);
        }
        row[field] = round(value);
      }
      if (populated === 0) {
        return json({
          error: "empty_actual_slot",
          detail: `actual_slots[${index}]`,
        }, 400);
      }
      actualRows.push(row);
      const deviceEnergy = actual.device_energy_kwh ?? {};
      if (
        !deviceEnergy || typeof deviceEnergy !== "object" ||
        Array.isArray(deviceEnergy)
      ) {
        return json({
          error: "invalid_device_energy",
          detail: `actual_slots[${index}].device_energy_kwh`,
        }, 400);
      }
      for (const [deviceKey, value] of Object.entries(deviceEnergy)) {
        const storedDevice = storedDeviceByKey.get(deviceKey);
        if (
          !storedDevice || typeof value !== "number" ||
          !Number.isFinite(value) || value < 0 || value > MAX_QUARTER_KWH
        ) {
          return json({
            error: "invalid_device_energy",
            detail: `actual_slots[${index}].device_energy_kwh.${deviceKey}`,
          }, 400);
        }
        deviceSlotRows.push({
          customer_id: auth.customerId,
          home_id: auth.homeId,
          device_id: storedDevice.id,
          start_ts: new Date(start).toISOString(),
          energy_kwh: round(value),
          quality: {
            aggregation: ACTUAL_AGGREGATION,
            duration_seconds: 900,
          },
          device_token_id: auth.tokenId,
        });
      }
    }
    actualRows.sort((a, b) =>
      Date.parse(String(a.start_ts)) - Date.parse(String(b.start_ts))
    );

    if (actualRows.length > 0) {
      const { error } = await supabase
        .from("energy_optimisation_actual_slots")
        .upsert(actualRows, { onConflict: "home_id,start_ts" });
      if (error) {
        console.error("[ENERGY-OPTIMISATION] actual upsert failed", error);
        return json({ error: "storage_failed" }, 500);
      }
    }
    if (deviceSlotRows.length > 0) {
      const { error } = await supabase
        .from("energy_optimisation_device_slots")
        .upsert(deviceSlotRows, { onConflict: "device_id,start_ts" });
      if (error) {
        console.error("[ENERGY-OPTIMISATION] device slot upsert failed", error);
        return json({ error: "storage_failed" }, 500);
      }
    }

    // Prices carry no watermark and no recorder dependency: they are published
    // figures the integration looked up, so a backfill may reach back to the
    // retention horizon and forward across the whole plan horizon.
    const earliestPriceStart = latestCompleteStart - 120 * 24 * 60 * 60_000;
    const latestPriceStart = latestCompleteStart + 8 * 24 * 60 * 60_000;
    const priceRows: Record<string, unknown>[] = [];
    const pricedStarts = new Set<number>();
    for (const [index, price] of prices.entries()) {
      const start = Date.parse(String(price?.start ?? ""));
      if (
        !Number.isFinite(start) || start % SLOT_MS !== 0 ||
        start < earliestPriceStart || start > latestPriceStart
      ) {
        return json({
          error: "invalid_price_start",
          detail: `price_slots[${index}]`,
        }, 400);
      }
      if (pricedStarts.has(start)) {
        return json(
          { error: "duplicate_price_start", detail: price.start },
          400,
        );
      }
      pricedStarts.add(start);
      const values = [
        price.import_price_sek_per_kwh,
        price.export_price_sek_per_kwh,
      ];
      if (
        values.some((value) =>
          typeof value !== "number" || !Number.isFinite(value) ||
          Math.abs(value) > MAX_PRICE_SEK_PER_KWH
        )
      ) {
        return json({
          error: "invalid_price",
          detail: `price_slots[${index}]`,
        }, 400);
      }
      priceRows.push({
        customer_id: auth.customerId,
        home_id: auth.homeId,
        start_ts: new Date(start).toISOString(),
        import_price_sek_per_kwh: round(price.import_price_sek_per_kwh),
        export_price_sek_per_kwh: round(price.export_price_sek_per_kwh),
        source: "integration",
        device_token_id: auth.tokenId,
      });
    }

    // The snapshot already priced its own horizon with the same all-in figure,
    // so harvesting it costs one pass over an array we were sent anyway. It
    // means the archive starts filling the moment this function deploys, rather
    // than waiting on an integration release. An explicit price_slots entry for
    // the same quarter takes precedence only because it is written second.
    if (snapshot) {
      for (const slot of snapshot.slots ?? []) {
        const start = Date.parse(String(slot?.start ?? ""));
        const importPrice = slot?.import_price_sek_per_kwh;
        const exportPrice = slot?.export_price_sek_per_kwh;
        if (
          !Number.isFinite(start) || start % SLOT_MS !== 0 ||
          start < earliestPriceStart || start > latestPriceStart ||
          pricedStarts.has(start) ||
          typeof importPrice !== "number" || !Number.isFinite(importPrice) ||
          typeof exportPrice !== "number" || !Number.isFinite(exportPrice) ||
          Math.abs(importPrice) > MAX_PRICE_SEK_PER_KWH ||
          Math.abs(exportPrice) > MAX_PRICE_SEK_PER_KWH
        ) continue;
        pricedStarts.add(start);
        priceRows.push({
          customer_id: auth.customerId,
          home_id: auth.homeId,
          start_ts: new Date(start).toISOString(),
          import_price_sek_per_kwh: round(importPrice),
          export_price_sek_per_kwh: round(exportPrice),
          source: "snapshot",
          device_token_id: auth.tokenId,
        });
      }
    }

    if (priceRows.length > 0) {
      const { error } = await supabase
        .from("energy_optimisation_price_slots")
        .upsert(priceRows, { onConflict: "home_id,start_ts" });
      if (error) {
        console.error("[ENERGY-OPTIMISATION] price upsert failed", error);
        return json({ error: "storage_failed" }, 500);
      }
    }

    // Thermal observations arrive on their own window: a zone sensor can
    // settle after its energy meter, so a quarter already accepted
    // electrically may only now become describable thermally.
    const thermalRows: Record<string, unknown>[] = [];
    const outdoorRows: Record<string, unknown>[] = [];
    const thermalStarts = new Set<number>();
    const temperature = (value: unknown): number | null => {
      if (value === undefined || value === null) return null;
      if (
        typeof value !== "number" || !Number.isFinite(value) ||
        value < MIN_ROOM_C || value > MAX_ROOM_C
      ) return NaN;
      return round(value, 4);
    };
    for (const [index, thermal] of thermals.entries()) {
      const start = Date.parse(String(thermal?.start ?? ""));
      if (
        !Number.isFinite(start) || start % SLOT_MS !== 0 ||
        start < earliestAcceptedStart || start > latestCompleteStart
      ) {
        return json({
          error: "invalid_thermal_start",
          detail: `thermal_slots[${index}]`,
        }, 400);
      }
      if (thermalStarts.has(start)) {
        return json(
          { error: "duplicate_thermal_start", detail: thermal.start },
          400,
        );
      }
      thermalStarts.add(start);

      const outdoor = temperature(thermal.outdoor_temperature_c);
      if (Number.isNaN(outdoor)) {
        return json({
          error: "invalid_outdoor_temperature",
          detail: `thermal_slots[${index}].outdoor_temperature_c`,
        }, 400);
      }
      if (outdoor !== null) {
        outdoorRows.push({
          customer_id: auth.customerId,
          home_id: auth.homeId,
          start_ts: new Date(start).toISOString(),
          temperature_c: outdoor,
          device_token_id: auth.tokenId,
        });
      }

      const observations = thermal.zone_observations;
      if (
        !observations || typeof observations !== "object" ||
        Array.isArray(observations) || Object.keys(observations).length === 0
      ) {
        return json({
          error: "invalid_zone_observations",
          detail: `thermal_slots[${index}].zone_observations`,
        }, 400);
      }
      for (const [roomKey, observation] of Object.entries(observations)) {
        const storedRoom = storedRoomByKey.get(roomKey);
        const detail =
          `thermal_slots[${index}].zone_observations.${roomKey}`;
        if (!storedRoom || !observation || typeof observation !== "object") {
          return json({ error: "invalid_zone_observations", detail }, 400);
        }
        const room = temperature(observation.room_temperature_c);
        const duty = observation.actuator_duty;
        if (
          room === null || Number.isNaN(room) || typeof duty !== "number" ||
          !Number.isFinite(duty) || duty < 0 || duty > 1
        ) {
          return json({ error: "invalid_zone_observations", detail }, 400);
        }
        // Absent means no cooling, which is the case in almost every home.
        const cooling = observation.cooling_duty ?? 0;
        if (
          typeof cooling !== "number" || !Number.isFinite(cooling) ||
          cooling < 0 || cooling > 1
        ) {
          return json({ error: "invalid_zone_observations", detail }, 400);
        }
        const comfortMin = temperature(observation.comfort_min_c);
        const comfortMax = temperature(observation.comfort_max_c);
        const setpoint = temperature(observation.setpoint_c);
        if (
          Number.isNaN(comfortMin) || Number.isNaN(comfortMax) ||
          Number.isNaN(setpoint)
        ) {
          return json({ error: "invalid_zone_observations", detail }, 400);
        }
        // A band whose floor sits above its ceiling is a mapping error, not a
        // reading. Storing it would make every later constraint infeasible.
        if (
          comfortMin !== null && comfortMax !== null && comfortMin > comfortMax
        ) {
          return json({ error: "invalid_comfort_band", detail }, 400);
        }
        thermalRows.push({
          customer_id: auth.customerId,
          home_id: auth.homeId,
          room_key: storedRoom.key,
          room_name: storedRoom.name,
          start_ts: new Date(start).toISOString(),
          room_temperature_c: room,
          actuator_duty: round(duty, 4),
          cooling_duty: round(cooling, 4),
          comfort_min_c: comfortMin,
          comfort_max_c: comfortMax,
          setpoint_c: setpoint,
          quality: thermal.quality ?? {},
          device_token_id: auth.tokenId,
        });
      }
    }

    if (outdoorRows.length > 0) {
      const { error } = await supabase
        .from("energy_optimisation_outdoor_slots")
        .upsert(outdoorRows, { onConflict: "home_id,start_ts" });
      if (error) {
        console.error("[ENERGY-OPTIMISATION] outdoor upsert failed", error);
        return json({ error: "storage_failed" }, 500);
      }
    }
    if (thermalRows.length > 0) {
      const { error } = await supabase
        .from("energy_optimisation_thermal_slots")
        .upsert(thermalRows, { onConflict: "home_id,room_key,start_ts" });
      if (error) {
        console.error("[ENERGY-OPTIMISATION] thermal upsert failed", error);
        return json({ error: "storage_failed" }, 500);
      }
    }
    const thermalAcceptedUntil = thermalStarts.size > 0
      ? new Date(Math.max(...thermalStarts) + SLOT_MS).toISOString()
      : null;

    let generated: (ReturnType<typeof generateOptimisationPlan> & {
      thermal_projection?: NonNullable<ReturnType<typeof buildThermalProjection>>;
    }) | null = null;
    if (snapshot !== null) {
      const models = new Map(
        snapshot.device_models.map((model) => [model.key, model]),
      );
      if (
        models.size !== snapshot.device_models.length ||
        [...models.keys()].some((key) => !storedDeviceByKey.has(key))
      ) {
        return json({ error: "snapshot_device_inventory_mismatch" }, 400);
      }
      snapshot = {
        ...snapshot,
        device_models: snapshot.device_models.map((model) => {
          const stored = storedDeviceByKey.get(model.key)!;
          return {
            ...model,
            suggested_load_type: stored.suggested_load_type,
            load_type: stored.load_type_override,
          };
        }),
      };
      // The measured price shape for this home, from the archive §1.3.7 added.
      // Two thirds of the horizon is beyond the day-ahead window, and without
      // this those slots price flat and the planner has no reason to prefer one
      // hour over another (§1.4.3). A read failure is not fatal: no shape means
      // a flat tail, which is the behaviour before this existed.
      let priceShape: PriceShape | null = null;
      const shapeFrom = new Date(
        Date.now() - PRICE_SHAPE_WINDOW_DAYS * 86_400_000,
      ).toISOString();
      const { data: shapeRows, error: shapeError } = await supabase
        .from("energy_optimisation_price_slots")
        .select("start_ts, import_price_sek_per_kwh")
        .eq("home_id", auth.homeId)
        .gte("start_ts", shapeFrom)
        .order("start_ts");
      if (shapeError) {
        console.error("[ENERGY-OPTIMISATION] price shape read failed", shapeError);
      } else {
        priceShape = buildPriceShape(shapeRows ?? [], snapshot.timezone);
      }

      let thermalZones: ProjectionZoneInput[] = [];
      try {
        const thermal = await prepareThermalPlanning(
          supabase,
          auth.customerId,
          auth.homeId,
          snapshot,
          storedDevices,
        );
        snapshot = thermal.snapshot;
        thermalZones = thermal.zones;
        generated = generateOptimisationPlan(snapshot, new Date(), priceShape);
      } catch (error) {
        const detail = error instanceof Error
          ? error.message
          : "invalid snapshot";
        return json({ error: "invalid_snapshot", detail }, 400);
      }

      // The same scheduled demand is projected into room temperature for the
      // Thermal tab. This is descriptive; the executable power series was
      // already installed in the snapshot before planning above.
      if (thermalZones.length > 0) {
        const plannedSlots = generated.plans.priority.slots;
        const projection = buildThermalProjection(
          snapshot.slots.map((slot) => slot.start),
          snapshot.outdoor_temperature_c as number[],
          thermalZones.map((zone) => ({
            ...zone,
            planned_power_w: plannedSlots.map((slot) =>
              slot.room_heating_w?.[zone.key] ?? 0
            ),
          })),
        );
        if (projection) {
          generated = { ...generated, thermal_projection: projection };
        }
      }

      const inputHash = await sha256Hex(JSON.stringify(snapshot));
      const currentRow = {
        home_id: auth.homeId,
        customer_id: auth.customerId,
        snapshot_id: snapshot.snapshot_id,
        input_hash: inputHash,
        captured_at: snapshot.captured_at,
        issued_at: generated.issued_at,
        valid_until: generated.valid_until,
        binding_until: generated.binding_until,
        status: generated.status,
        model_version: generated.model_version,
        snapshot,
        plan: generated,
        updated_at: new Date().toISOString(),
      };
      const { error: currentError } = await supabase
        .from("energy_optimisation_current")
        .upsert(currentRow, { onConflict: "home_id" });
      if (currentError) {
        console.error(
          "[ENERGY-OPTIMISATION] current plan upsert failed",
          currentError,
        );
        return json({ error: "storage_failed" }, 500);
      }

      const { error: runError } = await supabase
        .from("energy_optimisation_plan_runs")
        .upsert({
          id: generated.plan_id,
          customer_id: auth.customerId,
          home_id: auth.homeId,
          snapshot_id: snapshot.snapshot_id,
          input_hash: inputHash,
          issued_at: generated.issued_at,
          status: generated.status,
          model_version: generated.model_version,
          summary: compactPlanSummary(generated),
          validation_errors: generated.validation_errors,
        }, { onConflict: "home_id,snapshot_id" });
      if (runError) {
        console.error(
          "[ENERGY-OPTIMISATION] run summary upsert failed",
          runError,
        );
        return json({ error: "storage_failed" }, 500);
      }

      // Archive the forecasts exactly as they stood at this decision time.
      // §8.11's second replay run — the only achievable one — compares what was
      // knowable then against what happened, so this cannot be reconstructed
      // later from outturn data and cannot be backfilled at all.
      //
      // One row per six-hour window, matching the cadence of the weather models
      // underneath the PV forecast, and stored as parallel arrays with implied
      // slot times. A failure here is logged rather than returned: losing one
      // window is a gap in a study, while failing the request would stop the
      // house being planned.
      const issuedAt = new Date(snapshot.captured_at);
      const issuedBucket = new Date(issuedAt);
      issuedBucket.setUTCHours(
        Math.floor(issuedBucket.getUTCHours() / 6) * 6,
        0,
        0,
        0,
      );
      const outdoor = snapshot.outdoor_temperature_c as number[] | null;
      const { error: forecastError } = await supabase
        .from("energy_optimisation_forecast_runs")
        .upsert({
          customer_id: auth.customerId,
          home_id: auth.homeId,
          issued_at: issuedAt.toISOString(),
          issued_bucket: issuedBucket.toISOString(),
          horizon_start: snapshot.slots[0]?.start ?? snapshot.captured_at,
          slot_minutes: snapshot.slot_minutes,
          slot_count: snapshot.slots.length,
          series: {
            pv_forecast_w: snapshot.slots.map((slot) => slot.pv_forecast_w),
            base_load_forecast_w: snapshot.slots.map((slot) =>
              slot.base_load_forecast_w
            ),
            base_load_p10_w: snapshot.slots.map((slot) => slot.base_load_p10_w),
            base_load_p90_w: snapshot.slots.map((slot) => slot.base_load_p90_w),
            outdoor_temperature_c: snapshot.slots.map((_slot, index) =>
              outdoor?.[index] ?? null
            ),
            import_price_sek_per_kwh: snapshot.slots.map((slot) =>
              slot.import_price_sek_per_kwh
            ),
            export_price_sek_per_kwh: snapshot.slots.map((slot) =>
              slot.export_price_sek_per_kwh
            ),
          },
          sources: snapshot.sources,
        }, { onConflict: "home_id,issued_bucket", ignoreDuplicates: true });
      if (forecastError) {
        console.error(
          "[ENERGY-OPTIMISATION] forecast archive upsert failed",
          forecastError,
        );
      }
    }

    const { error: pruneError } = await supabase.rpc(
      "prune_energy_optimisation_data",
      { p_home_id: auth.homeId },
    );
    if (pruneError) {
      console.error("[ENERGY-OPTIMISATION] retention prune failed", pruneError);
    }

    return json({
      actual_slots_accepted: actualRows.length,
      actuals_accepted_until: actualRows.length > 0
        ? actualRows[actualRows.length - 1].start_ts
        : null,
      thermal_slots_accepted: thermalRows.length,
      thermal_slots_accepted_until: thermalAcceptedUntil,
      price_slots_accepted: priceRows.length,
      plan: generated,
      device_configuration: storedDevices.map((device) => ({
        key: device.key,
        statistic_id: device.statistic_id,
        name: device.name,
        category: device.category,
        suggested_load_type: device.suggested_load_type,
        load_type: device.load_type_override,
        ...effectivePlanning(device),
        mapping_status: device.mapping_status,
        mapped_control_type: device.mapped_control_type,
      })),
    });
  } catch (error) {
    console.error("[ENERGY-OPTIMISATION] unexpected", error);
    return json({ error: "internal_error" }, 500);
  }
});
