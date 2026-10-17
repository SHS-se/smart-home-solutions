import { assert, assertEquals, assertThrows } from "@std/assert";
import { commandSnapshot } from "../../../scripts/generate-ha-device-plan-fixture.ts";
import { mixedModeSnapshot, rulesFixtureInput, batterySnapshot } from "../../../scripts/generate-ha-plan-fixture.ts";
import { generateRulesPlan } from "./rules-planner.ts";
import { runRulesPlanner } from "./run-rules-planner.ts";
import { prepareRoomServices } from "./rules-room-services.ts";
import { mergePlanningWarnings } from "./planner/planning-warnings.ts";
import type { OptimisationSnapshot } from "./planner/planning-contracts.ts";
function input(source: OptimisationSnapshot) { const p=rulesFixtureInput(source); return {snapshot:p.snapshot,now:p.now,price_archive:[],resolved_price_outlook:p.price_outlook}; }
Deno.test("a room with no fitted model still receives comfort commands and an honest warning",()=>{
 const s=commandSnapshot();s.thermal_zones![0].model=null;s.thermal_zones![0].start_temperature_c=10;
 const plan=runRulesPlanner(input(s)).plan;
 assertEquals(plan.status,"ready");assert(plan.planning_warnings!.some(w=>w.code==="room_estimate"));
 for(const slot of plan.plans.priority.slots){assertEquals(slot.device_commands!.thermostat.type,"setpoint");assertEquals(slot.device_commands!.relay.type,"switch_schedule");}
 assertEquals(plan.plans.priority.slots[0].device_loads_w.relay,1000);
});
Deno.test("unattainable room comfort and thin evidence never discard the household schedule",()=>{
 const s=commandSnapshot();s.thermal_zones![0].start_temperature_c=1;
 const plan=runRulesPlanner(input(s)).plan;
 assertEquals(plan.plans.priority.slots.length,s.slots.length);
 assert(plan.planning_warnings!.some(w=>w.code==="comfort_shortfall"));
});
Deno.test("prepared room relays respect the shared household headroom",()=>{
 const s=commandSnapshot();const z=s.thermal_zones![0];z.start_temperature_c=1;
 s.device_models=s.device_models.map(m=>({...m,active_power_w:6000,control_type:"switch_schedule"}));
 z.rated_power_w=12000;z.maximum_power_w_by_slot.fill(12000);
 const rooms=prepareRoomServices(s,[],s.slots.map(()=>9000));
 assert(rooms.room_power.room.every(w=>w<=9000));
 assert(rooms.power.relay.every(w=>w===0||w===6000));
});
Deno.test("malformed optional pool physics becomes empirical service rather than a household rejection",()=>{
 const p=input(mixedModeSnapshot());p.snapshot.device_physics!.pool!.store.capacity_kwh_per_c=-1;
 delete p.snapshot.pool_model;
 const plan=runRulesPlanner(p).plan;
 assertEquals(plan.status,"ready");assertEquals(plan.pool!.planning_basis,"empirical");
 assert(plan.planning_warnings!.some(w=>w.code==="pool_physics_evidence"));
 assert(plan.plans.priority.slots.some(s=>s.pool_permitted));
});
Deno.test("usable pool physics can allocate missing member ratings from the same physical service",()=>{
 const p=input(mixedModeSnapshot());for(const m of p.snapshot.device_models){m.active_power_w=null;m.forecast_w_by_slot.fill(0);}
 const plan=runRulesPlanner(p).plan;assertEquals(plan.status,"ready");
 for(const slot of plan.plans.priority.slots) assert(Object.values(slot.device_loads_w).every(Number.isFinite));
});
Deno.test("an expired reference cannot prevent the next plan from recovering",()=>{
 const p=input(commandSnapshot());const previous=runRulesPlanner(p).plan;
 const day=86400000;p.snapshot.slots=p.snapshot.slots.map(s=>({...s,start:new Date(Date.parse(s.start)+day).toISOString()}));
 p.snapshot.captured_at=p.snapshot.slots[0].start;
 const plan=runRulesPlanner(p,{plan_id:previous.plan_id,slots:previous.plans.priority.slots}).plan;
 assertEquals(plan.status,"ready");assert(plan.planning_warnings!.some(w=>w.code==="reference_coverage"));
});
Deno.test("a short real reference retains covered commands and plans the uncovered intervals",()=>{
 const p=input(commandSnapshot());const previous=runRulesPlanner(p).plan;
 const plan=runRulesPlanner(p,{plan_id:previous.plan_id,slots:previous.plans.priority.slots.slice(0,2)}).plan;
 assertEquals(plan.status,"ready");assertEquals(plan.plans.priority.slots[0].device_commands,previous.plans.priority.slots[0].device_commands);
});
Deno.test("a changed control type cannot leak incompatible retained commands into HA",()=>{
 const p=input(commandSnapshot());const previous=runRulesPlanner(p).plan;
 p.snapshot.device_models[1].control_type="switch_schedule";
 const plan=runRulesPlanner(p,{plan_id:previous.plan_id,slots:previous.plans.priority.slots}).plan;
 assert(plan.plans.priority.slots.every(s=>s.device_commands!.thermostat.type==="switch_schedule"));
});
Deno.test("unavoidable measured demand above the fuse limit remains visible and warning-only",()=>{
 const s=commandSnapshot();s.device_models=[];s.thermal_zones=[];s.grid.import_limit_w=10000;
 s.slots=s.slots.map(s=>({...s,pv_forecast_w:0,base_load_forecast_w:12000}));
 const plan=runRulesPlanner(input(s)).plan;
 assert(plan.plans.priority.slots.every(s=>s.grid_import_w===12000));
 assert(plan.planning_warnings!.some(w=>w.code==="forecast_grid_excess"&&w.severity==="error"));
});
Deno.test("an explicit fixed battery booking survives baseline publication and its export permission is enforced",()=>{
 const p=input(batterySnapshot());p.snapshot.battery!.soc=.05;const source=runRulesPlanner(p).plan;const slot=structuredClone(source.plans.priority.slots[6]);
 slot.battery_command={schema_version:3,operation:"grid_charge",charge_limit_w:2000,discharge_limit_w:0,
  allow_grid_charge:true,allow_battery_export:false};
 const fixed={id:"fixed",starts_at:slot.start,ends_at:new Date(Date.parse(slot.start)+900000).toISOString(),source_snapshot_id:source.snapshot_id,
  slots:[{start:slot.start,targets:slot,power_w:{battery:2000},discharge_w:{battery:0},allow_export:false}]};
 const plan=runRulesPlanner({...p,fixed_plan:fixed}).plan;
 assertEquals(plan.plans.priority.slots[6].battery_command!.operation,"grid_charge");
 assertEquals(plan.plans.baseline.slots[6].battery_command!.operation,"grid_charge");
 slot.battery_command={...slot.battery_command!,operation:"export",charge_limit_w:0,discharge_limit_w:2000};
 p.snapshot.policy.battery_export_enabled=true;p.snapshot.policy.battery_export_reserve_soc=0;
 assertThrows(()=>runRulesPlanner({...p,fixed_plan:fixed}),Error);
});
Deno.test("malformed diagnostics cannot become another admission gate",()=>{
 assertEquals(mergePlanningWarnings([null,{},"bad"] as never),[]);
});

