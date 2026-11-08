import type { createWasmPlanner, NativeQuarter, SolveOutcome } from "./planner-wasm/core.ts";
import { proportionalSupply } from "./battery-supply.ts";
import type { NativeCommand } from "./planner-wasm/ready-problem.ts";
import type { PreparedRulesInput } from "./rules-planner.ts";
import { scheduleHotWater } from "./hot-water-opportunities.ts";
import { nativeOwnerHeld } from "./rules-commitments.ts";
import { chargeDcPower, dischargeDcPower, outputPower } from './planner/battery-conversion.ts';
import { mergePlanningWarnings, planningWarning } from './planner/planning-warnings.ts';

type Selection = Extract<SolveOutcome, { kind: "selected" }>["selection"];

/** Complete both bounded native finalists before selecting published commands.
 * A failed optional challenger cannot discard an already valid household plan. */
export function completeRulesCandidates(core: Pick<ReturnType<typeof createWasmPlanner>, "complete">,
  input: PreparedRulesInput, native: Selection): { input: PreparedRulesInput; selection: Selection } {
  const alternative = native.charging_alternative;
  if (!alternative) return addHotWater(core, input, native);
  const other = { ...native, commands: alternative.commands, quarters: alternative.quarters,
    account: alternative.account, charging_alternative: null, economic: [], runs: [], witness_coverage: [] };
  const [ordinary, block] = alternative.role === "ordinary" ? [other, native] : [native, other];
  const incumbent = addHotWater(core, input, ordinary);
  try {
    const candidate = addHotWater(core, input, block, { fallback: false });
    const waterNoWorse = Object.entries(incumbent.input.boiler_shortfall_minutes).every(([day, minutes]) =>
      Object.prototype.hasOwnProperty.call(candidate.input.boiler_shortfall_minutes, day) && candidate.input.boiler_shortfall_minutes[day] <= minutes);
    return waterNoWorse && candidate.selection.account.score_sek > incumbent.selection.account.score_sek + native.minimum_gain_sek
      ? candidate : incumbent;
  } catch (error) {
    incumbent.input.snapshot = { ...incumbent.input.snapshot, planning_warnings: mergePlanningWarnings(
      incumbent.input.snapshot.planning_warnings, [planningWarning("charging_alternative_unavailable", "charging",
        `The optional charging-block comparison could not complete: ${String(error)}`,
        "The completed household plan remains available and planning continues.")]) };
    return incumbent;
  }
}

/** A finite allowance backed by otherwise exported solar at a future full
 * battery. Intervening household discharge and the physical reserve are kept.
 * Each refill's surplus can be spent once, not once per water quarter. */
export function hotWaterSurplusPermissions(input: PreparedRulesInput, baseline: NativeQuarter[], water: number[]): boolean[] {
  const p = input.problem, battery = p.battery;
  const allowed = water.map(() => false);
  if (!battery) return allowed;
  const refill = baseline.map((q, i) => {
    const s = p.slots[i], hours = s.hours + Math.min(0, s.start_seconds) / 3600;
    const house = s.base_w + q.pool_w + q.ev_w;
    const possibleDc = Math.min(battery.charge_max_w,
      chargeDcPower(battery.conversion, q.charge_w + Math.max(0, -q.net_w), s.solar_w, house));
    return { i, wh: q.discharge_w === 0 && q.battery_kwh! >= battery.max_soc * battery.capacity_kwh - 1e-6
      ? Math.max(0, possibleDc - q.charge_dc_w) * hours * battery.charge_efficiency : 0 };
  }).filter(r => r.wh > 0);
  const spent = baseline.map(() => 0);
  for (let i = input.locked_slots.length; i < water.length; i++) {
    if (input.fixed_slots[i]) continue;
    if (water[i] <= 0) continue;
    const hours = p.slots[i].hours + Math.min(0, p.slots[i].start_seconds) / 3600;
    const extraAc = Math.max(0, water[i] - Math.max(0, p.slots[i].solar_w - (p.slots[i].base_w + baseline[i].pool_w + baseline[i].ev_w)));
    const totalDc = dischargeDcPower(battery.conversion, baseline[i].discharge_w + extraAc);
    if (totalDc > battery.discharge_max_w + 1e-7
      || outputPower(battery.conversion.discharge, totalDc) + 1e-7 < baseline[i].discharge_w + extraAc) continue;
    const wh = Math.max(0, totalDc - baseline[i].discharge_dc_w) / battery.discharge_efficiency * hours;
    const next = refill.find(r => r.i > i && r.wh >= wh);
    if (!next || wh <= 0) continue;
    const room = Math.min(...baseline.slice(i, next.i).map((q, j) =>
      (q.battery_kwh! - battery.min_soc * battery.capacity_kwh) * 1000 - spent[i + j]));
    if (room + 1e-6 < wh) continue;
    allowed[i] = true;
    next.wh -= wh;
    for (let j = i; j < next.i; j++) spent[j] += wh;
  }
  return allowed;
}

