import { assert, assertEquals, assertThrows } from "@std/assert";
import { dispatchedEvSnapshot, mixedModeSnapshot, rulesFixtureInput } from "../../../scripts/generate-ha-plan-fixture.ts";
import { commandSnapshot } from "../../../scripts/generate-ha-device-plan-fixture.ts";
import { runRulesPlanner } from "./run-rules-planner.ts";
import { type PublishedCommandReference } from "./rules-planner.ts";
import type { OptimisationSnapshot, PlannedSlot } from "./planner/planning-contracts.ts";
import type { ExecutionChange, ExecutionReplan } from "./execution-replan.ts";

const requestId = "fd1b02a1-0000-4000-8000-000000000001";
const input = (snapshot: OptimisationSnapshot, execution_replan?: ExecutionReplan) => ({snapshot,
  now: snapshot.captured_at, price_archive: [], resolved_price_outlook: {...rulesFixtureInput(snapshot).price_outlook, shadow_import_sek_per_kwh: snapshot.slots.map(slot => slot.import_price_sek_per_kwh!)}, execution_replan});
const end = (start: string) => new Date(Date.parse(start) + 900_000).toISOString();
const change = (owner: string, snapshot: OptimisationSnapshot, status: ExecutionChange["status"] = "faulted"): ExecutionChange => ({
  owner, status, cause: status === "temporarily_absent" ? "vehicle_disconnected" : "actuator_unavailable",
  blocked_intervals: status === "recovered" ? [] : [{start: snapshot.slots[0].start, end: end(snapshot.slots[0].start)}],
});
const request = (reference: PublishedCommandReference, snapshot: OptimisationSnapshot, changes: ExecutionChange[]): ExecutionReplan => ({
  request_id: requestId, accepted_plan_id: reference.plan_id, observed_at: snapshot.captured_at, changes,
});

function chargingHouse() {
  const snapshot = dispatchedEvSnapshot();
  snapshot.slots = snapshot.slots.slice(0, 8).map((slot, i) => ({...slot, pv_forecast_w: 0, base_load_forecast_w: 500, import_price_sek_per_kwh: i < 4 ? .1 : 1.5}));
  snapshot.captured_at = snapshot.slots[0].start;
  snapshot.ev_battery!.soc = .48;
  snapshot.battery = {capacity_kwh: 18.08, soc: .5, min_soc: .05, max_soc: 1,
    charge_max_w: 8800, discharge_max_w: 9600, charge_efficiency: .95, discharge_efficiency: .95};
  snapshot.capabilities.battery = true;
  const plan = runRulesPlanner(input(snapshot)).plan;
  const slots = plan.plans.priority.slots.map((slot, i): PlannedSlot => ({...slot,
    ev_target_current_a: i === 0 ? 6 : 0, ev_min_current_a: 0, ev_max_current_a: 16,
    battery_command: {schema_version: 3, operation: "grid_charge", charge_limit_w: 1000, discharge_limit_w: 0,
      allow_grid_charge: true, allow_battery_export: false},
    device_commands: Object.fromEntries(Object.entries(slot.device_commands ?? {}).map(([key, c]) => [key,
      c.type === "variable_power" ? {...c, value: i === 0 ? 6 : 0} : c])),
  }));
  return {snapshot, reference: {plan_id: plan.plan_id, slots}};
}

Deno.test("forced absence moves EV charging into held OFF destinations while battery requests remain exact", () => {
  const {snapshot, reference} = chargingHouse();
  snapshot.ev_battery!.connected = false;
  const result = runRulesPlanner(input(snapshot, request(reference, snapshot, [change("$ev", snapshot, "temporarily_absent")])), reference).plan;
  assertEquals(result.plans.priority.slots[0].ev_target_current_a, 0);
  assert(result.plans.priority.slots.slice(1, 4).some(slot => slot.ev_target_current_a > 0));
  for (let i = 0; i < 4; i++) assertEquals(result.plans.priority.slots[i].battery_command, reference.slots[i].battery_command);
  assert(result.plans.priority.slots.every(slot => !slot.ev_connected));
  assertEquals(result.execution_replan!.request_id, requestId);
  assert(result.execution_replan!.released_intervals.every(interval => interval.owner === "$ev"));
});

