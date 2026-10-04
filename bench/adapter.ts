// Run one planner version, checked out at `root`, on one test case.
//
// The only bench code that knows what a planner's input and output look like.
// A test case and the household carry no planner schema; this builds, from
// nothing but them, the input a given planner generation expects, and reads
// its plan back into the bench's own terms (decisions, beliefs, curves).
//
// Nothing here is another planner's work: no price outlook, no value curve in
// money, no battery cost curve, no previous plan. A planner is told what was
// knowable at the start (published prices, forecasts, price history, how the
// days before were forecast and what they drew, start states, the owner's
// comfort) and works out everything else itself, so its
// price estimate and its value curves are part of what is being compared.
//
// The household's devices reach a planner twice over: as its device models,
// for a planner that lists `device_physics` among its inputs, and as the older
// snapshot fields saying the same, which every planner on the bench reads.
//
// Generations, detected from the planner's own files:
//   snapshot          the schema-9 snapshot, with the owner's targets turned
//                     into the comfort bands and urgency older planners read.
//   snapshot+basis    the same, plus the planning basis the redesign branch
//                     builds from price history with its own code.
//   snapshot+comfort  the snapshot with the targets themselves and a valuation
//                     scale; the planner derives its own curves from them.
// A planner that needs a different input adds a generation here; test cases
// never change.

import { QUARTERS, quarterStarts, type BenchCase } from "../src/lib/planner-bench/case.ts";
import { TARGETS, type Household } from "../src/lib/planner-bench/household.ts";
import { chargerLevels, cop, heatPumpLevels, idleCPerHour, operatingPoint, WATER_KWH_PER_M3_K } from "../supabase/functions/_shared/planner/device-models.ts";
import type { Decisions } from "../src/lib/planner-bench/referee.ts";
import type { PlanRecord, UsedCurve } from "../src/lib/planner-bench/types.ts";
import { diskTree } from "../scripts/module-graph.ts";
import { plannerDir } from "./planner-version.ts";

/** Bump when the input built for a generation changes: every result is run again. */
export const ADAPTER_VERSION = 8;

/**
 * Planners before single targets read a comfort band and an urgency per store.
 * The adapter builds both from the target; they are this adapter's policy for
 * those planner generations, not something the owner sets.
 */
const LEGACY_BAND = { pool_c: 2, ev_km: 100 };
const LEGACY_URGENCY = { pool: 1.8, ev: 3 };

type Json = Record<string, unknown>;
/** The entry points the bench calls; stable across the planner versions on the bench. */
interface PlannerModule {
  generateOptimisationPlan(snapshot: Json, now: Date, archive: unknown[]): Json;
  /** Inputs the planner reads beyond the plain snapshot; absent on older planners. */
  PLANNER_INPUTS?: readonly string[];
}
interface BasisModule { freezePlanningBasis?(snapshot: Json, archive: unknown[], gridImports: unknown[]): unknown }

export interface LoadedPlanner {
  generation: "snapshot" | "snapshot+basis" | "snapshot+comfort";
  /** `scale` multiplies what the planner's value curves are worth (lanes.ts); 1 is the planner as it runs live. */
  plan(c: BenchCase, household: Household, scale?: number): { record: PlanRecord; cpuMs: number };
}

/** Colder and warmer than any pool is planned: the ends of the cooling line planners are given. */
const POOL_RESPONSE_BOTTOM_C = 10;
const POOL_RESPONSE_TOP_C = 45;

const POOL_PUMP = "sensor.pool_pump_energy";
const POOL_HEATER = "sensor.pool_heater_energy";
const EV_METER = "sensor.car_charging_total_energy";

