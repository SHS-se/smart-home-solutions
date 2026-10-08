import { localMonths } from "./planner-wasm/calendar.ts";
/** One prepared household, one native selection, one authoritative publication.
 * This boundary has no database, history, source fetching or model fitting API.
 */
import { createHash } from "node:crypto";
import artifact from "./planner-wasm/artifact.json" with { type: "json" };
import runtime from "./planner-wasm/runtime-config.json" with { type: "json" };
const { recipe, policy_manifest: policyManifest } = runtime;
import { SOLVER_BASE64 } from "./planner-wasm/solver-bytes.ts";
import { createWasmPlanner, type NativeQuarter } from "./planner-wasm/core.ts";
import { builderRecipe, type NativeCommand, type ReadyProblem } from "./planner-wasm/ready-problem.ts";
import type { ReadyRulePolicy } from "./planner-wasm/rule-policy.ts";
import type { EnergyPlanningInput } from "./planner/fixed-energy-plan.ts";
import type { GeneratedPlan, OptimisationPlan, OptimisationResult, OptimisationSnapshot, PlannedSlot, PlanSummary } from "./planner/energy-optimisation.ts";
import { isolateMeasurements } from "./planner/measurement-isolation.ts";
import { parseDeviceModels, parseHeaterResponse, publishHeater, WATER_KWH_PER_M3_K, type PublishedHeater, type ThermalStoreModel } from "./planner/device-models.ts";
import { poolHeaters } from "./planner/pool-devices.ts";
import { validateOperatingScope } from "./planner/operating-scope.ts";
import { buildBatteryExecutionContract, validateExecutionFeedback } from "./planner/battery-plan-execution.ts";
import type { BatteryProjectionRow } from "./planner/battery-dispatch-projection.ts";
import type { BatteryCommand } from "./planner/battery-command.ts";
import type { DeviceCommand } from "./planner/device-commands.ts";

export const RULES_MODEL_VERSION = `rules-planner-v4:${createHash("sha256").update(JSON.stringify({ artifact, recipe, policyManifest })).digest("hex")}`;
const QUARTER_MS = 900_000;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const fail = (message: string): never => { throw new Error(message); };

export type PublishedCommandSlot = Pick<PlannedSlot, "start" | "pool_w" | "pool_command_w" | "ev_target_current_a" | "ev_min_current_a" | "ev_max_current_a" | "boiler_permitted" | "battery_command" | "device_commands">;
export interface PublishedCommandReference {
  plan_id: string;
  slots: PublishedCommandSlot[];
}
interface DeviceMember { key: string; watts: number }
export interface PreparedRulesInput {
  snapshot: OptimisationSnapshot;
  now: string;
  model_version: string;
  problem: ReadyProblem;
  price_outlook: OptimisationPlan["price_outlook"];
  locked_slots: PublishedCommandSlot[];
  reference_plan_id: string | null;
  members: { heater: DeviceMember[]; auxiliary: DeviceMember[]; ev: DeviceMember[]; boiler: DeviceMember[] };
  passive_w: Record<string, number[]>;
  boiler_w: number[];
  boiler_permitted: boolean[];
  base_w: number[];
}

let compiled: ReturnType<typeof createWasmPlanner> | undefined;
function planner(): ReturnType<typeof createWasmPlanner> {
  if (compiled) return compiled;
  const bytes = Uint8Array.from(atob(SOLVER_BASE64), c => c.charCodeAt(0));
  if (artifact.abi !== 5 || createHash("sha256").update(bytes).digest("hex") !== artifact.wasm_sha256) {
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
    device_models: original.device_models.map(m => ({ ...m, forecast_w_by_slot: series(m.forecast_w_by_slot) })),
    services: original.services.map(s => s.device === "boiler"
      ? { ...s, control: { ...s.control, expected_power_w_by_slot: series(s.control.expected_power_w_by_slot) } } : s),
    ...(original.operating_scope ? { operating_scope: { ...original.operating_scope,
      external_demands: Object.fromEntries(Object.entries(original.operating_scope.external_demands).map(([key, value]) =>
        [key, { ...value, forecast_w_by_slot: series(value.forecast_w_by_slot), recent_observation: offset ? null : value.recent_observation }])) } } : {}),
  } };
}

