import { inputFor, countedBudget, assertStagesMatch, seasonInput } from "./energy-planning-step.fixture.ts";
import { replanReference } from "./planner/replan-continuity.ts";
import { assert, assertEquals } from "jsr:@std/assert@1";
import { snapshot, snapshotV8 } from "../../../src/lib/energy-shift/optimisation-snapshot.fixture.ts";
import { dispatchedEvSnapshot } from "../../../scripts/generate-ha-plan-fixture.ts";
import { generateOptimisationPlan } from "./planner/energy-optimisation.ts";
import { assembleOptimisationPlan, createPlanningBudget, energyPlanningStep } from "./energy-planning-step.ts";
import type { FixedEnergyPlan } from "./planner/fixed-energy-plan.ts";

Deno.test("worker slices stop on elapsed time instead of an unrelated operation count", () => {
  const original = performance.now;
  let elapsed = 0;
  performance.now = () => elapsed;
  try {
    const budget = createPlanningBudget();
    let paused = false;
    for (let count = 0; count < 2_000_001; count += 1) paused ||= budget.spent();
    assertEquals(paused, false);
    assertEquals(budget.allowsAuction(), true);
    elapsed = 900;
    assertEquals(budget.spent(), true);
    assertEquals(budget.allowsAuction(), false);
    const counted = createPlanningBudget(900, 2);
    assertEquals(counted.spent(), false);
    assertEquals(counted.spent(), false);
    assertEquals(counted.spent(), true);
  } finally {
    performance.now = original;
  }
});

Deno.test("a slice prepares the household once while completing multiple auctions", () => {
  const input = inputFor(snapshot());
  const captured = input.snapshot;
  let preparations = 0;
  Object.defineProperty(input, "snapshot", {
    get: () => {
      preparations += 1;
      return captured;
    },
  });
  const step = energyPlanningStep(input, undefined, createPlanningBudget(60_000));
  assertEquals(step.done, true);
  assert(step.completed.length > 1);
  assertEquals(preparations, 1);
});

Deno.test("a spent slice saves a finished auction before doing its caller's next work", () => {
  const captured = snapshot();
  captured.pool = null;
  captured.capabilities.pool = false;
  const input = inputFor(captured);
  const step = energyPlanningStep(input, undefined, {
    spent: () => false,
    allowsAuction: () => false,
  });
  assertEquals(step.done, false);
  assertEquals(step.completed.length, 1);
  assertEquals(step.checkpoint, undefined);
  const resumed = energyPlanningStep(input, {
    completed: step.completed,
    rankings: step.rankings,
  }, createPlanningBudget(60_000));
  assertEquals(resumed.done, true);
});

Deno.test("distributed planning preserves discrete EV alternatives", () => {
  assertStagesMatch(inputFor(dispatchedEvSnapshot()));
});

for (const from of [0, 4]) {
  Deno.test(`distributed fixed plan at slot ${from} preserves prefix and resumed suffix`, () => {
    const input = inputFor(dispatchedEvSnapshot());
    const base = generateOptimisationPlan(input.snapshot, new Date(input.now));
    const slots = base.plans.priority.slots.slice(from, from + 4);
    const fixed: FixedEnergyPlan = {
      id: "fixed",
      source_snapshot_id: input.snapshot.snapshot_id,
      starts_at: slots[0].start,
      ends_at: new Date(Date.parse(slots.at(-1)!.start) + 900_000)
        .toISOString(),
      slots: slots.map((slot) => ({
        start: slot.start,
        power_w: { ev: 0 },
        discharge_w: { ev: 0 },
        targets: slot,
        allow_export: false,
      })),
    };
    input.fixed_plan = fixed;
    assertStagesMatch(input);
  });
}

Deno.test("distributed planning preserves continuity candidates and selection", () => {
  const input = inputFor(snapshotV8());
  input.snapshot.slots.forEach(s => {
    if (s.import_price_sek_per_kwh !== null) s.import_price_sek_per_kwh *= .1;
    if (s.export_price_sek_per_kwh !== null) s.export_price_sek_per_kwh *= .1;
  });
  const previous = generateOptimisationPlan(input.snapshot, new Date(input.now));
  input.snapshot.snapshot_id = "00000000-0000-4000-8000-000000000002";
  input.snapshot.replan_reference = replanReference(previous, input.snapshot, new Date(input.now));
  input.snapshot.replan_reference!.battery!.discharge_w -= 10;
  assertStagesMatch(input);
});

Deno.test("distributed planning preserves the remaining horizon across a quarter boundary", () => {
  const input = inputFor(snapshot());
  const boundary = Date.parse(input.snapshot.slots[1].start);
  input.snapshot.captured_at = new Date(boundary - 5_000).toISOString();
  input.now = new Date(boundary + 20_000).toISOString();
  assertStagesMatch(input);
});


Deno.test("response rankings pause before an auction and survive JSON reconstruction", () => {
  const input = seasonInput("sunny");
  input.snapshot.slots = input.snapshot.slots.slice(0, 12);
  const counts = assertStagesMatch(input, () => {
    const budget = countedBudget(2)();
    return {...budget, allowsAuction: () => false};
  });
  assert(counts.rankings > 0);
  assert(counts.rankingOnly > 0);
});
