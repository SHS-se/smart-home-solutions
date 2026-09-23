import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { mixedModeSnapshot } from "../../../scripts/generate-ha-plan-fixture.ts";
import { commandSnapshot } from "../../../scripts/generate-ha-device-plan-fixture.ts";
import { generateOptimisationPlan, type OptimisationSnapshot } from "./energy-optimisation.ts";
import { projectExecutionSnapshot, validateOperatingScope } from "./operating-scope.ts";
import { assembleOptimisationPlan, energyPlanningStep } from "./energy-planning-step.ts";
import type { EnergyPlanningContinuation } from "./energy-planning-protocol.ts";

Deno.test("mixed mode conserves fixed demand and conditions only the current quarter", () => {
  const s = mixedModeSnapshot(); const before = structuredClone(s);
  const projected = projectExecutionSnapshot(s);
  assertEquals(s, before);
  assertEquals(projected.capabilities.pool, false);
  assertEquals(projected.device_models, []);
  assertEquals(projected.services, []);
  assertEquals(projected.slots[0].base_load_forecast_w, s.slots[0].base_load_forecast_w + 2100);
  assertEquals(projected.slots[1].base_load_forecast_w, s.slots[1].base_load_forecast_w + 1260);
  assertEquals(projected.replan_reference, null);
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

Deno.test("a pool pump owned by $pool runs with the pool and sizes it with the heater", () => {
  // The integration sends every Planned pool member under $pool. A pump owning
  // itself left its power outside the controlled pool, or was refused alone.
  for (const pool of ["control_verification", "controlling"] as const) {
    const s = mixedModeSnapshot();
    s.operating_scope.device_owners.pool_pump = "$pool";
    delete s.operating_scope.modes.pool_pump;
    s.operating_scope.modes.$pool = pool;
    if (pool === "controlling") s.operating_scope.external_demands = {};
    const projected = projectExecutionSnapshot(s);
    assertEquals(projected.device_models.map(m => m.key), pool === "controlling" ? ["pool_heater", "pool_pump"] : []);
    assertEquals(projected.services.map(service => service.control),
      pool === "controlling" ? [{type: "fixed_power", power_w: 2100}] : []);
  }
  const alone = mixedModeSnapshot();
  alone.operating_scope.modes.pool_pump = "controlling";
  delete alone.operating_scope.external_demands.pool_pump;
  assertThrows(() => projectExecutionSnapshot(alone), Error, "physical controller in Controlling mode");
});

Deno.test("external forecasts survive hypothetical thermal enrichment", () => {
  const s: OptimisationSnapshot = {...commandSnapshot(), schema_version: 9};
  s.operating_scope = {modes: {$battery: 'monitoring', $pool: 'monitoring', $ev: 'monitoring', relay: 'planning', thermostat: 'planning'},
    device_owners: {relay: 'relay', thermostat: 'thermostat'}, external_demands: Object.fromEntries(s.device_models.map(m =>
      [m.key, {forecast_w_by_slot: [...m.forecast_w_by_slot], recent_observation: null}]))};
  s.device_models.forEach(m => m.forecast_w_by_slot.fill(0));
  const projected = projectExecutionSnapshot(s);
  assertEquals(projected.slots[0].base_load_forecast_w, s.slots[0].base_load_forecast_w + 1500);
  assertEquals(projected.thermal_zones, []);
  s.operating_scope.modes.relay = 'controlling'; delete s.operating_scope.external_demands.relay;
  assertThrows(() => projectExecutionSnapshot(s), Error, 'Partial control of thermal zone');
});

Deno.test("scope requires complete nonnegative evidence and accepts observed zero", () => {
  const s = mixedModeSnapshot(); s.operating_scope.external_demands.pool_heater.recent_observation!.average_w = 0;
  assertEquals(projectExecutionSnapshot(s).slots[0].base_load_forecast_w, 1400);
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
