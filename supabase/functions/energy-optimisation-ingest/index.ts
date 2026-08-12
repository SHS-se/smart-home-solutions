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
  buildThermalProjection,
  fitZones,
  type ProjectionZoneInput,
  REFIT_INTERVAL_HOURS,
  type ThermalMomentRow,
  TRAINING_WINDOW_DAYS,
  zoneModelRows,
} from "../_shared/thermal-training.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const MAX_ACTUAL_SLOTS_PER_PUSH = 288;
const MAX_THERMAL_SLOTS_PER_PUSH = 288;
const MAX_DEVICES_PER_PUSH = 100;
const MAX_QUARTER_KWH = 100;
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

const effectivePlanning = (device: StoredDevice) => ({
  planning_role: device.planning_role_override,
  control_type: device.control_type_override,
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

/**
 * Refit stale zone models and build a temperature projection for the plan.
 *
 * Returns null whenever a projection would be misleading: no fitted zone, no
 * outdoor forecast, or no recent room temperature to start the trajectory
 * from. A missing projection reads as "not yet", which is true; an invented
 * one would read as a measurement.
 */
async function refitAndProject(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  customerId: string,
  homeId: string,
  snapshot: OptimisationSnapshotV5,
  plan: ReturnType<typeof generateOptimisationPlan>,
) {
  const now = Date.now();
  const { data: existing } = await supabase
    .from("energy_optimisation_zone_models")
    .select("device_id, fitted_at")
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
          { onConflict: "device_id" },
        );
      if (upsertError) throw upsertError;
    }
  }

  const outdoor = snapshot.outdoor_temperature_c;
  if (!outdoor || outdoor.length === 0) return null;

  const { data: trained } = await supabase
    .from("energy_optimisation_zone_models")
    .select(
      "device_id, gain_c_per_wh, cooling_constant_per_h, background_gain_c_per_h, thermal_capacity_wh_per_c, heat_loss_w_per_c, time_constant_h, heating_rate_c_per_h, r2, residual_std_c, sample_count",
    )
    .eq("home_id", homeId)
    .eq("trained", true);
  if (!trained || trained.length === 0) return null;

  const { data: devices } = await supabase
    .from("energy_optimisation_devices")
    .select("id, device_key, name, active_power_w")
    .eq("home_id", homeId);
  const deviceById = new Map(
    (devices ?? []).map((device: Record<string, unknown>) => [
      device.id as string,
      device,
    ]),
  );

  // The trajectory has to start from a real reading, not from the middle of
  // a comfort band, or the projection describes a house nobody lives in.
  const { data: latest } = await supabase
    .from("energy_optimisation_thermal_slots")
    .select("device_id, room_temperature_c, comfort_min_c, comfort_max_c, start_ts")
    .eq("home_id", homeId)
    .gte("start_ts", new Date(now - 6 * 3_600_000).toISOString())
    .order("start_ts", { ascending: false });
  const latestByDevice = new Map<string, Record<string, unknown>>();
  for (const row of latest ?? []) {
    if (!latestByDevice.has(row.device_id)) latestByDevice.set(row.device_id, row);
  }

  const slots = plan.plans.cost?.slots ?? plan.plans.baseline?.slots ?? [];
  const forecastByKey = new Map(
    snapshot.device_models.map((model) => [model.key, model.forecast_w_by_slot]),
  );

  const zones: ProjectionZoneInput[] = [];
  for (const model of trained) {
    const device = deviceById.get(model.device_id);
    const observation = latestByDevice.get(model.device_id);
    if (!device || !observation) continue;
    const key = device.device_key as string;
    const forecast = forecastByKey.get(key);
    if (!forecast) continue;
    zones.push({
      key,
      name: device.name as string,
      model: {
        gain_c_per_wh: Number(model.gain_c_per_wh),
        cooling_constant_per_h: Number(model.cooling_constant_per_h),
        background_gain_c_per_h: Number(model.background_gain_c_per_h),
        thermal_capacity_wh_per_c: Number(model.thermal_capacity_wh_per_c),
        heat_loss_w_per_c: Number(model.heat_loss_w_per_c),
        time_constant_h: Number(model.time_constant_h),
        heating_rate_c_per_h: model.heating_rate_c_per_h === null
          ? null
          : Number(model.heating_rate_c_per_h),
        r2: Number(model.r2),
        sample_count: Number(model.sample_count),
        residual_std_c: Number(model.residual_std_c),
      },
      start_temperature_c: Number(observation.room_temperature_c),
      rated_power_w: Number(device.active_power_w ?? 0),
      comfort_min_c: observation.comfort_min_c === null
        ? null
        : Number(observation.comfort_min_c),
      comfort_max_c: observation.comfort_max_c === null
        ? null
        : Number(observation.comfort_max_c),
      planned_power_w: slots.map((slot) => slot.device_loads_w?.[key] ?? 0),
      unplanned_power_w: [...forecast],
    });
  }

  return buildThermalProjection(
    slots.map((slot) => slot.start),
    outdoor,
    zones,
  );
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
    let devices: IncomingDevice[] = [];
    let thermals: IncomingThermalSlot[] = [];
    let snapshot: OptimisationSnapshotV5 | null = null;
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
      actuals = body.actual_slots ?? [];
      devices = body.devices ?? [];
      thermals = body.thermal_slots ?? [];
      snapshot = body.snapshot ?? null;
    } catch {
      return json({ error: "invalid_body" }, 400);
    }
    if (
      actuals.length === 0 && snapshot === null && devices.length === 0 &&
      thermals.length === 0
    ) {
      return json({ error: "empty_body" }, 400);
    }
    if (thermals.length > MAX_THERMAL_SLOTS_PER_PUSH) {
      return json({ error: "too_many_thermal_slots" }, 400);
    }
    if (actuals.length > MAX_ACTUAL_SLOTS_PER_PUSH) {
      return json({ error: "too_many_actual_slots" }, 400);
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
      "current_limit",
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
            device.mapping_error !== null)) ||
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
      });
    }

    let storedDevices: StoredDevice[] = [];
    if (deviceRows.length > 0) {
      const { data, error } = await supabase
        .from("energy_optimisation_devices")
        .upsert(deviceRows, { onConflict: "home_id,device_key" })
        .select(
          "id, device_key, statistic_id, name, category, suggested_load_type, load_type_override, suggested_planning_role, planning_role_override, suggested_control_type, control_type_override, active_power_w, profile_sample_count, inference, mapping_status, mapped_control_type, mapping_error, mapping_summary",
        );
      if (error) {
        console.error("[ENERGY-OPTIMISATION] device upsert failed", error);
        return json({ error: "storage_failed" }, 500);
      }
      storedDevices = (data ?? []).map((row) => ({
        id: row.id,
        key: row.device_key,
        statistic_id: row.statistic_id,
        name: row.name,
        category: row.category,
        suggested_load_type: row.suggested_load_type,
        load_type_override: row.load_type_override,
        suggested_planning_role: row.suggested_planning_role,
        planning_role_override: row.planning_role_override,
        suggested_control_type: row.suggested_control_type,
        control_type_override: row.control_type_override,
        active_power_w: row.active_power_w === null
          ? null
          : Number(row.active_power_w),
        profile_sample_count: row.profile_sample_count,
        inference: row.inference,
        mapping_status: row.mapping_status,
        mapped_control_type: row.mapped_control_type,
        mapping_error: row.mapping_error,
        mapping_summary: row.mapping_summary,
      })) as StoredDevice[];
    }
    const storedDeviceByKey = new Map(
      storedDevices.map((device) => [device.key, device]),
    );

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
      for (const [deviceKey, observation] of Object.entries(observations)) {
        const storedDevice = storedDeviceByKey.get(deviceKey);
        const detail =
          `thermal_slots[${index}].zone_observations.${deviceKey}`;
        if (!storedDevice || !observation || typeof observation !== "object") {
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
          device_id: storedDevice.id,
          start_ts: new Date(start).toISOString(),
          room_temperature_c: room,
          actuator_duty: round(duty, 4),
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
        .upsert(thermalRows, { onConflict: "device_id,start_ts" });
      if (error) {
        console.error("[ENERGY-OPTIMISATION] thermal upsert failed", error);
        return json({ error: "storage_failed" }, 500);
      }
    }
    const thermalAcceptedUntil = thermalStarts.size > 0
      ? new Date(Math.max(...thermalStarts) + SLOT_MS).toISOString()
      : null;

    let generated: ReturnType<typeof generateOptimisationPlan> | null = null;
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
      try {
        generated = generateOptimisationPlan(snapshot);
      } catch (error) {
        const detail = error instanceof Error
          ? error.message
          : "invalid snapshot";
        return json({ error: "invalid_snapshot", detail }, 400);
      }

      // Refit zones and attach a temperature projection. A failure here must
      // never cost the home its electrical plan, which is already valid and
      // is the part that actually controls equipment.
      try {
        const projection = await refitAndProject(
          supabase,
          auth.customerId,
          auth.homeId,
          snapshot,
          generated,
        );
        if (projection) {
          generated = { ...generated, thermal_projection: projection };
        }
      } catch (error) {
        console.error("[ENERGY-OPTIMISATION] thermal fit failed", error);
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
