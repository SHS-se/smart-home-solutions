import type { createWasmPlanner, NativeQuarter, SolveOutcome } from "./planner-wasm/core.ts";
import { endCredit } from "./planner-wasm/end-credit.ts";
import { proportionalSupply } from "./battery-supply.ts";
import type { NativeCommand } from "./planner-wasm/ready-problem.ts";
import type { PreparedRulesInput } from "./rules-planner.ts";
import { scheduleHotWater } from "./hot-water-opportunities.ts";
import { nativeOwnerHeld } from "./rules-commitments.ts";

type Selection = Extract<SolveOutcome, { kind: "selected" }>["selection"];

/** A finite allowance backed by otherwise exported solar at a future full
 * battery. Intervening household discharge and the physical reserve are kept.
 * Each refill's surplus can be spent once, not once per water quarter. */
export function hotWaterSurplusPermissions(input: PreparedRulesInput, baseline: NativeQuarter[], water: number[]): boolean[] {
  const p = input.problem, battery = p.battery;
  const allowed = water.map(() => false);
  if (!battery) return allowed;
  const refill = baseline.map((q, i) => ({ i, wh: q.discharge_w === 0 && q.battery_kwh! >= battery.max_soc * battery.capacity_kwh - 1e-6
    ? Math.max(0, -q.net_w) * p.slots[i].hours * battery.charge_efficiency * battery.discharge_efficiency : 0 })).filter(r => r.wh > 0);
  const spent = baseline.map(() => 0);
  for (let i = input.locked_slots.length; i < water.length; i++) {
    if (input.fixed_slots[i]) continue;
    if (water[i] <= 0) continue;
    const hours = p.slots[i].hours + Math.min(0, p.slots[i].start_seconds) / 3600;
    const wh = Math.max(0, water[i] - Math.max(0, p.slots[i].solar_w - (p.slots[i].base_w + baseline[i].pool_w + baseline[i].ev_w))) * hours;
    const next = refill.find(r => r.i > i && r.wh >= wh);
    if (!next || wh <= 0) continue;
    const room = Math.min(...baseline.slice(i, next.i).map((q, j) =>
      (q.battery_kwh! - battery.min_soc * battery.capacity_kwh) * 1000 * battery.discharge_efficiency - spent[i + j]));
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

/** One household solve followed by one water projection. Pool/EV choices stay
 * fixed. Battery ceilings use the same partition as HA's measured supply scope. */
export function addHotWater(core: ReturnType<typeof createWasmPlanner>, input: PreparedRulesInput, native: Selection): { input: PreparedRulesInput; selection: Selection } {
  if (!input.boiler_services.length) return { input, selection: native };
  const p = input.problem;
  const other = p.slots.map((s, i) => s.base_w - input.boiler_w[i] + native.quarters[i].pool_w + native.quarters[i].ev_w);
  const water = scheduleHotWater({ services: input.boiler_services, starts: input.snapshot.slots.map(s => s.start),
    timezone: input.snapshot.timezone, hours: p.slots.map(s => s.hours + Math.min(0, s.start_seconds) / 3600),
    other_house_w: other, import_price: p.slots.map(s => s.import_price), export_price: p.slots.map(s => s.export_price),
    solar_w: p.slots.map(s => s.solar_w), large_load_w: native.quarters.map(q => q.pool_w + q.ev_w + q.charge_w),
    available_w: native.quarters.map((q, i) => p.limits.import_w - q.net_w + q.charge_w + input.boiler_w[i]),
    locked: input.snapshot.slots.map((s,i) => {
      if (input.boiler_unavailable) {
        if (input.fixed_slots[i]?.boiler_permitted) throw new Error(`Fixed booking conflicts with unavailable boiler at ${s.start}`);
        return {start: s.start, boiler_permitted: false, boiler_expected_w: 0};
      }
      const slot = input.fixed_slots[i] ?? input.locked_slots[i];
      return typeof slot?.boiler_permitted === "boolean" && typeof slot.boiler_expected_w === "number"
        ? { start: slot.start, boiler_permitted: slot.boiler_permitted, boiler_expected_w: slot.boiler_expected_w } : undefined;
    }), previous_permissions: input.boiler_permission_starts });
  const batteryAllowed = hotWaterSurplusPermissions(input, native.quarters, water.rated_w.map((w, i) => water.permitted[i] ? w : 0));
  for (let i = 0; i < input.locked_slots.length; i++) batteryAllowed[i] = input.boiler_battery_allowed[i];
  for (const key of Object.keys(input.fixed_slots)) { const i=Number(key); batteryAllowed[i]=input.boiler_battery_allowed[i]; }
  const problem = { ...p, slots: p.slots.map((s, i) => ({ ...s, base_w: s.base_w - input.boiler_w[i] + water.expected_w[i] })) };
  const updated = { ...input, problem, boiler_w: water.expected_w, boiler_rated_w: water.rated_w, boiler_permitted: water.permitted,
    boiler_battery_allowed: batteryAllowed, boiler_permission_starts: water.permission_starts,
    boiler_shortfall_minutes: water.shortfall_minutes };
  const commands = waterBatteryCommands(updated, native.commands, native.quarters);
  const projected = core.project(problem, commands).outcome;
  if (projected.kind === "failed") throw new Error(`Hot-water opportunities exceed equipment limits: ${projected.issue}`);
  const quarters = projected.quarters;
  const cash = quarters.reduce((sum, q) => sum + q.cost, 0), wear = quarters.reduce((sum, q) => sum + q.wear, 0);
  const credit = endCredit(problem.end_credit, problem.initial, quarters.at(-1)!).credit_sek;
  const continuity = quarters.reduce((sum, q) => sum + q.continuity, 0);
  return { input: updated, selection: { ...native, commands, quarters,
      account: { ...native.account, cash_sek: cash, wear_sek: wear, credit_sek: credit, continuity_sek: continuity, score_sek: native.account.points - (cash + wear + continuity - credit) } } };
}
