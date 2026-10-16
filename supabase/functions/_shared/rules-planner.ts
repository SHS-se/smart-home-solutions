import { DEFAULT_VALUE_SETTINGS } from "./planner/value-curves.ts";
import { addHotWater } from "./rules-hot-water.ts";
import { projectRulesBaseline } from "./rules-baseline.ts";
import { POOL_START_COST_SEK } from "./planner-wasm/cost-policy.ts";
import { demandLevel } from "./planner/demand-outlook.ts";
import { preparePoolService, type PoolService } from "./rules-pool-service.ts";
import { prepareRoomServices, type RoomServices } from "./rules-room-services.ts";
import { mergePlanningWarnings, planningWarning } from "./planner/planning-warnings.ts";
import { localDay, localMonths } from "./planner-wasm/calendar.ts";
/** One prepared household, one native selection, one authoritative publication.
 * This boundary has no database, history, source fetching or model fitting API.
 */
import { sha256 } from "@noble/hashes/sha2.js";
const hash = (value: string | Uint8Array) => Array.from(sha256(typeof value === "string" ? new TextEncoder().encode(value) : value), b => b.toString(16).padStart(2, "0")).join("");
import artifact from "./planner-wasm/artifact.json" with { type: "json" };
import runtime from "./planner-wasm/runtime-config.json" with { type: "json" };
const { recipe, policy_manifest: policyManifest } = runtime;
import { SOLVER_BASE64 } from "./planner-wasm/solver-bytes.ts";
import { createWasmPlanner, type NativeQuarter } from "./planner-wasm/core.ts";
import { builderRecipe, type NativeCommand, type ReadyProblem } from "./planner-wasm/ready-problem.ts";
import { problemEndCredit } from "./planner-wasm/end-credit.ts";
import type { ReadyRulePolicy } from "./planner-wasm/rule-policy.ts";
import type { EnergyPlanningInput } from "./planner/planning-contracts.ts";
import type { BaselinePlan, DutyCycleServiceInput, GeneratedPlan, OptimisationPlan, OptimisationResult, OptimisationSnapshot, PlannedSlot, PlanSummary } from "./planner/planning-contracts.ts";
import { isolateMeasurements } from "./planner/measurement-isolation.ts";
import { parseDeviceModels } from "./planner/device-models.ts";
import { poolHeaters } from "./planner/pool-devices.ts";
import { validateOperatingScope } from "./planner/operating-scope.ts";
import { buildBatteryExecutionContract, validateExecutionFeedback } from "./planner/battery-plan-execution.ts";
import type { BatteryProjectionRow } from "./planner/planning-contracts.ts";
import type { BatteryCommand } from "./planner/battery-command.ts";
import type { DeviceCommand } from "./planner/device-commands.ts";

export const RULES_MODEL_VERSION = `rules-planner-v11:${hash(JSON.stringify({ artifact, recipe, policyManifest }))}`;
const QUARTER_MS = 900_000;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const fail = (message: string): never => { throw new Error(message); };

export type PublishedCommandSlot = Pick<PlannedSlot, "start" | "pool_w" | "pool_command_w" | "pool_permitted" | "ev_target_current_a" | "ev_min_current_a" | "ev_max_current_a" | "boiler_permitted" | "boiler_expected_w" | "boiler_battery_allowed" | "battery_command" | "device_commands"> & Partial<Pick<PlannedSlot, "device_loads_w" | "room_heating_w">>;
export interface PublishedCommandReference {
  plan_id: string;
  hot_water_permissions?: string[];
  slots: PublishedCommandSlot[];
}
interface DeviceMember { key: string; watts: number }
export interface PreparedRulesInput {
  rooms: RoomServices;
  pool_service: PoolService;
  snapshot: OptimisationSnapshot;
  now: string;
  model_version: string;
  problem: ReadyProblem;
  price_outlook: OptimisationPlan["price_outlook"];
  locked_slots: PublishedCommandSlot[];
  fixed_slots: Record<number, PublishedCommandSlot>;
  reference_plan_id: string | null;
  members: { heater: DeviceMember[]; auxiliary: DeviceMember[]; ev: DeviceMember[]; boiler: DeviceMember[] };
  passive_w: Record<string, number[]>;
  boiler_services: DutyCycleServiceInput[];
  boiler_w: number[];
  boiler_rated_w: number[];
  boiler_permitted: boolean[];
  boiler_battery_allowed: boolean[];
  boiler_permission_starts: string[];
  boiler_shortfall_minutes: Record<string, number>;
  base_w: number[];
}

let compiled: ReturnType<typeof createWasmPlanner> | undefined;
function planner(): ReturnType<typeof createWasmPlanner> {
  if (compiled) return compiled;
  const bytes = Uint8Array.from(atob(SOLVER_BASE64), c => c.charCodeAt(0));
  if (artifact.abi !== 8 || hash(bytes) !== artifact.wasm_sha256) {
    return fail("Rules planner artifact is missing, obsolete or corrupt");
  }
  compiled = createWasmPlanner(bytes);
  return compiled;
}

function alignedSnapshot(original: OptimisationSnapshot, effective: number): { snapshot: OptimisationSnapshot; offset: number } {
  const offset = original.slots.findIndex(s => Date.parse(s.start) + QUARTER_MS > effective);
  if (offset < 0) return fail("Snapshot has no remaining planning intervals");
  const series = (values: number[]) => values.slice(offset);
  return { offset, snapshot: {
    ...original,
    slots: original.slots.slice(offset),
    outdoor_temperature_c: original.outdoor_temperature_c?.slice(offset),
    solar_irradiance_w_per_m2: original.solar_irradiance_w_per_m2?.slice(offset),
    thermal_zones: original.thermal_zones?.map(z => ({ ...z,
      comfort_min_c: series(z.comfort_min_c), target_c: series(z.target_c), comfort_max_c: series(z.comfort_max_c),
      maximum_power_w_by_slot: series(z.maximum_power_w_by_slot), unplanned_power_w: series(z.unplanned_power_w) })),
    device_models: original.device_models.map(m => ({ ...m, forecast_w_by_slot: series(m.forecast_w_by_slot) })),
    services: original.services.map(s => s.device === "boiler"
      ? { ...s, control: { ...s.control, expected_power_w_by_slot: series(s.control.expected_power_w_by_slot) } } : s),
    ...(original.operating_scope ? { operating_scope: { ...original.operating_scope,
      external_demands: Object.fromEntries(Object.entries(original.operating_scope.external_demands).map(([key, value]) =>
        [key, { ...value, forecast_w_by_slot: series(value.forecast_w_by_slot), recent_observation: offset ? null : value.recent_observation }])) } } : {}),
  } };
}

