import { recordPlanningActivity } from '../_shared/planning-log.ts';
import { readPlannerLocation, withPlannerLocation } from "../_shared/home-planning-location.ts";
import { prepareActualUpload } from "../_shared/actual-upload.ts";
import { mergePlanningWarnings, planningWarning } from "../_shared/planner/planning-warnings.ts";
import { hasNewPublishedPrices, deviationRecommendations, recoveredMeasurementRecommendations, type DeviationActual } from '../_shared/replan-policy.ts';
import { isolateMeasurements } from '../_shared/planner/measurement-isolation.ts';
import { deviceContractBreach, roomMapping, type IncomingDevice, type RoomMapping, type DeviceMappingStatus } from "./device-contract.ts";
import { captureRulesPlanningInput } from "../_shared/rules-planning-capture.ts";
import { RULES_MODEL_VERSION } from "../_shared/rules-planner-identity.ts";
import { captureDeviceModels, poolLearningOwner, requestDeviceLearning, type DeviceModelBundle } from "../_shared/device-model-store.ts";
import { recordTestPriceForecastGeneration, testPriceForecastContext } from "../_shared/price-estimate-evidence.ts";
import { resolveRulePolicy } from "../_shared/planner-wasm/rule-policy.ts";
import { readOrPrepareForecasts, storePreparedForecasts, type PreparedForecastDatabase } from "../_shared/prepared-energy-forecasts.ts";
import { reportedPoolHardware, samePoolHardware, type PoolHardware } from "../_shared/pool-hardware.ts";
import { readHomeGridImportLimitW } from "../_shared/home-grid-limit.ts";
import { withTrafficMetrics } from "../_shared/edge-traffic.ts";
import type { OptimisationPlan, FixedEnergyPlan } from "../_shared/planner/planning-contracts.ts";
import { applyBatteryChoice } from "../_shared/home-planning.ts";
import { ExecutionReplanError, parseExecutionChanges, parseExecutionReplan, shouldAdmitPlanningSnapshot, validateExecutionReplan, type ExecutionReplan } from "../_shared/execution-replan.ts";
// Device-authenticated exchange for the live 15-minute energy model.
//
// Home Assistant sends only completed quarter-hour aggregates and, at most
// hourly, one rolling forecast snapshot. Raw recorder samples never cross this
// boundary. The large plan is overwritten per home; only compact run summaries
// are appended and both histories have explicit retention.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { authenticateDevice, sha256Hex } from "../_shared/ha-device-auth.ts";
import { devicePowerReport } from "../_shared/device-power-report.ts";
import {
  HA_API_CORS_HEADERS,
  HA_UUID,
  describeThrown,
  haApiResponse,
  haRequestId,
  validatePlanningNegotiation,
} from "../_shared/ha-api-contract.ts";
import {
  type DeviceControlType,
  type DeviceLoadType,
  type DevicePlanningRole,
  type OptimisationSnapshot,
} from "../_shared/planner/planning-contracts.ts";
import { PlanningTrace } from "../_shared/planning-trace.ts";
import { parseHeaterResponse } from "../_shared/planner/device-models.ts";
import { capturedPoolResponseState } from "../_shared/pool-capture.ts";
import { comfortTargets } from "../_shared/comfort-targets.ts";
import { PlanningJobs, PlanningJobError, PLANNING_EXCHANGE_VERSION, planningCompletionBasis, type PlanningReceipt } from "../_shared/energy-planning-jobs.ts";
import { buildPriceOutlook, type StoredPriceRow } from "../_shared/planner/energy-price-shape.ts";
import { houseTemperatureForecast, type HouseProfileRow } from "../_shared/house-temperature.ts";
import { prepareRoomModels, captureRoomPlanningState } from "../_shared/room-model-capture.ts";
import {
  resolveValueSettings,
} from "../_shared/planner/value-curves.ts";
import {
  homeLocation,
  withServerOutdoorTemperature,
} from "../_shared/outdoor-forecast.ts";
import { withWindOutlook } from "../_shared/market-wind.ts";
import {
  irradianceForQuarters,
  irradianceOnto,
  irradiancePoints,
} from "../_shared/solar-irradiance.ts";

const MAX_ACTUAL_SLOTS_PER_PUSH = 288;
const MAX_THERMAL_SLOTS_PER_PUSH = 288;
// A price row is four numbers, so a backfill sweeping weeks of history costs
// far less per slot than an actual does. The cap is what keeps one push inside
// MAX_REQUEST_BYTES, not a statement about how much history is reasonable.
const MAX_PRICE_SLOTS_PER_PUSH = 2_880;
const MAX_DEVICES_PER_PUSH = 100;
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
// Physically possible room and outdoor extremes. These reject a sensor
// reporting in Fahrenheit or a unit-less counter, not merely odd weather.
const MIN_ROOM_C = -50;
const MAX_ROOM_C = 80;

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
  /** The house every room sits in: the app's median of indoor area medians. */
  house_temperature_c?: number | null;
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
  battery_soc?: number | null;
  ev_soc?: number | null;
  device_energy_kwh?: Record<string, number>;
  quality?: Record<string, unknown>;
}

/**
 * All-in marginal price for one quarter (ENERGY_OPTIMISATION_ARCHITECTURE.md
 * §1.3.7.2). Separate from the actual slot because a price exists for future
 * quarters that have no measurement, and because a backfill reaches far further
 * back than the eight days the actual-slot watermark allows.
 */
/** Pool water temperature for one quarter: the pool's measured state (§8.3). */
interface IncomingPoolSlot {
  start: string;
  water_temperature_c: number;
  quality?: Record<string, unknown>;
}

interface IncomingPriceSlot {
  start: string;
  import_price_sek_per_kwh: number;
  export_price_sek_per_kwh: number;
}

interface StoredDevice extends IncomingDevice {
  planning_choice_at: string | null;
  id: string;
  load_type_override: DeviceLoadType;
  planning_role_override: DevicePlanningRole;
  control_type_override: DeviceControlType | null;
}

