import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertThrows,
} from "jsr:@std/assert@1";
import { snapshot, snapshotV8 } from "../../../src/lib/energy-shift/optimisation-snapshot.fixture.ts";
import {
  dispatchWorkbench,
  generateOptimisationPlan,
} from "./planner/energy-optimisation.ts";
import {
  continuityCandidates,
  HELD_RUN_RELEASE_SEK,
  heldRunCandidate,
  REPLAN_DEADBAND_SEK,
  replanReference,
  usableReference,
} from "./planner/replan-continuity.ts";
import { scoreDispatch } from "./planner/dispatch-plan.ts";
import { solvedPlan } from "./planner/solved-plan.fixture.ts";
import { batterySnapshot } from "../../../scripts/generate-ha-plan-fixture.ts";

function batteryContinuitySnapshot(solar = true) {
  const input = batterySnapshot();
  input.captured_at = input.slots[0].start;
  input.slots = input.slots.map((slot, index) => ({
    ...slot,
    pv_forecast_w: solar && index < 8 ? 4753.18 : 0,
    base_load_forecast_w: 1835.72,
    import_price_sek_per_kwh: 1,
    export_price_sek_per_kwh: 0.01,
  }));
  // Pin valuation so these tests isolate continuity, not daily curve selection.
  const reference = generateOptimisationPlan(input, new Date(input.captured_at)).battery_value_curve!.automatic_curve;
  input.value_curves = { battery: reference };
  input.policy.battery_export_enabled = true;
  input.policy.battery_export_reserve_soc = 0.05;
  input.policy.battery_export_min_price_sek_per_kwh = 0;
  return input;
}

for (const solar of [true, false]) {
  Deno.test(`continuity cannot turn ${solar ? "solar capture into grid charging" : "house supply into export"}`, () => {
    const input = batteryContinuitySnapshot(solar);
    const now = new Date(input.captured_at);
    const previous = generateOptimisationPlan(input, now);
    const operation = solar ? "solar_charge" : "supply_house";
    assertEquals(previous.plans.priority.slots[0].battery_command!.operation, operation);
    input.snapshot_id = "00000000-0000-4000-8000-000000000002";
    input.slots[0].base_load_forecast_w += solar ? 200 : -200;
    input.replan_reference = replanReference(previous, input, now);
    assert(input.replan_reference);

    const fresh = generateOptimisationPlan({ ...input, replan_reference: null }, now);
    const freshCommand = fresh.plans.priority.slots[0].battery_command!;
    assertEquals(freshCommand.allow_grid_charge, false);
    assertEquals(freshCommand.allow_battery_export, false);
    const continued = generateOptimisationPlan(input, now);
    assertEquals(continued.status, "ready", JSON.stringify(continued.validation_errors));
    assertEquals(continued.plans.priority.slots[0].battery_command, freshCommand);
    assertEquals(continued.plans.priority.continuity!.selected, "proposed");
    assertEquals(continued.plans.priority.continuity!.reason, "battery_operation_changed");
    assertEquals(continued.plans.priority.slots, fresh.plans.priority.slots);
  });
}

Deno.test("continuity can retain hold while a materially better fresh grid charge can replace solar", () => {
  const input = batteryContinuitySnapshot();
  const now = new Date(input.captured_at);
  input.slots[0].pv_forecast_w = input.slots[0].base_load_forecast_w;
  const previous = generateOptimisationPlan(input, now);
  assertEquals(previous.plans.priority.slots[0].battery_command!.operation, "hold");
  input.snapshot_id = "00000000-0000-4000-8000-000000000002";
  input.slots[0].pv_forecast_w += 100;
  input.replan_reference = replanReference(previous, input, now);
  const held = generateOptimisationPlan(input, now);
  assertEquals(held.plans.priority.slots[0].battery_command!.operation, "hold");
  assertEquals(held.plans.priority.continuity!.selected, "direct");

  const solar = batteryContinuitySnapshot();
  const previousSolar = generateOptimisationPlan(solar, now);
  assertEquals(previousSolar.plans.priority.slots[0].battery_command!.operation, "solar_charge");
  solar.snapshot_id = "00000000-0000-4000-8000-000000000002";
  solar.slots[0].import_price_sek_per_kwh = -1;
  solar.replan_reference = replanReference(previousSolar, solar, now);
  const replenished = generateOptimisationPlan(solar, now);
  assertEquals(replenished.plans.priority.slots[0].battery_command!.operation, "grid_charge");
  assertEquals(replenished.plans.priority.continuity!.selected, "proposed");
});

