import { assert, assertEquals } from "jsr:@std/assert@1";
import { validRun, continuedRun, validMinimumRun } from "./planner/minimum-run.ts";
import { planDispatch, scoreDispatch, type DispatchStore, type DispatchSlot } from "./planner/dispatch-plan.ts";

const limits = {grid_import_limit_w: 10000, grid_export_limit_w: 10000,
  grid_import_shaping_w: 10000, peak_shaping_sek_per_kwh_per_kw: 0};
const slots = (prices: number[], hours = prices.map(() => 0.25)): DispatchSlot[] => prices.map((p,i) => ({
  duration_hours: hours[i], pv_w: 0, fixed_load_w: 500, import_price_sek_per_kwh: p,
  export_price_sek_per_kwh: 0, binding: true, published_price: true,
}));
const store = (count: number): DispatchStore => ({key: "pool", initial_state: 0, max_state: 1,
  min_power_w: 1000, max_power_w: 1000, retention_per_slot: 1,
  curve: {unit: "celsius", points: [{at: 0, sek_per_unit: 4}, {at: 1, sek_per_unit: 0}]},
  usage_weight: new Array(count).fill(0), terminal_weight: 1,
  drift: s => s, units_per_kwh: () => 1,
  minimum_run: {minimum_seconds: 1800, remaining_seconds: 0, running: false}});

Deno.test("minimum runs validate seconds and carry a partial first quarter", () => {
  const run = {minimum_seconds: 1800, remaining_seconds: 1000, running: true};
  assert(!validRun([1000, 0], [0.1, 0.25], run));
  assert(validRun([1000, 1000, 0], [0.1, 0.25, 0.25], run));
  assertEquals(continuedRun(run, [1000], [0.1])?.remaining_seconds, 640);
  assert(!validMinimumRun({...run, minimum_seconds: Infinity}));
  assert(!validMinimumRun({...run, running: false}));
});

Deno.test("ongoing run survives high prices and pool stop temperature with honest energy", () => {
  const input = slots([20, 20, 20, 20], [0.1, 0.25, 0.25, 0.25]);
  const pool = {...store(4), initial_state: 2, slot_hours: input.map(s => s.duration_hours!),
    minimum_run: {minimum_seconds: 1800, remaining_seconds: 1000, running: true}, initially_charging: true};
  const plan = planDispatch(input, [pool], limits);
  assertEquals(plan.power_w.pool, [1000, 1000, 0, 0]);
  const score = scoreDispatch(input, [pool], limits, plan);
  assertEquals(score.infeasibilities, []);
  assertEquals(score.import_w, [1500, 1500, 500, 500]);
  assert(Math.abs(score.state.pool.at(-1)! - 2.35) < 1e-9);
});

Deno.test("new economic starts survive settlement and refinement only as complete runs", () => {
  const input = slots([0.1, 0.2, 10, 10, 0.1, 0.2, 10, 10]);
  for (const variable of [false, true]) {
    const device = {...store(input.length), ...(variable ? {max_power_w: 3000, power_step_w: 1000} : {})};
    const plan = planDispatch(input, [device], limits);
    assert(plan.power_w.pool.some(w => w > 0));
    assert(validRun(plan.power_w.pool, input.map(() => 0.25), device.minimum_run));
    assertEquals(scoreDispatch(input, [device], limits, plan).infeasibilities, []);
    const invalid = {...plan, power_w: {pool: [1000, 0, 0, 0, 0, 0, 0, 0]}};
    assert(scoreDispatch(input, [device], limits, invalid).infeasibilities.some(x => x.message.includes("minimum run")));
  }
});

import { commandSnapshot } from "../../../scripts/generate-ha-device-plan-fixture.ts";
import { discreteRoomPlan } from "./planner/discrete-room-plan.ts";
import { generateOptimisationPlan } from "./planner/energy-optimisation.ts";

Deno.test("room relay and setpoint searches retain ongoing and future runs", () => {
  for (const kind of ["relay", "thermostat"]) {
    const snapshot = commandSnapshot();
    const model = snapshot.device_models.find(m => m.key === kind)!;
    model.minimum_run = {minimum_seconds: 1800, remaining_seconds: 1000, running: true};
    const zone = snapshot.thermal_zones![0];
    const hours = snapshot.slots.map((_, i) => i === 0 ? 0.1 : 0.25);
    const result = discreteRoomPlan(snapshot, zone, zone.unplanned_power_w, undefined, hours)!;
    assert(result.devicePower[kind][0] > 0 && result.devicePower[kind][1] > 0);
    assert(validRun(result.devicePower[kind], hours, model.minimum_run));
  }
});

Deno.test("hot water permission cannot be inhibited during a protected initial run", () => {
  const snapshot = commandSnapshot();
  snapshot.thermal_zones = [];
  snapshot.capabilities.boiler = true;
  snapshot.grid.import_limit_w = 500;
  snapshot.device_models = [{...snapshot.device_models[0], key: "boiler", category: "hot_water", control_type: "permit_inhibit",
    minimum_run: {minimum_seconds: 1800, remaining_seconds: 1800, running: true}}];
  snapshot.services = [{id:"boiler", device:"boiler", earliest_start:snapshot.slots[0].start,
    deadline:new Date(Date.parse(snapshot.slots.at(-1)!.start)+900000).toISOString(), required_kwh:2,
    control:{type:"duty_cycle", rated_power_w:1000, expected_power_w_by_slot:snapshot.slots.map(() => 1000),
      max_consecutive_inhibit_slots:2}, priority:1}];
  const plan = generateOptimisationPlan(snapshot, new Date(snapshot.captured_at));
  for (const scenario of Object.values(plan.plans)) {
    assert(scenario.slots[0].boiler_permitted && scenario.slots[1].boiler_permitted);
    assert(validRun(scenario.slots.map(s => Number(s.boiler_permitted)), scenario.slots.map(s => s.duration_hours!), snapshot.device_models[0].minimum_run));
  }
});

import { dispatchWithPrefix, DispatchPrefixInfeasible } from "./planner/fixed-energy-plan.ts";
import { assertThrows } from "jsr:@std/assert@1";

Deno.test("fixed prefix can start a run that its suffix must finish", () => {
  const input = slots([0.1, 20, 20, 20]);
  const device = store(4);
  const schedule = {power_w: {pool: [1000]}, discharge_w: {pool: [0]}};
  const plan = dispatchWithPrefix(input, [device], limits, schedule, 1);
  assertEquals(plan.power_w.pool, [1000, 1000, 0, 0]);
  assertEquals(scoreDispatch(input, [device], limits, plan).infeasibilities, []);
  assertThrows(() => dispatchWithPrefix(input, [device], limits,
    {power_w: {pool: [1000, 0]}, discharge_w: {pool: [0, 0]}}, 2), DispatchPrefixInfeasible);
});