/** Normalize supplied physical facts once; no fabricated battery, car or heater. */
function poolModel(snapshot: OptimisationSnapshot): { store: ThermalStoreModel; heater: PublishedHeater } | null {
  if (!snapshot.capabilities.pool) return null;
  if (!snapshot.pool) return fail("Pool capability requires current pool state");
  const supplied = snapshot.device_physics?.pool;
  if (supplied) return { store: supplied.store, heater: publishHeater(supplied.heater) };
  const measured = snapshot.pool_model;
  if (!measured?.heater_response) return fail("Pool requires a published native heater response");
  const members = snapshot.device_models.filter(m => m.planning_service === "pool");
  const heaters = new Set(poolHeaters(members).map(m => m.key));
  const memberCompressor = sum(members.filter(m => heaters.has(m.key)).map(m => m.active_power_w ?? 0));
  const measuredCompressor = measured.heater_response.kind === "bergvarme" ? measured.heater_response.evidence?.steady_compressor_w : undefined;
  const compressor = finite(measuredCompressor) ? measuredCompressor : memberCompressor;
  const auxiliary = sum(members.filter(m => !heaters.has(m.key)).map(m => m.active_power_w ?? 0));
  if (!(compressor > 0)) return fail("Pool model requires measured compressor input");
  const capacity = snapshot.pool.volume_m3 * WATER_KWH_PER_M3_K;
  const lossPoints = (measured.response ?? []).flatMap(bin => finite(bin.idle_c_per_h)
    ? [{ at_c: bin.at_c, c_per_h: bin.idle_c_per_h }] : []).sort((a, b) => a.at_c - b.at_c);
  const gains = (measured.response ?? []).filter(bin => finite(bin.heat_c_per_kwh) && bin.heat_c_per_kwh > 0 && finite(bin.heated_kwh) && bin.heated_kwh > 0);
  const gainWeight = sum(gains.map(bin => bin.heated_kwh!));
  const gain = gainWeight > 0 ? sum(gains.map(bin => bin.heat_c_per_kwh! * bin.heated_kwh!)) / gainWeight : null;
  const heat = gain === null ? (finite(measured.rated_cop) ? measured.rated_cop * compressor : null) : gain * capacity * compressor;
  if (heat === null || !(heat > 0)) return fail("Pool requires measured heat delivery or a fitted COP");
  const loss: ThermalStoreModel["loss"] = lossPoints.length ? { kind: "measured", points: lossPoints }
    : finite(measured.loss_kw_per_k) ? { kind: "linear", kw_per_c: measured.loss_kw_per_k, surroundings_c: null }
    : fail("Pool requires a fitted standing loss");
  return { store: { capacity_kwh_per_c: capacity, loss }, heater: {
    compressor_w: compressor, auxiliary_w: auxiliary, heat_w: heat,
    response: parseHeaterResponse(measured.heater_response),
  } };
}