/** Match the runtime's measured eligibility partition; these are equipment
 * ceilings, not a substitute for HA measuring the selected load components. */
export function waterBatteryCommands(input: PreparedRulesInput, commands: NativeCommand[], quarters: NativeQuarter[]): NativeCommand[] {
  return commands.map((command, i) => waterBatteryCommand(input, command, quarters[i], i));
}

export function waterBatteryCommand(input: PreparedRulesInput, command: NativeCommand,
  quarter: Pick<NativeQuarter, "pool_w" | "ev_w">, i: number): NativeCommand {
  const p = input.problem;
  if (nativeOwnerHeld(p, i, "battery") || !input.boiler_permitted[i] && input.boiler_w[i] === 0) return command;
  const gross = p.slots[i].base_w + quarter.pool_w + quarter.ev_w;
  const excluded = (p.ev_battery_supply_allowed ? 0 : quarter.ev_w + p.slots[i].base_ev_w) + (input.boiler_battery_allowed[i] ? 0 : input.boiler_w[i]);
  const bound = proportionalSupply(gross, p.slots[i].solar_w, Math.max(0, gross - excluded)).houseSupplyBoundW;
  const reserved = input.boiler_permitted[i] ? Math.max(0, input.boiler_rated_w[i] - input.boiler_w[i]) : 0;
  return { ...command,
    ...(input.boiler_battery_allowed[i] ? {} : { discharge_limit_w: Math.min(command.discharge_limit_w, bound) }),
    ...(command.battery === "grid_charge" ? { charge_limit_w: Math.min(command.charge_limit_w, Math.max(0, p.limits.import_w - gross - reserved + p.slots[i].solar_w)) } : {}),
  };
}

/** Grid headroom the water may use in one quarter. The grid check charges the
 * pool's full ON draw and the charger's commanded current, not their quarter
 * averages, so a pool start-up or a car near its charge limit lends the water
 * no headroom it does not have. Grid charging is left out: the water's battery
 * commands lower it. */
export function hotWaterHeadroomW(input: PreparedRulesInput, native: Selection, i: number): number {
  const p = input.problem, q = native.quarters[i], command = native.commands[i];
  const poolReserved = Math.max(0, q.pool_command_w - q.pool_w);
  const evAdmitted = p.charger && q.ev_w > 0 ? command.ev_amps * p.charger.voltage_v * p.charger.phase_count : q.ev_w;
  return p.limits.import_w - q.net_w + q.charge_w + input.boiler_w[i] - poolReserved - Math.max(0, evAdmitted - q.ev_w);
}

/** One household solve followed by one water projection. Pool/EV choices stay
 * fixed. Battery ceilings use the same partition as HA's measured supply scope.
 * Water that still does not fit never stops the household plan: committed
 * water is kept without new opportunities, and failing that the household plan
 * is published as solved. Either is a visible warning. */
export function addHotWater(core: Pick<ReturnType<typeof createWasmPlanner>, "complete">, input: PreparedRulesInput, native: Selection,
  { fallback = true }: { fallback?: boolean } = {}): { input: PreparedRulesInput; selection: Selection } {
  if (!input.boiler_services.length) return { input, selection: native };
  let first: string | null = null;
  for (const opportunities of [true, false]) {
    const attempt = projectHotWater(core, input, native, opportunities);
    // An optional challenger is discarded rather than published with less water.
    if (!fallback && "issue" in attempt) throw new Error(`Hot-water opportunities exceed equipment limits: ${attempt.issue}`);
    if (!("issue" in attempt)) {
      if (first === null) return attempt;
      return { ...attempt, input: withWaterWarning(attempt.input, first,
        "Hot water keeps the heating already committed; new heating opportunities are left out of this plan.") };
    }
    first ??= attempt.issue;
  }
  return { input: withWaterWarning(input, first!,
    "The household plan is published without rescheduling hot water; its existing permissions are unchanged."),
    selection: native };
}

