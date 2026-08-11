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
  type DeviceLoadType,
  generateOptimisationPlan,
  type OptimisationSnapshotV4,
} from "../_shared/energy-optimisation.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const MAX_ACTUAL_SLOTS_PER_PUSH = 288;
const MAX_DEVICES_PER_PUSH = 100;
const MAX_QUARTER_KWH = 100;
const MAX_REQUEST_BYTES = 2_000_000;
const SLOT_MS = 15 * 60_000;
const ACTUAL_AGGREGATION = "sum_of_recorder_5minute_changes";

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
  active_power_w: number | null;
  profile_sample_count: number;
  inference: Record<string, unknown>;
}

interface StoredDevice extends IncomingDevice {
  id: string;
  load_type_override: DeviceLoadType | null;
}

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
    let snapshot: OptimisationSnapshotV4 | null = null;
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
      actuals = body.actual_slots ?? [];
      devices = body.devices ?? [];
      snapshot = body.snapshot ?? null;
    } catch {
      return json({ error: "invalid_body" }, 400);
    }
    if (actuals.length === 0 && snapshot === null) {
      return json({ error: "empty_body" }, 400);
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
        (device.active_power_w !== null &&
          (typeof device.active_power_w !== "number" ||
            !Number.isFinite(device.active_power_w) ||
            device.active_power_w < 0 || device.active_power_w > 100_000)) ||
        !Number.isInteger(device.profile_sample_count) ||
        device.profile_sample_count < 0 ||
        !device.inference || typeof device.inference !== "object" ||
        Array.isArray(device.inference)
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
        active_power_w: device.active_power_w,
        profile_sample_count: device.profile_sample_count,
        inference: device.inference,
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
          "id, device_key, statistic_id, name, category, suggested_load_type, load_type_override, active_power_w, profile_sample_count, inference",
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
        active_power_w: row.active_power_w === null
          ? null
          : Number(row.active_power_w),
        profile_sample_count: row.profile_sample_count,
        inference: row.inference,
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
            load_type: stored.load_type_override ?? stored.suggested_load_type,
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
      plan: generated,
      device_models: storedDevices.map((device) => ({
        key: device.key,
        suggested_load_type: device.suggested_load_type,
        load_type: device.load_type_override ?? device.suggested_load_type,
      })),
    });
  } catch (error) {
    console.error("[ENERGY-OPTIMISATION] unexpected", error);
    return json({ error: "internal_error" }, 500);
  }
});
