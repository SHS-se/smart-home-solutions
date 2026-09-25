import { hasNewPublishedPrices, deviationRecommendations, recoveredMeasurementRecommendations, type DeviationActual } from '../_shared/replan-policy.ts';
import { isolateMeasurements } from '../_shared/measurement-isolation.ts';
import { resolveCostCurve } from "../_shared/battery-cost-selection.ts";
import { deviceContractBreach, roomMapping, type IncomingDevice, type RoomMapping, type DeviceMappingStatus } from "./device-contract.ts";
import type { BatteryProjection } from "../_shared/battery-dispatch-projection.ts";
import { replanReference, type ReplanPreviousPlan } from "../_shared/replan-continuity.ts";
import { withTrafficMetrics } from "../_shared/edge-traffic.ts";
import type { FixedEnergyPlan } from "../_shared/fixed-energy-plan.ts";
import { applyBatteryChoice } from "../_shared/home-planning.ts";
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
  type generateOptimisationPlan,
  type OptimisationSnapshot,
} from "../_shared/energy-optimisation.ts";
import {
  EnergyPlanningError,
  generateRemoteOptimisationPlan,
} from "../_shared/energy-planning-client.ts";
import { type StoredPriceRow } from "../_shared/energy-price-shape.ts";
import { storedPlan } from "../_shared/stored-plan.ts";
import {
  buildThermalProjection,
  fitZones,
  type ProjectionZoneInput,
  REFIT_INTERVAL_HOURS,
  type ThermalMomentRow,
  TRAINING_WINDOW_DAYS,
  zoneModelRows,
} from "../_shared/thermal-training.ts";
import { MIN_TRAINING_SAMPLES } from "../_shared/thermal-model.ts";
import {
  resolveValueCurves,
  resolveValueSettings,
} from "../_shared/value-curves.ts";
import {
  fitPoolModel,
  type PoolTrainingSample,
  poolRefitIsDue,
  poolTrainingWindowStartMs,
} from "../_shared/pool-training.ts";
import {
  buildComfortForecast,
  isZoneComfortSchedule,
  summerHeatingLockoutForStarts,
  type ZoneComfortSchedule,
} from "../_shared/comfort-schedule.ts";
import {
  classifyOutdoorSeries,
  homeLocation,
  outdoorSeriesFromProvider,
} from "../_shared/outdoor-forecast.ts";
import {
  irradianceForQuarters,
  irradianceOnto,
  irradiancePoints,
} from "../_shared/solar-irradiance.ts";
import {
  gridRound,
  type WeatherPoint,
} from "../_shared/weather-cache.ts";

/**
 * Training quarters given an irradiance figure per push.
 *
 * A three-week window is 2016 quarters, and filling all of them in one request
 * costs more CPU than a worker is given. Refits are daily and pushes are
 * quarter-hourly, so a bounded batch closes the same gap within an hour and
 * never competes with the plan the household is actually waiting for.
 */
const BACKFILL_QUARTERS_PER_PUSH = 250;

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
  snapshot: OptimisationSnapshot;
  zones: ProjectionZoneInput[];
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
  zones: [],
});


/**
 * Fill in irradiance for training quarters recorded before it was collected.
 *
 * Bounded by construction: a three-week window is at most 2016 quarters, and
 * this runs only when a refit is actually due — at most daily. It never
 * invents a figure; quarters the provider cannot answer for stay null and are
 * simply quarters the sun cannot be fitted from.
 */
