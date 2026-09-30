import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  dispatchWithFixedPlan,
  dispatchWithPrefix,
  type FixedEnergyPlan,
  fixedPlanPreflightInput,
  QUARTER_MS,
  validateFixedSchedule,
} from "./planner/fixed-energy-plan.ts";
import {
  type DispatchSlot,
  type DispatchStore,
  planDispatch,
  scoreDispatch,
} from "./planner/dispatch-plan.ts";
import {
  dispatchWorkbench,
  dispatchWorkbenchInputs,
  generateOptimisationPlan,
  type PlannedSlot,
} from "./planner/energy-optimisation.ts";
import { generateRemoteOptimisationPlan } from "./energy-planning-client.ts";
import { handleEnergyPlanningStep } from "./energy-planning-worker.ts";
import { batterySnapshot, dispatchedEvSnapshot } from "../../../scripts/generate-ha-plan-fixture.ts";

const starts = Array.from(
  { length: 8 },
  (_, i) => Date.parse("2026-09-09T10:00:00Z") + i * QUARTER_MS,
);
const slots: DispatchSlot[] = starts.map(() => ({
  pv_w: 0,
  fixed_load_w: 0,
  import_price_sek_per_kwh: 1,
  export_price_sek_per_kwh: 0,
}));
const store: DispatchStore = {
  key: "battery",
  initial_state: 0,
  max_state: 1,
  min_state: 0,
  max_power_w: 1000,
  retention_per_slot: 1,
  usage_weight: starts.map(() => 0),
  terminal_weight: 1,
  curve: {
    unit: "kwh",
    points: [{ at: 0, sek_per_unit: 10 }, { at: 1, sek_per_unit: 10 }],
  },
  units_per_kwh: () => 1,
  drift: (s) => s,
};
const limits = {
  grid_import_limit_w: 10000,
  grid_export_limit_w: 10000,
  grid_import_shaping_w: 0,
  peak_shaping_sek_per_kwh_per_kw: 0,
};
function fixed(powers: number[]): FixedEnergyPlan {
  return {
    id: "fixed",
    source_snapshot_id: "snapshot",
    starts_at: new Date(starts[0]).toISOString(),
    ends_at: new Date(starts[powers.length - 1] + QUARTER_MS).toISOString(),
    slots: powers.map((w, i) => ({
      start: new Date(starts[i]).toISOString(),
      power_w: { battery: w },
      discharge_w: { battery: 0 },
      targets: {} as PlannedSlot,
      allow_export: false,
    })),
  };
}