function deviceModel(key: string, name: string, category: string, controlType: string, activeW: number, extra: Json = {}): Json {
  return {
    key, name, category, statistic_id: key,
    load_type: "variable_full_load", control_type: controlType, mapped_control_type: controlType,
    planning_role: "controllable", active_power_w: activeW,
    mapping_status: "ready", mapping_error: null, profile_status: "ready",
    forecast_method: "empirical_recent_history", profile_sample_count: 960,
    suggested_control_type: null, suggested_load_type: "variable_full_load", suggested_planning_role: "base_load",
    inference: { rule: "bench_household", method: "bench_household", profile: "bench_household", confidence: "high", history_days: 10 },
    mapping_summary: { control_type: controlType, entity_count: 1, configured_fields: ["power"], power_entity_name: name },
    forecast_w_by_slot: new Array(QUARTERS).fill(0),
    ...extra,
  };
}

/** A target as the three-point preference curve older planners re-anchor to their own prices. */
function legacyComfortCurve(unit: string, target: number, band: number, urgency: number): Json {
  return {
    unit, urgent_price_multiplier: urgency,
    // The planner replaces these placeholder values with ones anchored to the case's prices.
    points: [
      { at: target - band, sek_per_unit: urgency },
      { at: target, sek_per_unit: 1 },
      { at: target + band, sek_per_unit: 0 },
    ],
  };
}