Deno.test("faulted battery remains modelled without projected charging, while held EV requests stay exact", () => {
  const {snapshot, reference} = chargingHouse();
  const result = runRulesPlanner(input(snapshot, request(reference, snapshot, [change("$battery", snapshot)])), reference).plan;
  assert(result.battery, "the unresolved objective must retain its measured battery state");
  assert(result.plans.priority.slots.every(slot => slot.battery_charge_w === 0 && slot.battery_discharge_w === 0));
  for (let i = 0; i < 4; i++) assertEquals(result.plans.priority.slots[i].ev_target_current_a, reference.slots[i].ev_target_current_a);
  assert(result.planning_warnings!.some(warning => warning.code === "execution_unavailable"));
});

Deno.test("a delayed absence capture still releases EV destinations after its missed source quarter", () => {
  const {snapshot, reference} = chargingHouse();
  const missed = change("$ev", snapshot, "temporarily_absent");
  snapshot.captured_at = new Date(Date.parse(snapshot.captured_at) + 16 * 60_000).toISOString();
  snapshot.ev_battery!.connected = false;
  const result = runRulesPlanner(input(snapshot, request(reference, snapshot, [missed])), reference).plan;
  assert(result.plans.priority.slots.slice(0, 3).some(slot => slot.ev_target_current_a > 0));
  for (let i = 0; i < 5; i++) assertEquals(result.plans.priority.slots[i].battery_command, reference.slots[i + 1].battery_command);
  assert(result.execution_replan!.released_intervals.every(interval => interval.owner === "$ev"));
});

for (const native of [false, true]) Deno.test(`a scoped ${native ? "native" : "empirical"} pool failure preserves unrelated held battery and pump draw`, () => {
  const snapshot = native ? rulesFixtureInput(mixedModeSnapshot()).snapshot : mixedModeSnapshot();
  snapshot.operating_scope!.modes.$pool = "controlling";
  delete snapshot.operating_scope!.external_demands.pool_heater;
  const plan = runRulesPlanner(input(snapshot)).plan;
  const reference = {plan_id: plan.plan_id, slots: plan.plans.priority.slots};
  const result = runRulesPlanner(input(snapshot, request(reference, snapshot, [change("$pool", snapshot)])), reference).plan;
  assert(result.plans.priority.slots.every(slot => !slot.pool_permitted));
  for (let i = 0; i < 5; i++) {
    assertEquals(result.plans.priority.slots[i].battery_command, reference.slots[i].battery_command);
    assertEquals(result.plans.priority.slots[i].device_commands!.pool_pump, reference.slots[i].device_commands!.pool_pump);
    assertEquals(result.plans.priority.slots[i].device_loads_w.pool_pump, reference.slots[i].device_loads_w.pool_pump);
  }
  assert(result.plans.priority.slots[0].device_loads_w.pool_heater > 0, "an unavailable actuator is not evidence that measured demand stopped");
});

Deno.test("generic room faults preserve other held commands and avoid invented thermal delivery", () => {
  const snapshot = commandSnapshot();
  const plan = runRulesPlanner(input(snapshot)).plan;
  const reference = {plan_id: plan.plan_id, slots: plan.plans.priority.slots};
  const result = runRulesPlanner(input(snapshot, request(reference, snapshot, [change("relay", snapshot)])), reference).plan;
  for (let i = 0; i < 4; i++) {
    assertEquals(result.plans.priority.slots[i].device_commands!.thermostat, reference.slots[i].device_commands!.thermostat);
    assertEquals(result.plans.priority.slots[i].device_commands!.relay.type, "unavailable");
  }
  assert(!result.thermal_projection, "unconfirmed heat cannot yield a claimed room temperature trajectory");
});

