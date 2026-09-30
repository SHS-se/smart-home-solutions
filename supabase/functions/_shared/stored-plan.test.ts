import { assert, assertEquals, assertStrictEquals } from "jsr:@std/assert@1";
import { isOptimisationPlan } from "../../../src/lib/energy-shift/contracts.ts";
import type { OptimisationPlan } from "./planner/energy-optimisation.ts";
import { derivedExecutionPlan, expandStoredPlan, storedPlan } from "./stored-plan.ts";

const fixture = JSON.parse(await Deno.readTextFile(
  new URL("../../../contracts/ha-api/fixtures/schema-9-mixed-mode-plan.json", import.meta.url),
)).plan as OptimisationPlan;

Deno.test("stored schema 9 plans leave out the execution copy and restore it exactly", () => {
  const generated = { ...fixture, thermal_projection: { zones: [] } } as OptimisationPlan;
  assertEquals(derivedExecutionPlan(generated), fixture.execution_plan);
  const stored = storedPlan(generated);
  assert(!("execution_plan" in stored));
  assert(JSON.stringify(stored).length < JSON.stringify(generated).length * 0.6);
  assertEquals(expandStoredPlan(stored), generated);
  // Portal readers accept the stored form and still reject a broken copy.
  assert(isOptimisationPlan(stored));
  assert(isOptimisationPlan(generated));
  assert(!isOptimisationPlan({ ...stored, execution_plan: { schema_version: 9 } }));
});

Deno.test("a divergent execution plan is stored unchanged", () => {
  const priority = fixture.execution_plan!.plans.priority;
  const diverged = { ...fixture, execution_plan: { ...fixture.execution_plan!,
    plans: { ...fixture.execution_plan!.plans, priority: { ...priority, status: "incomplete" as const } } } };
  assertStrictEquals(storedPlan(diverged), diverged);
  // Keys only the execution copy carries are divergence too.
  const extra = { ...fixture, execution_plan: { ...fixture.execution_plan!, battery_execution: fixture.battery_execution ?? {} } } as OptimisationPlan;
  assertStrictEquals(storedPlan(extra), extra);
});

Deno.test("comparison follows serialized JSON, and older schemas are untouched", () => {
  const withUndefined = { ...fixture, execution_plan: { ...fixture.execution_plan!, fixed_plan: undefined } };
  assert(!("execution_plan" in storedPlan(withUndefined)));
  const v8 = fixture.execution_plan!;
  assertStrictEquals(storedPlan(v8), v8);
  assertStrictEquals(expandStoredPlan(v8), v8);
  assertStrictEquals(expandStoredPlan(fixture), fixture);
});