function nativeCommand(slot: PublishedCommandSlot, snapshot: OptimisationSnapshot, nativePool = snapshot.capabilities.pool): NativeCommand {
  const battery = slot.battery_command;
  if (snapshot.capabilities.battery && !battery) return fail(`Committed battery command missing at ${slot.start}`);
  if (snapshot.capabilities.pool && !finite(slot.pool_command_w)) return fail(`Committed native pool command missing at ${slot.start}`);
  if (snapshot.capabilities.ev && !finite(slot.ev_target_current_a)) return fail(`Committed native EV command missing at ${slot.start}`);
  return { pool_on: nativePool && (slot.pool_command_w ?? 0) > 0, ev_amps: slot.ev_target_current_a,
    battery: battery?.operation ?? "idle", charge_limit_w: battery?.charge_limit_w ?? 0,
    discharge_limit_w: battery?.discharge_limit_w ?? 0 };
}

/** Freeze supplied forecasts/models and current published commands before admission. */
export function prepareRulesPlanningInput(input: Omit<EnergyPlanningInput, "price_archive"> & { price_archive?: EnergyPlanningInput["price_archive"] }, reference: PublishedCommandReference | null,
  approved: ReadyRulePolicy): PreparedRulesInput {
  if (!input.resolved_price_outlook) return fail("Rules planner requires an already resolved price outlook");
  if (!approved || !Array.isArray(approved.rules)) return fail("Rules planner requires the approved rule policy");
  // State and commitment belong to the immutable measurement capture, not the
  // later admission or retry clock. issued_at separately records this generation.
  const effective = Date.parse(input.snapshot.captured_at);
  if (!finite(effective)) return fail("Invalid planning capture time");
  const isolated = isolateMeasurements(structuredClone(input.snapshot));
  if (isolated.device_physics) {
    const {pool,...electrical}=isolated.device_physics;
    isolated.device_physics=parseDeviceModels(electrical);
    if(pool) try { isolated.device_physics.pool=parseDeviceModels({pool}).pool; }
    catch(error) { isolated.planning_warnings=mergePlanningWarnings(isolated.planning_warnings,[planningWarning(
      "pool_physics_evidence","pool",String(error),"Pool service continues using empirical demand and known comfort targets.")]); }
  }
  const { snapshot, offset } = alignedSnapshot(isolated, effective);
  if (snapshot.schema_version === 9) validateOperatingScope(snapshot);
  if (snapshot.battery_execution_feedback) validateExecutionFeedback(snapshot.battery_execution_feedback);
  const count = snapshot.slots.length;
  if (Date.parse(snapshot.slots[0].start) > effective) return fail("Planning input must cover its capture interval");
  const outlook = { ...input.resolved_price_outlook,
    shadow_import_sek_per_kwh: input.resolved_price_outlook.shadow_import_sek_per_kwh.slice(offset) };
  if (outlook.shadow_import_sek_per_kwh.length !== count || !outlook.shadow_import_sek_per_kwh.every(finite)) return fail("Resolved prices must cover every planning interval");
  const battery = snapshot.capabilities.battery ? snapshot.device_physics?.battery ?? snapshot.battery : null;
  if (snapshot.capabilities.battery && !battery) return fail("Battery capability requires a physical model and state");
  if (battery && (!finite(snapshot.value_settings?.battery_degradation_sek_per_kwh) || snapshot.value_settings!.battery_degradation_sek_per_kwh < 0)) {
    snapshot.value_settings = {...DEFAULT_VALUE_SETTINGS, ...snapshot.value_settings,
      battery_degradation_sek_per_kwh: DEFAULT_VALUE_SETTINGS.battery_degradation_sek_per_kwh};
    snapshot.planning_warnings = mergePlanningWarnings(snapshot.planning_warnings, [planningWarning(
      "battery_wear_estimated", "battery", "The battery wear cost was unavailable.",
      "Planning continues using the shipped battery wear cost; equipment limits and supply permissions remain in force.",
      {battery_degradation_sek_per_kwh: DEFAULT_VALUE_SETTINGS.battery_degradation_sek_per_kwh})]);
  }
  let ev = snapshot.capabilities.ev ? snapshot.ev_battery : null;
  const evService = snapshot.services.find(s => s.device === "ev" && s.control.type === "discrete_current");
  let charger = ev ? snapshot.device_physics?.car?.charger ?? (evService?.control.type === "discrete_current" ? evService.control : null) : null;
  let car = ev ? snapshot.device_physics?.car?.battery ?? (finite(ev.kwh_per_km) ? {
    capacity_kwh: ev.capacity_kwh, kwh_per_km: ev.kwh_per_km, charge_efficiency: ev.charge_efficiency,
  } : null) : null;
  if (snapshot.capabilities.ev && (!ev || !charger || !car || !finite(snapshot.comfort?.ev?.target_km))) {
    snapshot.planning_warnings=mergePlanningWarnings(snapshot.planning_warnings,[planningWarning("ev_service_evidence","ev",
      "EV battery state, range target, consumption or charger configuration is incomplete.",
      "Household planning continues with the EV's measured demand. Existing charger settings are retained; no new charging command is invented.")]);
    snapshot.capabilities={...snapshot.capabilities,ev:false}; snapshot.ev_battery=null;
    snapshot.services=snapshot.services.filter(s=>s.device!=="ev"); ev=null; car=null; charger=null;
  }
  if (snapshot.policy.battery_target_is_hard) snapshot.planning_warnings = mergePlanningWarnings(snapshot.planning_warnings, [planningWarning(
    "battery_target_not_guaranteed", "battery", "The requested hard battery target cannot be guaranteed by the rules objective.",
    "Battery and household planning continue within the configured equipment limits.")]);
  const previous = new Map(reference?.slots.map(slot => [Date.parse(slot.start), slot]) ?? []);
  const retained = snapshot.slots.map(slot => reference && Date.parse(slot.start) < effective + 3_600_000
    ? previous.get(Date.parse(slot.start)) ?? {} : {});
  const fixedByStart = new Map(input.fixed_plan?.slots.map(s => [Date.parse(s.start), s.targets]) ?? []);
  const poolService = preparePoolService(snapshot, snapshot.slots.map((s, i) => fixedByStart.get(Date.parse(s.start)) ?? retained[i]));
  snapshot.planning_warnings = mergePlanningWarnings(snapshot.planning_warnings, poolService.warnings);
  const pool = poolService.physics;
  if (pool && snapshot.pool?.heating_running && !finite(snapshot.pool.heating_elapsed_seconds)) {
    snapshot.pool = { ...snapshot.pool, heating_elapsed_seconds: 0, heating_elapsed_basis: "observed_on_lower_bound" };
  }
  const hardware = snapshot.pool_model?.hardware ?? snapshot.pool?.hardware;
  if (pool && (!hardware || hardware.control !== "external_enable" || !finite(hardware.stop_c) || !finite(hardware.start_c))) return fail("Pool requires independently configured native start/stop settings and external-enable semantics");
  if (pool && !finite(snapshot.comfort?.pool?.target_c)) return fail("Pool requires an explicit comfort target");
  if (car && !finite(snapshot.comfort?.ev?.target_km)) return fail("EV requires an explicit range target");
  const poolMembers = snapshot.device_models.filter(m => m.planning_service === "pool");
  const heaterKeys = new Set(poolHeaters(poolMembers).map(m => m.key));
  const member = (m: OptimisationSnapshot["device_models"][number]): DeviceMember => ({ key: m.key, watts: m.active_power_w ?? 0 });
  const group = (models: typeof snapshot.device_models, total: number): DeviceMember[] => {
    const weights=models.map(m=>Math.max(m.active_power_w??0,...m.forecast_w_by_slot));
    const measured=sum(weights);
    return models.map((m,i)=>({key:m.key,watts:measured>0?weights[i]:total/models.length}));
  };
  const members = {
    heater: pool ? group(poolMembers.filter(m => heaterKeys.has(m.key)),pool.heater.compressor_w) : [],
    auxiliary: pool ? group(poolMembers.filter(m => !heaterKeys.has(m.key)),pool.heater.auxiliary_w) : [],
    ev: car ? group(snapshot.device_models.filter(m => m.category === "ev_charging"),charger ? charger.max_current_a*charger.voltage_v*charger.phase_count : 0) : [],
    boiler: snapshot.capabilities.boiler ? snapshot.device_models.filter(m => m.category === "hot_water").map(member) : [],
  };
  const owned = new Set(Object.values(members).flat().map(m => m.key));
  const passive = Object.fromEntries(snapshot.device_models.filter(m => !owned.has(m.key)).map(m => {
    const owner = snapshot.operating_scope?.device_owners[m.key];
    const mode = owner ? snapshot.operating_scope?.modes[owner] : undefined;
    const isolatedOwner = snapshot.measurement_issues?.some(issue =>
      issue.device === "ev" && m.category === "ev_charging" || issue.device === "pool" && m.planning_service === "pool");
    if (!isolatedOwner && !snapshot.thermal_zones?.some(z => z.device_keys.includes(m.key)) &&
      (mode === "controlling" || mode === "control_verification" || (!snapshot.operating_scope && m.control_type === "setpoint"))) {
      snapshot.planning_warnings = mergePlanningWarnings(snapshot.planning_warnings, [planningWarning("service_estimate", m.key,
        `${m.name}: no complete device service model is available.`,
        "Its measured demand remains in the household forecast. Existing settings are retained where no explicit target is available.")]);
    }
    return [m.key, m.forecast_w_by_slot];
  }));
  for (const [key, values] of Object.entries(passive)) if (values.length !== count || values.some(v => !finite(v) || v < 0)) return fail(`Invalid supplied passive forecast: ${key}`);
  let boilerService = snapshot.services.filter((s): s is DutyCycleServiceInput => s.device === "boiler");
  if (snapshot.capabilities.boiler && (!boilerService.length || boilerService.some(s => s.control.type !== "duty_cycle"))) {
    snapshot.planning_warnings=mergePlanningWarnings(snapshot.planning_warnings,[planningWarning("boiler_service_evidence","boiler",
      "The boiler's permit/inhibit service forecast is incomplete.",
      "Household planning continues with its measured demand; the boiler retains its existing settings.")]);
    for(const member of members.boiler) passive[member.key]=snapshot.device_models.find(m=>m.key===member.key)!.forecast_w_by_slot;
    members.boiler=[];boilerService=[];snapshot.capabilities={...snapshot.capabilities,boiler:false};
    snapshot.services=snapshot.services.filter(s=>s.device!=="boiler");
  }
  if(boilerService.some(s=>s.control.rated_power_w===null)) snapshot.planning_warnings=mergePlanningWarnings(snapshot.planning_warnings,[planningWarning(
    "boiler_power_estimated","boiler","Boiler running power has not been observed yet.",
    "Daily heating permissions remain active. Consumption and power headroom use available demand evidence until a heating run is measured.")]);
  const locked: PublishedCommandSlot[] = [];
  if (reference) {
    for (const slot of snapshot.slots) {
      if (Date.parse(slot.start) >= effective + 3_600_000) break;
      const prior = previous.get(Date.parse(slot.start));
      if (!prior) {
        snapshot.planning_warnings=mergePlanningWarnings(snapshot.planning_warnings,[planningWarning("reference_coverage","household",
          "The retained plan does not cover the complete next hour.","Existing covered commands are retained; uncovered intervals receive a new plan.")]);
        break;
      }
      locked.push(prior);
    }

  }
  for (let i = 0; i < locked.length; i++) {
    if (!locked[i].device_commands && snapshot.device_models.length && snapshot.schema_version >= 7) return fail("Committed device command map missing");
    if (snapshot.capabilities.boiler && typeof locked[i].boiler_permitted !== "boolean") return fail("Committed boiler permission missing");
    if (snapshot.capabilities.boiler && !finite(locked[i].boiler_expected_w)) return fail(`Committed hot-water power missing or non-finite at ${snapshot.slots[i].start}`);
  }
  const fixedSlots: Record<number, PublishedCommandSlot> = {};
  for (const booking of input.fixed_plan?.slots ?? []) {
    const i = snapshot.slots.findIndex(slot => Date.parse(slot.start) === Date.parse(booking.start));
    if (i < 0) continue; // A rolling horizon ignores elapsed bookings.
    fixedSlots[i] = booking.targets;
  }
  const retainedServices = snapshot.slots.map((_s, i) => fixedSlots[i] ?? locked[i]);
  const spreads = snapshot.slots.flatMap(s => s.import_price_sek_per_kwh === null || s.export_price_sek_per_kwh === null ? [] : [s.import_price_sek_per_kwh - s.export_price_sek_per_kwh]).sort((a, b) => a - b);
  if (!spreads.length && snapshot.slots.some(s => s.export_price_sek_per_kwh === null)) return fail("Resolved export forecast needs a published tariff spread");
  const spread = spreads[Math.floor(spreads.length / 2)] ?? 0;
  // Reuse the same matured-home level correction as the main planner. No
  // demand margin or future measured load enters the prepared forecast.
  const level = demandLevel(snapshot.demand_outlook?.days, localDay(snapshot.captured_at, snapshot.timezone));
  const baseW = snapshot.slots.map(s => s.base_load_forecast_w * (level?.factor ?? 1));
  const boilerW = snapshot.slots.map((_s, i) => retainedServices[i]?.boiler_expected_w ?? 0);
  const roomKeys=new Set(snapshot.thermal_zones?.flatMap(z=>z.device_keys)??[]);
  const headroom=snapshot.slots.map((slot,i)=>Math.max(0,snapshot.grid.import_limit_w+slot.pv_forecast_w*
    snapshot.pv_calibration.correction_factor_by_lead_day[Math.min(snapshot.pv_calibration.correction_factor_by_lead_day.length-1,
      Math.max(0,Math.floor((Date.parse(slot.start)-effective)/86400000)))]-baseW[i]-boilerW[i]-
      sum(Object.entries(passive).filter(([key])=>!roomKeys.has(key)).map(([,values])=>values[i]))));
  const rooms = prepareRoomServices(snapshot, retainedServices, headroom);
  Object.assign(passive, rooms.power, poolService.power);
  snapshot.planning_warnings = mergePlanningWarnings(snapshot.planning_warnings, rooms.warnings);
  const permitted = snapshot.slots.map((_s, i) => retainedServices[i]?.boiler_permitted ?? false);
  const months = localMonths(snapshot.slots.map(s => s.start), snapshot.timezone);
  const problem: ReadyProblem = {
    abi: 8, ev_battery_supply_allowed: false, work_grant: recipe.work_grant, recipe: builderRecipe(recipe),
    slots: snapshot.slots.map((s, i) => {
      const start = Date.parse(s.start);
      const lead = Math.max(0, Math.min(snapshot.pv_calibration.correction_factor_by_lead_day.length - 1, Math.floor((start - Date.parse(snapshot.captured_at)) / 86_400_000)));
      const outdoor = snapshot.outdoor_temperature_c?.[i];
      if (pool?.store.loss.kind === "linear" && pool.store.loss.surroundings_c === null && !finite(outdoor)) return fail(`Pool physical forecast requires outdoor temperature at ${s.start}`);
      return { battery_export_allowed: input.fixed_plan?.slots.find(b=>Date.parse(b.start)===start)?.allow_export, local_month: months[i], start_seconds: (start - effective) / 1000, hours: 0.25,
        base_w: baseW[i] + boilerW[i] + sum(Object.values(passive).map(values => values[i])),
        base_ev_w: sum(snapshot.device_models.filter(m => m.category === "ev_charging" && passive[m.key]).map(m => passive[m.key][i])),
        solar_w: s.pv_forecast_w * snapshot.pv_calibration.correction_factor_by_lead_day[lead],
        outdoor_c: finite(outdoor) ? outdoor : 0,
        import_price: outlook.shadow_import_sek_per_kwh[i], export_price: s.export_price_sek_per_kwh ?? outlook.shadow_import_sek_per_kwh[i] - spread,
        published: s.import_price_sek_per_kwh !== null && s.export_price_sek_per_kwh !== null,
        ev_available: !!ev && ev.connected && (ev.available_from === null || start + QUARTER_MS > Date.parse(ev.available_from)) && (ev.departure === null || start < Date.parse(ev.departure)),
      };
    }),
    battery, car, charger, pool_store: pool?.store ?? null, heater: pool?.heater ?? null,
    pool_stop_c: pool ? hardware?.stop_c ?? null : null,
    initial: { battery_kwh: battery && snapshot.battery ? snapshot.battery.soc * battery.capacity_kwh : null,
      ev_kwh: ev && car ? ev.soc * car.capacity_kwh : null, pool_c: pool ? snapshot.pool!.water_temperature_c : null,
      heater_state: pool ? snapshot.pool!.heating_running
        ? finite(snapshot.pool!.heating_elapsed_seconds) ? { kind: "running", seconds: snapshot.pool!.heating_elapsed_seconds! } : { kind: "running", seconds: 0 }
        : { kind: "off_unobserved" } : null },
    targets: { pool_c: pool ? snapshot.comfort!.pool!.target_c : null, ev_km: car ? snapshot.comfort!.ev!.target_km : null,
      ev_limit_kwh: car && ev ? ev.departure_target_soc * car.capacity_kwh : null },
    limits: { import_w: snapshot.grid.import_limit_w, export_w: snapshot.grid.export_limit_w,
      battery_export_enabled: !!battery && snapshot.policy.battery_export_enabled,
      battery_export_reserve_kwh: battery ? snapshot.policy.battery_export_reserve_soc * battery.capacity_kwh : 0,
      battery_export_min_price: snapshot.policy.battery_export_min_price_sek_per_kwh,
      wear_per_kwh: snapshot.value_settings?.battery_degradation_sek_per_kwh ?? 0,
      pool_start_cost_sek: POOL_START_COST_SEK },
    rules: approved.rules, service_guard: approved.service_guard,
    // Filled below from the finished problem: the credit's reference is the median of the prices in its slots.
    end_credit: { reference_sek_per_kwh: 0, battery: null, pool: null, ev: null },
    accepted: locked.length ? locked.map(slot => nativeCommand(slot, snapshot, !!pool)) : null,
    fixed_commands: snapshot.slots.map((_s, i) => fixedSlots[i] ? nativeCommand(fixedSlots[i], snapshot, !!pool) : null),
    locked_through_seconds: locked.length ? Math.min(3600,(Date.parse(locked.at(-1)!.start)+QUARTER_MS-effective)/1000) : 0,
  };
  problem.end_credit = problemEndCredit(problem);
  return { snapshot, rooms, pool_service: poolService, now: new Date(input.now).toISOString(), model_version: RULES_MODEL_VERSION, problem,
    price_outlook: outlook, locked_slots: locked, fixed_slots: fixedSlots, reference_plan_id: reference?.plan_id ?? null,
    members, passive_w: passive, boiler_services: boilerService, boiler_w: boilerW, boiler_rated_w: snapshot.slots.map(() => 0), boiler_permitted: permitted,
    boiler_battery_allowed: snapshot.slots.map((_s, i) => retainedServices[i]?.boiler_battery_allowed ?? false),
    boiler_permission_starts: [...new Set([...(reference?.hot_water_permissions ?? []), ...(reference?.slots.filter(s => s.boiler_permitted).map(s => s.start) ?? [])])],
    boiler_shortfall_minutes: {}, base_w: baseW };
}

