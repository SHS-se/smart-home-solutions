import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { hotWaterSnapshot, batterySnapshot } from "../../../scripts/generate-ha-plan-fixture.ts";
import { prepareRulesPlanningInput } from "./rules-planner.ts";
import { createWasmPlanner } from "./planner-wasm/core.ts";
import { SOLVER_BASE64 } from "./planner-wasm/solver-bytes.ts";
import { resolveRulePolicy } from "./planner-wasm/rule-policy.ts";
import { problemEndCredit } from "./planner-wasm/end-credit.ts";
import { projectedAccount, refineHotWater } from "./rules-hot-water-selection.ts";
import { cpuPlanningInput } from "../../../tests/planner-handler-cpu.fixture.ts";

const core = createWasmPlanner(Uint8Array.from(atob(SOLVER_BASE64), c => c.charCodeAt(0)));
function prepared(battery = false) {
  const s = hotWaterSnapshot();
  s.captured_at = s.slots[0].start;
  if (battery) {
    const b = batterySnapshot();
    s.capabilities.battery = true;
    s.battery = { ...b.battery!, soc: .8 };
    s.value_settings = { battery_degradation_sek_per_kwh: .05, vehicle_fallback_sek_per_km: null };
  }
  return prepareRulesPlanningInput({ snapshot: s, now: s.captured_at, resolved_price_outlook: {
    shaped: true, observed_days: 1, effective_days: 1, level_sek_per_kwh: 1.5,
    shadow_import_sek_per_kwh: s.slots.map(slot => slot.import_price_sek_per_kwh!),
  } }, null, resolveRulePolicy());
}

Deno.test("water projection account agrees with native cash, wear, points and store credit", () => {
  const input = prepared(true);
  const outcome = core.solve(input.problem).outcome;
  assert(outcome.kind === "selected");
  const projected = core.project(input.problem, outcome.selection.commands).outcome;
  assert(projected.kind === "projected");
  const account = projectedAccount(input.problem, projected.quarters, outcome.selection.account);
  for (const key of ["cash_sek", "wear_sek", "credit_sek", "score_sek"] as const) {
    assertAlmostEquals(account[key], outcome.selection.account[key], 1e-8);
  }
  const selected = refineHotWater(core, input, outcome.selection);
  const replayed = core.project(selected.input.problem, selected.selection.commands).outcome;
  assert(replayed.kind === "projected");
  assertEquals(replayed.quarters, selected.selection.quarters);
  assert(selected.selection.account.score_sek >= outcome.selection.account.score_sek - 1e-8);
  assertAlmostEquals(selected.input.boiler_w.reduce((sum, w) => sum + w / 4000, 0) + selected.input.boiler_deferred_kwh,
    input.boiler_w.reduce((sum, w) => sum + w / 4000, 0));
});

Deno.test("infeasible water proposals retain the coherent native admission candidate", () => {
  const input = prepared();
  const outcome = core.solve(input.problem).outcome;
  assert(outcome.kind === "selected");
  let rejected = 0;
  const selected = refineHotWater({ ...core, project(problem, commands) {
    if (problem.slots.some((s, i) => Math.abs(s.base_w - input.problem.slots[i].base_w) > 1e-8)) {
      rejected++;
      return { ...core.project(input.problem, commands), outcome: { kind: "failed" as const, issue: "shared_grid_limit" } };
    }
    return core.project(problem, commands);
  } }, input, outcome.selection);
  assert(rejected > 0);
  assertEquals(selected.input.boiler_w, input.boiler_w);
  assertEquals(selected.selection.quarters, outcome.selection.quarters);
});

Deno.test("morning water uses battery opportunity cost even with zero grid import", () => {
  const input = prepared(true);
  input.base_w = input.base_w.map(() => 500);
  input.problem.slots = input.problem.slots.map((s, i) => ({ ...s, base_w: 500 + input.boiler_w[i],
    solar_w: i < 4 ? 0 : 5000, import_price: i < 4 ? 3 : .2, export_price: .1 }));
  input.problem.end_credit = problemEndCredit(input.problem);
  const initial = core.solve(input.problem).outcome;
  assert(initial.kind === "selected");
  assert(initial.selection.quarters.slice(0, 4).every(q => Math.abs(q.net_w) < 1e-8 && q.discharge_w > 0));
  const selected = refineHotWater(core, input, initial.selection);
  assertEquals(selected.input.boiler_w.slice(0, 4), [0, 0, 0, 0]);
  assertAlmostEquals(selected.input.boiler_w.reduce((a, b) => a + b, 0), input.boiler_w.reduce((a, b) => a + b, 0));
  assert(selected.selection.account.score_sek > initial.selection.account.score_sek + .01);
  assert(selected.selection.account.credit_sek !== initial.selection.account.credit_sek ||
    selected.selection.account.wear_sek !== initial.selection.account.wear_sek);
});

Deno.test("72-hour hot-water refinement shares at most 64 projections across both search passes", () => {
  const input = cpuPlanningInput();
  assertEquals(input.problem.slots.length, 288);
  assertEquals(input.boiler_services.length, 4);
  const native = core.solve(input.problem).outcome;
  assert(native.kind === "selected");
  let projections = 0, solves = 0;
  const counted = { ...core, project(...args: Parameters<typeof core.project>) {
    projections++;
    return core.project(...args);
  }, solve(...args: Parameters<typeof core.solve>) {
    solves++;
    return core.solve(...args);
  } };
  const selected = refineHotWater(counted, input, native.selection);
  assert(projections <= 64, `hot water exceeded its complete refinement budget: ${projections} projections`);
  assert(solves <= 1, `hot water repeated native selection ${solves} times`);
  assert(selected.selection.account.score_sek >= native.selection.account.score_sek - 1e-8);
  const replayed = core.project(selected.input.problem, selected.selection.commands).outcome;
  assert(replayed.kind === "projected");
  assertEquals(replayed.quarters, selected.selection.quarters);
});