Deno.test("fixed zero slots stay off and automatic suffix starts from fixed closing state", () => {
  const result = dispatchWithFixedPlan(
    slots,
    [store],
    limits,
    starts,
    fixed([0, 1000, 1000, 1000, 1000]),
  );
  assertEquals(result.power_w.battery, [0, 1000, 1000, 1000, 1000, 0, 0, 0]);
  assertEquals(result.state.battery[5], 1);
});
Deno.test("rolling horizons match absolute times; expiry and rescission restore automatic", () => {
  const f = fixed([1000, 0, 1000]);
  const result = dispatchWithFixedPlan(
    slots.slice(1),
    [{
      ...store,
      initial_state: .25,
      usage_weight: store.usage_weight.slice(1),
    }],
    limits,
    starts.slice(1),
    f,
  );
  assertEquals(result.power_w.battery.slice(0, 2), [0, 1000]);
  assertEquals(
    dispatchWithFixedPlan(slots, [store], limits, starts, null),
    planDispatch(slots, [store], limits),
  );
  assertEquals(
    dispatchWithFixedPlan(
      slots,
      [store],
      limits,
      starts.map((s) => s + 24 * 60 * 60_000),
      f,
    ),
    planDispatch(slots, [store], limits),
  );
});
Deno.test("fixed infeasibility and device changes fail without rewriting allocations", () => {
  assertThrows(
    () =>
      dispatchWithFixedPlan(
        slots,
        [{ ...store, initial_state: 1 }],
        limits,
        starts,
        fixed([1000]),
      ),
    Error,
    "Fixed plan cannot execute",
  );
  assertThrows(
    () =>
      dispatchWithFixedPlan(
        slots,
        [{ ...store, key: "new" }],
        limits,
        starts,
        fixed([0]),
      ),
    Error,
    "inventory changed",
  );
  assertThrows(
    () =>
      validateFixedSchedule(starts, [store], { power_w: {}, discharge_w: {} }),
    Error,
    "every store",
  );
});
Deno.test("suffix callbacks retain original absolute slot indices", () => {
  const timeSensitive = {
    ...store,
    units_per_kwh: (_: number, i: number) => i >= 4 ? 1 : 0,
  };
  const result = dispatchWithFixedPlan(
    slots,
    [timeSensitive],
    limits,
    starts,
    fixed([0, 0, 0, 0]),
  );
  assertEquals(result.state.battery.at(-1), 1);
});
Deno.test("real EV plans retain fixed allocations across new prices and materialise manual edits", () => {
  const snapshot = dispatchedEvSnapshot();
  const original = generateOptimisationPlan(
    snapshot,
    new Date(snapshot.captured_at),
  );
  const bench = dispatchWorkbench(snapshot, [], original.price_outlook)!;
  assert(bench);
  const f: FixedEnergyPlan = {
    id: "ev-fixed",
    source_snapshot_id: snapshot.snapshot_id,
    starts_at: snapshot.slots[0].start,
    ends_at: snapshot.slots[4].start,
    slots: snapshot.slots.slice(0, 4).map((slot, i) => ({
      start: slot.start,
      power_w: { ev: i === 1 ? 4140 : 0 },
      discharge_w: { ev: 0 },
      targets: original.plans.priority.slots[i],
      allow_export: false,
    })),
  };
  const edited = generateOptimisationPlan(
    snapshot,
    new Date(snapshot.captured_at),
    [],
    original.price_outlook,
    f,
  );
  assertEquals(edited.status, "ready", edited.validation_errors.join("; "));
  assertEquals(edited.plans.priority.slots.slice(0, 4).map((s) => s.ev_w), [
    0,
    4140,
    0,
    0,
  ]);
  f.slots = f.slots.map((s, i) => ({
    ...s,
    targets: edited.plans.priority.slots[i],
  }));
  const updated = generateOptimisationPlan(
    {
      ...snapshot,
      slots: snapshot.slots.map((s) => ({
        ...s,
        import_price_sek_per_kwh: 10,
      })),
    },
    new Date(snapshot.captured_at),
    [],
    undefined,
    f,
  );
  assertEquals(updated.status, "ready", updated.validation_errors.join("; "));
  for (const scenario of Object.values(updated.plans)) {
    assertEquals(scenario.slots.slice(0, 4).map((s) => s.ev_w), [
      0,
      4140,
      0,
      0,
    ]);
  }
  assertEquals(updated.fixed_plan?.id, f.id);
});

Deno.test("activation preflight checks unsolved auction inputs and materialises through the planning worker", async () => {
  // energy-optimisation-fixed-plan's path: a CPU-bounded request can neither
  // solve the workbench nor the whole plan inline.
  const snapshot = dispatchedEvSnapshot();
  const original = generateOptimisationPlan(
    snapshot,
    new Date(snapshot.captured_at),
  );
  const bench = dispatchWorkbench(snapshot, [], original.price_outlook)!;
  const inputs = dispatchWorkbenchInputs(snapshot, [], original.price_outlook)!;
  const { planned: _planned, stopped_because: _stopped, iterations: _iterations,
    allocations: _allocations, battery: _battery, ...solvedInputs } = bench;
  assertEquals(JSON.stringify(inputs), JSON.stringify(solvedInputs));
  assertEquals(
    scoreDispatch(inputs.slots, inputs.stores, inputs.limits, bench.planned),
    scoreDispatch(bench.slots, bench.stores, bench.limits, bench.planned),
  );
  validateFixedSchedule(inputs.slot_start_ms, inputs.stores, bench.planned);

  const f: FixedEnergyPlan = {
    id: "ev-fixed",
    source_snapshot_id: snapshot.snapshot_id,
    starts_at: snapshot.slots[0].start,
    ends_at: snapshot.slots[4].start,
    slots: snapshot.slots.slice(0, 4).map((slot, i) => ({
      start: slot.start,
      power_w: { ev: i === 1 ? 4140 : 0 },
      discharge_w: { ev: 0 },
      targets: original.plans.priority.slots[i],
      allow_export: false,
    })),
  };
  const inline = generateOptimisationPlan(
    snapshot,
    new Date(snapshot.captured_at),
    [],
    original.price_outlook,
    f,
  );
  const connection = {
    url: "https://planner.test",
    planningSecret: "test-planning-secret",
    requestId: "fixed-plan-preflight",
  };
  const staged = await generateRemoteOptimisationPlan(
    fixedPlanPreflightInput(snapshot, original.price_outlook, f),
    connection,
    (url, init) =>
      handleEnergyPlanningStep(new Request(url, init), connection.planningSecret),
  );
  assertEquals(
    JSON.parse(JSON.stringify(staged.plan)),
    JSON.parse(JSON.stringify(inline)),
  );
  assertEquals(staged.plan.plans.priority.slots.slice(0, 4).map((s) => s.ev_w), [
    0,
    4140,
    0,
    0,
  ]);
});

