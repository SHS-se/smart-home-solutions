import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { commandSnapshot } from "../../../scripts/generate-ha-device-plan-fixture.ts";
import { hotWaterSnapshot, rulesFixtureInput, dispatchedEvSnapshot } from "../../../scripts/generate-ha-plan-fixture.ts";
import { runRulesPlanner } from "./run-rules-planner.ts";
import type { FixedEnergyPlan, OptimisationSnapshot, PlannedSlot } from "./planner/planning-contracts.ts";
function input(s: OptimisationSnapshot) { const p = rulesFixtureInput(s); return { snapshot:p.snapshot, now:p.now, price_archive:[], resolved_price_outlook:p.price_outlook }; }
function booking(slots: PlannedSlot[]): FixedEnergyPlan { return { id:"reviewed", starts_at:slots[0].start,
  ends_at:new Date(Date.parse(slots.at(-1)!.start)+900000).toISOString(), source_snapshot_id:"reviewed", slots: slots.map(targets => ({start:targets.start,
    targets, power_w:{}, discharge_w:{}, allow_export:false})) }; }
Deno.test("native bookings retain manually reviewed EV current beyond the next hour", () => {
  const p = input(dispatchedEvSnapshot()); const source = runRulesPlanner(p).plan;
  const slot = structuredClone(source.plans.priority.slots[6]); slot.ev_target_current_a=10;
  const plan=runRulesPlanner({...p, fixed_plan:booking([slot])}).plan;
  assertEquals(plan.plans.priority.slots[6].ev_target_current_a,10);
  assert(plan.plans.priority.slots[6].ev_w > 0);
});
Deno.test("native bookings retain exact room relay and thermostat commands", () => {
  const p=input(commandSnapshot()); const source=runRulesPlanner(p).plan;
  const slots=structuredClone(source.plans.priority.slots); slots[6].device_commands!.relay={type:"switch_schedule",on_seconds:900};
  slots[6].device_commands!.thermostat={type:"setpoint",target_c:22,minimum_c:20,maximum_c:24};
  slots[6].device_loads_w.relay=1000; slots[6].device_loads_w.thermostat=500;
  const plan=runRulesPlanner({...p,fixed_plan:booking([slots[6]])}).plan;
  assertEquals(plan.plans.priority.slots[6].device_commands,slots[6].device_commands);
  assertEquals(plan.plans.priority.slots[6].device_loads_w.relay, 1000);
  // The reviewed command remains exact; its stale 500 W prediction is not a physical constraint.
  assertAlmostEquals(plan.plans.priority.slots[6].device_loads_w.thermostat, 1000);
});
Deno.test("native bookings preserve hot-water permission and expected draw", () => {
  const p=input(hotWaterSnapshot()); const source=runRulesPlanner(p).plan;
  const slot=structuredClone(source.plans.priority.slots[6]); slot.boiler_permitted=true;slot.boiler_expected_w=500;
  slot.device_commands!.water={type:"permit_inhibit",permitted:true};
  const plan=runRulesPlanner({...p,fixed_plan:booking([slot])}).plan;
  assertEquals(plan.plans.priority.slots[6].boiler_permitted,true);
  assertEquals(plan.plans.priority.slots[6].boiler_expected_w,500);
});
Deno.test("native fixed bookings use absolute timestamps in a rolling horizon", () => {
  const p=input(dispatchedEvSnapshot());const source=runRulesPlanner(p).plan;
  const slot=structuredClone(source.plans.priority.slots[6]);slot.ev_target_current_a=10;
  p.snapshot.captured_at=p.snapshot.slots[2].start;
  const plan=runRulesPlanner({...p,fixed_plan:booking([slot])}).plan;
  assertEquals(plan.plans.priority.slots[4].start,slot.start);
  assertEquals(plan.plans.priority.slots[4].ev_target_current_a,10);
});