Deno.test("a cold room relay without learned watts retains explicit control intent", () => {
  const s = commandSnapshot();
  const zone = s.thermal_zones![0];
  zone.model = null;
  zone.start_temperature_c = 10;
  s.device_models = s.device_models.map(m => ({...m, active_power_w: null, forecast_w_by_slot: s.slots.map(() => 0)}));
  const rooms = prepareRoomServices(s);
  assertEquals(rooms.commands.relay[0], {type: "switch_schedule", on_seconds: 900});
  assertEquals(rooms.power.relay[0], 0);
  assert(rooms.warnings.some(w => w.code === "room_estimate"));
});

Deno.test("missing economic wear metadata cannot abort household or battery planning", () => {
  const source = batterySnapshot();
  delete source.value_settings;
  const plan = runRulesPlanner({snapshot: source, now: source.captured_at, price_archive: [],
    resolved_price_outlook: rulesFixtureInput(source).price_outlook}).plan;
  assertEquals(plan.status, "ready");
  assertEquals(plan.capabilities.battery, true);
  assert(plan.planning_warnings!.some(w => w.code === "battery_wear_estimated"));
});

/** The selected trajectory preserves storage for the booked heater quarter;
 * self-consumption would spend it earlier and exceed the same grid limit. */
function baselineLimitedHouse(soc: number) {
  const source = mixedModeSnapshot();
  source.captured_at = source.slots[0].start;
  source.slots = source.slots.map(slot => ({...slot, pv_forecast_w: 0,
    base_load_forecast_w: 700, import_price_sek_per_kwh: 1}));
  source.battery = {...source.battery!, capacity_kwh: 2, soc};
  source.grid.import_limit_w = 1000;
  const prepared = rulesFixtureInput(source);
  prepared.problem.fixed_commands = source.slots.map((_slot, i) => i === 6
    ? {pool_on: true, ev_amps: 0, battery: "supply_house", charge_limit_w: 8800, discharge_limit_w: 9600}
    : null);
  return prepared;
}