import { commandSnapshot } from "../../../scripts/generate-ha-device-plan-fixture.ts";
Deno.test("fixed room relays, setpoints and per-device allocations survive changed preferences", () => {
  const snapshot = commandSnapshot();
  // Include an editable store alongside the room actuators.
  const ev = dispatchedEvSnapshot();
  snapshot.capabilities.ev = true;
  snapshot.ev_battery = ev.ev_battery;
  snapshot.services = ev.services.map((s) => ({
    ...s,
    deadline: new Date(Date.parse(snapshot.slots.at(-1)!.start) + QUARTER_MS)
      .toISOString(),
  }));
  snapshot.device_models.push({
    key: "charger",
    name: "Charger",
    statistic_id: "sensor.charger",
    category: "ev_charging",
    suggested_load_type: "variable_full_load",
    load_type: "variable_full_load",
    planning_role: "controllable",
    control_type: "variable_power",
    active_power_w: 11040,
    profile_sample_count: 100,
    forecast_w_by_slot: snapshot.slots.map(() => 0),
  });
  const original = generateOptimisationPlan(
    snapshot,
    new Date(snapshot.captured_at),
  );
  assertEquals(original.status, "ready", original.validation_errors.join("; "));
  const bench = dispatchWorkbench(snapshot, [], original.price_outlook)!;
  const f: FixedEnergyPlan = {
    id: "rooms",
    starts_at: snapshot.slots[0].start,
    ends_at: snapshot.slots[4].start,
    source_snapshot_id: snapshot.snapshot_id,
    slots: snapshot.slots.slice(0, 4).map((s, i) => ({
      start: s.start,
      power_w: Object.fromEntries(
        bench.stores.map((s) => [s.key, bench.planned.power_w[s.key][i]]),
      ),
      discharge_w: Object.fromEntries(
        bench.stores.map((s) => [s.key, bench.planned.discharge_w[s.key][i]]),
      ),
      targets: original.plans.priority.slots[i],
      allow_export: false,
    })),
  };
  const updated = generateOptimisationPlan(
    {
      ...snapshot,
      thermal_zones: snapshot.thermal_zones!.map((z) => ({
        ...z,
        unplanned_power_w: z.unplanned_power_w.map(() => 1000),
      })),
    },
    new Date(snapshot.captured_at),
    [],
    undefined,
    f,
  );
  assertEquals(updated.status, "ready", updated.validation_errors.join("; "));
  for (let i = 0; i < 4; i++) {
    assertEquals(
      updated.plans.priority.slots[i].room_heating_w,
      original.plans.priority.slots[i].room_heating_w,
    );
    assertEquals(
      updated.plans.priority.slots[i].device_commands,
      original.plans.priority.slots[i].device_commands,
    );
    assertEquals(
      updated.plans.priority.slots[i].device_loads_w,
      original.plans.priority.slots[i].device_loads_w,
    );
  }
});

Deno.test("explicit export permission is fixed only in the selected interval", () => {
  const battery: DispatchStore = {
    ...store,
    initial_state: 1,
    discharge: {
      max_power_w: 1000,
      state_per_kwh_out: () => 1,
      export_allowed: false,
    },
  };
  const f = fixed([0]);
  f.slots[0].discharge_w.battery = 1000;
  assertThrows(
    () => dispatchWithFixedPlan(slots, [battery], limits, starts, f),
    Error,
    "discharges into export",
  );
  f.slots[0].allow_export = true;
  const result = dispatchWithFixedPlan(slots, [battery], limits, starts, f);
  assertEquals(result.discharge_w.battery[0], 1000);
  assert(result.discharge_w.battery.slice(1).every((w) => w === 0));
});