function allocate(members: DeviceMember[], watts: number, into: Record<string, number>) {
  const total = sum(members.map(m => m.watts));
  if (members.length && watts > 0 && !(total > 0)) return fail("Physical device members require measured allocation powers");
  for (const m of members) into[m.key] = total > 0 ? watts * m.watts / total : 0;
}
function commandMap(input: PreparedRulesInput, command: NativeCommand, i: number): Record<string, DeviceCommand> {
  const locked = input.fixed_slots[i] ?? input.locked_slots[i];
  const result: Record<string, DeviceCommand> = {};
  const pool = new Set([...input.members.heater, ...input.members.auxiliary].map(m => m.key));
  const ev = new Set(input.members.ev.map(m => m.key));
  const boiler = new Set(input.members.boiler.map(m => m.key));
  for (const model of input.snapshot.device_models) {
    // Commitments retain requests for current owners, not a frozen inventory.
    // A separated/replaced meter gets its command from the current service;
    // removed meters cannot remain in the replacement plan's command map.
    const committed = locked?.device_commands?.[model.key];
    const empiricalPool = input.pool_service.empirical && Object.prototype.hasOwnProperty.call(input.pool_service.power, model.key);
    const retained = committed?.type === model.control_type ? committed : undefined;
    result[model.key] = retained ? structuredClone(retained) : input.rooms.commands[model.key]?.[i] ?? (empiricalPool && model.control_type === "switch_schedule"
      ? { type: "switch_schedule", on_seconds: input.pool_service.permitted[i] ? 900 : 0 } : pool.has(model.key) ? model.control_type === "switch_schedule"
      ? { type: "switch_schedule", on_seconds: command.pool_on ? 900 : 0 }
      : { type: "unavailable", reason: "Dedicated pool owner supplies the native enable command" }
      : ev.has(model.key) ? { type: "variable_power", value: command.ev_amps, unit: "A" }
      : boiler.has(model.key) ? { type: "permit_inhibit", permitted: input.boiler_permitted[i] }
      : { type: "unavailable", reason: "No explicit service target is available; the device retains its existing settings" });
  }
  return result;
}
function batteryCommand(command: NativeCommand, quarter: NativeQuarter): BatteryCommand {
  // HA treats grid purchases/sales as sized allocations. Publish the power
  // that survived native grid/storage saturation, not an unattainable ceiling.
  // Automatic operations retain their demand-following permission ceilings.
  const forced = command.battery === "grid_charge" || command.battery === "export";
  const charge = forced ? quarter.charge_w : command.charge_limit_w;
  const discharge = forced ? quarter.discharge_w : command.discharge_limit_w;
  const operation = forced && charge === 0 && discharge === 0 ? "idle" : command.battery;
  return { schema_version: 3, operation, charge_limit_w: charge,
    discharge_limit_w: discharge, allow_grid_charge: operation === "grid_charge",
    allow_battery_export: operation === "export" };
}