/** The snapshot one planner generation is handed for a case; exported for the adapter's tests. */
export function snapshotFor(c: BenchCase, h: Household, scale: number, comfort: boolean, wind: boolean, demand: boolean, devicePhysics: boolean): Json {
  const starts = quarterStarts(c.start);
  const end = new Date(Date.parse(starts[QUARTERS - 1]) + 15 * 60_000).toISOString();
  const targets = { ...TARGETS, ...(c.comfort ?? {}) };
  const provenance = (entity: string, quality: string, extra: Json = {}) =>
    ({ provider: "bench_case", entity_ids: [`bench:${entity}`], issued_at: c.start, valid_until: end, quality, sample_count: QUARTERS, ...extra });
  const market = { location: { market_area: h.site.market_area } };
  // The household's devices, in the fields these planners read. The pool's heat pump runs at its
  // setting or not at all: its compressor is the heater, what must run with it the pump.
  const { store, heater } = h.pool, charger = h.car.charger;
  const running = operatingPoint(heater, heater.selected_setting), poolW = heatPumpLevels(heater).at(-1)!.draw_w;
  const carMaxW = chargerLevels(charger).at(-1)!.draw_w;
  const linear = store.loss.kind === "linear" ? store.loss : null;
  return {
    schema_version: 9,
    mode: "live",
    // A case has no snapshot; planners only require the shape of an id.
    snapshot_id: `00000000-0000-4000-8000-${(Date.parse(c.start) / 1000).toString(16).padStart(12, "0")}`,
    captured_at: c.start,
    timezone: c.timezone,
    location: c.location,
    slot_minutes: 15,
    capabilities: { pv: true, battery: true, ev: true, pool: true, boiler: false },
    slots: starts.map((start, i) => ({
      start,
      pv_forecast_w: c.solar_forecast_w[i],
      base_load_forecast_w: c.base_load_forecast_w[i],
      import_price_sek_per_kwh: c.known_prices.import_sek_per_kwh[i],
      export_price_sek_per_kwh: c.known_prices.export_sek_per_kwh[i],
    })),
    sources: {
      pv: provenance("solar_forecast", "calibrated", { location: c.location }),
      base_load: provenance("base_load_forecast", "measured"),
      import_price: provenance("import_price", "provider_raw", market),
      export_price: provenance("export_price", "provider_raw", market),
      battery: provenance("battery", "measured", { sample_count: 1 }),
      outdoor_temperature: provenance("outdoor_temperature", "measured"),
    },
    // The case's solar forecast is final; there is nothing left to correct.
    pv_calibration: { correction_factor_by_lead_day: [1, 1, 1, 1], sample_count_by_lead_day: [0, 0, 0, 0] },
    battery: { ...h.battery, soc: c.start_state.battery_soc },
    ev_battery: {
      // The car is planned whether plugged in or not, so the bench presents it as available.
      name: "Car", connected: true, capacity_kwh: h.car.battery.capacity_kwh,
      soc: c.start_state.ev.soc, departure_target_soc: c.start_state.ev.target_soc,
      charge_efficiency: h.car.battery.charge_efficiency, kwh_per_km: h.car.battery.kwh_per_km,
      available_from: c.start, departure: null, priority: 3,
      source_entity_ids: {
        connected: "binary_sensor.bench_ev_cable", soc: "sensor.bench_ev_soc", target_soc: "number.bench_ev_target",
        energy_remaining: null, charge_current: "number.bench_ev_current",
      },
    },
    pool: {
      volume_m3: store.capacity_kwh_per_c / WATER_KWH_PER_M3_K, water_temperature_c: c.start_state.pool_water_c, heating_running: false,
      source_entity_ids: { water_temperature: "sensor.bench_pool_water_temperature" },
    },
    pool_model: {
      // The heat pump's COP at its setting, whatever the outdoor air.
      loss_kw_per_k: linear?.kw_per_c ?? null, rated_cop: cop(running), cop_per_air_c: 0, cutout_air_c: null,
      // The pool as a home measures it, by water temperature: how fast it cools unheated, which
      // does not follow the outdoor air, and what a kWh of the compressor adds to it. The cooling
      // is a straight line, so its two ends say all of it.
      response: [linear?.surroundings_c ?? POOL_RESPONSE_BOTTOM_C, POOL_RESPONSE_TOP_C].map(waterC => ({
        at_c: waterC, idle_c_per_h: idleCPerHour(store, waterC, POOL_RESPONSE_BOTTOM_C), heat_c_per_kwh: cop(running) / store.capacity_kwh_per_c,
      })),
    },
    ...(comfort
      ? {
        comfort: { pool: { target_c: targets.pool_c }, ev: { target_km: targets.ev_km } },
        valuation: { pool: scale, ev: scale, battery: scale },
      }
      : {
        value_curves: {
          pool: legacyComfortCurve("celsius", targets.pool_c, LEGACY_BAND.pool_c, LEGACY_URGENCY.pool * scale),
          ev: legacyComfortCurve("km", targets.ev_km, LEGACY_BAND.ev_km, LEGACY_URGENCY.ev * scale),
        },
      }),
    value_settings: { battery_degradation_sek_per_kwh: h.site.battery_degradation_sek_per_kwh, vehicle_fallback_sek_per_km: null },
    grid: { import_limit_w: h.site.import_limit_w, export_limit_w: h.site.export_limit_w },
    policy: {
      battery_end_of_solar_target_soc: 0.8, battery_target_is_hard: false,
      terminal_soc_min: h.site.battery_terminal_soc_min, terminal_energy_value_sek_per_kwh: 1,
      battery_export_enabled: h.site.battery_export_enabled,
      battery_export_reserve_soc: h.site.battery_export_reserve_soc,
      battery_export_min_price_sek_per_kwh: h.site.battery_export_min_price_sek_per_kwh,
    },
    device_models: [
      deviceModel(EV_METER, "Car charging", "ev_charging", "variable_power", carMaxW),
      deviceModel(POOL_PUMP, "Pool pump", "pool_heating", "switch_schedule", heater.auxiliary_w, { planning_service: "pool", pool_role: "circulation" }),
      // No minimum run: the household states none, and a quarter is the least any device runs for.
      deviceModel(POOL_HEATER, "Pool heater", "pool_heating", "variable_power", running.electric_w, { planning_service: "pool", pool_role: "heater" }),
    ],
    services: [
      {
        id: `pool:${c.start}`, device: "pool", priority: 2, required_kwh: 0,
        control: { type: "fixed_power", power_w: poolW },
        earliest_start: c.start, baseline_preferred_start: c.start, deadline: end,
      },
      {
        id: `ev:${end}`, device: "ev", priority: 3, required_kwh: 0,
        control: {
          type: "discrete_current", voltage_v: charger.voltage_v, phase_count: charger.phase_count,
          max_current_a: charger.max_current_a, min_current_a: charger.min_current_a, current_step_a: charger.current_step_a,
        },
        earliest_start: c.start, baseline_preferred_start: c.start, deadline: end,
      },
    ],
    service_requirement_sample_days: { pool_heating: 0 },
    outdoor_temperature_c: c.recorded.outdoor_temperature_c,
    // A planner that plans with the device models is handed the household's own; the fields above say the same to the others.
    ...(devicePhysics ? { device_physics: { battery: h.battery, car: h.car, pool: h.pool } } : {}),
    ...(wind && c.recorded.wind ? { wind_outlook: { provider: "bench_case", zone: c.recorded.wind.zone, days: c.recorded.wind.days } } : {}),
    ...(demand && c.recorded.history.demand_days?.length ? { demand_outlook: { provider: "bench_case", days: c.recorded.history.demand_days } } : {}),
    ...(c.recorded.solar_irradiance_w_per_m2.every(v => v !== null) ? { solar_irradiance_w_per_m2: c.recorded.solar_irradiance_w_per_m2 } : {}),
    operating_scope: {
      modes: { $battery: "controlling", $ev: "controlling", $pool: "controlling" },
      device_owners: { [EV_METER]: "$ev", [POOL_PUMP]: "$pool", [POOL_HEATER]: "$pool" },
      external_demands: {},
    },
  };
}

