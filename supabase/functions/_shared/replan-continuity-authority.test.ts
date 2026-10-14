import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { dispatchWorkbench, generateOptimisationPlan } from "./planner/energy-optimisation.ts";
import { continuityCandidates, REPLAN_DEADBAND_SEK } from "./planner/replan-continuity.ts";
import { scoreDispatch } from "./planner/dispatch-plan.ts";
import { referencedSnapshot } from "./replan-continuity.fixture.ts";

// Battery command authority under continuity, kept apart from
// replan-continuity.test.ts so the two halves run on different CI shards.

Deno.test("small battery changes retain a feasible request while material gains switch immediately", () => {
  const { input } = referencedSnapshot(true);
  input.replan_reference!.battery!.discharge_w -= 10;
  const stable = generateOptimisationPlan(input, new Date(input.captured_at));
  assert(stable.plans.priority.continuity!.selected !== "proposed", JSON.stringify(stable.plans.priority.continuity));
  assertEquals(
    stable.plans.priority.slots[0].battery_discharge_w,
    input.replan_reference!.battery!.discharge_w,
  );
  assert(
    stable.plans.priority.continuity!.reference_sek! <=
      stable.plans.priority.continuity!.proposed_sek! + REPLAN_DEADBAND_SEK,
  );
  const bench = dispatchWorkbench(input, [], stable.price_outlook)!;
  assertAlmostEquals(
    bench.planned.discharge_w.battery[0],
    stable.plans.priority.slots[0].battery_discharge_w,
    .005,
  );
  input.replan_reference!.battery = { operation: "hold", charge_w: 0, discharge_w: 0 };
  const changed = generateOptimisationPlan(input, new Date(input.captured_at));
  assertEquals(changed.plans.priority.continuity!.selected, "proposed");
  assertEquals(changed.plans.priority.continuity!.reason, "material_benefit");
  assert(changed.plans.priority.slots[0].battery_discharge_w > 0);
});

Deno.test("old battery rating and export requests cannot become command authority", () => {
  const { input } = referencedSnapshot();
  input.replan_reference!.battery = { operation: "grid_charge", charge_w: 1e6, discharge_w: 0 };
  const result = generateOptimisationPlan(input, new Date(input.captured_at));
  assertEquals(result.plans.priority.continuity!.selected, "proposed");
  assertEquals(
    result.plans.priority.continuity!.reason,
    "reference_infeasible",
  );
  const bench = dispatchWorkbench({ ...input, replan_reference: null })!;
  input.replan_reference!.battery = { operation: "export", charge_w: 0, discharge_w: 2000 };
  const bundle = {
    ...bench,
    result: {
      ...bench.planned,
      ...scoreDispatch(bench.slots, bench.stores, bench.limits, bench.planned),
      allocations: [],
      battery: [],
      stopped_because: "no_profitable_candidate" as const,
      iterations: 0,
    },
  };
  const candidates = continuityCandidates(bundle, input.replan_reference!);
  assertEquals(candidates.candidates.length, 0);
});

Deno.test("fixed plan authority and changed store inventory exclude continuity", () => {
  const { input, previous } = referencedSnapshot(true);
  const bench = dispatchWorkbench({ ...input, replan_reference: null })!;
  input.replan_reference!.battery!.discharge_w -= 10;
  const fixed = {
    id: "manual",
    source_snapshot_id: previous.snapshot_id,
    starts_at: input.slots[0].start,
    ends_at: input.slots[1].start,
    slots: [{
      start: input.slots[0].start,
      power_w: Object.fromEntries(
        bench.stores.map((s) => [s.key, bench.planned.power_w[s.key][0]]),
      ),
      discharge_w: Object.fromEntries(
        bench.stores.map((s) => [s.key, bench.planned.discharge_w[s.key][0]]),
      ),
      targets: previous.plans.priority.slots[0],
      allow_export: false,
    }],
  };
  const manual = generateOptimisationPlan(
    input,
    new Date(input.captured_at),
    [],
    undefined,
    fixed,
  );
  assertEquals(
    manual.plans.priority.continuity!.reason,
    "fixed_plan_authority",
  );
  // The plan rounds its powers; the workbench's are not rounded.
  assertAlmostEquals(
    manual.plans.priority.slots[0].battery_discharge_w,
    fixed.slots[0].discharge_w.battery,
    .005,
  );
  input.replan_reference!.store_keys.push("unknown");
  const changed = generateOptimisationPlan(input, new Date(input.captured_at));
  assertEquals(
    changed.plans.priority.continuity!.reason,
    "store_inventory_changed",
  );
});