async function backfillTrainingIrradiance(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  homeId: string,
  points: WeatherPoint[] | null,
  from: string,
  to: string,
): Promise<void> {
  if (!points) return;
  try {
    // The whole row comes back, not just its timestamp. An upsert has to
    // present a tuple that could legally be inserted before its conflict
    // clause is ever reached, and `customer_id` and `temperature_c` are NOT
    // NULL — a three-column patch would be rejected outright rather than
    // resolving to an update.
    type OutdoorRow = {
      customer_id: string;
      home_id: string;
      start_ts: string;
      temperature_c: number;
      device_token_id: string | null;
    };
    const { data: missing } = await supabase
      .from("energy_optimisation_outdoor_slots")
      .select("customer_id, home_id, start_ts, temperature_c, device_token_id")
      .eq("home_id", homeId)
      .is("solar_w_per_m2", null)
      .gte("start_ts", from)
      .lt("start_ts", to)
      .order("start_ts")
      .limit(BACKFILL_QUARTERS_PER_PUSH);
    const existing = (missing ?? []) as OutdoorRow[];
    if (existing.length === 0) return;

    const irradiance = irradianceOnto(
      points,
      existing.map((row) => row.start_ts),
    );
    const rows = existing
      .map((row, index) => ({ ...row, solar_w_per_m2: irradiance[index] }))
      .filter((row) => row.solar_w_per_m2 !== null);
    if (rows.length === 0) return;

    // One statement per quarter would be thousands of round trips, so the
    // fill goes back as a single upsert onto the rows that already exist.
    const { error } = await supabase
      .from("energy_optimisation_outdoor_slots")
      .upsert(rows, { onConflict: "home_id,start_ts" });
    if (error) {
      console.error("[ENERGY-OPTIMISATION] irradiance backfill failed", error);
    }
  } catch (error) {
    // A zone that cannot learn from the sun today still fits without it.
    console.error("[ENERGY-OPTIMISATION] irradiance backfill skipped", error);
  }
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

/**
 * Refit the pool's loss and COP, at the same cadence as the room models.
 *
 * The training set joins three series the ingest path already stores: water
 * temperature, the pool heater's metered energy, and outdoor temperature. All
 * three are on the same quarter boundaries, so the join is exact rather than
 * interpolated.
 *
 * A refusal is written down as readily as a fit. Through a Swedish summer the
 * pool sits at temperature and the heater barely runs, so there is no COP to
 * identify for months — recording that is what lets the planner fall back to
 * its seeded figures deliberately instead of by accident.
 */
async function refitPoolModel(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  customerId: string,
  homeId: string,
  volumeM3: number,
  poolDeviceKeys: string[],
): Promise<void> {
  const now = Date.now();
  const { data: existing } = await supabase
    .from("energy_optimisation_pool_model")
    .select("fitted_at, heat_pump_epoch_start")
    .eq("home_id", homeId)
    .maybeSingle();
  const lastFit = existing?.fitted_at ? Date.parse(existing.fitted_at) : 0;
  // Samples from before the current heat pump was commissioned describe a
  // different machine, so the window is clamped to it and a newly recorded
  // epoch invalidates the standing fit at once rather than a day later.
  const epochStart = existing?.heat_pump_epoch_start
    ? Date.parse(existing.heat_pump_epoch_start)
    : null;
  if (!poolRefitIsDue(now, lastFit, epochStart, REFIT_INTERVAL_HOURS)) return;

  const from = new Date(
    poolTrainingWindowStartMs(now, epochStart, TRAINING_WINDOW_DAYS),
  ).toISOString();
  // The heater's energy is stored against `device_id`, so the pool's device
  // keys have to be resolved to ids before the slots can be filtered by them.
  // Without any, there is no heated quarter to find and no fit to attempt.
  const { data: poolDevices, error: poolDeviceError } = await supabase
    .from("energy_optimisation_devices")
    .select("id")
    .eq("home_id", homeId)
    .in("device_key", poolDeviceKeys);
  if (poolDeviceError) {
    console.error("[ENERGY-OPTIMISATION] pool device read failed", poolDeviceError);
    return;
  }
  const poolDeviceIds = (poolDevices ?? []).map((row: Record<string, unknown>) =>
    String(row.id)
  );
  if (poolDeviceIds.length === 0) return;

  const [water_, outdoor_, device_] = await Promise.all([
    supabase.from("energy_optimisation_pool_slots")
      .select("start_ts, water_temperature_c")
      .eq("home_id", homeId).gte("start_ts", from).order("start_ts"),
    supabase.from("energy_optimisation_outdoor_slots")
      .select("start_ts, temperature_c")
      .eq("home_id", homeId).gte("start_ts", from),
    supabase.from("energy_optimisation_device_slots")
      .select("start_ts, energy_kwh")
      .eq("home_id", homeId).gte("start_ts", from)
      .in("device_id", poolDeviceIds),
  ]);
  // A failed read is not a refusal to fit. Treating it as one would write a
  // rejection that reads like a Swedish summer, stamp `fitted_at` with it, and
  // then sit on that answer for the whole refit interval.
  const readError = water_.error ?? outdoor_.error ?? device_.error;
  if (readError) {
    console.error("[ENERGY-OPTIMISATION] pool training read failed", readError);
    return;
  }
  const waterRows = water_.data;
  const outdoorRows = outdoor_.data;
  const deviceRows = device_.data;

  const outdoorByStart = new Map<number, number>(
    (outdoorRows ?? []).map((row: Record<string, unknown>) => [
      Date.parse(String(row.start_ts)),
      Number(row.temperature_c),
    ]),
  );
  const heaterByStart = new Map<number, number>();
  for (const row of deviceRows ?? []) {
    const at = Date.parse(String(row.start_ts));
    heaterByStart.set(
      at,
      (heaterByStart.get(at) ?? 0) + Number(row.energy_kwh),
    );
  }

  const water = (waterRows ?? []).map((row: Record<string, unknown>) => ({
    at: Date.parse(String(row.start_ts)),
    c: Number(row.water_temperature_c),
  }));
  const samples: PoolTrainingSample[] = [];
  for (let index = 0; index + 1 < water.length; index += 1) {
    const current = water[index];
    const next = water[index + 1];
    // Only consecutive quarters describe one slot's change. A gap would put an
    // hour of cooling into a fifteen-minute rate and bias the loss upward.
    if (next.at - current.at !== SLOT_MS) continue;
    const air = outdoorByStart.get(current.at);
    if (air === undefined || !Number.isFinite(air)) continue;
    samples.push({
      water_temperature_c: current.c,
      next_water_temperature_c: next.c,
      outdoor_temperature_c: air,
      electrical_kwh: heaterByStart.get(current.at) ?? 0,
    });
  }

  const result = fitPoolModel(samples, volumeM3);
  const row = "fitted" in result
    ? {
      home_id: homeId,
      customer_id: customerId,
      fitted_at: new Date(now).toISOString(),
      ...result.fitted,
      rejection: null,
    }
    : {
      home_id: homeId,
      customer_id: customerId,
      fitted_at: new Date(now).toISOString(),
      loss_kw_per_k: null,
      rated_cop: null,
      cop_per_air_c: null,
      background_kw: null,
      r2: null,
      sample_count: result.sample_count,
      heated_sample_count: result.heated_sample_count,
      rejection: result.rejected,
    };
  const { error } = await supabase
    .from("energy_optimisation_pool_model")
    .upsert(row, { onConflict: "home_id" });
  if (error) console.error("[ENERGY-OPTIMISATION] pool refit failed", error);
}

async function prepareThermalPlanning(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  customerId: string,
  homeId: string,
  snapshot: OptimisationSnapshot,
  storedDevices: StoredDevice[],
): Promise<PreparedThermalPlanning> {
  const storedByKey = new Map(
    storedDevices.map((device) => [device.key, device]),
  );
  const roomModels = snapshot.device_models.filter((model) => {
    if (model.planning_service === "pool") return false;
    if (model.control_type === "setpoint") return true;
    if (model.control_type !== "switch_schedule") return false;
    const stored = storedByKey.get(model.key);
    return stored?.control_type_override === model.control_type &&
      roomMapping(stored) !== null;
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
    const room = stored ? roomMapping(stored) : null;
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
      zones: [],
    };
  }

  const classified = classifyOutdoorSeries(
    snapshot.outdoor_temperature_c,
    snapshot.slots.length,
  );
  if (classified.status === "holed") {
    throw new Error(
      "room comfort forecasting needs outdoor temperature for every slot",
    );
  }
  let outdoor: number[];
  if (classified.status === "complete") {
    outdoor = classified.series;
  } else {
    // Home Assistant's adapter did not reach the end of the horizon. The
    // weather usually still exists — met.no publishes ten days of it — so ask
    // the provider directly before planning the rooms blind, using the
    // coordinates the snapshot already declares.
    const location = homeLocation(snapshot);
    if (!location) return withoutComfortForecast(snapshot);
    const { latitude, longitude } = location;
    const provided = await outdoorSeriesFromProvider({
      supabase,
      latitude,
      longitude,
      starts,
    });
    if (!provided) return withoutComfortForecast(snapshot);
    outdoor = provided.series;
    snapshot = {
      ...snapshot,
      outdoor_temperature_c: provided.series,
      sources: {
        ...snapshot.sources,
        outdoor_temperature: {
          provider: "met_no_locationforecast",
          // No Home Assistant entity stands behind this one; the portal
          // reads the empty list as "the planner fetched this itself".
          entity_ids: [],
          issued_at: provided.issuedAt,
          valid_until: new Date(
            Date.parse(starts[starts.length - 1]) + SLOT_MS,
          ).toISOString(),
          quality: "provider_raw",
          sample_count: provided.points,
          location: {
            latitude: gridRound(latitude),
            longitude: gridRound(longitude),
          },
        },
      },
    };
  }

  // What the sun is expected to do over the horizon. A zone fitted with a
  // solar term projects far better with this than without, but it is never
  // required: `backgroundRateForSlot` falls back to the mean irradiance the
  // zone was fitted on, which is exactly the flat background a three-regressor
  // fit would have used. So an Open-Meteo outage costs accuracy and nothing
  // else, and is not allowed to shorten the horizon the way missing
  // temperature would.
  const solarLocation = homeLocation(snapshot);
  // Fetched once and resampled twice: an edge function has 50 ms of CPU, and
  // this series is some 2200 points. Reading it a second time for the training
  // backfill is what pushed the whole request past the worker's limit.
  //
  // A partial result is welcome here, unlike a partial temperature forecast:
  // each slot falls back to the fitted mean on its own, so covering what the
  // provider knows is strictly better than covering none of it.
  const solarPoints = solarLocation
    ? await irradiancePoints({
      supabase,
      latitude: solarLocation.latitude,
      longitude: solarLocation.longitude,
    })
    : null;
  const solar = solarPoints ? irradianceOnto(solarPoints, starts) : null;
  if (solar) {
    snapshot = { ...snapshot, solar_irradiance_w_per_m2: solar };
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
    // Quarters recorded before irradiance was collected have none, and a fit
    // will not mix covered quarters with uncovered ones. The provider's own
    // history reaches back three months against a three-week window, so the
    // gap is closed here rather than waiting a window's worth of pushes for
    // the sun to become fittable.
    await backfillTrainingIrradiance(
      supabase,
      homeId,
      solarPoints,
      trainingFrom,
      trainingTo,
    );
    const { data: moments, error } = await supabase.rpc(
      "get_energy_thermal_training_moments",
      {
        p_customer_id: customerId,
        p_home_id: homeId,
        p_from: trainingFrom,
        p_to: trainingTo,
        p_min_samples: MIN_TRAINING_SAMPLES,
      },
    );
    // A refit is maintenance, not a precondition. Whatever goes wrong while
    // re-learning a zone, the home still has the models it had a moment ago
    // and is still owed a plan — so this is logged and stepped over rather
    // than thrown, which would reject the snapshot and stop the house.
    if (error) {
      console.error("[ENERGY-OPTIMISATION] zone refit skipped", error);
    } else {
      const fits = fitZones((moments ?? []) as ThermalMomentRow[]);
      if (fits.length > 0) {
        const { error: upsertError } = await supabase
          .from("energy_optimisation_zone_models")
          .upsert(
            zoneModelRows(fits, {
              customerId,
              homeId,
              trainingFrom,
              trainingTo,
            }),
            { onConflict: "home_id,room_key" },
          );
        if (upsertError) {
          console.error(
            "[ENERGY-OPTIMISATION] zone models not stored",
            upsertError,
          );
        }
      }
    }
  }

  const [trainedResult, latestResult, scheduleResult] = await Promise.all([
    supabase
      .from("energy_optimisation_zone_models")
      .select(
        "room_key, room_name, gain_c_per_wh, cooling_constant_per_h, background_gain_c_per_h, solar_gain_c_per_h_per_wm2, solar_mean_w_per_m2, thermal_capacity_wh_per_c, heat_loss_w_per_c, time_constant_h, heating_rate_c_per_h, r2, residual_std_c, sample_count",
      )
      .eq("home_id", homeId)
      .eq("trained", true),
    // The trajectory starts from a real room reading no more than six hours
    // old. A guessed midpoint would describe a different house.
    supabase.rpc("get_energy_latest_room_temperatures", {
      p_customer_id: customerId,
      p_home_id: homeId,
      p_from: new Date(now - 6 * 3_600_000).toISOString(),
    }),
    supabase
      .from("energy_optimisation_comfort_schedules")
      .select(
        "room_key, room_name, weekday_modes, weekend_modes, off_temperature_c, low_temperature_c, high_temperature_c",
      )
      .eq("home_id", homeId),
  ]);
  // Room comfort needs all three of these. Losing them is the same situation
  // as having no weather: the rooms cannot be forecast, and every other load
  // still plans on prices and its own recent history.
  for (
    const result of [
      trainedResult,
      latestResult,
      scheduleResult,
    ]
  ) {
    if (result.error) {
      console.error(
        "[ENERGY-OPTIMISATION] comfort inputs unreadable",
        result.error,
      );
      return withoutComfortForecast(snapshot);
    }
  }

  const trainedByRoom = new Map<string, Record<string, unknown>>(
    (trainedResult.data ?? []).map((model: Record<string, unknown>) =>
      [
        model.room_key as string,
        model,
      ] as const
    ),
  );
  const latestByRoom = new Map<string, Record<string, unknown>>();
  for (const row of latestResult.data ?? []) {
    if (!latestByRoom.has(row.room_key)) latestByRoom.set(row.room_key, row);
  }
  const scheduleByRoom = new Map<string, Record<string, unknown>>(
    (scheduleResult.data ?? []).map((schedule: Record<string, unknown>) =>
      [
        schedule.room_key as string,
        schedule,
      ] as const
    ),
  );
  const forecasts = new Map<string, number[]>();

  const zones: ProjectionZoneInput[] = [];
  const planningZones: NonNullable<OptimisationSnapshot["thermal_zones"]> = [];
  // A room that cannot be comfort-forecast is skipped, not fatal. Refusing the
  // whole snapshot for one room meant any single zone the fit declined — too
  // few samples, a sensor the fit cannot separate from outdoor air, a comfort
  // routine nobody has filled in yet — stopped the battery, boiler, pool and
  // car being planned at all. A skipped room keeps its recent-history profile,
  // exactly as it had before comfort forecasting existed, while its neighbours
  // are still planned properly.
  const skipped: string[] = [];
  for (const room of rooms.values()) {
    const fitted = trainedByRoom.get(room.key);
    if (!fitted) {
      skipped.push(`${room.name}: no trained thermal model`);
      continue;
    }
    const observation = latestByRoom.get(room.key);
    if (
      !observation || !Number.isFinite(Number(observation.room_temperature_c))
    ) {
      skipped.push(`${room.name}: no recent room temperature`);
      continue;
    }
    const rawSchedule = scheduleByRoom.get(room.key);
    const schedule: ZoneComfortSchedule | null = rawSchedule
      ? {
        weekday_modes: rawSchedule
          .weekday_modes as ZoneComfortSchedule["weekday_modes"],
        weekend_modes: rawSchedule
          .weekend_modes as ZoneComfortSchedule["weekend_modes"],
        off_temperature_c: Number(rawSchedule.off_temperature_c),
        low_temperature_c: Number(rawSchedule.low_temperature_c),
        high_temperature_c: Number(rawSchedule.high_temperature_c),
      }
      : null;
    if (!isZoneComfortSchedule(schedule)) {
      skipped.push(`${room.name}: comfort schedule missing or invalid`);
      continue;
    }
    const ratedPowerW = room.models.reduce(
      (sum, model) => sum + Number(model.active_power_w ?? 0),
      0,
    );
    if (!Number.isFinite(ratedPowerW) || ratedPowerW <= 0) {
      skipped.push(`${room.name}: rated power unavailable`);
      continue;
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
      // Null here is the whole signal: a zone fitted before irradiance existed
      // keeps its flat background and is projected exactly as it always was.
      solar_gain_c_per_h_per_wm2: fitted.solar_gain_c_per_h_per_wm2 === null ||
          fitted.solar_gain_c_per_h_per_wm2 === undefined
        ? null
        : Number(fitted.solar_gain_c_per_h_per_wm2),
      solar_mean_w_per_m2: fitted.solar_mean_w_per_m2 === null ||
          fitted.solar_mean_w_per_m2 === undefined
        ? null
        : Number(fitted.solar_mean_w_per_m2),
      r2: Number(fitted.r2),
      sample_count: Number(fitted.sample_count),
      residual_std_c: Number(fitted.residual_std_c),
    };
    if (
      Object.entries(thermalModel).some(([key, value]) =>
        key !== "heating_rate_c_per_h" &&
        key !== "solar_gain_c_per_h_per_wm2" &&
        key !== "solar_mean_w_per_m2" &&
        !Number.isFinite(value)
      )
    ) {
      skipped.push(`${room.name}: fitted thermal model incomplete`);
      continue;
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
      solar,
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

  // Silent degradation is worse than none, so what was skipped is said out
  // loud. With no room left the result is exactly `withoutComfortForecast`:
  // no zones, and every model back on its own recent history.
  if (skipped.length > 0) {
    console.error(
      `[ENERGY-OPTIMISATION] ${skipped.length} of ${rooms.size} rooms not ` +
        `comfort-forecast: ${skipped.join("; ")}`,
    );
  }

  return {
    snapshot: {
      ...snapshot,
      device_models: snapshot.device_models.map((model) => ({
        ...model,
        forecast_method: forecasts.has(model.key)
          ? "thermal_comfort_schedule_v1"
          : model.forecast_method ?? "empirical_recent_history",
        forecast_w_by_slot: forecasts.get(model.key) ??
          model.forecast_w_by_slot,
      })),
      thermal_zones: planningZones,
    },
    zones,
  };
}

serve(withTrafficMetrics("energy-optimisation-ingest", async (req, traffic) => {
  const requestId = haRequestId(req);
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
      if (body?.replan_recommendation !== undefined) {
        if (typeof body.replan_recommendation !== 'string' || body.replan_recommendation.length > 1000) throw new Error('replan_recommendation');
        replanRecommendation = body.replan_recommendation;
      }
      if (!body || typeof body !== "object") throw new Error("body");
      // The portal request this push is answering, if it is answering one.
      // Only meaningful alongside a snapshot: an actuals-only exchange produces
      // no plan, so it cannot complete anything.
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
      }
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
        if (
          typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
          value > 1
        ) {
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
          // Filled below, once the whole batch's timestamps are known and one
          // provider read can answer for all of them.
          solar_w_per_m2: null as number | null,
          device_token_id: auth.tokenId,
        });
      }

      const observations = thermal.zone_observations;
      if (
        !observations || typeof observations !== "object" ||
        Array.isArray(observations)
      ) {
        return json({
          error: "invalid_zone_observations",
          detail: `thermal_slots[${index}].zone_observations`,
        }, 400);
      }
      // Outdoor temperature belongs to the home, not to a zone, and the pool's
      // fit is a consumer of it that needs no zone at all. A quarter carrying
      // only the outdoor reading is therefore a complete observation rather
      // than a malformed one; a quarter carrying neither is still rejected.
      if (Object.keys(observations).length === 0 && outdoor === null) {
        return json({
          error: "invalid_zone_observations",
          detail: `thermal_slots[${index}].zone_observations`,
        }, 400);
      }
      for (const [roomKey, observation] of Object.entries(observations)) {
        const storedRoom = storedRoomByKey.get(roomKey);
        const detail = `thermal_slots[${index}].zone_observations.${roomKey}`;
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

    // What the sun was doing over these quarters. Recorded now because it can
    // only be recovered for so long: the provider's history reaches back about
    // three months, so a quarter left unrecorded past that is unrecoverable,
    // and a zone can only ever learn from sunshine it has a record of.
    if (outdoorRows.length > 0) {
      const location = homeLocation(snapshot);
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
        if (!Number.isFinite(start) || start % SLOT_MS !== 0) {
          return json(
            { error: "invalid_pool_slot", detail: `${row?.start}` },
            400,
          );
        }
        if (!Number.isFinite(water) || water < -5 || water > 60) {
          return json({
            error: "invalid_pool_temperature",
            detail: `${row?.water_temperature_c}`,
          }, 400);
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
      Date.parse(snapshot.captured_at) >= Date.parse(accepted.replan_requested_at);
    if (snapshot && accepted?.plan && !pendingManual && !hasNewPublishedPrices(accepted.snapshot, snapshot)) {
      snapshot = null;
    }

    let batteryProjection: BatteryProjection | null = null;
    let generated:
      | (ReturnType<typeof generateOptimisationPlan> & {
        thermal_projection?: NonNullable<
          ReturnType<typeof buildThermalProjection>
        >;
      })
      | null = null;
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
      let priceArchive: StoredPriceRow[] = [];
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
        console.error(
          "[ENERGY-OPTIMISATION] price shape read failed",
          shapeError,
        );
      } else {
        priceArchive = shapeRows ?? [];
      }

      // The home's own curves, if it has edited any. Resolved here rather than
      // inside the planner so a malformed row degrades to the shipped default
      // with a warning instead of failing the plan.
      const [curveResult, settingsResult] = await Promise.all([
        supabase.from("energy_optimisation_value_curves")
          .select("store_key, unit, points, max_value_sek_per_kwh, urgent_price_multiplier, generation_mode")
          .eq("home_id", auth.homeId),
        supabase.from("energy_optimisation_value_settings")
          .select("battery_degradation_sek_per_kwh, vehicle_fallback_sek_per_km")
          .eq("home_id", auth.homeId).maybeSingle(),
      ]);
      if (curveResult.error) throw new Error(curveResult.error.message);
      const resolved = resolveValueCurves(curveResult.data ?? []);
      for (const warning of resolved.warnings) console.warn("[ENERGY-OPTIMISATION] value curve", warning);
      const settingsRow = settingsResult.data;
      const batteryRow = curveResult.data?.find(row => row.store_key === "battery");
      snapshot = {
        ...snapshot,
        value_curves: {
          pool: resolved.curves.pool.curve,
          ev: resolved.curves.ev.curve,
          ...(resolved.curves.battery ? { battery: resolved.curves.battery.curve } : {}),
        },
        value_settings: resolveValueSettings(settingsRow),
        battery_curve_mode: batteryRow?.generation_mode ?? "balanced",
        battery_cost_curve: undefined,
      };

      // Refit the pool alongside the rooms, then hand the planner whatever the
      // fit produced. A refusal leaves `pool_model` absent and the planner
      // falls back to its seeded figures.
      if (snapshot.pool) {
        const poolKeys = snapshot.device_models
          .filter((device) => device.planning_service === "pool")
          .map((device) => device.key);
        try {
          await refitPoolModel(
            supabase,
            auth.customerId,
            auth.homeId,
            snapshot.pool.volume_m3,
            poolKeys,
          );
        } catch (error) {
          // A refit is an improvement, never a precondition: a home must still
          // be planned on seeded figures if the fit itself fails.
          console.error("[ENERGY-OPTIMISATION] pool refit skipped", error);
        }
        const { data: poolModel } = await supabase
          .from("energy_optimisation_pool_model")
          .select("loss_kw_per_k, rated_cop, cop_per_air_c, cutout_air_c")
          .eq("home_id", auth.homeId)
          .maybeSingle();
        if (poolModel?.loss_kw_per_k && poolModel?.rated_cop) {
          snapshot = {
            ...snapshot,
            pool_model: {
              loss_kw_per_k: Number(poolModel.loss_kw_per_k),
              rated_cop: Number(poolModel.rated_cop),
              cop_per_air_c: Number(poolModel.cop_per_air_c ?? 0),
              // Null stays null: the planner reads it as "no cut-out on
              // record" and applies none, which is not the same as zero.
              cutout_air_c: poolModel.cutout_air_c === null ||
                  poolModel.cutout_air_c === undefined
                ? null
                : Number(poolModel.cutout_air_c),
            },
          };
        }
      }

      const { data: fixedState, error: fixedReadError } = await supabase.rpc("get_energy_replan_state", { p_home_id: auth.homeId });
      if (fixedReadError) return json({ error: "fixed_plan_read_failed" }, 500);
      const fixedPlan = fixedState?.fixed_plan as FixedEnergyPlan | null;
      const fixedRevision = fixedState?.fixed_plan_revision ?? 0;
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
        const planningNow = new Date();
        snapshot = { ...snapshot, replan_reference: replanReference(fixedState?.previous_plan as ReplanPreviousPlan | null, snapshot, planningNow) };
        const planningStarted = performance.now();
        console.info("[ENERGY-OPTIMISATION] inputs ready", { request_id: requestId, replan_request_id: portalReplanId,
          elapsed_ms: Math.round(planningStarted - ingestStarted) });
        console.info("[ENERGY-OPTIMISATION] planning started", {
          request_id: requestId,
          slot_count: snapshot.slots.length,
          device_count: snapshot.device_models.length,
          thermal_zone_count: thermalZones.length,
        });
        if (snapshot.battery_curve_mode === "price_only") {
          const costCurve = await resolveCostCurve(supabase, auth.homeId, auth.customerId,
            { snapshot, now: planningNow.toISOString() }, {
              url: Deno.env.get("SUPABASE_URL") ?? "",
              planningSecret: Deno.env.get("ENERGY_PLANNING_SECRET") ?? "",
              requestId,
            }, traffic.fetch);
          if ("pending" in costCurve) return json(costCurve, 202);
          snapshot = { ...snapshot, battery_cost_curve: costCurve.selection };
        }
        const planned = await generateRemoteOptimisationPlan({
          snapshot,
          now: planningNow.toISOString(),
          price_archive: priceArchive,
          fixed_plan: fixedPlan,
        }, {
          url: Deno.env.get("SUPABASE_URL") ?? "",
          planningSecret: Deno.env.get("ENERGY_PLANNING_SECRET") ?? "",
          requestId,
        }, traffic.fetch);
        generated = planned.plan;
        batteryProjection = planned.battery_projection;
        console.info("[ENERGY-OPTIMISATION] planning completed", {
          request_id: requestId,
          elapsed_ms: Math.round(performance.now() - planningStarted),
          status: generated.status,
        });
      } catch (error) {
        const detail = describeThrown(error);
        if (fixedPlan) await supabase.from("energy_optimisation_current")
          .update({ replan_error: detail }).eq("home_id", auth.homeId)
          .eq("fixed_plan_revision", fixedRevision);
        console.error("[ENERGY-OPTIMISATION] snapshot refused", detail, error);
        if (error instanceof EnergyPlanningError && error.status === 502) {
          return json({ error: "planning_failed", detail, retryable: true }, 502);
        }
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
          snapshot.solar_irradiance_w_per_m2 ?? null,
        );
        if (projection) {
          generated = { ...generated, thermal_projection: projection };
        }
      }

      const inputHash = await sha256Hex(JSON.stringify(snapshot));
      const currentRow = {
        fixed_plan_generation_revision: fixedRevision,
        replan_error: null,
        home_id: auth.homeId,
        customer_id: auth.customerId,
        snapshot_id: snapshot.snapshot_id,
        plan_id: generated.plan_id,
        generation_request_id: requestId,
        plan_schema_version: generated.schema_version,
        ha_ack_status: "pending",
        ha_acknowledged_at: null,
        ha_integration_version: integrationVersion,
        ha_ack_request_id: null,
        ha_ack_error: null,
        input_hash: inputHash,
        captured_at: snapshot.captured_at,
        issued_at: generated.issued_at,
        valid_until: generated.valid_until,
        binding_until: generated.binding_until,
        status: generated.status,
        model_version: generated.model_version,
        snapshot,
        plan: storedPlan(generated),
        battery_projection: batteryProjection,
        updated_at: new Date().toISOString(),
      };
      const storingStarted = performance.now();
      const { error: currentError } = await supabase.rpc(
        "store_energy_optimisation_current",
        currentRow,
      );
      console.info("[ENERGY-OPTIMISATION] current plan storage", {
        request_id: requestId, elapsed_ms: Math.round(performance.now() - storingStarted),
        error_code: currentError?.code ?? null,
      });
      if (currentError) {
        console.error(
          "[ENERGY-OPTIMISATION] current plan upsert failed",
          currentError,
        );
        return json({ error: "storage_failed" }, 500);
      }

      const runStarted = performance.now();
      const { error: runError } = await supabase
        .from("energy_optimisation_plan_runs")
        .upsert({
          id: generated.plan_id,
          customer_id: auth.customerId,
          home_id: auth.homeId,
          snapshot_id: snapshot.snapshot_id,
          generation_request_id: requestId,
          plan_schema_version: generated.schema_version,
          ha_ack_status: "pending",
          ha_acknowledged_at: null,
          ha_integration_version: integrationVersion,
          ha_ack_request_id: null,
          ha_ack_error: null,
          input_hash: inputHash,
          issued_at: generated.issued_at,
          status: generated.status,
          model_version: generated.model_version,
          summary: compactPlanSummary(generated),
          validation_errors: generated.validation_errors,
        }, { onConflict: "home_id,snapshot_id" });
      console.info("[ENERGY-OPTIMISATION] run summary storage", {
        request_id: requestId, elapsed_ms: Math.round(performance.now() - runStarted),
        error_code: runError?.code ?? null,
      });
      if (runError) {
        console.error(
          "[ENERGY-OPTIMISATION] run summary upsert failed",
          runError,
        );
        return json({ error: "storage_failed" }, 500);
      }

      // Answer whatever the portal is waiting on. The device names the request
      // when it knows about one; otherwise the snapshot's own capture time
      // decides, so a home on an older integration still clears its request on
      // its next ordinary push rather than waiting for a reply it cannot send.
      // Failing the whole exchange over this would throw away a stored plan to
      // report a stale button, so it is logged and left for the next push.
      const { error: completionError } = await supabase.rpc(
        "complete_energy_optimisation_replan",
        {
          p_home_id: auth.homeId,
          p_captured_at: snapshot.captured_at,
          p_request_id: portalReplanId,
        },
      );
      console.info("[ENERGY-OPTIMISATION] publication finished", { request_id: requestId, replan_request_id: portalReplanId,
        elapsed_ms: Math.round(performance.now() - ingestStarted), completed: !completionError });
      if (completionError) {
        console.error(
          "[ENERGY-OPTIMISATION] replan completion failed",
          completionError,
        );
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

    // Deliver newly generated plans before doing retention maintenance. Ordinary
    // telemetry exchanges drain bounded batches independently of replanning.
    if (!generated) {
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
    return json({
      replan_recommendations: recommendationState?.replan_recommendations ?? [],
      actual_slots_accepted: actualRows.length,
      actuals_accepted_until: actualRows.length > 0
        ? actualRows[actualRows.length - 1].start_ts
        : null,
      thermal_slots_accepted: thermalRows.length,
      thermal_slots_accepted_until: thermalAcceptedUntil,
      price_slots_accepted: priceRows.length,
      plan_id: generated?.plan_id ?? null,
      snapshot_id: generated?.snapshot_id ?? null,
      plan: generated,
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
    });
  } catch (error) {
    console.error("[ENERGY-OPTIMISATION] unexpected", error);
    return json({ error: "internal_error" }, 500);
  }
}));