Deno.test("retries keep the same partial-quarter hold and unrelated OFF requests", () => {
  const {snapshot, reference} = chargingHouse();
  snapshot.captured_at = new Date(Date.parse(snapshot.captured_at) + 7 * 60_000).toISOString();
  snapshot.ev_battery!.connected = false;
  const forced = input(snapshot, request(reference, snapshot, [change("$ev", snapshot, "temporarily_absent")]));
  const first = runRulesPlanner(forced, reference).plan;
  const retry = runRulesPlanner({...forced, now: end(snapshot.captured_at)}, reference).plan;
  assertEquals(first.plans.priority.slots, retry.plans.priority.slots);
  for (let i = 0; i < 5; i++) assertEquals(first.plans.priority.slots[i].battery_command, reference.slots[i].battery_command);
});

Deno.test("an unrelated commitment conflict cannot become a global unlock", () => {
  const {snapshot, reference} = chargingHouse();
  snapshot.grid.import_limit_w = 100;
  snapshot.ev_battery!.connected = false;
  assertThrows(() => runRulesPlanner(input(snapshot, request(reference, snapshot, [change("$ev", snapshot, "temporarily_absent")])), reference), Error, "Previously accepted commands");
});

Deno.test("a stale execution reference cannot release a different accepted plan", () => {
  const {snapshot, reference} = chargingHouse();
  const stale = {...request(reference, snapshot, [change("$battery", snapshot)]), accepted_plan_id: requestId};
  assertThrows(() => runRulesPlanner(input(snapshot, stale), reference), Error, "must name the retained accepted plan");
});

Deno.test("a failed boiler retains the outstanding service and reports unmet heating opportunities", () => {
  const snapshot = commandSnapshot();
  snapshot.thermal_zones = [];
  snapshot.capabilities.boiler = true;
  snapshot.device_models = [{key: "water", name: "Water", statistic_id: "sensor.water", category: "hot_water",
    load_type: "duty_cycle", suggested_load_type: "duty_cycle", planning_role: "controllable",
    control_type: "permit_inhibit", active_power_w: 2000, profile_sample_count: 100,
    forecast_w_by_slot: snapshot.slots.map(() => 500)}];
  snapshot.services = [{id: "water", device: "boiler", priority: 1, required_kwh: 1,
    earliest_start: snapshot.slots[0].start, deadline: end(snapshot.slots.at(-1)!.start),
    control: {type: "duty_cycle", rated_power_w: 2000, expected_power_w_by_slot: snapshot.slots.map(() => 500)}}];
  const original = runRulesPlanner(input(snapshot)).plan;
  const reference = {plan_id: original.plan_id, slots: original.plans.priority.slots};
  const blocked = runRulesPlanner(input(snapshot, request(reference, snapshot, [change("water", snapshot)])), reference).plan;
  assertEquals(blocked.services, snapshot.services);
  assert(blocked.capabilities.boiler);
  assert(blocked.plans.priority.slots.every(slot => !slot.boiler_permitted && slot.boiler_expected_w === 0));
  assert(blocked.plans.priority.slots.every(slot => slot.device_loads_w.water === 500));
  assert(Object.values(blocked.hot_water_shortfall_minutes!).some(minutes => minutes > 0));
});

Deno.test("unresolved faults are retained on an ordinary later capture until explicit recovery", () => {
  const {snapshot, reference} = chargingHouse();
  snapshot.slots = snapshot.slots.map(slot => ({...slot, import_price_sek_per_kwh: -.2, export_price_sek_per_kwh: -.3}));
  snapshot.execution_availability = [change("$battery", snapshot)];
  const blocked = runRulesPlanner(input(snapshot), reference).plan;
  assert(blocked.plans.priority.slots.every(slot => slot.battery_charge_w === 0));
  const recovered = change("$battery", snapshot, "recovered");
  const next = {plan_id: blocked.plan_id, slots: blocked.plans.priority.slots};
  const resumed = runRulesPlanner(input(snapshot, request(next, snapshot, [recovered])), next).plan;
  assertEquals(resumed.execution_availability, []);
  assert(resumed.plans.priority.slots.some(slot => slot.battery_charge_w > 0));
});