function withWaterWarning(input: PreparedRulesInput, issue: string, consequence: string): PreparedRulesInput {
  return { ...input, snapshot: { ...input.snapshot, planning_warnings: mergePlanningWarnings(input.snapshot.planning_warnings, [
    planningWarning("hot_water_exceeds_equipment_limits", "boiler", `Hot-water heating did not fit the equipment limits: ${issue}.`, consequence)]) } };
}

function projectHotWater(core: Pick<ReturnType<typeof createWasmPlanner>, "complete">, input: PreparedRulesInput,
  native: Selection, opportunities: boolean): { input: PreparedRulesInput; selection: Selection } | { issue: string } {
  const p = input.problem;
  const other = p.slots.map((s, i) => s.base_w - input.boiler_w[i] + native.quarters[i].pool_w + native.quarters[i].ev_w);
  const committed = input.snapshot.slots.map((s, i) => {
    if (input.boiler_unavailable) {
      if (input.fixed_slots[i]?.boiler_permitted) throw new Error(`Fixed booking conflicts with unavailable boiler at ${s.start}`);
      return {start: s.start, boiler_permitted: false, boiler_expected_w: 0};
    }
    const slot = input.fixed_slots[i] ?? input.locked_slots[i];
    return typeof slot?.boiler_permitted === "boolean" && typeof slot.boiler_expected_w === "number"
      ? { start: slot.start, boiler_permitted: slot.boiler_permitted, boiler_expected_w: slot.boiler_expected_w } : undefined;
  });
  // Without opportunities, every quarter not already committed stays inhibited,
  // so committed heating is kept exactly and nothing new is scheduled.
  const locked = opportunities ? committed
    : committed.map((slot, i) => slot ?? { start: input.snapshot.slots[i].start, boiler_permitted: false, boiler_expected_w: 0 });
  let water: ReturnType<typeof scheduleHotWater>;
  try {
    water = scheduleHotWater({ services: input.boiler_services, starts: input.snapshot.slots.map(s => s.start),
      timezone: input.snapshot.timezone, hours: p.slots.map(s => s.hours + Math.min(0, s.start_seconds) / 3600),
      other_house_w: other, import_price: p.slots.map(s => s.import_price), export_price: p.slots.map(s => s.export_price),
      solar_w: p.slots.map(s => s.solar_w), large_load_w: native.quarters.map(q => q.pool_w + q.ev_w + q.charge_w),
      available_w: native.quarters.map((_q, i) => hotWaterHeadroomW(input, native, i)),
      locked, previous_permissions: input.boiler_permission_starts });
  } catch (error) {
    return { issue: error instanceof Error ? error.message : String(error) };
  }
  const batteryAllowed = hotWaterSurplusPermissions(input, native.quarters, water.rated_w.map((w, i) => water.permitted[i] ? w : 0));
  for (let i = 0; i < input.locked_slots.length; i++) batteryAllowed[i] = input.boiler_battery_allowed[i];
  for (const key of Object.keys(input.fixed_slots)) { const i=Number(key); batteryAllowed[i]=input.boiler_battery_allowed[i]; }
  const problem = { ...p, slots: p.slots.map((s, i) => ({ ...s, base_w: s.base_w - input.boiler_w[i] + water.expected_w[i] })) };
  const updated = { ...input, problem, boiler_w: water.expected_w, boiler_rated_w: water.rated_w, boiler_permitted: water.permitted,
    boiler_battery_allowed: batteryAllowed, boiler_permission_starts: water.permission_starts,
    boiler_shortfall_minutes: water.shortfall_minutes };
  const commands = waterBatteryCommands(updated, native.commands, native.quarters);
  const projected = core.complete(problem, commands).outcome;
  if (projected.kind === "failed") return { issue: projected.issue };
  return { input: updated, selection: { ...native, commands: projected.commands,
    quarters: projected.quarters, account: projected.account } };
}