/** The case's price history as the archive rows planners read. */
function priceArchive(c: BenchCase): { start_ts: string; import_price_sek_per_kwh: number; export_price_sek_per_kwh: number | null }[] {
  const { start, import_sek_per_kwh: buy, export_sek_per_kwh: sell } = c.recorded.history.prices;
  const first = Date.parse(start);
  return buy.flatMap((price, i) => price === null ? [] : [{
    start_ts: new Date(first + i * 15 * 60_000).toISOString(), import_price_sek_per_kwh: price, export_price_sek_per_kwh: sell[i] ?? null,
  }]);
}

const num = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

/** The curves the planner says it planned with, in the bench's terms. */
function usedCurves(plan: Json): UsedCurve[] {
  const out: UsedCurve[] = [];
  for (const store of (plan.resolved_value_stores ?? []) as Json[]) {
    const curve = store.curve as { unit?: string; points?: UsedCurve["points"] } | undefined;
    if (!curve?.points) continue;
    out.push({
      store: String(store.key), unit: curve.unit ?? null, points: curve.points,
      initial_state: num(store.initial_state), max_state: num(store.max_state),
      units_per_kwh: num(store.units_per_kwh), reference_sek_per_kwh: num(store.reference_sek_per_kwh),
      mode: (store.derivation as { method?: string } | undefined)?.method === "merit_order" ? "merit order" : null,
      ...(store.derivation ? { derivation: store.derivation as Record<string, number | string> } : {}),
    });
  }
  const battery = plan.battery_value_curve as Json | null | undefined;
  const curve = battery?.curve as { unit?: string; points?: UsedCurve["points"] } | undefined;
  if (battery && curve?.points) {
    const entry: UsedCurve = {
      store: "battery", unit: curve.unit ?? "kwh", points: curve.points,
      initial_state: num(battery.initial_state_kwh), max_state: num(battery.usable_capacity_kwh),
      units_per_kwh: 1, reference_sek_per_kwh: null, mode: typeof battery.generation_mode === "string" ? battery.generation_mode : null,
    };
    const at = out.findIndex(c => c.store === "battery");
    if (at >= 0) out[at] = { ...out[at], mode: entry.mode }; else out.push(entry);
  }
  return out;
}

