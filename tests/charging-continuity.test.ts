import { syntheticIdentityConversion } from '../supabase/functions/_shared/planner/battery-physics.fixture.ts';
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { createWasmPlanner } from "../supabase/functions/_shared/planner-wasm/core.ts";
import type { NativeCommand, ReadyProblem } from "../supabase/functions/_shared/planner-wasm/ready-problem.ts";
import { activeCurrentCompetition } from "./charging-continuity.fixture.ts";
import { problem } from "./planner-wasm.fixture.ts";

const core = createWasmPlanner(await Deno.readFile(new URL("../supabase/functions/_shared/planner-wasm/solver.wasm", import.meta.url)));
const starts = (values: boolean[]) => values.filter((on, i) => on && !values[i - 1]).length;
function competition(): ReadyProblem {
  const p: ReadyProblem = problem();
  p.work_grant = 100_000_000;
  p.charging_before = { ev_amps: 0, battery_grid_w: 0 };
  p.heater = p.pool_store = null;
  p.initial.pool_c = p.initial.pool_pending_heat_kwh = p.initial.heater_state = p.targets.pool_c = null;
  p.battery = { capacity_kwh: 6, min_soc: 0, max_soc: 1, charge_max_w: 4000, discharge_max_w: 4000, charge_efficiency: 1, discharge_efficiency: 1 , conversion: syntheticIdentityConversion()};
  p.car = { capacity_kwh: 10, kwh_per_km: .2, charge_efficiency: 1 };
  p.charger = { voltage_v: 230, phase_count: 3, min_current_a: 5, max_current_a: 6, current_step_a: 1 };
  p.initial.battery_kwh = p.initial.ev_kwh = 0;
  p.limits.import_w = 5000;
  p.slots = Array.from({ length: 16 }, (_, i) => ({ ...p.slots[0], start_seconds: i * 900, base_w: 700, solar_w: 0, import_price: 1 + (i % 2) * .005, export_price: 0 }));
  p.car_policy = { floor_kwh: 6, limit_kwh: 6, breach_permille: p.slots.map(() => null) };
  p.end_credit = { reference_sek_per_kwh: 5, battery: { cap: 6, grid_kwh_per_unit: 1 }, pool: null, ev: { grid_kwh_per_unit: 1, tiers: [{ up_to: 6, sek_per_kwh: 5 }] } };
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
  old.limits.ev_change_preference_sek = old.limits.battery_change_preference_sek = 0;
  const before = selected(old), after = selected(p);
  assert(starts(before.quarters.map(q => q.ev_w > 0)) > 1);
  assertEquals(starts(after.quarters.map(q => q.ev_w > 0)), 1);
  assertEquals(starts(after.commands.map((c, i) => c.battery === "grid_charge" && after.quarters[i].charge_w > 0)), 1);
  assertAlmostEquals(after.quarters.at(-1)!.ev_kwh!, before.quarters.at(-1)!.ev_kwh!, 1e-9);
  assertAlmostEquals(after.quarters.at(-1)!.battery_kwh!, before.quarters.at(-1)!.battery_kwh!, 1e-9);
  assert(after.quarters.every(q => q.net_w <= p.limits.import_w + 1e-7));
  const evRequests = [0, ...after.commands.map(c => c.ev_amps)];
  const evChanges = evRequests.slice(1).filter((a, i) => a !== evRequests[i]).length;
  const batteryRequests = [0, ...after.commands.map(c => c.battery === "grid_charge" ? c.charge_limit_w : 0)];
  const batteryChanges = batteryRequests.slice(1).filter((w, i) => w !== batteryRequests[i]).length;
  assertAlmostEquals(after.account.continuity_sek, .125 * (evChanges + batteryChanges), 1e-9);
  // The approved setting-change preference can buy stability. Reprice the
  // same-energy no-preference schedule before checking the exact tradeoff.
  const repriced = core.project(p, before.commands).outcome;
  assert(repriced.kind === "projected");
  const oldPreference = repriced.quarters.reduce((sum, q) => sum + q.continuity, 0);
  assert(after.account.cash_sek + after.account.wear_sek + after.account.continuity_sek <=
    before.account.cash_sek + before.account.wear_sek + oldPreference + 1e-9);
  assertAlmostEquals(after.account.score_sek, after.account.points - after.account.cash_sek - after.account.wear_sek - after.account.continuity_sek + after.account.credit_sek, 1e-9);
});