function nativeCommand(slot: PublishedCommandSlot, snapshot: OptimisationSnapshot): NativeCommand {
  const battery = slot.battery_command;
  if (snapshot.capabilities.battery && !battery) return fail(`Committed battery command missing at ${slot.start}`);
  if (snapshot.capabilities.pool && !finite(slot.pool_command_w)) return fail(`Committed native pool command missing at ${slot.start}`);
  if (snapshot.capabilities.ev && !finite(slot.ev_target_current_a)) return fail(`Committed native EV command missing at ${slot.start}`);
  return { pool_on: (slot.pool_command_w ?? 0) > 0, ev_amps: slot.ev_target_current_a,
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
  if (isolated.device_physics) isolated.device_physics = parseDeviceModels(isolated.device_physics);
  const { snapshot, offset } = alignedSnapshot(isolated, effective);
  if (snapshot.schema_version === 9) validateOperatingScope(snapshot);
  if (snapshot.battery_execution_feedback) validateExecutionFeedback(snapshot.battery_execution_feedback);
  if (snapshot.thermal_zones?.length) return fail(`Unsupported active thermal owners: ${snapshot.thermal_zones.map(z => z.name).join(", ")}`);
  const count = snapshot.slots.length;
  if (Date.parse(snapshot.slots[0].start) > effective) return fail("Planning input must cover its capture interval");
  const outlook = { ...input.resolved_price_outlook,
    shadow_import_sek_per_kwh: input.resolved_price_outlook.shadow_import_sek_per_kwh.slice(offset) };
  if (outlook.shadow_import_sek_per_kwh.length !== count || !outlook.shadow_import_sek_per_kwh.every(finite)) return fail("Resolved prices must cover every planning interval");
  const battery = snapshot.capabilities.battery ? snapshot.device_physics?.battery ?? snapshot.battery : null;
  if (snapshot.capabilities.battery && !battery) return fail("Battery capability requires a physical model and state");
  if (battery && (!finite(snapshot.value_settings?.battery_degradation_sek_per_kwh) || snapshot.value_settings!.battery_degradation_sek_per_kwh < 0)) return fail("Battery requires its resolved wear setting");
  const ev = snapshot.capabilities.ev ? snapshot.ev_battery : null;
  const evService = snapshot.services.find(s => s.device === "ev" && s.control.type === "discrete_current");
  const charger = ev ? snapshot.device_physics?.car?.charger ?? (evService?.control.type === "discrete_current" ? evService.control : null) : null;
  const car = ev ? snapshot.device_physics?.car?.battery ?? (finite(ev.kwh_per_km) ? {
    capacity_kwh: ev.capacity_kwh, kwh_per_km: ev.kwh_per_km, charge_efficiency: ev.charge_efficiency,
  } : null) : null;
  if (snapshot.capabilities.ev && (!ev || !charger || !car)) return fail("EV requires measured battery state, consumption and a native charger model");
  if (snapshot.policy.battery_target_is_hard) return fail("Unsupported configured hard battery target in rules planner");
  if (snapshot.capabilities.pool && finite(snapshot.pool_model?.cutout_air_c)) return fail("Unsupported configured pool air cutout in native model");
  const pool = poolModel(snapshot);
  if (pool && snapshot.pool?.heating_running && !finite(snapshot.pool.heating_elapsed_seconds)) {
    snapshot.pool = { ...snapshot.pool, heating_elapsed_seconds: 0, heating_elapsed_basis: "observed_on_lower_bound" };
  }
  const hardware = snapshot.pool_model?.hardware;
  if (pool && (!hardware || hardware.control !== "external_enable" || !finite(hardware.stop_c) || !finite(hardware.start_c))) return fail("Pool requires independently configured native start/stop settings and external-enable semantics");
  if (pool && !finite(snapshot.comfort?.pool?.target_c)) return fail("Pool requires an explicit comfort target");
  if (car && !finite(snapshot.comfort?.ev?.target_km)) return fail("EV requires an explicit range target");
  const poolMembers = snapshot.device_models.filter(m => m.planning_service === "pool");
  const heaterKeys = new Set(poolHeaters(poolMembers).map(m => m.key));
  const member = (m: OptimisationSnapshot["device_models"][number]): DeviceMember => ({ key: m.key, watts: m.active_power_w ?? 0 });
  const members = {
    heater: pool ? poolMembers.filter(m => heaterKeys.has(m.key)).map(member) : [],
    auxiliary: pool ? poolMembers.filter(m => !heaterKeys.has(m.key)).map(member) : [],
    ev: car ? snapshot.device_models.filter(m => m.category === "ev_charging").map(member) : [],
    boiler: snapshot.capabilities.boiler ? snapshot.device_models.filter(m => m.category === "hot_water").map(member) : [],
  };
  const owned = new Set(Object.values(members).flat().map(m => m.key));
  const passive = Object.fromEntries(snapshot.device_models.filter(m => !owned.has(m.key)).map(m => {
    const owner = snapshot.operating_scope?.device_owners[m.key];
    const mode = owner ? snapshot.operating_scope?.modes[owner] : undefined;
    const isolatedOwner = snapshot.measurement_issues?.some(issue =>
      issue.device === "ev" && m.category === "ev_charging" || issue.device === "pool" && m.planning_service === "pool");
    if (!isolatedOwner && (mode === "controlling" || mode === "control_verification" || (!snapshot.operating_scope && m.control_type === "setpoint"))) return fail(`Unsupported active physical owner: ${m.name} (${m.key})`);
    return [m.key, m.forecast_w_by_slot];
  }));
  for (const [key, values] of Object.entries(passive)) if (values.length !== count || values.some(v => !finite(v) || v < 0)) return fail(`Invalid supplied passive forecast: ${key}`);
  const boilerService = snapshot.services.filter(s => s.device === "boiler");
  if (snapshot.capabilities.boiler && (!boilerService.length || boilerService.some(s => s.control.type !== "duty_cycle"))) return fail("Boiler requires its native permit/inhibit forecast");
  const boilerW = snapshot.slots.map((slot, i) => sum(boilerService.map(s =>
    s.control.type === "duty_cycle" && Date.parse(slot.start) + QUARTER_MS > Date.parse(s.earliest_start) && Date.parse(slot.start) < Date.parse(s.deadline)
      ? s.control.expected_power_w_by_slot[i] : 0)));
  const permitted = snapshot.slots.map(() => true);
  const previous = new Map(reference?.slots.map(slot => [Date.parse(slot.start), slot]) ?? []);
  const locked: PublishedCommandSlot[] = [];
  if (reference) {
    for (const slot of snapshot.slots) {
      if (Date.parse(slot.start) >= effective + 3_600_000) break;
      const prior = previous.get(Date.parse(slot.start));
      if (!prior) return fail(`Committed next-hour commands unavailable at ${slot.start}`);
      locked.push(prior);
    }
    if (Date.parse(snapshot.slots.at(-1)!.start) + QUARTER_MS < effective + 3_600_000) return fail("Committed next hour is outside the planning horizon");
  }
  for (let i = 0; i < locked.length; i++) {
    if (!locked[i].device_commands && snapshot.device_models.length && snapshot.schema_version >= 7) return fail("Committed device command map missing");
    for (const key of Object.keys(locked[i].device_commands ?? {})) if (!snapshot.device_models.some(m => m.key === key)) return fail(`Committed owner removed: ${key}`);
    if (snapshot.capabilities.boiler && typeof locked[i].boiler_permitted !== "boolean") return fail("Committed boiler permission missing");
    permitted[i] = locked[i].boiler_permitted;
    if (!permitted[i]) boilerW[i] = 0;
  }
  if (input.fixed_plan) {
    const fixed = new Map(input.fixed_plan.slots.map(s => [Date.parse(s.start), s.targets]));
    for (const slot of snapshot.slots) {
      const booking = fixed.get(Date.parse(slot.start));
      if (!booking) continue;
      const i = snapshot.slots.indexOf(slot);
      if (i >= locked.length || JSON.stringify(nativeCommand(booking, snapshot)) !== JSON.stringify(nativeCommand(locked[i], snapshot))) {
        return fail("Existing fixed booking requires an exact native commitment beyond the next hour");
      }
    }
  }
  const spreads = snapshot.slots.flatMap(s => s.import_price_sek_per_kwh === null || s.export_price_sek_per_kwh === null ? [] : [s.import_price_sek_per_kwh - s.export_price_sek_per_kwh]).sort((a, b) => a - b);
  if (!spreads.length && snapshot.slots.some(s => s.export_price_sek_per_kwh === null)) return fail("Resolved export forecast needs a published tariff spread");
  const spread = spreads[Math.floor(spreads.length / 2)] ?? 0;
  const baseW = snapshot.slots.map(s => s.base_load_forecast_w);
  const months = localMonths(snapshot.slots.map(s => s.start), snapshot.timezone);
  const problem: ReadyProblem = {
    abi: 5, pool_cycle_seconds: approved.pool_cycle_seconds, work_grant: recipe.work_grant, recipe: builderRecipe(recipe),
    slots: snapshot.slots.map((s, i) => {
      const start = Date.parse(s.start);
      const lead = Math.max(0, Math.min(snapshot.pv_calibration.correction_factor_by_lead_day.length - 1, Math.floor((start - Date.parse(snapshot.captured_at)) / 86_400_000)));
      const outdoor = snapshot.outdoor_temperature_c?.[i];
      if (pool?.store.loss.kind === "linear" && pool.store.loss.surroundings_c === null && !finite(outdoor)) return fail(`Pool physical forecast requires outdoor temperature at ${s.start}`);
      return { local_month: months[i], start_seconds: (start - effective) / 1000, hours: 0.25,
        base_w: baseW[i] + boilerW[i] + sum(Object.values(passive).map(values => values[i])),
        solar_w: s.pv_forecast_w * snapshot.pv_calibration.correction_factor_by_lead_day[lead],
        outdoor_c: finite(outdoor) ? outdoor : 0,
        import_price: outlook.shadow_import_sek_per_kwh[i], export_price: s.export_price_sek_per_kwh ?? outlook.shadow_import_sek_per_kwh[i] - spread,
        published: s.import_price_sek_per_kwh !== null && s.export_price_sek_per_kwh !== null,
        ev_available: !!ev && ev.connected && (ev.available_from === null || start + QUARTER_MS > Date.parse(ev.available_from)) && (ev.departure === null || start < Date.parse(ev.departure)),
      };
    }),
    battery, car, charger, pool_store: pool?.store ?? null, heater: pool?.heater ?? null,
    pool_stop_c: hardware?.stop_c ?? null,
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
      wear_per_kwh: snapshot.value_settings?.battery_degradation_sek_per_kwh ?? 0 },
    rules: approved.rules, service_guard: approved.service_guard,
    accepted: reference ? locked.map(slot => nativeCommand(slot, snapshot)) : null,
    locked_through_seconds: reference ? 3600 : 0,
  };
  return { snapshot, now: new Date(input.now).toISOString(), model_version: RULES_MODEL_VERSION, problem,
    price_outlook: outlook, locked_slots: locked, reference_plan_id: reference?.plan_id ?? null,
    members, passive_w: passive, boiler_w: boilerW, boiler_permitted: permitted, base_w: baseW };
}