interface Materialized { generated: GeneratedPlan; rows: BatteryProjectionRow[] }
function scenario(input: PreparedRulesInput, commands: NativeCommand[], quarters: NativeQuarter[],
  key: "priority" | "baseline" | "cost", label: string): Materialized {
  const p = input.problem, snapshot = input.snapshot;
  const rows: BatteryProjectionRow[] = [];
  let binding = true;
  const slots: PlannedSlot[] = quarters.map((q, i) => {
    const f = p.slots[i], source = snapshot.slots[i], command = commands[i];
    const hours = f.hours + Math.min(0, f.start_seconds) / 3600;
    const loads = Object.fromEntries(Object.entries(input.passive_w).map(([k, values]) => [k, values[i]]));
    allocate(input.members.heater, q.pool_compressor_w, loads);
    allocate(input.members.auxiliary, q.pool_auxiliary_w, loads);
    allocate(input.members.ev, q.ev_w, loads);
    allocate(input.members.boiler, input.boiler_w[i], loads);
    const unrepresented = (input.members.heater.length + input.members.auxiliary.length ? 0 : q.pool_w) +
      (input.members.ev.length ? 0 : q.ev_w) + (input.members.boiler.length ? 0 : input.boiler_w[i]);
    const load = input.base_w[i] + sum(Object.values(loads)) + unrepresented;
    const net = load + q.charge_w - q.discharge_w + q.curtailed_w - f.solar_w;
    const imports = Math.max(0, net), exports = Math.max(0, -net);
    const batteryExport = Math.max(0, q.discharge_w - Math.max(0, load - f.solar_w));
    binding = binding && f.published;
    const end = Date.parse(source.start) + QUARTER_MS;
    rows.push({ start: new Date(end - hours * 3_600_000).toISOString(), end: new Date(end).toISOString(),
      house_w: load, residual_w: input.base_w[i] + unrepresented, device_loads_w: loads,
      charge_w: q.charge_w, discharge_w: q.discharge_w, export_w: batteryExport, curtailed_w: q.curtailed_w, unserved_w: 0 });
    const locked = input.fixed_slots[i] ?? input.locked_slots[i];
    return { start: source.start, duration_hours: hours, binding,
      pv_raw_w: source.pv_forecast_w, pv_w: f.solar_w, base_w: input.base_w[i],
      import_price_sek_per_kwh: source.import_price_sek_per_kwh, export_price_sek_per_kwh: source.export_price_sek_per_kwh,
      shadow_import_sek_per_kwh: f.import_price, shadow_export_sek_per_kwh: f.export_price,
      pool_w: input.pool_service.empirical ? input.pool_service.total_w[i] : q.pool_w,
      pool_permitted: input.pool_service.empirical ? input.pool_service.permitted[i] : command.pool_on,
      pool_command_w: locked?.pool_command_w ?? (input.pool_service.empirical ? input.pool_service.command_w[i]
        : command.pool_on && p.heater ? p.heater.compressor_w + p.heater.auxiliary_w : 0),
      ...(q.pool_c === null ? {} : { pool_temperature_c: q.pool_c }),
      boiler_expected_w: input.boiler_w[i], boiler_permitted: input.boiler_permitted[i],
      ...(input.boiler_services.length ? { boiler_battery_allowed: input.boiler_battery_allowed[i] } : {}),
      ev_w: q.ev_w, room_heating_w: Object.fromEntries(Object.entries(input.rooms.room_power).map(([key, values]) => [key, values[i]])), device_loads_w: loads, device_commands: commandMap(input, command, i),
      ev_target_current_a: command.ev_amps, ev_min_current_a: locked?.ev_min_current_a ?? 0, ev_max_current_a: locked?.ev_max_current_a ?? (f.ev_available ? p.charger?.max_current_a ?? 0 : 0),
      ev_soc: p.car && q.ev_kwh !== null ? q.ev_kwh / p.car.capacity_kwh : null, ev_connected: f.ev_available,
      load_w: load, battery_charge_w: q.charge_w, battery_discharge_w: q.discharge_w, battery_export_w: batteryExport,
      battery_command: p.battery ? locked?.battery_command ?? batteryCommand(command, q) : null,
      battery_soc: p.battery && q.battery_kwh !== null ? q.battery_kwh / p.battery.capacity_kwh : 0,
      grid_import_w: imports, grid_export_w: exports, curtailed_w: q.curtailed_w, unserved_w: 0,
      import_cost_sek: source.import_price_sek_per_kwh === null ? null : imports * hours / 1000 * source.import_price_sek_per_kwh,
      export_revenue_sek: source.export_price_sek_per_kwh === null ? null : exports * hours / 1000 * source.export_price_sek_per_kwh,
      decision: { schema_version: 1, store_allocations: [], battery: null,
        grid_balance: { load_w: load, pv_w: f.solar_w, battery_charge_w: q.charge_w, battery_discharge_w: q.discharge_w,
          residual_w: load - f.solar_w, direction: net > 0 ? "import" : net < 0 ? "export" : "balanced",
          power_w: Math.abs(net), limit_w: net >= 0 ? p.limits.import_w : p.limits.export_w,
          limit_binding: q.curtailed_w > 0, reason: q.curtailed_w > 0 ? "export_limit" : net === 0 ? "balanced" : "residual_after_dispatch" } },
    };
  });
  const energy = (read: (s: PlannedSlot) => number) => sum(slots.map(s => read(s) * s.duration_hours! / 1000));
  const socs = [snapshot.battery?.soc ?? 0, ...slots.map(s => s.battery_soc)];
  const summary: PlanSummary = { load_kwh: energy(s => s.load_w), flexible_load_kwh: energy(s => s.pool_w + s.ev_w + s.boiler_expected_w),
    pv_kwh: energy(s => s.pv_w), grid_import_kwh: energy(s => s.grid_import_w), grid_export_kwh: energy(s => s.grid_export_w), curtailed_kwh: energy(s => s.curtailed_w),
    priced_import_kwh: energy(s => s.binding ? s.grid_import_w : 0), priced_export_kwh: energy(s => s.binding ? s.grid_export_w : 0),
    net_cost_sek: sum(slots.map(s => (s.import_cost_sek ?? 0) - (s.export_revenue_sek ?? 0))),
    terminal_adjusted_cost_sek: sum(quarters.map(q => q.cost)), battery_soc_start: socs[0], battery_soc_end: socs.at(-1)!,
    battery_soc_low: Math.min(...socs), battery_end_of_solar_soc: {},
    service_required_kwh: sum(snapshot.services.map(s => s.required_kwh)), service_delivered_kwh: energy(s => s.pool_w + s.ev_w + s.boiler_expected_w), duty_cycle_deferred_kwh: 0 };
  const indices = (test: (s: PlannedSlot) => boolean) => slots.flatMap((s, i) => test(s) ? [i] : []);
  // A device planned as a state has no block schedule: the integration reads an
  // empty service schedule beside `dispatched_devices`, and refuses a filled one.
  const dispatched = [...(p.battery ? ["battery"] : []), ...(snapshot.capabilities.pool ? ["pool"] : []), ...(p.car ? ["ev"] : [])];
  const serviceSlots = Object.fromEntries(snapshot.services.map(s => [s.id, dispatched.includes(s.device) ? [] : indices(slot => Date.parse(slot.start) >= Date.parse(s.earliest_start) && Date.parse(slot.start) < Date.parse(s.deadline) &&
    (s.device === "pool" ? slot.pool_w : s.device === "ev" ? slot.ev_w : slot.boiler_expected_w) > 0)]));
  return { rows, generated: { key, label, status: "ready", validation_errors: [], slots, summary,
    service_slots: serviceSlots, service_currents_a: Object.fromEntries(snapshot.services.filter(s => s.device === "ev").map(s => [s.id, serviceSlots[s.id].map(i => slots[i].ev_target_current_a)])),
    service_inhibited_slots: Object.fromEntries(snapshot.services.filter(s => s.device === "boiler").map(s => [s.id, indices(slot => !slot.boiler_permitted && Date.parse(slot.start) + QUARTER_MS > Date.parse(s.earliest_start) && Date.parse(slot.start) < Date.parse(s.deadline))])),
    dispatched_devices: dispatched, store_diagnostics: [] } };
}