Deno.test("requested setting changes are counted once across a reused accepted prefix", () => {
  const p = competition();
  const commands: NativeCommand[] = p.slots.map((_s, i) => ({ pool_on: false, ev_amps: i < 4 ? (i % 2 ? 5 : 6) : 0,
    battery: i >= 4 ? "grid_charge" : "idle", charge_limit_w: i >= 4 ? 500 + i * 10 : 0, discharge_limit_w: 0 }));
  const projected = core.project(p, commands).outcome;
  assert(projected.kind === "projected");
  assertAlmostEquals(projected.quarters.reduce((sum, q) => sum + q.continuity, 0), 17 * .125, 1e-9);
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
  assertEquals(result.account.continuity_sek, 3 * .125);
});

Deno.test("active EV currents group into blocks instead of alternating with battery headroom", () => {
  const p = activeCurrentCompetition();
  // Isolate current smoothing from the separate ongoing-readiness preference.
  // This synthetic scenario retains its active-block demand and all bounds.
  p.rules = p.rules.filter(rule => rule.key !== 'car_floor');
  const result = selected(p);
  const evening = result.commands.slice(25, 44).map(c => c.ev_amps);
  assert(evening.filter(amps => amps > 0).length > 1);
  assert(evening.some(amps => amps === p.charger!.max_current_a));
  assert(evening.some(amps => amps === p.charger!.min_current_a));
  assert(evening.every((amps, i) => i === 0 || amps <= evening[i - 1]), JSON.stringify(evening));
  // Intermediate currents can end this active block earlier. EV rules are
  // disabled here, so range is economic inventory, not a service guarantee.
  // Keep the grouping assertion above (including a trailing OFF suffix) and
  // independently reconcile all delivered energy instead of fixing run length.
  const supplied = result.quarters.reduce((sum, q, i) => sum + q.ev_w * p.slots[i].hours / 1000, 0);
  assertAlmostEquals(result.quarters.at(-1)!.ev_kwh!, p.initial.ev_kwh! + supplied * p.car!.charge_efficiency, 1e-9);
  assert(result.quarters.at(-1)!.battery_kwh! > 17.5);
  assert(result.quarters.every(q => q.net_w <= p.limits.import_w + 1e-7));
  assert(result.work_used <= p.work_grant);
  const projection = core.project(p, result.commands).outcome;
  assert(projection.kind === "projected");
  assertEquals(result.quarters, projection.quarters);
  assertAlmostEquals(result.account.continuity_sek, projection.quarters.reduce((sum, q) => sum + q.continuity, 0), 1e-9);
});

Deno.test("complete projection charges discrete requests and does not round through a ceiling", () => {
  const p = competition();
  p.slots = p.slots.slice(0, 3);
  p.car_policy!.breach_permille = [null, null, null];
  p.battery!.conversion = { ...syntheticIdentityConversion(), grid_charge: { gain: .96, overhead_w: 120 } };
  p.charging_before.battery_grid_w = 2500;
  const commands: NativeCommand[] = [125.4, 125.6, 1500.9].map(charge_limit_w => ({
    pool_on: false, ev_amps: 0, battery: "grid_charge", charge_limit_w, discharge_limit_w: 0,
  }));
  const completed = core.complete(p, commands).outcome;
  assert(completed.kind === "projected");
  assertEquals(completed.commands.map(c => [c.battery, c.charge_limit_w]), [
    ["idle", 0], ["idle", 0], ["grid_charge", 1500],
  ]);
  assertEquals(completed.quarters.map(q => q.continuity), [.125, 0, .125]);
  assertEquals(completed.account.continuity_sek, .25);
});

Deno.test("independent four-quarter transition ledger agrees with exact projection", () => {
  const p = competition();
  p.slots = p.slots.slice(0, 4);
  p.car_policy!.breach_permille = [null, null, null, null];
  p.limits.import_w = 15000;
  const ev = [0, 5, 6], watts = [0, 500, 1200];
  const charges = (settings: readonly number[]) => settings.slice(1)
    .reduce((count, value, i) => count + Number(value !== settings[i]), 0);
  for (let row = 0; row < 81; row++) {
    for (const phase of [0, 1, 2]) {
      const amps = Array.from({ length: 4 }, (_, i) => ev[Math.floor(row / 3 ** i) % 3]);
      const grid = amps.map((_, i) => watts[(Math.floor(row / 3 ** (3 - i)) + phase) % 3]);
      const commands: NativeCommand[] = amps.map((ev_amps, i) => ({ pool_on: false, ev_amps,
        battery: grid[i] > 0 ? "grid_charge" : "idle", charge_limit_w: grid[i], discharge_limit_w: 0 }));
      const projected = core.project(p, commands).outcome;
      assert(projected.kind === "projected");
      assertEquals(projected.quarters.reduce((total, q) => total + q.continuity, 0),
        (charges([0, ...amps]) + charges([0, ...grid])) / 8);
    }
  }
});
