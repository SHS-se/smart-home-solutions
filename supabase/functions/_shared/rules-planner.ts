import { deviceMembers as group, allocateDevicePower as allocate, type DeviceMember } from './planner/device-power-allocation.ts';
import { DEFAULT_VALUE_SETTINGS } from "./planner/value-curves.ts";
import { addHotWater } from "./rules-hot-water.ts";
import { projectRulesBaseline } from "./rules-baseline.ts";
import { POOL_START_COST_SEK, EV_START_PREFERENCE_SEK, BATTERY_START_PREFERENCE_SEK } from "./planner-wasm/cost-policy.ts";
import { demandLevel } from "./planner/demand-outlook.ts";
import { preparePoolService, type PoolService } from "./rules-pool-service.ts";
import { prepareRoomServices, type RoomServices } from "./rules-room-services.ts";
import { roomProjectionControl } from "./planner/models/room/control.ts";
import { mergePlanningWarnings, planningWarning } from "./planner/planning-warnings.ts";
import { localDay, localMonths } from "./planner-wasm/calendar.ts";
/** One prepared household, one native selection, one authoritative publication.
 * This boundary has no database, history, source fetching or model fitting API.
 */
import runtime from "./planner-wasm/runtime-config.json" with { type: "json" };
const { recipe } = runtime;
import { nativePlanner } from "./planner-wasm/runtime.ts";
import type { NativeQuarter } from "./planner-wasm/core.ts";
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
import { batteryDemand, instructionFor, nativeBattery, profileFor } from "./planner/battery-instruction.ts";
import { allocatedBatteryCommand } from "./planner-wasm/battery-command.ts";
import type { DeviceCommand } from "./planner/device-commands.ts";
import { planningStage, type PlanningTrace } from "./planning-trace.ts";
import { assertHeldCommands, commandOwner, compileCommitments, unavailableOwner, type RetainedCommandSlot } from "./rules-commitments.ts";
import { parseExecutionChanges, validateExecutionAvailability } from "./execution-replan.ts";
import type { ExecutionReplan } from "./execution-replan.ts";

import { RULES_MODEL_VERSION } from "./rules-planner-identity.ts";
export { RULES_MODEL_VERSION } from "./rules-planner-identity.ts";
const QUARTER_MS = 900_000;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const fail = (message: string): never => { throw new Error(message); };

export type PublishedCommandSlot = Pick<PlannedSlot, "start" | "pool_w" | "pool_command_w" | "pool_permitted" | "ev_target_current_a" | "ev_min_current_a" | "ev_max_current_a" | "boiler_permitted" | "boiler_expected_w" | "boiler_battery_allowed" | "battery_command" | "device_commands"> & Partial<Pick<PlannedSlot, "battery_instruction">> & Partial<Pick<PlannedSlot, "device_loads_w" | "room_heating_w">>;
export interface PublishedCommandReference {
  plan_id: string;
  hot_water_permissions?: string[];
  /** Provenance from the exact accepted publication, never inferred from its draw. */
  pool_planning_basis?: "thermal" | "empirical";
  slots: PublishedCommandSlot[];
}
export interface PreparedRulesInput {
  rooms: RoomServices;
  pool_service: PoolService;
  snapshot: OptimisationSnapshot;
  now: string;
  model_version: string;
  problem: ReadyProblem;
  price_outlook: OptimisationPlan["price_outlook"];
  locked_slots: RetainedCommandSlot[];
  held_reference: PublishedCommandSlot[];
  released_owners_by_slot: string[][];
  execution_replan: ExecutionReplan | null;
  fixed_slots: Record<number, PublishedCommandSlot>;
  reference_plan_id: string | null;
  members: { heater: DeviceMember[]; auxiliary: DeviceMember[]; ev: DeviceMember[]; boiler: DeviceMember[] };
  passive_w: Record<string, number[]>;
  auxiliary_dispatch: Record<string, {fixed_w: number; on_w: number}[]>;
  boiler_services: DutyCycleServiceInput[];
  boiler_unavailable: boolean;
  boiler_w: number[];
  boiler_rated_w: number[];
  boiler_permitted: boolean[];
  boiler_battery_allowed: boolean[];
  boiler_permission_starts: string[];
  boiler_shortfall_minutes: Record<string, number>;
  base_w: number[];
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
    house_temperature_c: original.house_temperature_c?.slice(offset),
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
  // A schema 10 quarter keeps the exact candidate it was chosen as.
  const stated = slot.battery_instruction ? nativeBattery(slot.battery_instruction) : null;
  return { pool_on: nativePool && (slot.pool_command_w ?? 0) > 0, ev_amps: slot.ev_target_current_a,
    battery: stated?.battery ?? battery?.operation ?? "idle", charge_limit_w: stated?.charge_limit_w ?? battery?.charge_limit_w ?? 0,
    discharge_limit_w: stated?.discharge_limit_w ?? battery?.discharge_limit_w ?? 0 };
}

