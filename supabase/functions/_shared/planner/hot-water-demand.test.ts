import { assertAlmostEquals, assertEquals } from "@std/assert";
import type { DutyCycleServiceInput } from "./energy-optimisation.ts";
import { hotWaterPermission, planHotWaterDemand } from "./hot-water-demand.ts";

function example(other: number[], forecast = other.map(() => 500), rated = 2000) {
  const first = Date.parse("2026-10-14T00:00:00Z");
  const slots = other.map((_w, i) => ({ start: new Date(first + i * 900_000).toISOString() }));
  const service: DutyCycleServiceInput = { id: "water", device: "boiler", priority: 1, required_kwh: 1,
    earliest_start: slots[0].start, deadline: new Date(first + slots.length * 900_000).toISOString(),
    control: { type: "duty_cycle", rated_power_w: rated, expected_power_w_by_slot: forecast } };
  return { services: [service], slots, hours: slots.map(() => .25), other_house_w: other, locked: [] };
}

Deno.test("hot-water load level moves with household demand and conserves deferred forecast energy", () => {
  const other = [4500, 4500, 4500, 4500, 500, 500, 500, 500];
  const plan = planHotWaterDemand(example(other));
  assertAlmostEquals(plan.policies[0]!.allow_below_w, 1500);
  assertAlmostEquals(plan.policies[0]!.inhibit_above_w, 3500);
  assertEquals(plan.permitted, [false, false, false, false, true, true, true, true]);
  assertEquals(plan.expected_w, [0, 0, 0, 0, 2000, 1000, 500, 500]);
  assertEquals(plan.deferred_kwh, 0);
  const cold = planHotWaterDemand(example(other.map(w => w + 4000)));
  assertAlmostEquals(cold.policies[0]!.allow_below_w, 5500);
  assertAlmostEquals(cold.policies[0]!.inhibit_above_w, 7500);
  assertEquals(cold.permitted, plan.permitted);
});

Deno.test("hot-water own rated draw does not reverse a permission just granted", () => {
  const policy = { allow_below_w: 1500, inhibit_above_w: 3500 };
  assertEquals(hotWaterPermission(policy, 1500, false), true);
  assertEquals(hotWaterPermission(policy, 3500, true), true);
  assertEquals(hotWaterPermission(policy, 3501, true), false);
  assertEquals(hotWaterPermission(policy, 2000, false), false);
  assertEquals(hotWaterPermission(policy, 1000, false), true);
});

Deno.test("hot-water high demand can remain inhibited without a maximum pause", () => {
  const other = [0, ...Array(40).fill(10_000)];
  const plan = planHotWaterDemand(example(other, [2000, ...Array(40).fill(0)]));
  assertEquals(plan.permitted, [true, ...Array(40).fill(false)]);
});

Deno.test("hot-water forecasts above rated power are preserved and not used as validity bounds", () => {
  const plan = planHotWaterDemand(example([2000, 2000, 2000, 2000], [1200, 1200, 1200, 1200], 1000));
  assertEquals(plan.permitted, [true, true, true, true]);
  assertEquals(plan.expected_w, [1200, 1200, 1200, 1200]);
});

Deno.test("hot-water committed permissions and power stay exact, with outstanding forecast visible", () => {
  const input = example([500, 500, 4500, 4500]);
  const plan = planHotWaterDemand({ ...input, locked: [{boiler_permitted: false, boiler_expected_w: 0}] });
  assertEquals(plan.permitted[0], false);
  assertEquals(plan.expected_w[0], 0);
  assertAlmostEquals(plan.expected_w.reduce((a, b) => a + b, 0) / 4000 + plan.deferred_kwh, .5);
});
