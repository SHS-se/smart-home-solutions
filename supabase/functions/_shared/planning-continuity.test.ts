/** Independently constructed synthetic inputs; no household captures. */
import { assert, assertEquals, assertThrows } from '@std/assert';
import { dispatchedEvSnapshot, rulesFixtureInput } from '../../../scripts/generate-ha-plan-fixture.ts';
import { syntheticIdentityConversion } from './planner/battery-physics.fixture.ts';
import { runRulesPlanner } from './run-rules-planner.ts';
import type { OptimisationSnapshot } from './planner/planning-contracts.ts';
import type { PublishedCommandReference } from './rules-planner.ts';

function household(soc = .99) {
  const snapshot = dispatchedEvSnapshot();
  snapshot.slots = snapshot.slots.slice(0, 8).map(s => ({...s, pv_forecast_w: 0,
    base_load_forecast_w: 500, import_price_sek_per_kwh: .1}));
  snapshot.captured_at = snapshot.slots[0].start;
  snapshot.battery = {capacity_kwh: 10, soc, min_soc: .05, max_soc: 1,
    charge_max_w: 8000, discharge_max_w: 8000, charge_efficiency: .95,
    discharge_efficiency: .95, conversion: syntheticIdentityConversion()};
  snapshot.capabilities.battery = true;
  return snapshot;
}
function input(snapshot: OptimisationSnapshot) {
  return {snapshot, now: snapshot.captured_at, price_archive: [],
    resolved_price_outlook: {...rulesFixtureInput(snapshot).price_outlook,
      shadow_import_sek_per_kwh: snapshot.slots.map(() => .1)}};
}
function accepted(snapshot: OptimisationSnapshot, operation: 'grid_charge' | 'export' = 'grid_charge'): PublishedCommandReference {
  const plan = runRulesPlanner(input(snapshot)).plan;
  return {plan_id: plan.plan_id, slots: plan.plans.priority.slots.map(slot => ({...slot,
    battery_command: {schema_version: 3, operation, charge_limit_w: operation === 'grid_charge' ? 1000 : 0,
      discharge_limit_w: operation === 'export' ? 1000 : 0, allow_grid_charge: operation === 'grid_charge',
      allow_battery_export: operation === 'export'}}))};
}

for (const operation of ['grid_charge', 'export'] as const) Deno.test(`unachievable retained battery ${operation} is corrected without stopping the home`, () => {
  const snapshot = household(operation === 'grid_charge' ? .99 : .05);
  snapshot.policy.battery_export_enabled = true;
  snapshot.policy.battery_export_reserve_soc = .05;
  snapshot.policy.battery_export_min_price_sek_per_kwh = 0;
  const reference = accepted(snapshot, operation), before = structuredClone(reference);
  const result = runRulesPlanner(input(snapshot), reference).plan;
  assertEquals(result.status, 'ready');
  assertEquals(reference, before);
  assert(result.planning_warnings?.some(w => w.code === 'battery_commitment_rescheduled'));
  for (let i = 0; i < 4; i++) {
    const slot = result.plans.priority.slots[i];
    assertEquals(slot.ev_target_current_a, reference.slots[i].ev_target_current_a);
    assertEquals(slot.pool_permitted, reference.slots[i].pool_permitted);
    assertEquals(slot.device_commands, reference.slots[i].device_commands);
    assert(slot.grid_import_w <= snapshot.grid.import_limit_w + 1e-6);
    assert(slot.battery_soc >= snapshot.battery!.min_soc - 1e-6 && slot.battery_soc <= 1);
  }
});

Deno.test('positive EV capacity keeps charging and only constrains its observed quarter', () => {
  const snapshot = household(.5);
  snapshot.ev_battery!.soc = .1;
  const reference = accepted(snapshot);
  for (const slot of reference.slots) {
    slot.ev_target_current_a = 16;
    slot.battery_command = {schema_version: 3, operation: 'idle', charge_limit_w: 0,
      discharge_limit_w: 0, allow_grid_charge: false, allow_battery_export: false};
    for (const c of Object.values(slot.device_commands ?? {})) if (c.type === 'variable_power') c.value = 16;
  }
  snapshot.execution_availability = [{owner: '$ev', status: 'capacity_limited', cause: 'house_import_capacity',
    maximum_current_a: 13, blocked_intervals: [{start: snapshot.slots[0].start,
      end: new Date(Date.parse(snapshot.slots[0].start) + 900000).toISOString()}]}];
  const plan = runRulesPlanner(input(snapshot), reference).plan;
  const slots = plan.plans.priority.slots;
  assert(slots[0].ev_target_current_a > 0 && slots[0].ev_target_current_a <= 13);
  assert(slots.slice(1, 4).some(s => s.ev_target_current_a > 13));
  for (let i = 0; i < 4; i++) assertEquals(slots[i].battery_command, reference.slots[i].battery_command);
  assert(plan.planning_warnings?.some(w => w.code === 'execution_capacity_limited'));
});