/** Freeze supplied forecasts/models and current published commands before admission. */
export function prepareRulesPlanningInput(input: Omit<EnergyPlanningInput, "price_archive"> & { price_archive?: EnergyPlanningInput["price_archive"] }, reference: PublishedCommandReference | null,
  approved: ReadyRulePolicy, trace?: PlanningTrace): PreparedRulesInput {
  if (!input.resolved_price_outlook) return fail("Rules planner requires an already resolved price outlook");
  if (!approved || !Array.isArray(approved.rules)) return fail("Rules planner requires the approved rule policy");
  // State and commitment belong to the immutable measurement capture, not the
  // later admission or retry clock. issued_at separately records this generation.
  const effective = Date.parse(input.snapshot.captured_at);
  if (!finite(effective)) return fail("Invalid planning capture time");
  if (input.execution_replan && input.execution_replan.accepted_plan_id !== reference?.plan_id) return fail("Execution replan must name the retained accepted plan");
  // Own the supplied basis once. All derived schedules belong to this call;
  // copying them again at publication adds work without further isolation.
  // The resolved outlook is authoritative here; the archive is not consumed.
  ({ input, reference, approved } = structuredClone({ input: {
    snapshot: input.snapshot, now: input.now, fixed_plan: input.fixed_plan,
    execution_replan: input.execution_replan, resolved_price_outlook: input.resolved_price_outlook,
  }, reference, approved }));
  const isolated = isolateMeasurements(input.snapshot);
  const availability = new Map(parseExecutionChanges(isolated.execution_availability ?? []).map(change => [change.owner, change]));
  for (const change of input.execution_replan?.changes ?? []) {
    if (change.status === "recovered") availability.delete(change.owner);
    else if (change.status !== "plan_deviation") availability.set(change.owner, change);
  }
  isolated.execution_availability = [...availability.values()];
  if (isolated.device_physics) {
    const {pool,...electrical}=isolated.device_physics;
    isolated.device_physics=parseDeviceModels(electrical);
    if(pool) try { isolated.device_physics.pool=parseDeviceModels({pool}).pool; }
    catch(error) { isolated.planning_warnings=mergePlanningWarnings(isolated.planning_warnings,[planningWarning(
      "pool_physics_evidence","pool",String(error),"Pool service continues using empirical demand and known comfort targets.")]); }
  }
  const { snapshot, offset } = alignedSnapshot(isolated, effective);
  validateExecutionAvailability(snapshot);
  if (snapshot.schema_version >= 9) validateOperatingScope(snapshot);
  if (snapshot.battery_execution_feedback) validateExecutionFeedback(snapshot.battery_execution_feedback);
  const count = snapshot.slots.length;
  if (Date.parse(snapshot.slots[0].start) > effective) return fail("Planning input must cover its capture interval");
  const outlook = { ...input.resolved_price_outlook!,
    shadow_import_sek_per_kwh: input.resolved_price_outlook!.shadow_import_sek_per_kwh.slice(offset) };
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
  const commitments = compileCommitments(snapshot, reference, input.execution_replan);
  snapshot.planning_warnings = mergePlanningWarnings(snapshot.planning_warnings, commitments.warnings);
  const retained = snapshot.slots.map((_slot, i) => commitments.retained[i] ?? {});
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
    if (!Object.prototype.hasOwnProperty.call(poolService.power, m.key) &&
      !isolatedOwner && !snapshot.thermal_zones?.some(z => z.device_keys.includes(m.key)) &&
      (mode === "controlling" || mode === "control_verification" || (!snapshot.operating_scope && m.control_type === "setpoint"))) {
      snapshot.planning_warnings = mergePlanningWarnings(snapshot.planning_warnings, [planningWarning("service_estimate", m.key,
        `${m.name}: no complete device service model is available.`,
        "Its measured demand remains in the household forecast. Existing settings are retained where no explicit target is available.")]);
    }
    return [m.key, m.forecast_w_by_slot];
  }));
  for (const model of snapshot.device_models) if (owned.has(model.key) &&
    snapshot.execution_availability?.some(change => change.owner === commandOwner(snapshot, model) && change.status === "faulted")) {
    passive[model.key] = model.forecast_w_by_slot.slice();
  }
  // A separately owned pump keeps its own accepted request when the heater
  // moves. Its electrical draw need not follow the heater's enable command.
  const auxiliaryDispatch: PreparedRulesInput["auxiliary_dispatch"] = {};
  const auxiliaryTotal = sum(members.auxiliary.map(m => m.watts));
  for (const member of members.auxiliary) {
    const model = snapshot.device_models.find(m => m.key === member.key)!;
    const owner = commandOwner(snapshot, model);
    const watts = auxiliaryTotal > 0 ? member.watts / auxiliaryTotal * pool!.heater.auxiliary_w : 0;
    auxiliaryDispatch[member.key] = snapshot.slots.map((slot, i) => {
      if (unavailableOwner(snapshot, owner, slot.start)) return {fixed_w: 0, on_w: 0};
      const held = commitments.retained[i]?.device_commands?.[member.key];
      if (owner !== "$pool" && held?.type === "switch_schedule") {
        return {fixed_w: watts * held.on_seconds / 900, on_w: 0};
      }
      return {fixed_w: 0, on_w: watts};
    });
  }
  for (const [key, values] of Object.entries(passive)) if (values.length !== count || values.some(v => !finite(v) || v < 0)) return fail(`Invalid supplied passive forecast: ${key}`);
  let boilerService = snapshot.services.filter((s): s is DutyCycleServiceInput => s.device === "boiler");
  const faultedBoilers = snapshot.device_models.filter(model => model.category === "hot_water" &&
    snapshot.execution_availability?.some(change => change.owner === commandOwner(snapshot, model) && change.status === "faulted"));
  if (faultedBoilers.length) {
    const blocked = new Set(faultedBoilers.map(model => model.key));
    members.boiler = members.boiler.filter(member => !blocked.has(member.key));
    const rating = sum(members.boiler.map(member => member.watts));
    boilerService = rating > 0 ? boilerService.map(service => ({...service, control: {...service.control,
      rated_power_w: rating, expected_power_w_by_slot: service.control.expected_power_w_by_slot.map((w, i) =>
        Math.max(0, w - sum(faultedBoilers.map(model => model.forecast_w_by_slot[i])))) }})) : boilerService;
  }
  if (snapshot.capabilities.boiler && !faultedBoilers.length && (!boilerService.length || boilerService.some(s => s.control.type !== "duty_cycle"))) {
    snapshot.planning_warnings=mergePlanningWarnings(snapshot.planning_warnings,[planningWarning("boiler_service_evidence","boiler",
      "The boiler's permit/inhibit service forecast is incomplete.",
      "Household planning continues with its measured demand; the boiler retains its existing settings.")]);
    for(const member of members.boiler) passive[member.key]=snapshot.device_models.find(m=>m.key===member.key)!.forecast_w_by_slot;
    members.boiler=[];boilerService=[];snapshot.capabilities={...snapshot.capabilities,boiler:false};
    snapshot.services=snapshot.services.filter(s=>s.device!=="boiler");
  }
  if(boilerService.some(s=>s.control.rated_power_w===null)) snapshot.planning_warnings=mergePlanningWarnings(snapshot.planning_warnings,[planningWarning(
    "boiler_power_estimated","boiler","Boiler running power has not been observed yet.",
    "Daily heating permissions remain active. Electrical consumption is unknown until the boiler's running power is measured.")]);
  const locked = commitments.retained;
  if (faultedBoilers.length) for (const [i, slot] of locked.entries()) if (finite(slot.boiler_expected_w)) {
    slot.boiler_expected_w = Math.max(0, slot.boiler_expected_w - sum(faultedBoilers.map(model => model.forecast_w_by_slot[i])));
  }
  if (reference && locked.length < snapshot.slots.filter(slot => Date.parse(slot.start) < effective + 3_600_000).length) {
    snapshot.planning_warnings = mergePlanningWarnings(snapshot.planning_warnings, [planningWarning("reference_coverage", "household",
      "The retained plan does not cover the complete next hour.", "Existing covered commands are retained; uncovered intervals receive a new plan.")]);
  }
  for (let i = 0; i < locked.length; i++) {
    if (!locked[i].device_commands && snapshot.device_models.length && snapshot.schema_version >= 7) return fail("Committed device command map missing");
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
  // Forecast solar left after every load fixed before the solve.
  const spare=snapshot.slots.map((slot,i)=>slot.pv_forecast_w*
    snapshot.pv_calibration.correction_factor_by_lead_day[Math.min(snapshot.pv_calibration.correction_factor_by_lead_day.length-1,
      Math.max(0,Math.floor((Date.parse(slot.start)-effective)/86400000)))]-baseW[i]-boilerW[i]-
      sum(Object.entries(passive).filter(([key])=>!roomKeys.has(key)).map(([,values])=>values[i])));
  const headroom=spare.map(w=>Math.max(0,snapshot.grid.import_limit_w+w));
  const rooms = prepareRoomServices(snapshot, retainedServices, headroom, {
    import_sek_per_kwh: outlook.shadow_import_sek_per_kwh,
    export_sek_per_kwh: snapshot.slots.map((s, i) => s.export_price_sek_per_kwh ?? outlook.shadow_import_sek_per_kwh[i] - spread),
    surplus_w: spare }, trace);
  Object.assign(passive, rooms.power, poolService.power);
  snapshot.planning_warnings = mergePlanningWarnings(snapshot.planning_warnings, rooms.warnings);
  const permitted = snapshot.slots.map((_s, i) => retainedServices[i]?.boiler_permitted ?? false);
  const months = localMonths(snapshot.slots.map(s => s.start), snapshot.timezone);
  const problem: ReadyProblem = {
    abi: 13, ev_battery_supply_allowed: false, work_grant: recipe.work_grant, recipe: builderRecipe(recipe),
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
        pool_auxiliary_dispatch: pool && members.auxiliary.some(member => {
          const model = snapshot.device_models.find(m => m.key === member.key)!;
          return unavailableOwner(snapshot, commandOwner(snapshot, model), s.start) ||
            commandOwner(snapshot, model) !== "$pool" && !!commitments.retained[i]?.device_commands?.[member.key];
        }) ? {fixed_w: sum(Object.values(auxiliaryDispatch).map(series => series[i].fixed_w)),
          on_w: sum(Object.values(auxiliaryDispatch).map(series => series[i].on_w))} : null,
        ev_available: !!ev && !unavailableOwner(snapshot, "$ev", s.start) && (ev.available_from === null || start + QUARTER_MS > Date.parse(ev.available_from)),
      };
    }),
    battery, car, charger, pool_store: pool?.store ?? null, heater: pool?.heater ?? null,
    pool_stop_c: pool ? Math.min(hardware!.stop_c, poolService.stop_c!) : null,
    initial: { battery_kwh: battery && snapshot.battery ? snapshot.battery.soc * battery.capacity_kwh : null,
      ev_kwh: ev && car ? ev.soc * car.capacity_kwh : null, pool_c: pool ? snapshot.pool!.water_temperature_c : null,
      pool_pending_heat_kwh: pool ? poolService.pending_heat_kwh : null,
      pool_source_depletion_kwh: pool ? poolService.source_depletion_kwh : null,
      heater_state: pool ? snapshot.pool!.heating_running
        ? finite(snapshot.pool!.heating_elapsed_seconds) ? { kind: "running", seconds: snapshot.pool!.heating_elapsed_seconds! } : { kind: "running", seconds: 0 }
        : { kind: "off_unobserved" } : null },
    targets: { pool_c: pool ? snapshot.comfort!.pool!.target_c : null, ev_km: car ? snapshot.comfort!.ev!.target_km : null,
      ev_limit_kwh: car && ev ? ev.charge_limit_soc * car.capacity_kwh : null },
    limits: { import_w: snapshot.grid.import_limit_w, export_w: snapshot.grid.export_limit_w,
      battery_export_enabled: !!battery && snapshot.policy.battery_export_enabled,
      battery_export_reserve_kwh: battery ? snapshot.policy.battery_export_reserve_soc * battery.capacity_kwh : 0,
      battery_export_min_price: snapshot.policy.battery_export_min_price_sek_per_kwh,
      wear_per_kwh: snapshot.value_settings?.battery_degradation_sek_per_kwh ?? 0,
      ev_start_preference_sek: EV_START_PREFERENCE_SEK, battery_start_preference_sek: BATTERY_START_PREFERENCE_SEK, pool_start_cost_sek: POOL_START_COST_SEK },
    rules: approved.rules, service_guard: approved.service_guard,
    // Filled below from the finished problem: the credit's reference is the median of the prices in its slots.
    end_credit: { reference_sek_per_kwh: 0, battery: null, pool: null, ev: null },
    accepted: locked.length ? commitments.original.map(slot => nativeCommand(slot, snapshot, !!pool)) : null,
    released: locked.length ? commitments.released : null,
    unavailable: commitments.unavailable,
    fixed_commands: snapshot.slots.map((_s, i) => fixedSlots[i] ? nativeCommand(fixedSlots[i], snapshot, !!pool) : null),
    locked_through_seconds: locked.length ? Math.min(3600,(Date.parse(locked.at(-1)!.start)+QUARTER_MS-effective)/1000) : 0,
  };
  problem.end_credit = problemEndCredit(problem);
  return { snapshot, rooms, pool_service: poolService, now: new Date(input.now).toISOString(), model_version: RULES_MODEL_VERSION, problem,
    price_outlook: outlook, locked_slots: locked, held_reference: commitments.original, released_owners_by_slot: commitments.owners_by_slot, execution_replan: input.execution_replan ?? null, fixed_slots: fixedSlots, reference_plan_id: reference?.plan_id ?? null,
    members, passive_w: passive, auxiliary_dispatch: auxiliaryDispatch, boiler_services: boilerService, boiler_unavailable: faultedBoilers.length > 0 && !members.boiler.length, boiler_w: boilerW, boiler_rated_w: snapshot.slots.map(() => 0), boiler_permitted: permitted,
    boiler_battery_allowed: snapshot.slots.map((_s, i) => retainedServices[i]?.boiler_battery_allowed ?? false),
    boiler_permission_starts: [...new Set([...(reference?.hot_water_permissions ?? []), ...(reference?.slots.filter(s => s.boiler_permitted).map(s => s.start) ?? [])])],
    boiler_shortfall_minutes: {}, base_w: baseW };
}