Deno.test("hot-water permissions and demand remain fixed when the forecast changes", () => {
  const snapshot = dispatchedEvSnapshot();
  snapshot.capabilities.boiler = true;
  snapshot.services.push({
    id: "water",
    device: "boiler",
    earliest_start: snapshot.slots[0].start,
    deadline: new Date(Date.parse(snapshot.slots.at(-1)!.start) + QUARTER_MS)
      .toISOString(),
    required_kwh: 6.4,
    priority: 1,
    control: {
      type: "duty_cycle",
      rated_power_w: 1000,
      expected_power_w_by_slot: snapshot.slots.map(() => 400),
      max_consecutive_inhibit_slots: 4,
    },
  });
  const source = generateOptimisationPlan(
    snapshot,
    new Date(snapshot.captured_at),
  );
  const bench = dispatchWorkbench(snapshot, [], source.price_outlook)!;
  const f: FixedEnergyPlan = {
    id: "water",
    source_snapshot_id: snapshot.snapshot_id,
    starts_at: snapshot.slots[0].start,
    ends_at: snapshot.slots[4].start,
    slots: snapshot.slots.slice(0, 4).map((s, i) => ({
      start: s.start,
      power_w: { ev: bench.planned.power_w.ev[i] },
      discharge_w: { ev: 0 },
      targets: source.plans.priority.slots[i],
      allow_export: false,
    })),
  };
  const changed = structuredClone(snapshot);
  const service = changed.services.find((s) => s.id === "water")!;
  if (service.control.type === "duty_cycle") {
    service.control.expected_power_w_by_slot.fill(200);
  }
  const result = generateOptimisationPlan(
    changed,
    new Date(snapshot.captured_at),
    [],
    undefined,
    f,
  );
  assertEquals(result.status, "ready", result.validation_errors.join("; "));
  assertEquals(
    result.plans.priority.slots.slice(0, 4).map(
      (s) => [s.boiler_expected_w, s.boiler_permitted],
    ),
    source.plans.priority.slots.slice(0, 4).map(
      (s) => [s.boiler_expected_w, s.boiler_permitted],
    ),
  );
  assertEquals(result.plans.priority.slots[4].boiler_expected_w, 200);
});


Deno.test("fixed-plan suffix inherits actual boundary running state", () => {
  const relay: DispatchStore = {
    ...store,
    max_state: 10,
    min_power_w: 1000,
    start_cost_sek: 0.5,
    curve: { unit: "kwh", points: [{ at: 0, sek_per_unit: 2 }, { at: 10, sek_per_unit: 2 }] },
    initially_charging: false,
  };
  // Only the final quarter remains automatic. It pays for continuation but
  // cannot justify a fresh start after an off quarter in the fixed prefix.
  const on = dispatchWithFixedPlan(slots, [relay], limits, starts, fixed([1000, 1000, 1000, 1000, 1000, 1000, 1000]));
  assertEquals(on.power_w.battery[7], 1000);
  relay.initially_charging = true;
  const off = dispatchWithFixedPlan(slots, [relay], limits, starts, fixed([1000, 1000, 1000, 1000, 1000, 1000, 0]));
  assertEquals(off.power_w.battery[7], 0);
});

Deno.test("prefix continuation shifts per-slot export eligibility", () => {
  const exporting = {
    ...store, initial_state: 1,
    curve: { unit: "kwh" as const, points: [{ at: 0, sek_per_unit: 0 }, { at: 1, sek_per_unit: 0 }] },
    discharge: { max_power_w: 1000, state_per_kwh_out: () => 1, export_allowed: true,
      export_allowed_by_slot: [false, true, false, false, false, false, false, false] },
  };
  const priced = slots.map(s => ({ ...s, export_price_sek_per_kwh: 10 }));
  const result = dispatchWithPrefix(priced, [exporting], limits,
    { power_w: { battery: [0] }, discharge_w: { battery: [0] } }, 1);
  assertEquals(result.discharge_w.battery[0], 0);
  assert(result.discharge_w.battery[1] > 0);
  assert(result.discharge_w.battery.slice(2).every(w => w === 0));
});


Deno.test("fixed battery commands preserve v2 ceilings and reject the old execution contract", () => {
  const snapshot = batterySnapshot();
  const now = new Date(snapshot.captured_at);
  const original = generateOptimisationPlan(snapshot, now);
  const first = original.plans.priority.slots[0];
  const f: FixedEnergyPlan = {
    id: "battery-fixed", source_snapshot_id: snapshot.snapshot_id,
    starts_at: first.start, ends_at: snapshot.slots[1].start,
    slots: [{start: first.start, power_w: {battery: first.battery_charge_w},
      discharge_w: {battery: first.battery_discharge_w}, targets: first,
      allow_export: false}],
  };
  const current = generateOptimisationPlan(snapshot, now, [], original.price_outlook, f);
  assertEquals(current.plans.priority.slots[0].battery_command, first.battery_command);
  const old = JSON.parse(JSON.stringify(f));
  old.slots[0].targets.battery_command.schema_version = 1;
  assertThrows(() => generateOptimisationPlan(snapshot, now, [], original.price_outlook, old),
    Error, "Fixed plan battery command schema changed");
});