Deno.test('a battery correction cannot unlock an unrelated import conflict', () => {
  const snapshot = household(), reference = accepted(snapshot);
  snapshot.grid.import_limit_w = 100;
  reference.slots[0].ev_target_current_a = 16;
  assertThrows(() => runRulesPlanner(input(snapshot), reference), Error, 'Previously accepted commands');
});

for (const device of ['battery', 'ev'] as const) Deno.test(`an unavailable ${device} reading isolates its retained commands without stopping other planning`, () => {
  const snapshot = household(.5);
  snapshot.ev_battery!.soc = .1;
  const reference = accepted(snapshot);
  assert(reference.slots.some(slot => slot.ev_target_current_a > 0));
  snapshot.measurement_issues = [{device, field: 'soc', entity_id: `sensor.synthetic_${device}`,
    value: 'unavailable', reason: 'Synthetic source outage', detected_by: 'home_assistant'}];
  const plan = runRulesPlanner(input(snapshot), reference).plan;
  assertEquals(plan.status, 'ready');
  assertEquals(plan.capabilities[device], false);
  for (let i = 0; i < 4; i++) {
    if (device === 'battery') assertEquals(plan.plans.priority.slots[i].ev_target_current_a, reference.slots[i].ev_target_current_a);
    else assertEquals(plan.plans.priority.slots[i].battery_command, reference.slots[i].battery_command);
  }
});

Deno.test('an explicit battery booking is never rewritten by retained-request recovery', () => {
  const snapshot = household(), reference = accepted(snapshot);
  const original = runRulesPlanner(input(snapshot)).plan;
  const target = {...original.plans.priority.slots[0], battery_command: reference.slots[0].battery_command};
  const start = target.start, end = new Date(Date.parse(start) + 900000).toISOString();
  const booked = {...input(snapshot), fixed_plan: {id: 'synthetic-booking', starts_at: start, ends_at: end,
    source_snapshot_id: snapshot.snapshot_id, slots: [{start, targets: target, power_w: {}, discharge_w: {}, allow_export: false}]}};
  assertThrows(() => runRulesPlanner(booked, reference), Error, 'native_battery_power_limit');
});

Deno.test('a retained battery purchase that alone exceeds headroom is rescheduled with native attribution', () => {
  const snapshot = household(.5), reference = accepted(snapshot);
  snapshot.grid.import_limit_w = 750;
  const result = runRulesPlanner(input(snapshot), reference).plan;
  assertEquals(result.status, 'ready');
  assert(result.planning_warnings?.some(w => w.code === 'battery_commitment_rescheduled'));
  for (let i = 0; i < 4; i++) {
    assertEquals(result.plans.priority.slots[i].ev_target_current_a, reference.slots[i].ev_target_current_a);
    assert(result.plans.priority.slots[i].grid_import_w <= 750 + 1e-6);
  }
});

Deno.test('a 17 W import forecast change trims one held charge without reopening the hour', () => {
  const snapshot = household(.5), reference = accepted(snapshot);
  snapshot.grid.import_limit_w = 15_000;
  snapshot.slots[1].base_load_forecast_w = 14_017;
  for (const slot of reference.slots) slot.ev_target_current_a = 0;
  const prior = structuredClone(reference);

  const plan = runRulesPlanner(input(snapshot), reference).plan;
  const slots = plan.plans.priority.slots;
  assertEquals(reference, prior);
  assertEquals(slots[1].battery_command?.charge_limit_w, 983);
  assertEquals(slots[1].grid_import_w, 15_000);
  for (const i of [0, 2, 3]) assertEquals(slots[i].battery_command, reference.slots[i].battery_command);
  assert(plan.planning_warnings?.some(w => w.code === 'battery_commitment_resized'));
  assert(!plan.planning_warnings?.some(w => w.code === 'battery_commitment_rescheduled'));
});