function allocate(members: DeviceMember[], watts: number, into: Record<string, number>) {
  const total = sum(members.map(m => m.watts));
  if (members.length && watts > 0 && !(total > 0)) return fail("Physical device members require measured allocation powers");
  for (const m of members) into[m.key] = total > 0 ? watts * m.watts / total : 0;
}
function commandMap(input: PreparedRulesInput, command: NativeCommand, i: number): Record<string, DeviceCommand> {
  const locked = input.locked_slots[i];
  if (locked?.device_commands) return structuredClone(locked.device_commands);
  const result: Record<string, DeviceCommand> = {};
  const pool = new Set([...input.members.heater, ...input.members.auxiliary].map(m => m.key));
  const ev = new Set(input.members.ev.map(m => m.key));
  const boiler = new Set(input.members.boiler.map(m => m.key));
  for (const model of input.snapshot.device_models) {
    result[model.key] = pool.has(model.key) ? model.control_type === "switch_schedule"
      ? { type: "switch_schedule", on_seconds: command.pool_on ? 900 : 0 }
      : { type: "unavailable", reason: "Dedicated pool owner supplies the native enable command" }
      : ev.has(model.key) ? { type: "variable_power", value: command.ev_amps, unit: "A" }
      : boiler.has(model.key) ? { type: "permit_inhibit", permitted: input.boiler_permitted[i] }
      : { type: "unavailable", reason: "External forecast owner has no planner command" };
  }
  return result;
}
function batteryCommand(command: NativeCommand): BatteryCommand {
  return { schema_version: 3, operation: command.battery, charge_limit_w: command.charge_limit_w,
    discharge_limit_w: command.discharge_limit_w, allow_grid_charge: command.battery === "grid_charge",
    allow_battery_export: command.battery === "export" };
}

