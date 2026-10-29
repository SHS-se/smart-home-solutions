import { assert, assertEquals, assertThrows } from "@std/assert";
import { dispatchedEvSnapshot, mixedModeSnapshot, rulesFixtureInput } from "../../../scripts/generate-ha-plan-fixture.ts";
import { commandSnapshot } from "../../../scripts/generate-ha-device-plan-fixture.ts";
import { runRulesPlanner } from "./run-rules-planner.ts";
import { prepareRulesPlanningInput, type PublishedCommandReference } from "./rules-planner.ts";
import { resolveRulePolicy } from "./planner-wasm/rule-policy.ts";
import { ownerLabel } from "./rules-commitments.ts";
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
  assertEquals(result.planning_warnings!.find(warning => warning.code === "execution_unavailable")?.message,
    "Battery: scheduled work could not execute (actuator_unavailable).");
});

Deno.test("execution notes name the device that could not execute", () => {
  const snapshot = mixedModeSnapshot();
  assertEquals(ownerLabel(snapshot, "$battery"), "Battery");
  assertEquals(ownerLabel(snapshot, "$pool"), "Pool");
  assertEquals(ownerLabel({...snapshot, ev_battery: null}, "$ev"), "EV charging");
  assertEquals(ownerLabel(dispatchedEvSnapshot(), "$ev"), dispatchedEvSnapshot().ev_battery!.name);
  const model = snapshot.device_models.find(m => m.key === "pool_pump")!;
  assertEquals(ownerLabel({...snapshot, device_models: [{...model, name: "Pool pump"}]}, "pool_pump"), "Pool pump");
  assertEquals(ownerLabel(snapshot, "sensor.removed_device"), "sensor.removed_device");
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

// Synthetic outage and recovery; no household captures are used.
Deno.test("an observation outage can publish without a battery and recover through other device events", () => {
  const {snapshot, reference} = chargingHouse();
  snapshot.device_models.push({key: "relay", name: "Relay", statistic_id: "sensor.synthetic_relay",
    category: "other", load_type: "fixed_full_load", suggested_load_type: "fixed_full_load",
    planning_role: "controllable", control_type: "switch_schedule", active_power_w: 100,
    profile_sample_count: 100, forecast_w_by_slot: snapshot.slots.map(() => 100)});
  for (const slot of reference.slots) slot.device_commands!.relay = {type: "switch_schedule", on_seconds: 900};
  const batteryFault = change("$battery", snapshot);
  const relayFault = change("relay", snapshot);
  snapshot.measurement_issues = [{device: "battery", field: "soc", entity_id: "sensor.synthetic_battery",
    value: "unavailable", reason: "Synthetic network outage", detected_by: "home_assistant"}];
  const outage = runRulesPlanner(input(snapshot, request(reference, snapshot, [batteryFault, relayFault])), reference).plan;
  assertEquals(outage.capabilities.battery, false);
  assert(outage.plans.priority.slots.every(slot => slot.battery_command === null));

  // Readings return while the battery's execution fault is still unresolved.
  snapshot.measurement_issues = [];
  snapshot.execution_availability = [batteryFault, relayFault];
  const outageReference = {plan_id: outage.plan_id, slots: outage.plans.priority.slots};
  const partial = runRulesPlanner(input(snapshot, request(outageReference, snapshot,
    [change("relay", snapshot, "recovered")])), outageReference).plan;
  assertEquals(partial.status, "ready");
  assert(partial.battery);
  assert(partial.plans.priority.slots.every(slot => slot.battery_charge_w === 0 && slot.battery_discharge_w === 0));
  assertEquals(partial.execution_availability, [batteryFault]);

  // The same outage plan also supports direct battery recovery, without a manual reset.
  snapshot.slots = snapshot.slots.map(slot => ({...slot, import_price_sek_per_kwh: -.2, export_price_sek_per_kwh: -.3}));
  const recovered = runRulesPlanner(input(snapshot, request(outageReference, snapshot,
    [change("$battery", snapshot, "recovered")])), outageReference).plan;
  assertEquals(recovered.status, "ready");
  assert(recovered.plans.priority.slots.some(slot => slot.battery_charge_w > 0));
  assertEquals(recovered.execution_availability, [relayFault]);
  for (const plan of [outage, partial, recovered]) for (let i = 0; i < 4; i++) {
    assertEquals(plan.plans.priority.slots[i].ev_target_current_a, reference.slots[i].ev_target_current_a);
  }
});

for (const owner of ["$battery", "$pool", "$ev"] as const) {
  Deno.test(`released ${owner} commands may be absent while unaffected native commitments remain held`, () => {
    const snapshot = rulesFixtureInput(mixedModeSnapshot()).snapshot;
    snapshot.operating_scope!.modes.$pool = "controlling";
    delete snapshot.operating_scope!.external_demands.pool_heater;
    const ev = dispatchedEvSnapshot();
    snapshot.capabilities.ev = true;
    snapshot.ev_battery = ev.ev_battery;
    snapshot.comfort!.ev = ev.comfort!.ev;
    snapshot.services.push(...ev.services);
    snapshot.operating_scope!.modes.$ev = "controlling";
    const previous = runRulesPlanner(input(snapshot)).plan;
    const reference = {plan_id: previous.plan_id, slots: structuredClone(previous.plans.priority.slots)};
    const nativeOwner = owner.slice(1) as "battery" | "pool" | "ev";
    for (const slot of reference.slots) {
      if (owner === "$battery") { slot.battery_command = null; delete slot.battery_instruction; }
      if (owner === "$pool") { slot.pool_permitted = true; delete slot.pool_command_w; }
      if (owner === "$ev") delete slot.ev_target_current_a;
    }
    // Missing commands remain errors when their owner has not been released.
    assertThrows(() => prepareRulesPlanningInput(input(snapshot), reference, resolveRulePolicy()), Error, "command missing");
    const prepared = prepareRulesPlanningInput(input(snapshot, request(reference, snapshot,
      [change(owner, snapshot, "recovered")])), reference, resolveRulePolicy());
    assert(prepared.problem.released!.every(mask => mask[nativeOwner]));
    for (const mask of prepared.problem.released!) {
      for (const other of ["battery", "pool", "ev"] as const) if (other !== nativeOwner) assertEquals(mask[other], false);
    }
    const plan = runRulesPlanner(input(snapshot, request(reference, snapshot,
      [change(owner, snapshot, "recovered")])), reference).plan;
    assertEquals(plan.status, "ready");
    for (let i = 0; i < prepared.held_reference.length; i++) {
      const actual = plan.plans.priority.slots[i], old = reference.slots[i];
      if (owner !== "$battery") assertEquals(actual.battery_command, old.battery_command);
      if (owner !== "$ev") assertEquals(actual.ev_target_current_a, old.ev_target_current_a);
      if (owner !== "$pool") assertEquals(actual.pool_command_w, old.pool_command_w);
    }
    const booking = {id: "synthetic-booking", source_snapshot_id: snapshot.snapshot_id,
      starts_at: reference.slots[0].start, ends_at: end(reference.slots[0].start),
      slots: [{start: reference.slots[0].start, targets: reference.slots[0], power_w: {}, discharge_w: {}, allow_export: false}]};
    assertThrows(() => prepareRulesPlanningInput({...input(snapshot, request(reference, snapshot,
      [change(owner, snapshot, "recovered")])), fixed_plan: booking}, reference, resolveRulePolicy()), Error, "command missing");
  });
}

Deno.test('pool forecast deviation corrects only that owner and keeps its healthy heater available', () => {
  const snapshot = rulesFixtureInput(mixedModeSnapshot()).snapshot;
  snapshot.operating_scope!.modes.$pool = 'controlling';
  delete snapshot.operating_scope!.external_demands.pool_heater;
  snapshot.pool!.water_temperature_c = 25;
  const original = runRulesPlanner(input(snapshot)).plan;
  const reference = {plan_id:original.plan_id,slots:original.plans.priority.slots};
  const deviation: ExecutionChange = {owner:'$pool',status:'plan_deviation',cause:'pool_temperature_shortfall',
    magnitude:.5,persistence_ms:1_800_000,affected_intervals:[{start:snapshot.slots[0].start,end:end(snapshot.slots[0].start)}]};
  const corrected = runRulesPlanner(input(snapshot,request(reference,snapshot,[deviation])),reference).plan;
  assertEquals(corrected.execution_availability, []);
  assert(corrected.plans.priority.slots.some(slot => slot.pool_permitted));
  for(let i=0;i<4;i++) assertEquals(corrected.plans.priority.slots[i].battery_command,reference.slots[i].battery_command);
  assert(corrected.execution_replan!.released_intervals.every(interval=>interval.owner==='$pool'));
});
