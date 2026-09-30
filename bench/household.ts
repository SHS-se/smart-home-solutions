// The household every test case is planned for (docs/planner-bench/README.md).
//
// A replay is a moment in one real home: its solar, price and base-load
// forecasts, and whatever devices that home had set up that day. The bench
// keeps the moment and replaces the devices it plans, so every case plans the
// same household and every planner version sees the same input. Devices the
// household does not own yet (hot water, room heaters) stay as the replay has
// them, as fixed demand unless the replay controlled them.
//
// To plan another device, add it here and bump HOUSEHOLD_VERSION.

import type { BenchInput } from "../src/lib/planner-bench/types.ts";
import type {
  EmpiricalDeviceModelInput, OptimisationSnapshot, ServiceInput,
} from "../supabase/functions/_shared/planner/energy-optimisation.ts";
import type { OperatingMode, OperatingScope } from "../supabase/functions/_shared/planner/operating-scope.ts";

/**
 * Bump whenever the household or how it is applied changes: every stored
 * result was planned for the old household, so the runner re-runs them all.
 */
export const HOUSEHOLD_VERSION = 1;

/** Outdoor weather over a case's slots, when the replay carried none. */
export interface BenchWeather {
  source: string;
  fetched_at: string;
  /** Per slot, aligned to the replay's slots. */
  outdoor_temperature_c: number[];
  solar_irradiance_w_per_m2: number[];
}

type Json = Record<string, unknown>;

const BATTERY = {
  capacity_kwh: 18.08, min_soc: 0.05, max_soc: 1,
  charge_max_w: 8800, discharge_max_w: 9600, charge_efficiency: 0.95, discharge_efficiency: 0.95,
};
/** Used only when a replay has no home battery reading. */
const DEFAULT_BATTERY_SOC = 0.5;

const EV = {
  name: "Tesla Model Y", capacity_kwh: 75.625, charge_efficiency: 0.92, kwh_per_km: 0.16, priority: 3,
  meter: "sensor.car_charging_total_energy",
  control: { type: "discrete_current", voltage_v: 230, phase_count: 3, max_current_a: 16, min_current_a: 5, current_step_a: 1 },
};
/**
 * The car when the replay's own is unplugged or already at its target: plugged
 * in at the start, needing charge by the next morning.
 */
const DEFAULT_EV = { soc: 0.4, target_soc: 0.8, departure_local_hour: 7 };

const POOL = {
  volume_m3: 55, pump_meter: "sensor.pool_pump_energy", pump_w: 764,
  heater_meter: "sensor.pool_heater_energy", heater_w: 2314, heater_minimum_run_s: 4 * 3600,
};
/** Used only when a replay has no pool reading. */
const DEFAULT_POOL_C = 29;
/**
 * Captures taken before the pool loss was fitted carry no pool model, and
 * without one the pool cannot be planned; 0.1 kW/K is the loss the acceptance
 * replays have always used.
 */
const DEFAULT_POOL_MODEL = { loss_kw_per_k: 0.1, rated_cop: null, cop_per_air_c: null };

/** Categories the household owns: the replay's own devices of these kinds go. */
const OWNED_CATEGORIES = new Set(["ev_charging", "pool_heating"]);

function deviceModel(
  key: string, name: string, category: string, controlType: string, activeW: number, slots: number, extra: Json = {},
): EmpiricalDeviceModelInput {
  return {
    key, name, category, statistic_id: key,
    load_type: "variable_full_load", control_type: controlType, mapped_control_type: controlType,
    planning_role: "controllable", active_power_w: activeW,
    mapping_status: "ready", mapping_error: null, profile_status: "ready",
    forecast_method: "empirical_recent_history", profile_sample_count: 960,
    suggested_control_type: null, suggested_load_type: "variable_full_load", suggested_planning_role: "base_load",
    inference: { rule: "bench_household", method: "bench_household", profile: "bench_household", confidence: "high", history_days: 10 },
    mapping_summary: { control_type: controlType, entity_count: 1, configured_fields: ["power"], power_entity_name: name },
    forecast_w_by_slot: new Array(slots).fill(0),
    ...extra,
  } as unknown as EmpiricalDeviceModelInput;
}

/** The first `hour`:00 local on the calendar day after `from`. */
function nextMorning(from: string, timeZone: string, hour: number): string {
  const parts = (ms: number) => Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  const start = Date.parse(from);
  const startDay = parts(start).day;
  for (let ms = start; ms < start + 3 * 86_400_000; ms += 15 * 60_000) {
    const p = parts(ms);
    if (p.day !== startDay && Number(p.hour) === hour && p.minute === "00") return new Date(ms).toISOString();
  }
  throw new Error(`No ${hour}:00 in ${timeZone} after ${from}`);
}