function referencedSnapshot(cheap = false) {
  const input = snapshotV8();
  if (cheap) {
    input.slots.forEach((s) => {
      if (s.import_price_sek_per_kwh !== null) s.import_price_sek_per_kwh *= .1;
      if (s.export_price_sek_per_kwh !== null) s.export_price_sek_per_kwh *= .1;
    });
    // These continuity cases need a fixed declining valuation: a 10 W
    // adjustment stays within the deadband, while replacing house supply
    // with hold costs enough to switch immediately. Previously the automatic
    // candidate search supplied this shape; balanced valuation need not do so.
    const battery = input.battery!;
    input.battery_curve_mode = "custom";
    input.value_curves = { ...input.value_curves, battery: {
      unit: "kwh",
      points: [
        { at: 0, sek_per_unit: .159 },
        { at: (battery.max_soc - battery.min_soc) * battery.capacity_kwh, sek_per_unit: 0 },
      ],
    } };
  }
  const previous = solvedPlan(input, new Date(input.captured_at)).plan;
  input.snapshot_id = "00000000-0000-4000-8000-000000000002";
  input.replan_reference = replanReference(
    previous,
    input,
    new Date(input.captured_at),
  );
  assert(input.replan_reference);
  return { input, previous };
}

Deno.test("reference rejects expired, future, self, schema and capability mismatches", () => {
  const { input, previous } = referencedSnapshot();
  const now = new Date(input.captured_at);
  for (
    const bad of [
      { ...previous, valid_until: now.toISOString() },
      { ...previous, issued_at: new Date(now.getTime() + 1).toISOString() },
      { ...previous, plan_id: input.snapshot_id },
      { ...previous, schema_version: 5 as const },
      {
        ...previous,
        capabilities: { ...previous.capabilities, battery: false },
      },
    ]
  ) assertEquals(replanReference(bad, input, now), null);
  assertEquals(
    replanReference(previous, { ...input, slots: input.slots.slice(0, 1) }, new Date(now.getTime() + 900000)),
    null,
  );
});

Deno.test("agreement skips suffix search and replay inputs stay immutable", () => {
  const { input } = referencedSnapshot();
  const bench = dispatchWorkbench({ ...input, replan_reference: null })!;
  const result = generateOptimisationPlan(input, new Date(input.captured_at));
  assertEquals(result.plans.priority.continuity!.reason, "agrees");
  const before = structuredClone(input.replan_reference);
  const alternatives = continuityCandidates(
    {
      ...bench,
      result: {
        ...bench.planned,
        state: {},
        import_w: [],
        export_w: [],
        allocations: [],
        battery: [],
        stopped_because: "no_profitable_candidate",
        iterations: 0,
      },
    },
    input.replan_reference!,
    () => {
      throw new Error("unnecessary solve");
    },
  );
  assertEquals(alternatives.reason, "agrees");
  assertEquals(input.replan_reference, before);
});