Deno.test("a failed comparison baseline cannot block a physically valid executable plan", () => {
  const prepared = baselineLimitedHouse(.8);
  const before = structuredClone(prepared.problem);
  const plan = generateRulesPlan(prepared).plan;
  assertEquals(plan.status, "ready");
  assertEquals(plan.validation_errors, []);
  assertEquals(plan.plans.priority.status, "ready");
  assertEquals(plan.plans.priority.slots.length, prepared.snapshot.slots.length);
  assertEquals(plan.plans.baseline.status, "infeasible");
  assertEquals(plan.plans.baseline.validation_errors, ["shared_grid_limit"]);
  assertEquals(plan.plans.baseline.slots, []);
  assertEquals(plan.plans.baseline.summary, null);
  assert(plan.planning_warnings!.some(w => w.code === "baseline_unavailable" && w.scope === "comparison"));
  assertEquals(prepared.problem, before, "comparison failure must not relax any equipment limit");
  assertEquals(plan.grid.import_limit_w, 1000);
  assert(plan.plans.priority.slots[6].pool_w > 0, "the booked command still executes");
  for (const slot of plan.plans.priority.slots) {
    assert(slot.grid_import_w <= 1000 + 1e-7);
    assert(slot.grid_export_w <= plan.grid.export_limit_w + 1e-7);
    assert(slot.battery_charge_w <= plan.battery!.charge_max_w + 1e-7);
    assert(slot.battery_discharge_w <= plan.battery!.discharge_max_w + 1e-7);
    assert(slot.battery_soc >= plan.battery!.min_soc - 1e-7);
    assert(slot.battery_soc <= plan.battery!.max_soc + 1e-7);
    assert(Math.abs(slot.pv_w + slot.grid_import_w + slot.battery_discharge_w
      - slot.load_w - slot.battery_charge_w - slot.grid_export_w - slot.curtailed_w) < 1e-7);
  }
  assert(plan.battery_execution, "comparison failure must not suppress the battery contract");
  assertEquals(plan.battery_execution.intervals.length, plan.plans.priority.slots.length);
  assertEquals(plan.execution_plan!.plans, plan.plans);
  assertEquals(plan.plans.cost.slots, plan.plans.priority.slots);
});

Deno.test("an executable command exceeding the real equipment limit still fails", () => {
  const prepared = baselineLimitedHouse(.5);
  // Stored energy can be preserved for the booking. A discharge ceiling below
  // its 1.8 kW deficit is physically impossible regardless of that trajectory.
  prepared.problem.fixed_commands![6]!.discharge_limit_w = 1000;
  assertThrows(() => generateRulesPlan(prepared), Error, "exceed the configured grid limit");
});
