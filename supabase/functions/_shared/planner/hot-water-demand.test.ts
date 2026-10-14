import { assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
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

Deno.test("a load valley before the water draw cannot hold the draw off: the level rises until the window is served", () => {
  // The filling estimate would put 1 kWh into the quiet first hour, but the
  // heater cannot heat ahead of a draw it was held off for.
  const other = [500, 500, 500, 500, 4500, 4500, 4500, 4500];
  const plan = planHotWaterDemand(example(other, [0, 0, 0, 0, 1000, 1000, 1000, 1000]));
  assertEquals(plan.deferred_kwh, 0);
  assertEquals(plan.permitted, other.map(() => true));
  assertEquals(plan.expected_w, [0, 0, 0, 0, 1000, 1000, 1000, 1000]);
  assertAlmostEquals(plan.policies[0]!.allow_below_w, 4500);
  // Where held-off water can be caught up in a later valley, the level stays in the valley.
  const later = planHotWaterDemand(example([4500, 4500, 500, 500, 500, 500, 4500, 4500], [1000, 1000, 0, 0, 0, 0, 0, 0]));
  assertEquals(later.deferred_kwh, 0);
  assertEquals(later.permitted, [false, false, true, true, true, true, false, false]);
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

Deno.test("hot-water preparation names missing or non-finite committed power before it can corrupt household demand", () => {
  for (const power of [undefined, null, NaN, Infinity, -Infinity]) {
    const input = example([500, 500, 500, 500]);
    const locked = [{ boiler_permitted: true, boiler_expected_w: power as number }];
    for (const services of [input.services, []]) {
      assertThrows(() => planHotWaterDemand({ ...input, services, locked }), Error,
        `Committed hot-water power missing or non-finite at ${input.slots[0].start}`);
    }
  }
});

Deno.test("economic inhibition queues causal work and derives thresholds from eligible quarters", () => {
  const input = example([500, 500, 500, 500, 500, 500, 500, 500]);
  const water = planHotWaterDemand({ ...input, eligible: [false, false, false, false, true, true, true, true] });
  assertEquals(water.expected_w, [0, 0, 0, 0, 2000, 1000, 500, 500]);
  assertAlmostEquals(water.policies[4]!.allow_below_w, 1500);
  assertEquals(water.deferred_kwh, 0);
  const allOff = planHotWaterDemand({ ...input, eligible: input.slots.map(() => false) });
  assertEquals(allOff.expected_w, input.slots.map(() => 0));
  assertAlmostEquals(allOff.deferred_kwh, 1);
});

Deno.test("chosen battery charging shifts the site-load level and translates to the gross-house meter", () => {
  const input = example([500, 500, 500, 500, 500, 500, 500, 500]);
  const plan = planHotWaterDemand({ ...input, battery_offset_w: [4000, 4000, 4000, 4000, 0, 0, 0, 0] });
  assertEquals(plan.permitted, [false, false, false, false, true, true, true, true]);
  assertEquals(plan.expected_w, [0, 0, 0, 0, 2000, 1000, 500, 500]);
  assertEquals(plan.policies[0], null);
  assertEquals(plan.eligible.slice(0, 4), [false, false, false, false]);
  assertAlmostEquals(plan.policies[4]!.allow_below_w, 1500);
  assertAlmostEquals(plan.policies[4]!.inhibit_above_w, 3500);
});

Deno.test("a negative translated admission level inhibits even a zero-watt house", () => {
  const input = example(Array(8).fill(0));
  const plan = planHotWaterDemand({ ...input, battery_offset_w: [4000, 4000, 4000, 4000, 0, 0, 0, 0] });
  assertEquals(plan.permitted, [false, false, false, false, true, true, true, true]);
  assertEquals(plan.eligible, plan.permitted);
  assertEquals(plan.expected_w, [0, 0, 0, 0, 2000, 1000, 500, 500]);
});