Deno.test("small battery changes retain a feasible request while material gains switch immediately", () => {
  const { input } = referencedSnapshot(true);
  input.replan_reference!.battery!.discharge_w -= 10;
  const stable = generateOptimisationPlan(input, new Date(input.captured_at));
  assertEquals(stable.plans.priority.continuity!.selected, "direct");
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

Deno.test("pool continuity preserves the heat action using the current learned power", () => {
  const { input } = referencedSnapshot();
  const bench = dispatchWorkbench({ ...input, replan_reference: null })!;
  const pool = bench.stores.find((s) => s.key === "pool")!;
  const stores = bench.stores.map((s) =>
    s.key === "pool" ? { ...s, max_power_w: 2148, min_power_w: 2148 } : s
  );
  input.replan_reference!.pool_heat = true;
  const alternatives = continuityCandidates({
    ...bench,
    stores,
    result: {
      ...bench.planned,
      state: {},
      import_w: [],
      export_w: [],
      allocations: [],
      battery: [],
      stopped_because: "no_profitable_candidate",
      iterations: 0,
    },
  }, input.replan_reference!);
  assert(alternatives.candidates.length > 0);
  for (const candidate of alternatives.candidates) {
    assertEquals(candidate.result.power_w.pool[0], 2148);
  }
  assertEquals(pool.initially_charging, false);
});

Deno.test("continuation sentinels and unexpected solver errors are not swallowed", () => {
  const { input } = referencedSnapshot();
  const bench = dispatchWorkbench({ ...input, replan_reference: null })!;
  input.replan_reference!.battery!.discharge_w -= 10;
  assertThrows(
    () =>
      continuityCandidates(
        {
          ...bench,
          result: {
            ...bench.planned,
            state: {},
            import_w: [],
            export_w: [],
            allocations: [],
            battery: [],
            stopped_because: "no_profitable_candidate",
            iterations: 0,
          },
        },
        input.replan_reference!,
        () => {
          throw new Error("continuation");
        },
      ),
    Error,
    "continuation",
  );
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
  assertEquals(
    manual.plans.priority.slots[0].battery_discharge_w,
    fixed.slots[0].discharge_w.battery,
  );
  input.replan_reference!.store_keys.push("unknown");
  const changed = generateOptimisationPlan(input, new Date(input.captured_at));
  assertEquals(
    changed.plans.priority.continuity!.reason,
    "store_inventory_changed",
  );
});

Deno.test("workbench uses the frozen planning time when capture preceded issuance", () => {
  const { input, previous } = referencedSnapshot(true);
  const now = new Date(input.captured_at);
  input.captured_at = new Date(now.getTime() - 1000).toISOString();
  input.replan_reference = replanReference(previous, input, now);
  assert(input.replan_reference);
  input.replan_reference.battery!.discharge_w -= 10;
  const generated = generateOptimisationPlan(input, now);
  const bench = dispatchWorkbench(input, [], generated.price_outlook)!;
  assertEquals(generated.plans.priority.continuity!.selected, "direct");
  assertAlmostEquals(
    bench.planned.discharge_w.battery[0],
    generated.plans.priority.slots[0].battery_discharge_w,
    .005,
  );
});

Deno.test("boundary-crossing snapshots reference the active quarter", () => {
  const { input, previous } = referencedSnapshot();
  const now = new Date(Date.parse(input.slots[1].start) + 20_000);
  input.captured_at = new Date(now.getTime() - 25_000).toISOString();
  const reference = replanReference(previous, input, now);
  assert(reference);
  assertEquals(reference.slot_start, input.slots[1].start);
  input.replan_reference = reference;
  const plan = generateOptimisationPlan(input, now);
  assertEquals(plan.status, "ready", JSON.stringify(plan.validation_errors));
  assertEquals(plan.plans.priority.slots[0].start, input.slots[1].start);
  assert(plan.plans.priority.continuity);
  assert(plan.plans.priority.continuity.reason !== "invalid_reference");
});

Deno.test("continuity requires explicit prior intent and rejects legacy or inconsistent references", () => {
  const input = batteryContinuitySnapshot();
  const now = new Date(input.captured_at);
  const previous = generateOptimisationPlan(input, now);
  input.snapshot_id = "00000000-0000-4000-8000-000000000002";
  const reference = replanReference(previous, input, now)!;
  assertEquals(reference.version, 2);
  assertEquals(reference.battery!.operation, "solar_charge");
  for (const mutate of [
    (value: typeof reference) => { Reflect.set(value, "version", 1); },
    (value: typeof reference) => { Reflect.deleteProperty(value.battery!, "operation"); },
    (value: typeof reference) => { Reflect.set(value.battery!, "operation", "unknown"); },
    (value: typeof reference) => { Reflect.set(value.battery!, "operation", "self_consumption"); },
    (value: typeof reference) => { value.battery!.operation = "hold"; },
    (value: typeof reference) => { value.battery!.operation = "supply_house"; },
    (value: typeof reference) => { value.battery!.discharge_w = 100; },
    (value: typeof reference) => { value.battery!.charge_w = -1; },
    (value: typeof reference) => { value.battery!.charge_w = NaN; },
  ]) {
    const invalid = structuredClone(reference);
    mutate(invalid);
    assertEquals(usableReference(invalid, input.snapshot_id, Date.parse(input.slots[0].start), now.getTime()), false);
    const plan = generateOptimisationPlan({ ...input, replan_reference: invalid }, now);
    assertEquals(plan.plans.priority.continuity!.reason, "invalid_reference");
    assertEquals(plan.plans.priority.slots[0].battery_command!.operation, "solar_charge");
  }
  delete previous.plans.priority.slots[0].battery_command;
  assertEquals(replanReference(previous, input, now), null);

  const legacy = snapshot();
  const legacyPlan = generateOptimisationPlan(legacy, new Date(legacy.captured_at));
  legacy.snapshot_id = input.snapshot_id;
  assertEquals(replanReference(legacyPlan, legacy, new Date(legacy.captured_at)), null);
});

Deno.test("pool-only continuity does not require a battery command", () => {
  const input = snapshotV8();
  input.capabilities.battery = false;
  input.battery = null;
  input.sources.battery = null;
  input.policy = {
    battery_end_of_solar_target_soc: 0, battery_target_is_hard: false,
    terminal_soc_min: 0, terminal_energy_value_sek_per_kwh: 0,
    battery_export_enabled: false, battery_export_reserve_soc: 0,
    battery_export_min_price_sek_per_kwh: 0,
  };
  const now = new Date(input.captured_at);
  const previous = generateOptimisationPlan(input, now);
  input.snapshot_id = "00000000-0000-4000-8000-000000000002";
  const reference = replanReference(previous, input, now);
  assert(reference);
  assertEquals(reference.battery, null);
  assertEquals(reference.pool_heat, previous.plans.priority.slots[0].pool_w > 0);
  const plan = generateOptimisationPlan({ ...input, replan_reference: reference }, now);
  assertEquals(plan.plans.priority.continuity!.reason, "agrees");
});

/** A pool-only home whose previous plan heated for `run` published quarters from now. */
function heatingPoolSnapshot(run: number) {
  const input = snapshotV8();
  input.capabilities.battery = false;
  input.battery = null;
  input.sources.battery = null;
  input.policy = {
    battery_end_of_solar_target_soc: 0, battery_target_is_hard: false,
    terminal_soc_min: 0, terminal_energy_value_sek_per_kwh: 0,
    battery_export_enabled: false, battery_export_reserve_soc: 0,
    battery_export_min_price_sek_per_kwh: 0,
  };
  const now = new Date(input.captured_at);
  const previous = generateOptimisationPlan(input, now);
  previous.plans.priority.slots.forEach((slot, index) => {
    slot.pool_w = index < run ? 3500 : 0;
  });
  input.snapshot_id = "00000000-0000-4000-8000-000000000002";
  input.pool!.heating_running = true;
  input.replan_reference = replanReference(previous, input, now);
  assert(input.replan_reference);
  return { input, now, previous };
}

Deno.test("the reference counts the unbroken published pool run from the current quarter", () => {
  const { input, now, previous } = heatingPoolSnapshot(6);
  assertEquals(input.replan_reference!.pool_heat, true);
  assertEquals(input.replan_reference!.pool_run_quarters, 6);
  previous.plans.priority.slots[3].binding = false;
  assertEquals(replanReference(previous, input, now)!.pool_run_quarters, 3);
  previous.plans.priority.slots[0].pool_w = 0;
  assertEquals(replanReference(previous, input, now)!.pool_run_quarters, 0);
  const start = Date.parse(input.slots[0].start);
  for (const bad of [-1, 1.5]) {
    assertEquals(usableReference({ ...input.replan_reference!, pool_run_quarters: bad }, input.snapshot_id, start, now.getTime()), false);
  }
  // A run cannot contradict the heat action it continues.
  assertEquals(usableReference({ ...input.replan_reference!, pool_run_quarters: 0 }, input.snapshot_id, start, now.getTime()), false);
  assertEquals(usableReference({ ...input.replan_reference!, pool_run_quarters: undefined }, input.snapshot_id, start, now.getTime()), true);
});

Deno.test("a running pool keeps its previous run, and a planned one may still move", () => {
  const { input } = heatingPoolSnapshot(8);
  // Dear enough that a fresh solve waits for quarter 5, cheap enough that
  // holding the run costs less than the release margin.
  const start = input.slots[5].import_price_sek_per_kwh! + 1;
  input.slots.slice(0, 5).forEach((slot) => slot.import_price_sek_per_kwh = start);
  const bench = dispatchWorkbench({ ...input, replan_reference: null })!;
  const result = {
    ...bench.planned,
    ...scoreDispatch(bench.slots, bench.stores, bench.limits, bench.planned),
    allocations: [], battery: [],
    stopped_because: "no_profitable_candidate" as const, iterations: 0,
  };
  assert(result.power_w.pool.slice(0, 8).some((watts) => watts === 0));
  const problem = { ...bench, result };
  assertEquals(heldRunCandidate(problem, input.replan_reference!, false), null);
  const held = heldRunCandidate(problem, input.replan_reference!, true)!;
  assertEquals(held.construction, "held");
  assert(held.result.power_w.pool.slice(0, 8).every((watts) => watts > 0));
  assertEquals(bench.stores.find((s) => s.key === "pool")!.minimum_run, undefined);
  const agreeing = { ...problem, result: { ...result, power_w: { ...result.power_w, pool: held.result.power_w.pool } } };
  assertEquals(heldRunCandidate(agreeing, input.replan_reference!, true, () => {
    throw new Error("unnecessary solve");
  }), null);

  const plan = generateOptimisationPlan(input, new Date(input.captured_at));
  const continuity = plan.plans.priority.continuity!;
  assertEquals(continuity.selected, "held", JSON.stringify(continuity));
  assertEquals(continuity.held_run!.released, false);
  assert(continuity.held_run!.held_sek <= continuity.proposed_sek! + HELD_RUN_RELEASE_SEK);
  assert(plan.plans.priority.slots.slice(0, 8).every((slot) => slot.pool_w > 0));
});

Deno.test("a running pool is let go when stopping it saves more than the release margin", () => {
  const { input } = heatingPoolSnapshot(8);
  input.slots.slice(0, 8).forEach((slot) => slot.import_price_sek_per_kwh! += 40);
  const plan = generateOptimisationPlan(input, new Date(input.captured_at));
  const continuity = plan.plans.priority.continuity!;
  assertEquals(continuity.held_run!.released, true);
  assert(continuity.held_run!.held_sek > continuity.proposed_sek! + HELD_RUN_RELEASE_SEK);
  assert(plan.plans.priority.slots.slice(0, 8).some((slot) => slot.pool_w === 0));
});
