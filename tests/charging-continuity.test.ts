import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { createWasmPlanner } from "../supabase/functions/_shared/planner-wasm/core.ts";
import type { NativeCommand, ReadyProblem } from "../supabase/functions/_shared/planner-wasm/ready-problem.ts";
import { problem } from "./planner-wasm.fixture.ts";

const core = createWasmPlanner(await Deno.readFile(new URL("../supabase/functions/_shared/planner-wasm/solver.wasm", import.meta.url)));
const starts = (values: boolean[]) => values.filter((on, i) => on && !values[i - 1]).length;
function competition(): ReadyProblem {
  const p: ReadyProblem = problem();
  p.work_grant = 100_000_000;
  p.heater = p.pool_store = null;
  p.initial.pool_c = p.initial.pool_pending_heat_kwh = p.initial.heater_state = p.targets.pool_c = null;
  p.battery = { capacity_kwh: 6, min_soc: 0, max_soc: 1, charge_max_w: 4000, discharge_max_w: 4000, charge_efficiency: 1, discharge_efficiency: 1 };
  p.car = { capacity_kwh: 10, kwh_per_km: .2, charge_efficiency: 1 };
  p.charger = { voltage_v: 230, phase_count: 3, min_current_a: 5, max_current_a: 6, current_step_a: 1 };
  p.initial.battery_kwh = p.initial.ev_kwh = 0;
  p.targets.ev_km = 30; p.targets.ev_limit_kwh = 6;
  p.limits.import_w = 5000;
  p.slots = Array.from({ length: 16 }, (_, i) => ({ ...p.slots[0], start_seconds: i * 900, base_w: 700, solar_w: 0, import_price: 1 + (i % 2) * .005, export_price: 0 }));
  p.end_credit = { reference_sek_per_kwh: 5, battery: { cap: 6, grid_kwh_per_unit: 1 }, pool: null, ev: { cap: 6, grid_kwh_per_unit: 1 } };
  return p;
}
function selected(p: ReadyProblem) {
  const result = core.solve(p).outcome;
  assert(result.kind === "selected");
  return result.selection;
}

Deno.test("near-equal quarters group EV and battery charging without sacrificing delivered energy", () => {
  const p = competition();
  const old = structuredClone(p);
  old.limits.ev_start_preference_sek = old.limits.battery_start_preference_sek = 0;
  const before = selected(old), after = selected(p);
  assert(starts(before.quarters.map(q => q.ev_w > 0)) > 1);
  assertEquals(starts(after.quarters.map(q => q.ev_w > 0)), 1);
  assertEquals(starts(after.commands.map((c, i) => c.battery === "grid_charge" && after.quarters[i].charge_w > 0)), 1);
  assertAlmostEquals(after.quarters.at(-1)!.ev_kwh!, before.quarters.at(-1)!.ev_kwh!, 1e-9);
  assertAlmostEquals(after.quarters.at(-1)!.battery_kwh!, before.quarters.at(-1)!.battery_kwh!, 1e-9);
  assert(after.quarters.every(q => q.net_w <= p.limits.import_w + 1e-7));
  assertAlmostEquals(after.account.continuity_sek, .5, 1e-9);
  assert(after.account.cash_sek - before.account.cash_sek < .01);
  assertAlmostEquals(after.account.score_sek, after.account.points - after.account.cash_sek - after.account.wear_sek - after.account.continuity_sek + after.account.credit_sek, 1e-9);
});

Deno.test("power changes and a reused accepted prefix do not create charging starts", () => {
  const p = competition();
  const commands: NativeCommand[] = p.slots.map((_s, i) => ({ pool_on: false, ev_amps: i < 4 ? (i % 2 ? 5 : 6) : 0,
    battery: i >= 4 ? "grid_charge" : "idle", charge_limit_w: i >= 4 ? 500 + i * 10 : 0, discharge_limit_w: 0 }));
  const projected = core.project(p, commands).outcome;
  assert(projected.kind === "projected");
  assertAlmostEquals(projected.quarters.reduce((sum, q) => sum + q.continuity, 0), .5, 1e-9);
  p.accepted = commands.slice(0, 4);
  p.locked_through_seconds = 3600;
  const result = selected(p);
  assertEquals(result.commands.slice(0, 4), p.accepted);
  const certified = core.project(p, result.commands).outcome;
  assert(certified.kind === "projected");
  assertEquals(result.quarters, certified.quarters);
});

Deno.test("a worthwhile price gap can still interrupt charging", () => {
  const p = competition();
  p.battery = null; p.initial.battery_kwh = null; p.end_credit.battery = null;
  p.slots = p.slots.slice(0, 3).map((s, i) => ({ ...s, import_price: i === 1 ? 20 : 0 }));
  const result = selected(p);
  assertEquals(result.quarters.map(q => q.ev_w > 0), [true, false, true]);
  assertEquals(result.account.continuity_sek, .5);
});