interface Materialized { generated: GeneratedPlan; rows: BatteryProjectionRow[] }
function scenario(input: PreparedRulesInput, commands: NativeCommand[], quarters: NativeQuarter[],
  key: "priority" | "baseline" | "cost", label: string, execution = false): Materialized {
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
    if (execution) for (const [device, demand] of Object.entries(snapshot.operating_scope?.external_demands ?? {})) loads[device] = demand.forecast_w_by_slot[i];
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
    const locked = input.locked_slots[i];
    const ownerWatts = (members: DeviceMember[], modeled: number) => execution && members.some(m => m.key in (snapshot.operating_scope?.external_demands ?? {}))
      ? sum(members.map(m => loads[m.key])) : modeled;
    const physicalPool = ownerWatts([...input.members.heater, ...input.members.auxiliary], q.pool_w);
    const physicalEv = ownerWatts(input.members.ev, q.ev_w);
    const physicalBoiler = ownerWatts(input.members.boiler, input.boiler_w[i]);
    return { start: source.start, duration_hours: hours, binding,
      pv_raw_w: source.pv_forecast_w, pv_w: f.solar_w, base_w: input.base_w[i],
      import_price_sek_per_kwh: source.import_price_sek_per_kwh, export_price_sek_per_kwh: source.export_price_sek_per_kwh,
      shadow_import_sek_per_kwh: f.import_price, shadow_export_sek_per_kwh: f.export_price,
      pool_w: physicalPool, pool_command_w: locked?.pool_command_w ?? (command.pool_on && p.heater ? p.heater.compressor_w + p.heater.auxiliary_w : 0),
      ...(q.pool_c === null ? {} : { pool_temperature_c: q.pool_c }),
      boiler_expected_w: physicalBoiler, boiler_permitted: input.boiler_permitted[i],
      ev_w: physicalEv, room_heating_w: {}, device_loads_w: loads, device_commands: commandMap(input, command, i),
      ev_target_current_a: command.ev_amps, ev_min_current_a: locked?.ev_min_current_a ?? 0, ev_max_current_a: locked?.ev_max_current_a ?? (f.ev_available ? p.charger?.max_current_a ?? 0 : 0),
      ev_soc: p.car && q.ev_kwh !== null ? q.ev_kwh / p.car.capacity_kwh : null, ev_connected: f.ev_available,
      load_w: load, battery_charge_w: q.charge_w, battery_discharge_w: q.discharge_w, battery_export_w: batteryExport,
      battery_command: p.battery ? locked?.battery_command ?? batteryCommand(command) : null,
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
  const serviceSlots = Object.fromEntries(snapshot.services.map(s => [s.id, indices(slot => Date.parse(slot.start) >= Date.parse(s.earliest_start) && Date.parse(slot.start) < Date.parse(s.deadline) &&
    (s.device === "pool" ? slot.pool_w : s.device === "ev" ? slot.ev_w : slot.boiler_expected_w) > 0)]));
  return { rows, generated: { key, label, status: "ready", validation_errors: [], slots, summary,
    service_slots: serviceSlots, service_currents_a: Object.fromEntries(snapshot.services.filter(s => s.device === "ev").map(s => [s.id, serviceSlots[s.id].map(i => slots[i].ev_target_current_a)])),
    service_inhibited_slots: Object.fromEntries(snapshot.services.filter(s => s.device === "boiler").map(s => [s.id, indices(slot => !slot.boiler_permitted)])),
    dispatched_devices: [...(p.battery ? ["battery"] : []), ...(p.pool_store ? ["pool"] : []), ...(p.car ? ["ev"] : [])], store_diagnostics: [] } };
}

/** Native physics also owns baseline and actual external-demand projections. */
export function generateRulesPlan(input: PreparedRulesInput): OptimisationResult {
  if (input.model_version !== RULES_MODEL_VERSION) return fail("Prepared rules planner version changed");
  if (input.problem.work_grant !== recipe.work_grant || JSON.stringify(input.problem.recipe) !== JSON.stringify(builderRecipe(recipe))) return fail("Prepared planner work recipe differs from its model identity");
  const core = planner(), p = input.problem;
  const solved = core.solve(p).outcome;
  if (solved.kind === "failed") return fail(solved.issue);
  const selected = solved.selection;
  const priority = scenario(input, selected.commands, selected.quarters, "priority", "Rule-based plan");
  const baselineCommands = selected.commands.map((c, i) => input.problem.accepted?.[i] ?? {
    ...c, battery: p.battery ? "self_consumption" as const : "idle" as const,
    charge_limit_w: p.battery?.charge_max_w ?? 0, discharge_limit_w: p.battery?.discharge_max_w ?? 0,
  });
  const baselineProjection = core.project(p, baselineCommands).outcome;
  if (baselineProjection.kind === "failed") return fail(`Baseline projection: ${baselineProjection.issue}`);
  const baseline = scenario(input, baselineCommands, baselineProjection.quarters, "baseline", "Selected loads with self-consumption battery");
  const cost = { ...priority.generated, key: "cost" as const, label: "Rule-based plan (same selected schedule)" };
  const snapshot = input.snapshot;
  const bindingUntil = priority.generated.slots.filter(s => s.binding).at(-1);
  let plan: OptimisationPlan = { schema_version: snapshot.schema_version, mode: "live", capabilities: snapshot.capabilities,
    model_version: RULES_MODEL_VERSION, decision_diagnostics_version: 2, plan_id: snapshot.snapshot_id, snapshot_id: snapshot.snapshot_id,
    issued_at: input.now, valid_until: new Date(Date.parse(snapshot.slots.at(-1)!.start) + QUARTER_MS).toISOString(),
    binding_until: bindingUntil ? new Date(Date.parse(bindingUntil.start) + QUARTER_MS).toISOString() : snapshot.slots[0].start,
    timezone: snapshot.timezone, slot_minutes: 15, status: "ready", validation_errors: [], measurement_issues: snapshot.measurement_issues ?? [],
    sources: snapshot.sources, pv_calibration: snapshot.pv_calibration, price_outlook: input.price_outlook,
    battery_value_curve: null, resolved_value_stores: [], policy: { ...snapshot.policy, battery_end_of_solar_target_soc: 0, battery_target_is_hard: false, terminal_soc_min: 0, terminal_energy_value_sek_per_kwh: 0 }, battery_supply_scope: { kind: "whole_house" },
    battery: snapshot.battery && p.battery ? { ...snapshot.battery, ...p.battery } : null,
    ev_battery: snapshot.ev_battery && p.car ? { ...snapshot.ev_battery, ...p.car } : null,
    pool: snapshot.pool && p.heater ? { ...snapshot.pool, stop_temperature_c: p.pool_stop_c, heater_response: p.heater.response } : null,
    grid: snapshot.grid, peak_shaping: { threshold_w: 0, sek_per_kwh_per_kw: 0, grid_ramp_sek_per_kw: 0, load_start_preference_sek: 0 },
    device_models: snapshot.device_models, services: snapshot.services, service_requirement_sample_days: snapshot.service_requirement_sample_days,
    plans: { baseline: baseline.generated, priority: priority.generated, cost },
  };
  if (snapshot.schema_version === 9) {
    const external = snapshot.operating_scope!.external_demands;
    const externalPool = snapshot.operating_scope!.modes.$pool !== "controlling";
    const externalEv = snapshot.operating_scope!.modes.$ev !== "controlling";
    const externalBoiler = input.members.boiler.some(m => m.key in external);
    const executionProblem: ReadyProblem = { ...p,
      slots: p.slots.map((s, i) => ({ ...s, base_w: input.base_w[i] + sum(Object.entries(input.passive_w).map(([key, v]) => external[key]?.forecast_w_by_slot[i] ?? v[i])) +
        (externalBoiler ? 0 : input.boiler_w[i]) + sum(Object.entries(external).filter(([key]) => !(key in input.passive_w)).map(([, d]) => d.forecast_w_by_slot[i])) })),
      ...(externalPool ? { pool_store: null, heater: null, pool_stop_c: null } : {}),
      ...(externalEv ? { car: null, charger: null } : {}),
      initial: { ...p.initial, ...(externalPool ? { pool_c: null, heater_state: null } : {}), ...(externalEv ? { ev_kwh: null } : {}) },
      targets: { ...p.targets, ...(externalPool ? { pool_c: null } : {}), ...(externalEv ? { ev_km: null, ev_limit_kwh: null } : {}) },
      accepted: null, locked_through_seconds: 0,
    };
    const executionCommands = selected.commands.map(c => ({ ...c, ...(externalPool ? { pool_on: false } : {}), ...(externalEv ? { ev_amps: 0 } : {}) }));
    const projected = core.project(executionProblem, executionCommands).outcome;
    if (projected.kind === "failed") return fail(`Execution physical projection: ${projected.issue}`);
    const execution = scenario(input, selected.commands, projected.quarters, "priority", "Physical execution forecast", true);
    const executionPlan = { ...plan, schema_version: 8 as const, plans: { ...plan.plans, priority: execution.generated } };
    const mode = snapshot.operating_scope!.modes.$battery;
    const feedback = snapshot.battery_execution_feedback;
    const contract = p.battery && feedback && (mode === "controlling" || mode === "control_verification")
      ? buildBatteryExecutionContract({ plan: executionPlan, rows: execution.rows, pv_w: p.slots.map(s => s.solar_w),
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
