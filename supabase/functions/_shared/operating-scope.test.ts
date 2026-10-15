import { runRulesPlanner } from "./run-rules-planner.ts";
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { mixedModeSnapshot } from "../../../scripts/generate-ha-plan-fixture.ts";
import { type OptimisationSnapshot } from "./planner/planning-contracts.ts";
import { validateOperatingScope } from "./planner/operating-scope.ts";

Deno.test("Verification and Controlling never change the plan", () => {
  // User requirement, 23 September 2026: switching a device between
  // Verification and Controlling changes only which writer is authorised. The
  // schedule, device requests and battery reference stay exactly the same.
  const solve = (battery: "controlling" | "control_verification", pool: "controlling" | "control_verification") => {
    const s = mixedModeSnapshot();
    s.operating_scope.modes.$battery = battery;
    s.operating_scope.modes.$pool = pool;
    if (pool === "controlling") delete s.operating_scope.external_demands.pool_heater;
    s.battery_execution_feedback = { generation: 1, source_receipt: 0, previous_contract_id: null,
      objectives: [], scope_revision: "fixture-whole-house" };
    const plan = runRulesPlanner({ snapshot: s, now: (new Date(s.captured_at)).toISOString(), price_archive: [] }).plan;
    assert(plan.battery_execution, "both modes carry the battery reference");
    return plan;
  };
  const reference = solve("controlling", "control_verification");
  for (const [battery, pool] of [["control_verification", "control_verification"], ["controlling", "controlling"],
    ["control_verification", "controlling"]] as const) {
    const plan = solve(battery, pool);
    for (const key of ["plans", "capabilities", "services", "device_models", "battery", "pool", "valid_until"] as const) {
      assertEquals(plan[key], reference[key], `${battery}/${pool}: ${key}`);
      assertEquals(plan.execution_plan![key], reference.execution_plan![key], `${battery}/${pool}: execution ${key}`);
    }
    // The reference differs only in the mode it was captured under.
    assertEquals({ ...plan.battery_execution, mode: reference.battery_execution!.mode }, reference.battery_execution);
  }
});

Deno.test("both charts and execution publish one authoritative device schedule", () => {
  const s = mixedModeSnapshot();
  const p = runRulesPlanner({ snapshot: s, now: (new Date(s.captured_at)).toISOString(), price_archive: [] }).plan;
  assertEquals(p.schema_version, 9);
  assert(p.execution_plan);
  assertEquals(p.plans, p.execution_plan.plans);
  assertEquals(p.device_models, p.execution_plan.device_models);
  assert(p.plans.priority.slots.some(slot => slot.pool_w > 0));
});

Deno.test("all controlling preserves the unscoped electrical plan", () => {
  const s = mixedModeSnapshot();
  s.operating_scope.modes.$pool = 'controlling';
  s.operating_scope.modes.pool_pump = 'controlling';
  s.operating_scope.external_demands = {};
  const input = {...s, schema_version: 8 as const}; delete (input as OptimisationSnapshot).operating_scope;
  const p = runRulesPlanner({ snapshot: s, now: (new Date(s.captured_at)).toISOString(), price_archive: [] }).plan;
  const original = runRulesPlanner({ snapshot: input, now: (new Date(s.captured_at)).toISOString(), price_archive: [] }).plan;
  assertEquals(p.execution_plan?.plans.priority.slots, original.plans.priority.slots);
});

Deno.test("scope requires complete nonnegative evidence and accepts observed zero", () => {
  const s = mixedModeSnapshot(); s.operating_scope.external_demands.pool_heater.recent_observation!.average_w = 0;
  validateOperatingScope(s);
  s.operating_scope.external_demands.pool_heater.forecast_w_by_slot[0] = -1;
  assertThrows(() => validateOperatingScope(s), Error, 'nonnegative');
  delete s.operating_scope.external_demands.pool_heater;
  assertThrows(() => validateOperatingScope(s), Error, 'exactly once');
});

Deno.test("scope trimming keeps resolved prices and future empirical demand aligned", () => {
  const s = mixedModeSnapshot();
  const initial = runRulesPlanner({ snapshot: s, now: (new Date(s.captured_at)).toISOString(), price_archive: [] }).plan;
  const now = new Date(Date.parse(s.slots[1].start) + 1000);
  s.captured_at = now.toISOString();
  s.sources.battery!.issued_at = s.captured_at;
  const p = runRulesPlanner({ snapshot: s, now: (now).toISOString(), price_archive: [], resolved_price_outlook: initial.price_outlook }).plan;
  assertEquals(p.price_outlook.shadow_import_sek_per_kwh, initial.price_outlook.shadow_import_sek_per_kwh.slice(1));
  assertEquals(p.execution_plan!.plans.priority.slots[0].base_w, s.slots[1].base_load_forecast_w);
  assertEquals(p.operating_scope!.external_demands.pool_heater.recent_observation, null);
});

Deno.test("native plans publish the selected rules without retired curve valuation",()=>{
 const s=mixedModeSnapshot(); const p=runRulesPlanner({snapshot:s,now:s.captured_at,price_archive:[]}).plan;
 assertEquals(p.resolved_value_stores,[]);assertEquals(p.battery_value_curve,null);
 assertEquals(p.execution_plan!.plans,p.plans);
});