/** The replay's moment, planned for the bench household. */
export function applyHousehold(input: BenchInput, weather: BenchWeather | null): BenchInput {
  // Typed as the current planner reads it; older versions read the same shape.
  const s = structuredClone(input.snapshot) as unknown as OptimisationSnapshot;
  const slots = s.slots;
  const n = slots.length;
  const start = slots[0].start;
  const end = new Date(Date.parse(slots[n - 1].start) + 15 * 60_000).toISOString();
  const tz = s.timezone ?? "Europe/Stockholm";

  // Weather: the replay's own forecast when it has one, else the archived one.
  const hasOwnWeather = Array.isArray(s.outdoor_temperature_c) && s.outdoor_temperature_c.length === n
    && s.outdoor_temperature_c.every(v => typeof v === "number");
  if (!hasOwnWeather && weather && weather.outdoor_temperature_c.length === n) {
    s.outdoor_temperature_c = weather.outdoor_temperature_c;
    s.solar_irradiance_w_per_m2 = weather.solar_irradiance_w_per_m2;
  }

  // Home battery: the replay's reading, the household's hardware.
  s.battery = { ...BATTERY, soc: typeof s.battery?.soc === "number" ? s.battery.soc : DEFAULT_BATTERY_SOC };

  // Car: the replay's own when it is plugged in and wants charge, else the default.
  const own = s.ev_battery;
  const ownWantsCharge = own?.connected === true && typeof own.soc === "number"
    && typeof own.departure_target_soc === "number" && own.soc < own.departure_target_soc;
  s.ev_battery = {
    name: EV.name, capacity_kwh: EV.capacity_kwh, charge_efficiency: EV.charge_efficiency,
    kwh_per_km: EV.kwh_per_km, priority: EV.priority, connected: true, available_from: start,
    ...(ownWantsCharge
      ? { soc: own.soc, departure_target_soc: own.departure_target_soc, departure: own.departure ?? null }
      : { soc: DEFAULT_EV.soc, departure_target_soc: DEFAULT_EV.target_soc, departure: nextMorning(start, tz, DEFAULT_EV.departure_local_hour) }),
    source_entity_ids: {
      connected: "binary_sensor.bench_ev_cable", soc: "sensor.bench_ev_soc", target_soc: "number.bench_ev_target",
      energy_remaining: null, charge_current: "number.bench_ev_current",
    },
  };

  // Pool: the replay's water temperature and fitted model, the household's pool.
  const heaterWasRunning = s.pool?.heating_running === true;
  s.pool = {
    volume_m3: POOL.volume_m3,
    water_temperature_c: typeof s.pool?.water_temperature_c === "number" ? s.pool.water_temperature_c : DEFAULT_POOL_C,
    heating_running: heaterWasRunning,
    source_entity_ids: { water_temperature: "sensor.bench_pool_water_temperature" },
  };
  s.pool_model ??= DEFAULT_POOL_MODEL;
  const ownHeater = s.device_models.find(m => m.key === POOL.heater_meter);

  // Devices: the household's replace the replay's of the same kinds.
  const kept = s.device_models.filter(m => !OWNED_CATEGORIES.has(m.category));
  const owned = [
    deviceModel(EV.meter, "Car charging", "ev_charging", "variable_power",
      EV.control.voltage_v * EV.control.phase_count * EV.control.max_current_a, n),
    deviceModel(POOL.pump_meter, "Pool pump", "pool_heating", "switch_schedule", POOL.pump_w, n, { planning_service: "pool" }),
    deviceModel(POOL.heater_meter, "Pool heater", "pool_heating", "variable_power", POOL.heater_w, n, {
      planning_service: "pool",
      minimum_run: ownHeater?.minimum_run ?? { running: heaterWasRunning, minimum_seconds: POOL.heater_minimum_run_s, remaining_seconds: 0 },
    }),
  ];
  s.device_models = [...kept, ...owned];

  s.services = [
    ...s.services.filter(service => service.device !== "ev" && service.device !== "pool"),
    {
      id: `pool:${start}`, device: "pool", priority: 2, required_kwh: 0,
      control: { type: "fixed_power", power_w: POOL.pump_w + POOL.heater_w },
      earliest_start: start, baseline_preferred_start: start, deadline: end,
    },
    {
      id: `ev:${end}`, device: "ev", priority: EV.priority, required_kwh: 0, control: EV.control,
      earliest_start: start, baseline_preferred_start: start, deadline: end,
    },
  ] as ServiceInput[];
  s.service_requirement_sample_days = { ...s.service_requirement_sample_days, pool_heating: s.service_requirement_sample_days?.pool_heating ?? 0 };
  s.capabilities = { ...s.capabilities, battery: true, ev: true, pool: true };

  // Operating scope: the household plans and controls its devices; every other
  // device keeps the replay's owner and mode, or is monitored when the replay
  // predates operating scopes.
  const scope = s.operating_scope;
  const modes: Record<string, OperatingMode> = { $battery: "controlling", $ev: "controlling", $pool: "controlling" };
  const owners: Record<string, string> = {};
  const demands: OperatingScope["external_demands"] = {};
  for (const model of kept) {
    const key = model.key;
    const owner = scope?.device_owners?.[key] ?? key;
    owners[key] = owner;
    modes[owner] ??= scope?.modes?.[owner] ?? "monitoring";
  }
  for (const model of owned) owners[model.key] = model.category === "ev_charging" ? "$ev" : "$pool";
  for (const model of kept) {
    const key = model.key;
    if (modes[owners[key]] === "controlling") continue;
    const recorded = scope?.external_demands?.[key];
    demands[key] = recorded?.forecast_w_by_slot?.length === n
      ? recorded
      : { forecast_w_by_slot: model.forecast_w_by_slot.map(w => Math.max(0, w)), recent_observation: null };
  }
  s.operating_scope = { modes, device_owners: owners, external_demands: demands };
  s.schema_version = 9;

  return { ...input, snapshot: s as unknown as BenchInput["snapshot"] };
}