/** Native physics also owns the baseline projection. */
export function generateRulesPlan(input: PreparedRulesInput): OptimisationResult {
  if (input.model_version !== RULES_MODEL_VERSION) return fail("Prepared rules planner version changed");
  if (input.problem.work_grant !== recipe.work_grant || JSON.stringify(input.problem.recipe) !== JSON.stringify(builderRecipe(recipe))) return fail("Prepared planner work recipe differs from its model identity");
  const core = planner();
  let solved = core.solve(input.problem).outcome;
  let released: GeneratedPlan["continuity"];
  if (solved.kind === "failed") {
    // The next hour remains exact unless its commands violate current
    // equipment limits or permissions. A price change or a cheaper schedule
    // is never authority to release it. Rebuild once under the same limits;
    // malformed inputs and unrelated construction failures still fail fast.
    const violation = /^committed_command_infeasible:(\d+):(shared_grid_limit|native_battery_power_limit|export_without_permission|non_native_ev_command|command_for_absent_device)$/.exec(solved.issue);
    if (violation && input.reference_plan_id) {
      released = { source_plan_id: input.reference_plan_id, selected: "repaired",
        reason: `${violation[2]} at ${input.snapshot.slots[Number(violation[1])].start}`,
        proposed_sek: null, reference_sek: null, deadband_sek: 0 };
      // Clear the native lock and its materialization maps together, so the
      // published device requests describe the replacement actually solved.
      input = { ...input, locked_slots: [], problem: { ...input.problem, accepted: null, locked_through_seconds: 0 } };
      input = { ...input, boiler_w: input.boiler_w.map(() => 0), boiler_permitted: input.boiler_permitted.map(() => false),
        problem: { ...input.problem, slots: input.problem.slots.map((s, i) => ({ ...s, base_w: s.base_w - input.boiler_w[i] })) } };
      solved = core.solve(input.problem).outcome;
    }
  }
  if (solved.kind === "failed") {
    const committed = /^committed_command_infeasible:(\d+):(.+)$/.exec(solved.issue);
    if (committed) {
      const start = input.snapshot.slots[Number(committed[1])]?.start;
      if (start) return fail(committed[2] === "shared_grid_limit"
        ? `Previously accepted commands at ${start} exceed the configured grid limit when projected from current measurements (import ${input.problem.limits.import_w / 1000} kW, export ${input.problem.limits.export_w / 1000} kW).`
        : `Previously accepted commands at ${start} cannot be projected from current measurements: ${committed[2]}.`);
    }
    return fail(solved.issue);
  }
  const refined = addHotWater(core, input, solved.selection);
  input = refined.input;
  const selected = refined.selection;
  const p = input.problem;
  const priority = scenario(input, selected.commands, selected.quarters, "priority", "Rule-based plan");
  if (released) priority.generated.continuity = released;
  // Only the selected schedule has a rule account; the baseline was never scored.
  priority.generated.slots.forEach((slot, i) => {
    slot.rule_points = Object.fromEntries(p.rules.flatMap((rule, r) => {
      const points = selected.account.contributions[i][r];
      return points ? [[rule.key, points]] : [];
    }));
  });
  const { commands: baselineCommands, outcome: baselineProjection } = projectRulesBaseline(core, input, selected.commands, selected.quarters);
  const baseline: BaselinePlan = baselineProjection.kind === "projected"
    ? scenario(input, baselineCommands, baselineProjection.quarters, "baseline", "Selected loads with self-consumption battery and EV load balancing").generated
    : { key: "baseline", label: "Selected loads with self-consumption battery and EV load balancing", status: "infeasible",
      validation_errors: [baselineProjection.issue], slots: [], summary: null,
      service_slots: {}, service_currents_a: {}, service_inhibited_slots: {}, dispatched_devices: [], store_diagnostics: [] };
  if (baselineProjection.kind === "failed") {
    input.snapshot.planning_warnings = mergePlanningWarnings(input.snapshot.planning_warnings, [planningWarning(
      "baseline_unavailable", "comparison", `The comparison baseline could not be projected: ${baselineProjection.issue}.`,
      "The selected control plan remains available. Baseline forecasts and cost comparisons are unavailable.",
      { reason: baselineProjection.issue })]);
  } else {
    const reduced = baselineCommands.filter((command, i) => command.ev_amps < selected.commands[i].ev_amps).length;
    if (reduced) {
      const evEnergy = (quarters: NativeQuarter[]) => sum(quarters.map((q, i) => q.ev_w *
        (p.slots[i].hours + Math.min(0, p.slots[i].start_seconds) / 3600) / 1000));
      input.snapshot.planning_warnings = mergePlanningWarnings(input.snapshot.planning_warnings, [planningWarning(
        "baseline_ev_load_balanced", "comparison", "The comparison reduced EV charging to stay within the grid limit.",
        "Its forecast and costs use the load-balanced charging actually projected. Cost comparisons are withheld if delivered EV energy differs.",
        { quarters: reduced, selected_ev_kwh: evEnergy(selected.quarters), baseline_ev_kwh: evEnergy(baselineProjection.quarters) })]);
    }
  }
  const cost = { ...priority.generated, key: "cost" as const, label: "Rule-based plan (same selected schedule)" };
  const snapshot = input.snapshot;
  const bindingUntil = priority.generated.slots.filter(s => s.binding).at(-1);
  const overloads = priority.generated.slots.filter(s => s.grid_import_w > snapshot.grid.import_limit_w + 1e-6);
  if (overloads.length) snapshot.planning_warnings = mergePlanningWarnings(snapshot.planning_warnings, [planningWarning(
    "forecast_grid_excess", "household", `${overloads.length} quarters forecast demand above the configured import limit.`,
    "The full demand remains visible. Planning avoids additional controllable demand that worsens the excess.",
    { quarters: overloads.length, peak_w: Math.max(...overloads.map(s => s.grid_import_w)) }, "error")]);
  const modelledRooms=(snapshot.thermal_zones??[]).filter(z=>input.rooms.temperature[z.key]?.every(finite)&&
    input.rooms.unplanned_temperature[z.key]?.every(finite));
  const thermalProjection: OptimisationPlan["thermal_projection"] = modelledRooms.length && snapshot.outdoor_temperature_c?.every(finite) ? {
    source:"comfort_schedule_model",season:null,slot_minutes:15,starts:snapshot.slots.map(s=>s.start),
    outdoor_temperature_c:snapshot.outdoor_temperature_c as number[],
    planned_total_power_w:snapshot.slots.map((_s,i)=>sum(modelledRooms.map(z=>input.rooms.room_power[z.key][i]))),
    unplanned_total_power_w:snapshot.slots.map((_s,i)=>sum(modelledRooms.map(z=>z.unplanned_power_w[i]))),
    zones:modelledRooms.map((z,i)=>({key:z.key,name:z.name,control_type:"setpoint",load_type:"duty_cycle",priority:i+1,
      rated_power_w:z.rated_power_w,comfort_min_c:z.comfort_min_c,target_c:z.target_c,comfort_max_c:z.comfort_max_c,
      planned_temperature_c:input.rooms.temperature[z.key] as number[],unplanned_temperature_c:input.rooms.unplanned_temperature[z.key] as number[],
      planned_power_w:input.rooms.room_power[z.key],unplanned_power_w:z.unplanned_power_w}))} : undefined;
  let plan: OptimisationPlan = { schema_version: snapshot.schema_version, mode: "live", capabilities: snapshot.capabilities,
    model_version: RULES_MODEL_VERSION, decision_diagnostics_version: 2, plan_id: snapshot.snapshot_id, snapshot_id: snapshot.snapshot_id,
    issued_at: input.now, valid_until: new Date(Date.parse(snapshot.slots.at(-1)!.start) + QUARTER_MS).toISOString(),
    binding_until: bindingUntil ? new Date(Date.parse(bindingUntil.start) + QUARTER_MS).toISOString() : snapshot.slots[0].start,
    hot_water_permissions: input.boiler_permission_starts, hot_water_shortfall_minutes: input.boiler_shortfall_minutes,
    timezone: snapshot.timezone, slot_minutes: 15, status: "ready", validation_errors: [], measurement_issues: snapshot.measurement_issues ?? [],
    planning_warnings: snapshot.planning_warnings ?? [],
    ...(thermalProjection?{thermal_projection:thermalProjection}:{}),
    sources: snapshot.sources, pv_calibration: snapshot.pv_calibration, price_outlook: input.price_outlook,
    battery_value_curve: null, resolved_value_stores: [], policy: { ...snapshot.policy, battery_end_of_solar_target_soc: 0, battery_target_is_hard: false, terminal_soc_min: 0, terminal_energy_value_sek_per_kwh: 0 }, battery_supply_scope: { kind: "selected", include_base: true,
      planned_device_keys: snapshot.device_models.filter(m => m.category !== "ev_charging").map(m => m.key).sort() },
    battery: snapshot.battery && p.battery ? { ...snapshot.battery, ...p.battery } : null,
    ev_battery: snapshot.ev_battery && p.car ? { ...snapshot.ev_battery, ...p.car } : null,
    pool: snapshot.pool && snapshot.capabilities.pool ? { ...snapshot.pool,
      stop_temperature_c: input.pool_service.empirical ? input.pool_service.stop_c : p.pool_stop_c,
      planning_basis: input.pool_service.empirical ? "empirical" : "thermal",
      ...(p.heater ? { heater_response: p.heater.response } : {}) } : null,
    grid: snapshot.grid, peak_shaping: { threshold_w: 0, sek_per_kwh_per_kw: 0, grid_ramp_sek_per_kw: 0, load_start_preference_sek: 0 },
    device_models: snapshot.device_models, services: snapshot.services, service_requirement_sample_days: snapshot.service_requirement_sample_days,
    plans: { baseline, priority: priority.generated, cost },
  };
  if (snapshot.schema_version === 9) {
    // One selected schedule owns both charts, the device requests and the
    // battery contract. A device's mode decides who writes its requests, never
    // what the household is planned to do, so no second projection is made.
    const executionPlan = { ...plan, schema_version: 8 as const };
    const mode = snapshot.operating_scope!.modes.$battery;
    const feedback = snapshot.battery_execution_feedback;
    const contract = p.battery && feedback && (mode === "controlling" || mode === "control_verification")
      ? buildBatteryExecutionContract({ plan: executionPlan, rows: priority.rows, pv_w: p.slots.map(s => s.solar_w),
        mode, scope_revision: feedback.scope_revision!, feedback }) : undefined;
    plan = { ...plan, operating_scope: snapshot.operating_scope, execution_plan: executionPlan,
      ...(contract ? { battery_execution: contract } : {}) };
  }
  // Native commands remain the existing authority when the integration does
  // not publish optional execution feedback. Do not invent a feedback receipt
  // or a utility-curve monetary projection for the rules objective.
  return { plan, battery_projection: { status: "unsupported", reasons: [
    !p.battery ? "no_battery" : plan.battery_execution
      ? "replaced_by_plan_execution_contract" : "rules_objective_has_no_conditional_money_projection",
  ] } };
}