function commandMap(input: PreparedRulesInput, command: NativeCommand, i: number): Record<string, DeviceCommand> {
  const locked = input.fixed_slots[i] ?? input.locked_slots[i];
  const result: Record<string, DeviceCommand> = {};
  const pool = new Set([...input.members.heater, ...input.members.auxiliary].map(m => m.key));
  const ev = new Set(input.members.ev.map(m => m.key));
  const boiler = new Set(input.members.boiler.map(m => m.key));
  for (const model of input.snapshot.device_models) {
    if (unavailableOwner(input.snapshot, commandOwner(input.snapshot, model), input.snapshot.slots[i].start)) {
      if (input.fixed_slots[i]?.device_commands?.[model.key]) return fail(`Fixed booking conflicts with unavailable ${model.key} at ${input.snapshot.slots[i].start}`);
      result[model.key] = {type: "unavailable", reason: "Equipment execution is unavailable until recovery is observed"};
      continue;
    }
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
  const allocated = allocatedBatteryCommand(command, quarter);
  // Schema 3 has no import-target response; its nearest meaning follows demand.
  const operation = allocated.battery === "shave_import" ? "self_consumption" : allocated.battery;
  return { schema_version: 3, operation, charge_limit_w: allocated.charge_limit_w,
    discharge_limit_w: allocated.discharge_limit_w, allow_grid_charge: operation === "grid_charge",
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
    if (!unavailableOwner(snapshot, "$pool", source.start)) {
      allocate(input.members.heater, q.pool_compressor_w, loads);

    }
    if (f.pool_auxiliary_dispatch) {
      for (const member of input.members.auxiliary) {
        const model = snapshot.device_models.find(m => m.key === member.key)!;
        if (unavailableOwner(snapshot, commandOwner(snapshot, model), source.start)) continue;
        const dispatch = input.auxiliary_dispatch[member.key][i];
        loads[member.key] = dispatch.fixed_w + (command.pool_on ? dispatch.on_w : 0);
      }
    } else if (!unavailableOwner(snapshot, "$pool", source.start)) allocate(input.members.auxiliary, q.pool_auxiliary_w, loads);
    if (!unavailableOwner(snapshot, "$ev", source.start)) allocate(input.members.ev, q.ev_w, loads);
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
      ev_soc: p.car && q.ev_kwh !== null ? q.ev_kwh / p.car.capacity_kwh : null, ev_connected: !!snapshot.ev_battery?.connected,
      ...(p.car && !snapshot.ev_battery?.connected && command.ev_amps > 0 ? { ev_charging_conditional: true } : {}),
      load_w: load, battery_charge_w: q.charge_w, battery_discharge_w: q.discharge_w, battery_export_w: batteryExport,
      battery_command: p.battery ? locked?.battery_command ?? batteryCommand(command, q) : null,
      ...(p.battery && snapshot.schema_version >= 10 ? { battery_instruction: locked?.battery_instruction ??
        instructionFor(command, q, profileFor(input.boiler_services.length ? input.boiler_battery_allowed[i] : undefined),
          { import_w: p.limits.import_w, discharge_max_w: p.battery.discharge_max_w }) } : {}),
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
export function generateRulesPlan(input: PreparedRulesInput, trace?: PlanningTrace): OptimisationResult {
  if (input.model_version !== RULES_MODEL_VERSION) return fail("Prepared rules planner version changed");
  if (input.problem.work_grant !== recipe.work_grant || JSON.stringify(input.problem.recipe) !== JSON.stringify(builderRecipe(recipe))) return fail("Prepared planner work recipe differs from its model identity");
  input = { ...input, snapshot: { ...input.snapshot } };
  const core = nativePlanner(trace);
  const solved = planningStage(trace, "solve", () => core.solve(input.problem, trace)).outcome;
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
  const projections = core.projectionSession();
  const refined = planningStage(trace, "hot_water_refinement", () => addHotWater(projections, input, solved.selection));
  input = refined.input;
  const selected = refined.selection;
  const p = input.problem;
  const materialized = trace?.start("selected_plan_materialize");
  const priority = scenario(input, selected.commands, selected.quarters, "priority", "Rule-based plan");
  // Only the selected schedule has a rule account; the baseline was never scored.
  priority.generated.slots.forEach((slot, i) => {
    slot.rule_points = Object.fromEntries(p.rules.flatMap((rule, r) => {
      const points = selected.account.contributions[i][r];
      return points ? [[rule.key, points]] : [];
    }));
  });
  materialized?.();
  const { commands: baselineCommands, outcome: baselineProjection } = planningStage(trace, "baseline_projection",
    () => projectRulesBaseline(projections, input, selected.commands, selected.quarters));
  const assembled = trace?.start("plan_assemble");
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
  assertHeldCommands(input.snapshot, input.held_reference, input.released_owners_by_slot, priority.generated.slots);
  const cost = { ...priority.generated, key: "cost" as const, label: "Rule-based plan (same selected schedule)" };
  const snapshot = input.snapshot;
  if (snapshot.ev_battery && !snapshot.ev_battery.connected && priority.generated.slots.some(slot => slot.ev_w > 0)) {
    snapshot.planning_warnings = mergePlanningWarnings(snapshot.planning_warnings, [planningWarning(
      "ev_connection_required", "ev", "The car is unplugged. Its future charging remains planned.",
      "Forecast charging and range depend on connecting the car. Scheduled charging that cannot execute automatically requests a new plan.")]);
  }
  for (const change of snapshot.execution_availability ?? []) {
    if (change.status === "plan_deviation") continue;
    snapshot.planning_warnings = mergePlanningWarnings(snapshot.planning_warnings, [planningWarning(
      "execution_unavailable", change.owner, `Scheduled work could not execute: ${change.cause}.`,
      "The replacement accounts for current state and outstanding service. Other loads retain their accepted next-hour commands.",
      { status: change.status, blocked_intervals: JSON.stringify(change.blocked_intervals) })]);
  }
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
    unplanned_total_power_w:snapshot.slots.map((_s,i)=>sum(modelledRooms.map(z=>input.rooms.unplanned_power[z.key][i]))),
    zones:modelledRooms.map((z,i)=>({key:z.key,name:z.name,device_keys:z.device_keys,...roomProjectionControl(snapshot, z.device_keys),priority:i+1,
      rated_power_w:z.rated_power_w,comfort_min_c:z.comfort_min_c,target_c:z.target_c,comfort_max_c:z.comfort_max_c,
      planned_temperature_c:input.rooms.temperature[z.key] as number[],unplanned_temperature_c:input.rooms.unplanned_temperature[z.key] as number[],
      planned_power_w:input.rooms.room_power[z.key],unplanned_power_w:input.rooms.unplanned_power[z.key]}))} : undefined;
  let plan: OptimisationPlan = { schema_version: snapshot.schema_version, mode: "live", capabilities: snapshot.capabilities,
    model_version: RULES_MODEL_VERSION, decision_diagnostics_version: 2, plan_id: snapshot.snapshot_id, snapshot_id: snapshot.snapshot_id,
    issued_at: input.now, valid_until: new Date(Date.parse(snapshot.slots.at(-1)!.start) + QUARTER_MS).toISOString(),
    binding_until: bindingUntil ? new Date(Date.parse(bindingUntil.start) + QUARTER_MS).toISOString() : snapshot.slots[0].start,
    hot_water_permissions: input.boiler_permission_starts, hot_water_shortfall_minutes: input.boiler_shortfall_minutes,
    timezone: snapshot.timezone, slot_minutes: 15, status: "ready", validation_errors: [], measurement_issues: snapshot.measurement_issues ?? [],
    planning_warnings: snapshot.planning_warnings ?? [],
    execution_availability: snapshot.execution_availability ?? [],
    ...(input.execution_replan ? { execution_replan: { request_id: input.execution_replan.request_id,
      accepted_plan_id: input.execution_replan.accepted_plan_id, changes: input.execution_replan.changes,
      released_intervals: input.held_reference.flatMap((slot, i) => input.released_owners_by_slot[i].filter(owner => {
        const command = (row: PublishedCommandSlot) => [
          ...(owner === "$ev" ? [row.ev_target_current_a, row.ev_min_current_a, row.ev_max_current_a]
            : owner === "$pool" ? [row.pool_command_w, row.pool_permitted]
            : owner === "$battery" ? [row.battery_command, row.battery_instruction] : []),
          ...snapshot.device_models.filter(model => commandOwner(snapshot, model) === owner).map(model => row.device_commands?.[model.key]),
        ];
        const before = command(slot), after = command(priority.generated.slots[i]);
        return JSON.stringify(before) !== JSON.stringify(after);
      }).map(owner => ({ owner, start: slot.start, end: new Date(Date.parse(slot.start) + QUARTER_MS).toISOString() }))) } } : {}),
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
  if (snapshot.schema_version >= 10) {
    // The contract states the demand; the plan view reads the same partition.
    const { battery_supply_scope: _superseded, ...stated } = plan;
    plan = { ...stated, battery_demand: batteryDemand(snapshot.device_models,
      p.slots.map((_s, i) => input.boiler_services.length ? input.boiler_battery_allowed[i] : undefined)) };
  }
  if (snapshot.schema_version >= 9) {
    // One selected schedule owns both charts, the device requests and the
    // battery contract. A device's mode decides who writes its requests, never
    // what the household is planned to do, so no second projection is made.
    const executionPlan = { ...plan, schema_version: 8 as const };
    const mode = snapshot.operating_scope!.modes.$battery;
    const feedback = snapshot.battery_execution_feedback;
    const contract = p.battery && feedback && (mode === "controlling" || mode === "control_verification")
      ? buildBatteryExecutionContract({ plan: executionPlan, rows: priority.rows, pv_w: p.slots.map(s => s.solar_w),
        mode, scope_revision: feedback.scope_revision!, feedback, demand: plan.battery_demand }) : undefined;
    plan = { ...plan, operating_scope: snapshot.operating_scope, execution_plan: executionPlan,
      ...(contract ? { battery_execution: contract } : {}) };
  }
  // Native commands remain the existing authority when the integration does
  // not publish optional execution feedback. Do not invent a feedback receipt
  // or a utility-curve monetary projection for the rules objective.
  const result: OptimisationResult = { plan, battery_projection: { status: "unsupported", reasons: [
    !p.battery ? "no_battery" : plan.battery_execution
      ? "replaced_by_plan_execution_contract" : "rules_objective_has_no_conditional_money_projection",
  ] } };
  assembled?.();
  return result;
}
