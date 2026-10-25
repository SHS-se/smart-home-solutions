import { assert, assertEquals, assertThrows } from "@std/assert";
import { mixedModeSnapshot, rulesFixtureInput } from "../../../scripts/generate-ha-plan-fixture.ts";
import { compileCommitments, assertHeldCommands } from "./rules-commitments.ts";
import { runRulesPlanner } from "./run-rules-planner.ts";
import type { PublishedCommandReference } from "./rules-planner.ts";
import { poolElectricalDemand } from "./planner/models/pool/electrical.ts";

// Synthetic command reservations constructed from the public generator.
function house() {
  const snapshot = rulesFixtureInput(mixedModeSnapshot()).snapshot;
  snapshot.operating_scope!.modes.$pool = "controlling";
  delete snapshot.operating_scope!.external_demands.pool_heater;
  const input = { snapshot, now: snapshot.captured_at, price_archive: [] };
  const plan = runRulesPlanner(input).plan;
  const demand = poolElectricalDemand(snapshot);
  const slots = plan.plans.priority.slots.map((s, i) => ({ ...s,
    pool_permitted: i !== 1, pool_command_w: i !== 1 ? demand.compressor_w + demand.auxiliary_w : 0,
    pool_w: i !== 1 ? 1000 : 0,
    device_loads_w: { ...s.device_loads_w, pool_heater: i !== 1 ? 300 : 0, pool_pump: 700 },
  }));
  const reference: PublishedCommandReference = { plan_id: plan.plan_id, pool_planning_basis: "empirical", slots };
  return { snapshot, reference, demand, input, slots };
}
Deno.test("corrected empirical reservation releases only affected pool-ON intervals and owned members", () => {
  const { snapshot, reference, slots } = house();
  const c = compileCommitments(snapshot, reference, null);
  assertEquals(c.released[0], { pool: true, ev: false, battery: false });
  assertEquals(c.released[1], { pool: false, ev: false, battery: false });
  assertEquals(c.retained[0].pool_command_w, undefined);
  assertEquals(c.retained[1].pool_command_w, 0);
  assertEquals(c.retained[0].device_commands!.pool_pump, reference.slots[0].device_commands!.pool_pump);
  assertEquals(c.retained[0].device_loads_w!.pool_pump, 700);
  assertEquals(c.retained[0].battery_command, reference.slots[0].battery_command);
  assertEquals(c.retained[0].ev_target_current_a, reference.slots[0].ev_target_current_a);
  assertEquals(c.warnings[0].code, "pool_commitment_power_corrected");
  // Publication may change released ON work, never another pool interval.
  const actual = structuredClone(slots);
  actual[0].pool_command_w = 0;
  assertHeldCommands(snapshot, c.original, c.owners_by_slot, actual);
  actual[1].pool_command_w = 1;
  assertThrows(() => assertHeldCommands(snapshot, c.original, c.owners_by_slot, actual), Error, "Held $pool");
});
Deno.test("unchanged full empirical reservations and unknown provenance grant no release", () => {
  const { snapshot, reference, demand } = house();
  reference.slots.forEach((s, i) => { s.device_loads_w!.pool_heater = i === 1 ? 0 : demand.member_w.pool_heater; });
  assert(compileCommitments(snapshot, reference, null).released.every(m => !m.pool));
  delete reference.pool_planning_basis;
  reference.slots[0].device_loads_w!.pool_heater = 1;
  assert(compileCommitments(snapshot, reference, null).released.every(m => !m.pool));
});
Deno.test("normal thermal startup draw and independent pump rating increases do not release pool holds", () => {
  const { snapshot, reference } = house();
  reference.pool_planning_basis = "thermal";
  assert(compileCommitments(snapshot, reference, null).released.every(m => !m.pool));
  reference.pool_planning_basis = "empirical";
  const demand = poolElectricalDemand(snapshot);
  reference.slots.forEach((s, i) => {s.device_loads_w!.pool_heater = i === 1 ? 0 : demand.member_w.pool_heater;});
  snapshot.device_models.find(m => m.key === "pool_pump")!.active_power_w! += 500;
  assert(compileCommitments(snapshot, reference, null).released.every(m => !m.pool));
});
Deno.test("native replacement can move an under-reserved pool while unrelated held battery stays exact", () => {
  const { snapshot, reference, input, slots } = house();
  snapshot.grid.import_limit_w = 2000;
  snapshot.slots = snapshot.slots.map(s => ({...s, base_load_forecast_w: 1000, pv_forecast_w: 0}));
  reference.slots.forEach(s => {s.battery_command = {schema_version:3,operation:"idle",charge_limit_w:0,
    discharge_limit_w:0,allow_grid_charge:false,allow_battery_export:false};});
  const withoutBasis = {...reference}; delete withoutBasis.pool_planning_basis;
  assertThrows(() => runRulesPlanner(input, withoutBasis), Error, "Previously accepted commands");
  const plan = runRulesPlanner(input, reference).plan;
  assertEquals(plan.status, "ready");
  const booked = {id:"synthetic-reviewed",source_snapshot_id:snapshot.snapshot_id,
    starts_at:reference.slots[0].start, ends_at:new Date(Date.parse(reference.slots[0].start)+900000).toISOString(),
    slots:[{start:reference.slots[0].start,targets:slots[0],power_w:{},discharge_w:{},allow_export:false}]};
  assertThrows(() => runRulesPlanner({...input,fixed_plan:booked},reference));
  for (const [i, slot] of plan.plans.priority.slots.slice(0,5).entries()) {
    assertEquals(slot.battery_command, reference.slots[i].battery_command);
    assertEquals(slot.ev_target_current_a, reference.slots[i].ev_target_current_a);
    assert(slot.grid_import_w <= snapshot.grid.import_limit_w + 1e-6);
  }
});
