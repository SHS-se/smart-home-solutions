import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { mixedModeSnapshot } from "../../../scripts/generate-ha-plan-fixture.ts";
import { generateOptimisationPlan, type OptimisationSnapshot } from "./energy-optimisation.ts";
import { validateOperatingScope } from "./operating-scope.ts";
import { assembleOptimisationPlan, energyPlanningStep } from "./energy-planning-step.ts";
import type { EnergyPlanningContinuation } from "./energy-planning-protocol.ts";

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
    const plan = generateOptimisationPlan(s, new Date(s.captured_at));
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
  const p = generateOptimisationPlan(s, new Date(s.captured_at));
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
  const p = generateOptimisationPlan(s, new Date(s.captured_at));
  const original = generateOptimisationPlan(input, new Date(s.captured_at));
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

Deno.test("both scope solves survive staged planning reconstruction", () => {
  const s = mixedModeSnapshot(); const now = s.captured_at;
  const input = {snapshot: s, now, price_archive: []};
  const continuation: EnergyPlanningContinuation = { completed: [] };
  for (let i = 0; i < 100; i++) {
    const step = energyPlanningStep(input, continuation);
    continuation.completed.push(...step.completed);
    continuation.checkpoint = step.checkpoint;
    if (step.done) {
      assertEquals(assembleOptimisationPlan(input, continuation.completed).plan, generateOptimisationPlan(s, new Date(now)));
      return;
    }
  }
  throw new Error('scoped planner did not finish');
});

Deno.test("scope trimming keeps resolved prices and future empirical demand aligned", () => {
  const s = mixedModeSnapshot();
  const initial = generateOptimisationPlan(s, new Date(s.captured_at));
  const now = new Date(Date.parse(s.slots[1].start) + 1000);
  s.captured_at = new Date(Date.parse(s.slots[0].start) + 14 * 60_000).toISOString();
  s.sources.battery!.issued_at = s.captured_at;
  const p = generateOptimisationPlan(s, now, [], initial.price_outlook);
  assertEquals(p.price_outlook.shadow_import_sek_per_kwh, initial.price_outlook.shadow_import_sek_per_kwh.slice(1));
  assertEquals(p.execution_plan!.plans.priority.slots[0].base_w, s.slots[1].base_load_forecast_w);
  assertEquals(p.operating_scope!.external_demands.pool_heater.recent_observation, null);
});

Deno.test("current curve evidence is frozen from the selected solver inputs", () => {
  const s = mixedModeSnapshot();
  const p = generateOptimisationPlan(s, new Date(s.captured_at));
  assert(p.resolved_value_stores?.length);
  assertEquals(p.resolved_value_stores, p.execution_plan!.resolved_value_stores);
  const pool = p.resolved_value_stores.find(store => store.key === 'pool')!;
  assert(pool.units_per_kwh > 0);
  assert(pool.reference_sek_per_kwh > 0);
  assertEquals(pool.initial_state, s.pool!.water_temperature_c);
  const curve = structuredClone(pool.curve);
  s.pool!.water_temperature_c += 1;
  s.value_curves = {};
  assertEquals(pool.curve, curve, 'editing inputs cannot mutate recorded current-plan evidence');
});