function recordFrom(plan: Json, generation: LoadedPlanner["generation"], scale: number): PlanRecord {
  const slots = (plan.plans as { priority?: { slots?: Json[] } } | undefined)?.priority?.slots ?? [];
  if (slots.length !== QUARTERS) throw new Error(`The planner returned ${slots.length} quarters, not ${QUARTERS}; status ${String(plan.status)}.`);
  const pick = (read: (slot: Json) => unknown) => slots.map(slot => num(read(slot)) ?? 0);
  const decisions: Decisions = {
    pool_w: pick(s => s.pool_w),
    ev_w: pick(s => s.ev_w),
    battery_charge_w: pick(s => s.battery_charge_w),
    // A plan's discharge is all the battery gives, the house's share and what it sells; `battery_export_w` is the part of it sold.
    battery_discharge_w: pick(s => s.battery_discharge_w),
  };
  // How the plan says the battery is to be run, where it says so: operations the
  // plant carries out itself follow the house within the plan's limits.
  const commands = slots.map(s => s.battery_command as { operation?: string; charge_limit_w?: number; discharge_limit_w?: number } | null | undefined);
  if (commands.every(command => typeof command?.operation === "string" && num(command.charge_limit_w) !== null && num(command.discharge_limit_w) !== null)) {
    decisions.battery_follow = commands.map((command, i) => ({
      follows: ["self_consumption", "solar_charge", "supply_house", "hold"].includes(command!.operation!),
      charge_limit_w: command!.charge_limit_w!, discharge_limit_w: command!.discharge_limit_w!,
      planned: [decisions.battery_charge_w[i], decisions.battery_discharge_w[i]],
    }));
  }
  const believed = slots.map(s => num(s.import_price_sek_per_kwh) ?? num(s.shadow_import_sek_per_kwh));
  const believedSell = slots.map(s => num(s.export_price_sek_per_kwh) ?? num(s.shadow_export_sek_per_kwh));
  const believedCost = slots.every((_, i) => believed[i] !== null && believedSell[i] !== null)
    ? slots.reduce((sum: number, s, i) => sum + ((num(s.grid_import_w) ?? 0) * believed[i]! - (num(s.grid_export_w) ?? 0) * believedSell[i]!) * 0.25 / 1_000, 0)
    : null;
  return {
    status: String(plan.status ?? "unknown"), generation, decisions,
    valuation: generation === "snapshot+comfort"
      ? { scale, pool: "scale", ev: "scale", battery: "scale" }
      // Older generations have no scale input: urgency moves the pool and car curves below
      // target only, and nothing reaches the battery's derived curve.
      : { scale, pool: "urgency_only", ev: "urgency_only", battery: "none" },
    beliefs: { import_sek_per_kwh: believed, grid_cost_sek: believedCost },
    curves: usedCurves(plan),
  };
}

async function optionalImport(path: string): Promise<BasisModule | null> {
  try { await Deno.stat(path); } catch { return null; }
  return await import(`file://${path}`);
}

export async function loadPlanner(root: string): Promise<LoadedPlanner> {
  const dir = `${root}/${plannerDir(diskTree(root))}`;
  const M: PlannerModule = await import(`file://${dir}/energy-optimisation.ts`);
  const basis = await optionalImport(`${dir}/planning-basis.ts`);
  const generation = M.PLANNER_INPUTS?.includes("comfort") ? "snapshot+comfort"
    : typeof basis?.freezePlanningBasis === "function" ? "snapshot+basis" : "snapshot";
  return {
    generation,
    plan(c, household, scale = 1) {
      const snapshot = snapshotFor(c, household, scale, generation === "snapshot+comfort", M.PLANNER_INPUTS?.includes("wind_outlook") === true,
        M.PLANNER_INPUTS?.includes("demand_outlook") === true, M.PLANNER_INPUTS?.includes("device_physics") === true);
      const archive = priceArchive(c);
      if (generation === "snapshot+basis") {
        // The planner's own code builds its basis from the case's history.
        const first = Date.parse(c.recorded.history.grid_import_kwh.start);
        const imports = c.recorded.history.grid_import_kwh.kwh.flatMap((kwh, i) => kwh === null ? [] : [{
          start_ts: new Date(first + i * 15 * 60_000).toISOString(), grid_import_kwh: kwh,
        }]);
        snapshot.planning_basis = basis!.freezePlanningBasis!(snapshot, archive, imports);
      }
      const started = performance.now();
      const result = M.generateOptimisationPlan(snapshot, new Date(c.start), archive);
      const cpuMs = performance.now() - started;
      return { record: recordFrom(result, generation, scale), cpuMs };
    },
  };
}