const effectivePlanning = (device: StoredDevice) => ({
  planning_choice_at: device.planning_choice_at,
  planning_role: device.planning_role_override,
  control_type: device.control_type_override,
});

const STORED_DEVICE_COLUMNS =
  "id, device_key, statistic_id, name, category, suggested_load_type, load_type_override, suggested_planning_role, planning_role_override, planning_choice_at, suggested_control_type, control_type_override, active_power_w, profile_sample_count, inference, mapping_status, mapped_control_type, mapping_error, mapping_summary";

const storedDeviceFromRow = (row: Record<string, unknown>): StoredDevice => ({
  id: row.id as string,
  planning_choice_at: row.planning_choice_at as string | null,
  key: row.device_key as string,
  statistic_id: row.statistic_id as string,
  name: row.name as string,
  category: row.category as string,
  suggested_load_type: row.suggested_load_type as DeviceLoadType,
  load_type_override: row.load_type_override as DeviceLoadType,
  suggested_planning_role: row.suggested_planning_role as DevicePlanningRole,
  planning_role_override: row.planning_role_override as DevicePlanningRole,
  suggested_control_type: row.suggested_control_type as
    | DeviceControlType
    | null,
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

const round = (value: number, decimals = 6) => {
  const multiplier = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
};


declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

/** Forecast preparation is owned by telemetry; calibration is captured separately. */
async function refreshPreparedForecasts(
  // deno-lint-ignore no-explicit-any
  supabase: any, customerId: string, homeId: string,
  source: OptimisationSnapshot,
): Promise<{snapshot:OptimisationSnapshot;price_outlook:OptimisationPlan["price_outlook"];issued_at:string}> {
  // Price/weather products cover an extra day so a new capture can read its
  // complete horizon between source refreshes. This is not a device forecast.
  const forecastSlots = [...source.slots];
  const last = source.slots.at(-1)!;
  for (let i = 1; i <= 96; i++) forecastSlots.push({ ...last,
    start: new Date(Date.parse(last.start) + i * SLOT_MS).toISOString(),
    import_price_sek_per_kwh: null, export_price_sek_per_kwh: null });
  const forecastSource = { ...source, slots: forecastSlots };
  const [archiveResult, weather, wind] = await Promise.all([
    supabase.rpc("read_energy_planning_price_archive", { p_home_id: homeId,
      p_from: new Date(Date.now() - PRICE_SHAPE_WINDOW_DAYS * 86_400_000).toISOString() }),
    withServerOutdoorTemperature(supabase, forecastSource),
    withWindOutlook(supabase, forecastSource),
  ]);
  if (archiveResult.error) {
    console.warn("[ENERGY-OPTIMISATION] price history unavailable; current published prices remain in use",{home_id:homeId});
    source.planning_warnings=mergePlanningWarnings(source.planning_warnings,[planningWarning("price_history_read","prices",
      "Historical prices could not be read.","Price estimates use the currently published horizon.")]);
  }
  const priceHistory = (archiveResult.data ?? []) as StoredPriceRow[];
  const projectUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const priceZone = source.sources.import_price?.location?.market_area?.trim().toUpperCase() ?? null;
  const marketContext = await testPriceForecastContext(supabase, projectUrl, priceZone);
  const priceGeneratedAt = new Date().toISOString();
  const outlook = buildPriceOutlook(forecastSlots, priceHistory, {
    timeZone: source.timezone, asOf: Date.parse(source.captured_at), wind: wind.wind_outlook?.days });
  if (marketContext && priceZone) EdgeRuntime.waitUntil(recordTestPriceForecastGeneration(supabase, projectUrl, {
    id: crypto.randomUUID(), home_id: homeId, generated_at: priceGeneratedAt,
    model_as_of: source.captured_at, timezone: source.timezone, zone: priceZone,
    algorithm: RULES_MODEL_VERSION, market_context: marketContext,
    inputs: structuredClone({ format_version: 1 as const,
      slot_starts: forecastSlots.map(slot => slot.start),
      published_import_sek_per_kwh: forecastSlots.map(slot => slot.import_price_sek_per_kwh ?? null),
      price_history_available: !archiveResult.error, price_history: priceHistory,
      smhi_wind_outlook: wind.wind_outlook ?? null }),
    outlook: structuredClone(outlook),
  }));
  const location = homeLocation(source);
  const [solarPoints, houseResult] = await Promise.all([
    location ? irradiancePoints({ supabase, latitude: location.latitude, longitude: location.longitude }) : null,
    supabase.rpc("get_energy_house_temperature_profile", {
      p_customer_id: customerId, p_home_id: homeId, p_timezone: source.timezone, p_to: new Date().toISOString(),
    }),
  ]);
  if (houseResult.error) {
    console.error("[ENERGY-OPTIMISATION] room evidence unavailable", houseResult.error);
    source.planning_warnings = mergePlanningWarnings(source.planning_warnings, [planningWarning(
      "room_evidence_unavailable", "rooms", "Some room evidence could not be read.",
      "Planning continues using the available room evidence and measured demand profiles.")]);
  }
  const starts = forecastSlots.map(slot => slot.start);
  const product = weather;
  const preparedSnapshot={ ...product,
    planning_warnings: mergePlanningWarnings(source.planning_warnings,product.planning_warnings),
    solar_irradiance_w_per_m2: solarPoints ? irradianceOnto(solarPoints, starts) : null,
    house_temperature_c: houseResult.error ? null : houseTemperatureForecast(starts, source.timezone, (houseResult.data ?? []) as HouseProfileRow[]) };
  const priceOutlook={shaped:outlook.shaped,observed_days:outlook.observedDays,effective_days:outlook.effectiveDays,
    level_sek_per_kwh:outlook.levelSekPerKwh,shadow_import_sek_per_kwh:outlook.shadowImportSekPerKwh.slice(0,product.slots.length),
    ...(outlook.levelBasis?{level_basis:outlook.levelBasis}:{})};
  try { await storePreparedForecasts(supabase,homeId,preparedSnapshot,priceOutlook); }
  catch(error) {
    console.warn("[ENERGY-OPTIMISATION] forecast cache publication failed; using fresh preparation",{home_id:homeId,error:describeThrown(error)});
    preparedSnapshot.planning_warnings=mergePlanningWarnings(preparedSnapshot.planning_warnings,[planningWarning("forecast_cache_write","forecasts",
      "The fresh forecast could not be cached.","This plan uses the freshly prepared forecast and planning continues.")]);
  }
  return {snapshot:preparedSnapshot,
    price_outlook:{...priceOutlook,shadow_import_sek_per_kwh:priceOutlook.shadow_import_sek_per_kwh.slice(0,source.slots.length)},
    issued_at:new Date().toISOString()};
}

serve(withTrafficMetrics("energy-optimisation-ingest", async (req, traffic) => {
  const requestId = haRequestId(req);
  const trace = new PlanningTrace(requestId);
  const ingestStarted = performance.now();
  const json = (body: unknown, status = 200) =>
    haApiResponse(requestId, body, status, {}, req.headers.get("X-SHS-API-Version"));
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: HA_API_CORS_HEADERS });
  }
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false }, global: { fetch: traffic.fetch } },
  );

  try {
    const auth = await authenticateDevice(supabase, req);
    if (auth.ok === false) return json({ error: auth.error }, auth.status);
    if (!auth.subscriptionActive) {
      return json({ error: "subscription_inactive" }, 402);
    }

    const jobs = new PlanningJobs(supabase);
    let sourceHash: string | null = null;
    let actuals: IncomingActualSlot[] = [];
    let prices: IncomingPriceSlot[] = [];
    let devices: IncomingDevice[] = [];
    let thermals: IncomingThermalSlot[] = [];
    let pools: IncomingPoolSlot[] = [];
    let snapshot: OptimisationSnapshot | null = null;
    let deviceInventoryComplete = false;
    let equipment: { battery: boolean } | undefined;
    let integrationVersion: string | null = null;
    let portalReplanId: string | null = null;
    let executionReplan: ExecutionReplan | null = null;
    let replanRecommendation: string | null = null;
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
      if (body?.job_id !== undefined || body?.snapshot_id !== undefined) {
        const identity = body.job_id ?? body.snapshot_id;
        if ((body.job_id !== undefined && body.snapshot_id !== undefined) || typeof identity !== "string" || !HA_UUID.test(identity) ||
            body.api_version !== 1 || body.planning_exchange_version !== PLANNING_EXCHANGE_VERSION ||
            Object.keys(body).some(key => !["api_version", "planning_exchange_version", "job_id", "snapshot_id"].includes(key))) {
          return json({ error: "invalid_planning_status_request" }, 400);
        }
        const receipt = await jobs.advanceForHome(auth.homeId,
          body.job_id !== undefined ? { jobId: body.job_id } : { snapshotId: body.snapshot_id }, {
            url: Deno.env.get("SUPABASE_URL") ?? "",
            planningSecret: Deno.env.get("ENERGY_PLANNING_SECRET") ?? "",
          }, traffic.fetch);
        return receipt ? json(receipt, receipt.pending ? 202 : 200) : json({ error: "planning_job_not_found" }, 404);
      }
      if (body?.replan_recommendation !== undefined) {
        if (typeof body.replan_recommendation !== 'string' || body.replan_recommendation.length > 1000) throw new Error('replan_recommendation');
        replanRecommendation = body.replan_recommendation;
      }
      if (!body || typeof body !== "object") throw new Error("body");
      // The portal request this push is answering, if it is answering one.
      // Only meaningful alongside a snapshot: an actuals-only exchange produces
      // no plan, so it cannot complete anything.
      if (body.execution_replan !== undefined) {
        executionReplan = parseExecutionReplan(body.execution_replan);
        if (!body.snapshot) throw new ExecutionReplanError("invalid_execution_replan", "Execution replan requires a snapshot");
      }
      if (body.replan_request_id !== undefined) {
        if (
          typeof body.replan_request_id !== "string" ||
          !HA_UUID.test(body.replan_request_id) ||
          !body.snapshot
        ) {
          throw new Error("replan_request_id requires a snapshot");
        }
        portalReplanId = body.replan_request_id;
      }
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
      if (body.pool_slots !== undefined && !Array.isArray(body.pool_slots)) {
        throw new Error("pool_slots");
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
      pools = body.pool_slots ?? [];
      snapshot = body.snapshot ?? null;
      deviceInventoryComplete = body.device_inventory_complete ?? false;
      if (body.equipment !== undefined) {
        if (!body.equipment || typeof body.equipment.battery !== "boolean") throw new Error("equipment");
        equipment = { battery: body.equipment.battery };
      }
      integrationVersion = typeof body.integration_version === "string"
        ? body.integration_version
        : null;
      if (snapshot !== null) {
        if (typeof snapshot.snapshot_id !== "string" || !HA_UUID.test(snapshot.snapshot_id)) {
          return json({ error: "invalid_snapshot", detail: "snapshot_id must be a UUID" }, 400);
        }
        if (body.planning_exchange_version !== PLANNING_EXCHANGE_VERSION) {
          return json({ error: "planning_exchange_upgrade_required", detail: "Update the SHS app to use durable planning.", retryable: false }, 426);
        }
        if (snapshot.execution_availability !== undefined) snapshot.execution_availability = parseExecutionChanges(snapshot.execution_availability);
        sourceHash = await sha256Hex(JSON.stringify({ snapshot, replan_request_id: portalReplanId, execution_replan: executionReplan }));
        const negotiationError = validatePlanningNegotiation(
          body,
          snapshot.schema_version,
        );
        if (negotiationError) {
          return json({
            error: negotiationError.code,
            message: negotiationError.message,
            path: negotiationError.path,
            details: negotiationError.details,
            retryable: negotiationError.retryable,
          }, 426);
        }
        const existing = executionReplan
          ? await jobs.findExecutionRequest(auth.homeId, executionReplan.request_id, sourceHash) ?? await jobs.findSnapshot(auth.homeId, snapshot.snapshot_id, sourceHash)
          : await jobs.findSnapshot(auth.homeId, snapshot.snapshot_id, sourceHash);
        if (existing) return json(existing, existing.pending ? 202 : 200);
      }
    } catch (error) {
      if (error instanceof PlanningJobError || error instanceof ExecutionReplanError) return json({ error: error.code, detail: error.message }, error.status);
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

    const deviceKeys = new Set<string>();
    const deviceRows: Record<string, unknown>[] = [];
    for (const [index, device] of devices.entries()) {
      // A bad descriptive estimate must not block prices, actuals and the
      // plan. Do not alter snapshot device_models: their scheduling inputs
      // still have to pass the planner's independent safety validation.
      const powerReport = devicePowerReport(device?.active_power_w);
      if (device && typeof device === "object" && !Array.isArray(device)) {
        device.active_power_w = powerReport.power;
      }
      const breach = deviceContractBreach(device, deviceKeys);
      if (breach !== null) {
        return json(
          { error: "invalid_device", detail: `devices[${index}].${breach}` },
          400,
        );
      }
      if (powerReport.rejected) {
        console.warn("[ENERGY-OPTIMISATION] ignored invalid inventory power", {
          device_key: device.key,
        });
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
        inference: {
          ...device.inference,
          ...(powerReport.rejected ? {
            power_warning: "The reported power could not be used. A fresh estimate is needed.",
          } : {}),
        },
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
        .upsert(deviceRows, { onConflict: "home_id,device_key" });
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
        console.error(
          "[ENERGY-OPTIMISATION] device inventory read failed",
          activeError,
        );
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
          console.error(
            "[ENERGY-OPTIMISATION] device retirement failed",
            retireError,
          );
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
      console.error(
        "[ENERGY-OPTIMISATION] device inventory load failed",
        storedError,
      );
      return json({ error: "storage_failed" }, 500);
    }
    const { error: homeCreateError } = await supabase.from("energy_optimisation_home_planning")
      .upsert({ home_id: auth.homeId, customer_id: auth.customerId }, { onConflict: "home_id", ignoreDuplicates: true });
    if (homeCreateError) return json({ error: "home_planning_storage_failed" }, 500);
    if (equipment !== undefined) {
      const { error } = await supabase.from("energy_optimisation_home_planning")
        .update({ battery_present: equipment.battery }).eq("home_id", auth.homeId)
        .neq("battery_present", equipment.battery);
      if (error) return json({ error: "home_planning_storage_failed" }, 500);
    }
    const { data: homePlanning, error: homePlanningError } = await supabase
      .from("energy_optimisation_home_planning").select("battery_present, battery_included, battery_choice_at")
      .eq("home_id", auth.homeId).single();
    if (homePlanningError) return json({ error: "home_planning_unavailable" }, 500);
    if (snapshot) snapshot = applyBatteryChoice(snapshot, homePlanning.battery_included);
    const plannerLocation = snapshot || thermals.length ? await readPlannerLocation(supabase, auth.homeId, {
      endpoint: Deno.env.get("SHS_GEOCODER_URL") || undefined,
    }) : { coordinates: null, warnings: [] };
    if (snapshot) snapshot = withPlannerLocation(snapshot, plannerLocation);
    if (plannerLocation.warnings.length) console.warn("[ENERGY-LOCATION] planning continues without resolved address coordinates", { home_id: auth.homeId });
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
    const uploadedActuals = prepareActualUpload(actuals, storedDeviceByKey, {
      customer_id: auth.customerId, home_id: auth.homeId, device_token_id: auth.tokenId,
    }, now);
    const { actualRows, deviceSlotRows } = uploadedActuals;
    if (Object.keys(uploadedActuals.ignored).length) {
      console.warn("[ENERGY-OPTIMISATION] history items ignored; planning continues", {
        home_id: auth.homeId, request_id: requestId, counts: uploadedActuals.ignored,
      });
    }
    if (snapshot) snapshot = { ...snapshot,
      planning_warnings: mergePlanningWarnings(snapshot.planning_warnings, uploadedActuals.warnings) };

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

    const ignoredUploads: Record<string,number> = {};
    const ignoreUpload = (code:string) => { ignoredUploads[code]=(ignoredUploads[code]??0)+1; };
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
        ignoreUpload("invalid_price_start"); continue;
      }
      if (pricedStarts.has(start)) {
        ignoreUpload("duplicate_price_start"); continue;
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
        ignoreUpload("invalid_price"); continue;
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
    const houseRows: Record<string, unknown>[] = [];
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
        ignoreUpload("invalid_thermal_start"); continue;
      }
      if (thermalStarts.has(start)) {
        ignoreUpload("duplicate_thermal_start"); continue;
      }
      thermalStarts.add(start);

      const outdoor = temperature(thermal.outdoor_temperature_c);
      if (Number.isNaN(outdoor)) {
        ignoreUpload("invalid_outdoor_temperature"); continue;
      }
      if (outdoor !== null) {
        outdoorRows.push({
          customer_id: auth.customerId,
          home_id: auth.homeId,
          start_ts: new Date(start).toISOString(),
          temperature_c: outdoor,
          // Filled below, once the whole batch's timestamps are known and one
          // provider read can answer for all of them.
          solar_w_per_m2: null as number | null,
          device_token_id: auth.tokenId,
        });
      }

      const house = temperature(thermal.house_temperature_c);
      if (Number.isNaN(house)) {
        ignoreUpload("invalid_house_temperature"); continue;
      }
      if (house !== null) {
        houseRows.push({
          customer_id: auth.customerId,
          home_id: auth.homeId,
          start_ts: new Date(start).toISOString(),
          temperature_c: house,
          device_token_id: auth.tokenId,
        });
      }

      const observations = thermal.zone_observations;
      if (
        !observations || typeof observations !== "object" ||
        Array.isArray(observations)
      ) {
        ignoreUpload("invalid_zone_observations"); continue;
      }
      // Outdoor and house temperatures belong to the home, not to a zone, and
      // the pool's fit needs no zone at all. A quarter carrying only a home
      // reading is therefore a complete observation rather than a malformed
      // one; a quarter carrying none is still rejected.
      if (Object.keys(observations).length === 0 && outdoor === null && house === null) {
        ignoreUpload("invalid_zone_observations"); continue;
      }
      for (const [roomKey, observation] of Object.entries(observations)) {
        const storedRoom = storedRoomByKey.get(roomKey);
        const detail = `thermal_slots[${index}].zone_observations.${roomKey}`;
        if (!storedRoom || !observation || typeof observation !== "object") {
          ignoreUpload("invalid_zone_observations"); continue;
        }
        const room = temperature(observation.room_temperature_c);
        const duty = observation.actuator_duty;
        if (
          room === null || Number.isNaN(room) || typeof duty !== "number" ||
          !Number.isFinite(duty) || duty < 0 || duty > 1
        ) {
          ignoreUpload("invalid_zone_observations"); continue;
        }
        // Absent means no cooling, which is the case in almost every home.
        const cooling = observation.cooling_duty ?? 0;
        if (
          typeof cooling !== "number" || !Number.isFinite(cooling) ||
          cooling < 0 || cooling > 1
        ) {
          ignoreUpload("invalid_zone_observations"); continue;
        }
        const comfortMin = temperature(observation.comfort_min_c);
        const comfortMax = temperature(observation.comfort_max_c);
        const setpoint = temperature(observation.setpoint_c);
        if (
          Number.isNaN(comfortMin) || Number.isNaN(comfortMax) ||
          Number.isNaN(setpoint)
        ) {
          ignoreUpload("invalid_zone_observations"); continue;
        }
        // A band whose floor sits above its ceiling is a mapping error, not a
        // reading. Storing it would make every later constraint infeasible.
        if (
          comfortMin !== null && comfortMax !== null && comfortMin > comfortMax
        ) {
          ignoreUpload("invalid_comfort_band"); continue;
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

    // What the sun was doing over these quarters. Recorded now because it can
    // only be recovered for so long: the provider's history reaches back about
    // three months, so a quarter left unrecorded past that is unrecoverable,
    // and a zone can only ever learn from sunshine it has a record of.
    if (outdoorRows.length > 0) {
      const location = plannerLocation.coordinates;
      const irradiance = location
        ? await irradianceForQuarters({
          supabase,
          latitude: location.latitude,
          longitude: location.longitude,
          starts: outdoorRows.map((row) => row.start_ts as string),
        })
        : null;
      if (irradiance) {
        for (const [index, row] of outdoorRows.entries()) {
          row.solar_w_per_m2 = irradiance[index];
        }
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
    if (houseRows.length > 0) {
      // A room without its house boundary still fits on outdoor air, so a lost
      // house reading never costs the push that carried the room's own data.
      const { error } = await supabase
        .from("energy_optimisation_house_slots")
        .upsert(houseRows, { onConflict: "home_id,start_ts" });
      if (error) console.error("[ENERGY-OPTIMISATION] house temperature upsert failed", error);
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

    // Pool water temperature: the state the pool is scheduled against, and the
    // training series for its loss coefficient and its heat pump's COP (§8.3).
    const poolRows: Record<string, unknown>[] = [];
    if (pools.length > 0) {
      for (const row of pools) {
        const start = Date.parse(String(row?.start));
        const water = Number(row?.water_temperature_c);
        if (!Number.isFinite(start) || start % SLOT_MS !== 0 || start < earliestAcceptedStart || start > latestCompleteStart) {
          ignoreUpload("invalid_pool_slot"); continue;
        }
        if (!Number.isFinite(water) || water < -5 || water > 60) {
          ignoreUpload("invalid_pool_temperature"); continue;
        }
        poolRows.push({
          customer_id: auth.customerId,
          home_id: auth.homeId,
          start_ts: new Date(start).toISOString(),
          water_temperature_c: round(water, 3),
          quality: row?.quality ?? {},
          device_token_id: auth.tokenId,
        });
      }
    }
    if (Object.keys(ignoredUploads).length) {
      console.warn("[ENERGY-OPTIMISATION] history observations ignored; planning continues", {home_id:auth.homeId,counts:ignoredUploads});
      uploadedActuals.warnings = mergePlanningWarnings(uploadedActuals.warnings, Object.entries(ignoredUploads).map(([code,count]) =>
        planningWarning(code,"history",count+" invalid or out-of-window observations were ignored.",
          "Usable observations and household planning continue.",{count},count>=5?"error":"warning")));
      if (snapshot) snapshot.planning_warnings=mergePlanningWarnings(snapshot.planning_warnings,uploadedActuals.warnings);
    }
    if (poolRows.length > 0) {
      const { error } = await supabase
        .from("energy_optimisation_pool_slots")
        .upsert(poolRows, { onConflict: "home_id,start_ts" });
      if (error) {
        console.error("[ENERGY-OPTIMISATION] pool upsert failed", error);
        return json({ error: "storage_failed" }, 500);
      }
    }
    const thermalAcceptedUntil = thermalStarts.size > 0
      ? new Date(Math.max(...thermalStarts) + SLOT_MS).toISOString()
      : null;

    const { data: accepted, error: acceptedError } = await supabase.rpc('get_energy_replan_monitor', { p_home_id: auth.homeId });
    if (acceptedError) throw new Error(acceptedError.message);
    const recommend = async (key: string, reason: string, at = new Date().toISOString()) => {
      const { error } = await supabase.rpc('recommend_energy_replan', {
        p_home_id: auth.homeId, p_key: key, p_reason: reason, p_occurred_at: at,
      });
      if (error) throw new Error(error.message);
    };
    if (replanRecommendation) await recommend('integration_change', replanRecommendation);
    if (accepted?.plan?.status === 'ready') {
      const { data: measured, error } = await supabase.from('energy_optimisation_actual_slots')
        .select('start_ts,total_load_kwh').eq('home_id', auth.homeId)
        .gte('start_ts', new Date(Date.now() - 5 * SLOT_MS).toISOString()).order('start_ts');
      if (error) throw new Error(error.message);
      // A reading that could not be real is named on the next plan, never
      // compared against this one. A malformed issue list is refused by the
      // planner itself if this snapshot is solved.
      let observed: OptimisationSnapshot | null = null;
      try {
        observed = snapshot ? isolateMeasurements(snapshot) : null;
      } catch (isolationError) {
        console.warn("[ENERGY-OPTIMISATION] measurement issues unreadable", describeThrown(isolationError));
      }
      for (const warning of [
        ...deviationRecommendations(accepted.plan, (measured ?? []) as DeviationActual[], observed, new Date()),
        ...recoveredMeasurementRecommendations(accepted.plan, observed),
      ]) await recommend(warning.key, warning.reason, warning.occurred_at);
    }
    // Exchanging telemetry is not permission to replace an accepted schedule.
    // A manual request may be picked up by either the listener or quarter poll.
    const pendingManual = accepted?.replan_request_id && !accepted.replan_error &&
      accepted.replan_request_id !== accepted.replan_completed_request_id && snapshot &&
      portalReplanId === accepted.replan_request_id;
    const planningTrigger = { source: accepted?.plan ? "price_release" : "initial_plan", forced: false,
      reason: { code: accepted?.plan ? "new_published_prices" : "no_accepted_plan" } };
    const admitSnapshot = snapshot !== null && shouldAdmitPlanningSnapshot({
      hasAcceptedPlan: !!accepted?.plan, pendingManual: !!pendingManual,
      newPublishedPrices: hasNewPublishedPrices(accepted?.snapshot ?? null, snapshot), executionReplan,
    });
    if (snapshot && !admitSnapshot) {
      const refresh = refreshPreparedForecasts(supabase, auth.customerId, auth.homeId,
        structuredClone(snapshot)).catch(error =>
          console.error("[ENERGY-FORECAST] preparation failed", describeThrown(error)));
      EdgeRuntime.waitUntil(refresh);
    }
    if (snapshot) {
      const owners = new Map<string, { kind: "room"; key: string; requested: boolean; input: {
        location: OptimisationSnapshot["location"] | null;
        devices: { key: string; active_power_w: number | null }[];
      } }>();
      for (const device of storedDevices) {
        const room = roomMapping(device);
        if (!room) continue;
        const owner = owners.get(room.key) ?? { kind: "room" as const, key: room.key, requested: false,
          input: { location: snapshot.location ?? null, devices: [] as { key: string; active_power_w: number | null }[] } };
        owner.requested ||= device.planning_role_override === "controllable" &&
          ["setpoint", "switch_schedule"].includes(device.control_type_override ?? "");
        owner.input.devices.push({ key: device.key, active_power_w: device.active_power_w });
        owners.set(room.key, owner);
      }
      const unique = [...owners.values()].filter(owner => owner.requested).map(owner => ({ kind: owner.kind, key: owner.key,
        input: { ...owner.input, devices: owner.input.devices.sort((a, b) => a.key.localeCompare(b.key)) } }));
      const poolOwner = poolLearningOwner(snapshot.pool, snapshot.device_models);
      const learning = requestDeviceLearning(supabase, auth.homeId, auth.customerId, [
        ...unique, ...(poolOwner ? [poolOwner] : []),
      ]).catch(error => console.error("[ENERGY-LEARNING] enqueue failed", describeThrown(error)));
      // Enqueue is a small durable transaction, not an in-request fit.
      await learning;
    }
    if (snapshot && !admitSnapshot) {
      snapshot = null;
    }

    let planningReceipt: PlanningReceipt | null = null;
    if (snapshot !== null) {
      // The forecast is prepared from the snapshot as the home sent it.
      const forecastSource = snapshot;
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
      const [targetResult, settingsResult] = await Promise.all([
        supabase.from("energy_optimisation_comfort_targets")
          .select("pool_target_c, ev_target_soc").eq("home_id", auth.homeId).maybeSingle(),
        supabase.from("energy_optimisation_value_settings")
          .select("battery_degradation_sek_per_kwh, vehicle_fallback_sek_per_km").eq("home_id", auth.homeId).maybeSingle(),
      ]);
      if (targetResult.error) throw new Error(targetResult.error.message);
      // The grid import limit is the owner's answer in the home profile: the
      // main fuse, or less if they chose less. The figure a snapshot carries is
      // not used.
      const importLimitW = await readHomeGridImportLimitW(supabase, auth.homeId);
      if (importLimitW === null) {
        return json({ error: "invalid_snapshot",
          detail: "The home profile on the website has no main fuse size, so the plan has no grid import limit" }, 400);
      }
      const { value_curves: _curves, ...withoutCurves } = snapshot;
      snapshot = {
        ...withoutCurves,
        grid: { ...snapshot.grid, import_limit_w: importLimitW },
        // The same car battery the planner plans with turns the charge level into a range.
        comfort: comfortTargets(targetResult.data, snapshot.device_physics?.car?.battery ??
          (snapshot.ev_battery && Number.isFinite(snapshot.ev_battery.kwh_per_km)
            ? { capacity_kwh: snapshot.ev_battery.capacity_kwh, kwh_per_km: snapshot.ev_battery.kwh_per_km! } : null)),
        value_settings: resolveValueSettings(settingsResult.data),
        battery_curve_mode: "balanced",
      };

      let modelBundle: DeviceModelBundle | null = null;
      try {
        modelBundle = await captureDeviceModels(supabase, auth.homeId);
      } catch (error) {
        console.warn("[ENERGY-OPTIMISATION] optional device models unavailable", describeThrown(error));
        snapshot.planning_warnings = mergePlanningWarnings(snapshot.planning_warnings, [planningWarning(
          "device_model_read", "models", "Stored device model evidence could not be read.",
          "Planning continues with known comfort intent, current equipment and measured demand.")]);
      }
      // Device models own their prepared response, startup and hardware facts.
      if (snapshot.pool) {
        const poolModel = modelBundle?.pool ?? null;
        // The home reads the heat pump's own start and stop settings with every
        // snapshot. The stored copy serves only a home that does not send them.
        let reportedHardware: PoolHardware | null = null;
        try {
          reportedHardware = reportedPoolHardware(snapshot.pool);
        } catch (error) {
          snapshot.planning_warnings=mergePlanningWarnings(snapshot.planning_warnings,[planningWarning("pool_hardware_evidence","pool",
            describeThrown(error),"Pool service uses known comfort intent and measured demand while hardware evidence is unavailable.")]);
        }
        if (reportedHardware && poolModel && !samePoolHardware(poolModel.hardware, reportedHardware)) {
          const { error } = await supabase.from("energy_optimisation_pool_model")
            .update({ hardware: reportedHardware }).eq("home_id", auth.homeId);
          // This plan already uses what the home reported; the next one stores it.
          if (error) console.error("[ENERGY-OPTIMISATION] pool hardware not stored", error.message);
        }
        const poolHardware = reportedHardware ?? poolModel?.hardware;
        if (poolModel?.last_fit_attempt?.issues?.length) {
          snapshot.planning_warnings = mergePlanningWarnings(snapshot.planning_warnings, [planningWarning("pool_model_quality", "pool",
            "Pool model evidence needs attention: " + poolModel.last_fit_attempt.issues.join(", ") + ".",
            "Planning continues with the latest usable parameters and measured response.")]);
        }
        // The idle loss stands on its own; the joint fit adds the COP when it
        // has one. Either is enough to stop planning on the seeded loss.
        const copFitted = Boolean(poolModel?.loss_kw_per_k && poolModel?.rated_cop);
        const lossKwPerK = poolModel?.idle_loss_kw_per_k ?? (copFitted ? poolModel?.loss_kw_per_k : null);
        // The measured response stands on its own too: it needs no air
        // temperature, so it can exist where neither fit does. The planner's
        // seeded loss then only fills in what the response did not measure.
        const poolResponse = Array.isArray(poolModel?.response) && poolModel.response.length > 0
          ? poolModel.response
          : null;
        let heaterResponse;
        try { if(poolModel?.heater_response) heaterResponse=parseHeaterResponse(poolModel.heater_response); }
        catch(error) { snapshot.planning_warnings=mergePlanningWarnings(snapshot.planning_warnings,[planningWarning("pool_response_evidence","pool",
          describeThrown(error),"Pool thermostat permission remains active using empirical demand.")]); }
        if (lossKwPerK || poolResponse || heaterResponse || poolHardware) {
          snapshot = {
            ...snapshot,
            pool_model: {
              ...(poolHardware ? { hardware: poolHardware } : {}),
              ...(heaterResponse ? { heater_response: heaterResponse } : {}),
              ...(poolModel?.thermal_dynamics ? { thermal_dynamics: poolModel.thermal_dynamics } : {}),
              ...(poolResponse ? { response: poolResponse } : {}),
              loss_kw_per_k: lossKwPerK ? Number(lossKwPerK) : null,
              rated_cop: copFitted ? Number(poolModel!.rated_cop) : null,
              cop_per_air_c: copFitted ? Number(poolModel!.cop_per_air_c ?? 0) : null,
              // Null stays null: the planner reads it as "no cut-out on
              // record" and applies none, which is not the same as zero.
              cutout_air_c: poolModel?.cutout_air_c === null ||
                  poolModel?.cutout_air_c === undefined
                ? null
                : Number(poolModel.cutout_air_c),
            },
          };
          if (snapshot.pool_model?.thermal_dynamics) {
            try {
              const state = await capturedPoolResponseState(supabase, auth.homeId, snapshot, snapshot.pool_model.thermal_dynamics);
              snapshot.pool_model.pending_heat_kwh = state.pending_heat_kwh;
              snapshot.pool_model.source_depletion_kwh = state.source_depletion_kwh;
            } catch (error) {
              console.error("[ENERGY-OPTIMISATION] pool response state unavailable", describeThrown(error));
              snapshot.planning_warnings = mergePlanningWarnings(snapshot.planning_warnings, [planningWarning("pool_response_evidence", "pool",
                describeThrown(error), "Pool service retains known comfort intent and measured demand while response history is unavailable.")]);
            }
          }
        }
      }

      const { data: fixedState, error: fixedReadError } = await supabase.rpc("get_energy_replan_state", { p_home_id: auth.homeId });
      if (fixedReadError) return json({ error: "fixed_plan_read_failed" }, 500);
      const fixedPlan = fixedState?.fixed_plan as FixedEnergyPlan | null;
      const fixedRevision = fixedState?.fixed_plan_revision ?? 0;
      try {
        if (executionReplan) {
          if (fixedState?.ha_ack_status !== "accepted") throw new ExecutionReplanError("execution_reference_changed", "The current publication must be acknowledged by Home Assistant before applying execution evidence", 409);
          executionReplan = validateExecutionReplan(executionReplan, fixedState.published_commands ?? null, snapshot);
        }
        const prepared = await readOrPrepareForecasts(supabase as unknown as PreparedForecastDatabase, auth.homeId, snapshot,
          () => refreshPreparedForecasts(supabase, auth.customerId, auth.homeId, structuredClone(forecastSource)));
        // Comfort routines and room temperatures are read now, never from the prepared copy.
        const thermal = prepareRoomModels(prepared.snapshot, storedDevices.map(device => ({
          key: device.key, control_type_override: device.control_type_override, room: roomMapping(device),
        })), modelBundle);
        snapshot = await captureRoomPlanningState(supabase, auth.customerId, auth.homeId, thermal.snapshot, thermal.rooms);
        const { data: savedRules, error: rulesError } = await supabase.from("energy_planner_rule_policy")
          .select("criteria").eq("id", true).single();
        if (rulesError) throw new Error(rulesError.message);
        const planningNow = new Date();
        const planningInput = { snapshot, now: planningNow.toISOString(),
          fixed_plan: fixedPlan, resolved_price_outlook: prepared.price_outlook, execution_replan: executionReplan };
        const rulesInput = trace.run("admission_preparation", () => captureRulesPlanningInput(planningInput,
          fixedState?.published_commands ?? null, resolveRulePolicy(savedRules.criteria)),
          { rooms: snapshot.thermal_zones?.length ?? 0, slots: snapshot.slots.length });
        const planningStarted = performance.now();
        console.info("[ENERGY-OPTIMISATION] inputs ready", { request_id: requestId, replan_request_id: portalReplanId,
          elapsed_ms: Math.round(planningStarted - ingestStarted) });
        const admitted = trace.start("job_admission");
        planningReceipt = await jobs.accept({
          homeId: auth.homeId, customerId: auth.customerId,
          snapshotId: snapshot.snapshot_id, sourceHash: sourceHash!,
          input: rulesInput,
          context: {
            request_id: requestId, integration_version: integrationVersion,
            model_capture_status: modelBundle ? "captured" : "unavailable",
            ...(modelBundle ? { model_revisions: modelBundle.revisions } : {}),
            reference_plan_id: fixedState?.reference_plan_id ?? null, fixed_revision: fixedRevision,
            observed_replan_request_id: accepted?.replan_request_id ?? null,
            replan_request_id: portalReplanId, execution_replan: executionReplan, planning_trigger: planningTrigger,
            completion_basis: planningCompletionBasis(Deno.env.get("SUPABASE_URL") ?? ""),
            exchange: {
              planning_warnings: uploadedActuals.warnings,
              actual_slots_ignored: uploadedActuals.ignored,
              actual_slots_accepted: actualRows.length,
              actuals_accepted_until: actualRows.at(-1)?.start_ts ?? null,
              thermal_slots_accepted: thermalRows.length,
              thermal_slots_accepted_until: thermalAcceptedUntil,
              price_slots_accepted: priceRows.length,
              home_configuration: { battery: { included: homePlanning.battery_included, choice_at: homePlanning.battery_choice_at } },
              device_configuration: storedDevices.map((device) => ({
                key: device.key, statistic_id: device.statistic_id, name: device.name,
                category: device.category, suggested_load_type: device.suggested_load_type,
                load_type: device.load_type_override, ...effectivePlanning(device),
                mapping_status: device.mapping_status, mapped_control_type: device.mapped_control_type,
              })),
            },
          },
        });
        admitted({ job_id: planningReceipt.job_id });
        // Admission returns the durable receipt. HA's existing status loop
        // runs the complete solve in a fresh request, preserving ingest's CPU.
        console.info("[ENERGY-OPTIMISATION] planning response", {
          request_id: requestId, job_id: planningReceipt.job_id, state: planningReceipt.state,
          elapsed_ms: Math.round(performance.now() - planningStarted),
        });
      } catch (error) {
        const detail = describeThrown(error);
        console.error("[ENERGY-OPTIMISATION] preparation refused", detail, error);
        if (error instanceof PlanningJobError || error instanceof ExecutionReplanError) return json({ error: error.code, detail }, error.status);
        return json({ error: "invalid_snapshot", detail }, 400);
      }
    }

    // Deliver accepted job receipts before retention maintenance. Ordinary
    // telemetry exchanges drain bounded batches independently of replanning.
    if (!planningReceipt) {
      const { error: pruneError } = await supabase.rpc(
        "prune_energy_optimisation_data",
        { p_home_id: auth.homeId },
      );
      if (pruneError) {
        console.error("[ENERGY-OPTIMISATION] retention prune failed", pruneError);
      }
    }

    const { data: recommendationState, error: recommendationError } = await supabase.from('energy_optimisation_current')
      .select('replan_recommendations').eq('home_id', auth.homeId).maybeSingle();
    if (recommendationError) throw new Error(recommendationError.message);
    EdgeRuntime.waitUntil(recordPlanningActivity(supabase, auth.homeId, auth.customerId, {
      receipt_id: requestId, source: 'home_assistant',
      counts: { actuals: actualRows.length, devices: deviceSlotRows.length, thermal: thermalRows.length,
        pool: poolRows.length, prices: priceRows.length }, warnings: uploadedActuals.warnings,
    }));
    return json({
      replan_recommendations: recommendationState?.replan_recommendations ?? [],
      planning_warnings: uploadedActuals.warnings,
      actual_slots_ignored: uploadedActuals.ignored,
      actual_slots_accepted: actualRows.length,
      actuals_accepted_until: actualRows.length > 0
        ? actualRows[actualRows.length - 1].start_ts
        : null,
      thermal_slots_accepted: thermalRows.length,
      thermal_slots_accepted_until: thermalAcceptedUntil,
      price_slots_accepted: priceRows.length,
      plan_id: null,
      snapshot_id: null,
      plan: null,
      ...planningReceipt,
      home_configuration: { battery: { included: homePlanning.battery_included, choice_at: homePlanning.battery_choice_at } },
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
    }, planningReceipt?.pending ? 202 : 200);
  } catch (error) {
    console.error("[ENERGY-OPTIMISATION] unexpected", error);
    if (error instanceof PlanningJobError) return json({ error: error.code, detail: error.message }, error.status);
    return json({ error: "internal_error" }, 500);
  }
}));
