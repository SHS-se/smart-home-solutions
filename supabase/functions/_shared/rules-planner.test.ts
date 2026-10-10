import { assert, assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import { dispatchedEvSnapshot } from "../../../scripts/generate-ha-plan-fixture.ts";
import type { OptimisationSnapshot, PlannedSlot } from "./planner/energy-optimisation.ts";
import { generateRulesPlan, prepareRulesPlanningInput } from "./rules-planner.ts";
import { resolveRulePolicy } from "./planner-wasm/rule-policy.ts";

function snapshot(): OptimisationSnapshot {
  const s = dispatchedEvSnapshot();
  const start = Date.parse(s.slots[0].start);
  s.captured_at = new Date(start).toISOString();
  s.slots = s.slots.slice(0, 8).map(slot => ({ ...slot, pv_forecast_w: 0 }));
  s.comfort = { ev: { target_km: 300 } };
  return s;
}
function prepare(s: OptimisationSnapshot, reference: {plan_id:string;slots:PlannedSlot[]} | null = null, now = s.captured_at) {
  return prepareRulesPlanningInput({ snapshot: s, now, price_archive: [], resolved_price_outlook: {
    shaped: true, observed_days: 1, effective_days: 1, level_sek_per_kwh: 1.5,
    shadow_import_sek_per_kwh: s.slots.map(slot => slot.import_price_sek_per_kwh!),
  } }, reference, resolveRulePolicy());
}
Deno.test("rules preparation preserves absent equipment and disconnected EV state", () => {
  const s = snapshot();
  s.ev_battery!.connected = false;
  const p = prepare(s).problem;
  assertEquals(p.battery, null);
  assertEquals(p.pool_store, null);
  assert(p.car);
  assert(p.slots.every(slot => !slot.ev_available));
  assertEquals(p.initial.ev_kwh, s.ev_battery!.soc * s.ev_battery!.capacity_kwh);
});
Deno.test("rules preparation counts a supplied passive device exactly once and never mutates input", () => {
  const s = snapshot();
  s.device_models.push({ key: "fridge", name: "Fridge", statistic_id: "fridge", category: "other", suggested_load_type: "duty_cycle",
    load_type: "duty_cycle", planning_role: "controllable", control_type: "permit_inhibit", active_power_w: 300,
    profile_sample_count: 12, forecast_w_by_slot: s.slots.map(() => 120) });
  const before = JSON.stringify(s);
  const prepared = prepare(s);
  assertEquals(prepared.problem.slots[0].base_w, s.slots[0].base_load_forecast_w + 120);
  assertEquals(prepared.passive_w.fridge[0], 120);
  assertEquals(JSON.stringify(s), before);
});
Deno.test("rules preparation requires supplied price outlook and explicit EV model facts", () => {
  const s = snapshot();
  assertThrows(() => prepareRulesPlanningInput({ snapshot: s, now: s.captured_at, price_archive: [] }, null, resolveRulePolicy()), Error, "already resolved");
  s.ev_battery!.kwh_per_km = null;
  assertThrows(() => prepare(s), Error, "native charger model");
});
Deno.test("rules native solve materializes missing devices and exact physical balance", () => {
  const result = generateRulesPlan(prepare(snapshot()));
  assertEquals(result.plan.battery, null);
  assertEquals(result.plan.pool, null);
  for (const slot of result.plan.plans.priority.slots) {
    assertAlmostEquals(slot.pv_w + slot.grid_import_w + slot.battery_discharge_w,
      slot.load_w + slot.battery_charge_w + slot.grid_export_w + slot.curtailed_w, 1e-8);
    assertEquals(slot.ev_target_current_a, slot.ev_w / 230 / 3);
  }
  assertEquals(result.plan.plans.cost.label, "Rule-based plan (same selected schedule)");
});
Deno.test("rules plan publishes the points each deduction took, on the selected schedule only", () => {
  const s = snapshot();
  s.slots = s.slots.map((slot, i) => ({ ...slot, import_price_sek_per_kwh: i < 2 ? 0.4 : 1.5 }));
  const prepared = prepare(s);
  const { plans } = generateRulesPlan(prepared).plan;
  // The planner is sent the deduction rules only: a cheap quarter is on the bill, not a reward.
  const sent = new Set<string>(prepared.problem.rules.map(rule => rule.key));
  assert(!sent.has("cheapest_buy") && !sent.has("cheap_buy") && sent.has("ev_low"));
  assert(plans.priority.slots.every(slot => slot.rule_points && Object.keys(slot.rule_points).every(key => sent.has(key))));
  // The car still charges in the two cheap quarters, because the bill is in the score.
  const charged = plans.priority.slots.flatMap((slot, i) => slot.ev_w > 0 ? [i] : []);
  assertEquals(charged.filter(i => i < 2), [0, 1]);
  assert(plans.baseline.slots.every(slot => slot.rule_points === undefined));
  // The problem carries what the energy left in the car is worth, at the median price it was told.
  assertEquals(prepared.problem.end_credit.reference_sek_per_kwh, 1.5);
  assert(prepared.problem.end_credit.ev !== null && prepared.problem.end_credit.battery === null);
});
Deno.test("rules partial-quarter commitment locks five exact intervals without a fabricated suffix", () => {
  const s = snapshot();
  const first = generateRulesPlan(prepare(s)).plan;
  const now = new Date(Date.parse(s.captured_at) + 7 * 60_000).toISOString();
  s.captured_at = now;
  const prepared = prepare(s, { plan_id: first.plan_id, slots: first.plans.priority.slots }, now);
  assertEquals(prepared.problem.accepted?.length, 5);
  assertEquals(prepared.problem.slots[0].hours, .25);
  assertEquals(prepared.problem.slots[0].start_seconds, -420);
  const replanned = generateRulesPlan(prepared).plan;
  assertAlmostEquals(replanned.plans.priority.slots[0].duration_hours!, 8 / 60, 1e-10);
  for (let i = 0; i < 5; i++) {
    assertEquals(replanned.plans.priority.slots[i].ev_target_current_a, first.plans.priority.slots[i].ev_target_current_a);
    assertEquals(replanned.plans.priority.slots[i].device_commands, first.plans.priority.slots[i].device_commands);
  }
  assertThrows(() => prepare(s, { plan_id: first.plan_id, slots: first.plans.priority.slots.slice(0, 4) }, now), Error, "unavailable");
});
// User requirement, 23 September 2026: a device's mode decides who writes its
// requests, never what the household is planned to do. Home Assistant refuses a
// plan whose execution schedule differs from the displayed one.
Deno.test("the execution plan is the displayed schedule whatever each device's mode", () => {
  const s = snapshot();
  s.schema_version = 9;
  s.capabilities.battery = true;
  s.value_settings = {battery_degradation_sek_per_kwh:.05,vehicle_fallback_sek_per_km:null};
  s.battery = { capacity_kwh: 10, soc: .5, min_soc: .1, max_soc: .9, charge_max_w: 3000, discharge_max_w: 3000, charge_efficiency: .95, discharge_efficiency: .95 };
  s.operating_scope = { modes: { $battery: "controlling", $pool: "monitoring", $ev: "control_verification" }, device_owners: {}, external_demands: {} };
  s.device_models = [{ key: "ev", name: "EV", statistic_id: "ev", category: "ev_charging", suggested_load_type: "variable_full_load",
    load_type: "variable_full_load", planning_role: "controllable", control_type: "variable_power", active_power_w: 11040,
    profile_sample_count: 12, forecast_w_by_slot: s.slots.map(() => 200) }];
  s.operating_scope.device_owners.ev = "$ev";
  s.operating_scope.external_demands.ev = { forecast_w_by_slot: s.slots.map(() => 200), recent_observation: null };
  s.battery_execution_feedback = { generation: 1, source_receipt: 0, previous_contract_id: null, scope_revision: "scope1", objectives: [] };
  s.ev_battery!.soc = .1;
  const previous = generateRulesPlan(prepare(s)).plan;
  const commitment = previous.plans.priority.slots.map(slot => ({ ...slot, ev_target_current_a: 16, ev_min_current_a: 0, ev_max_current_a: 16,
    device_commands: { ...slot.device_commands, ev: {type: "variable_power" as const, value: 16, unit: "A" as const} } }));
  const plan = generateRulesPlan(prepare(s, {plan_id: previous.plan_id, slots: commitment})).plan;
  assert(plan.battery_execution);
  assert(plan.execution_plan);
  // The car is only being verified, and its planned charging is still the plan.
  assert(plan.plans.priority.slots.some(slot => slot.ev_w > 200));
  assertEquals(plan.execution_plan.schema_version, 8);
  for (const key of ["device_models", "capabilities", "battery", "pool", "ev_battery", "plans"] as const) {
    assertEquals(plan.execution_plan[key], plan[key]);
  }
  for (const [i, slot] of plan.plans.priority.slots.entries()) {
    assertEquals(plan.battery_execution.intervals[i].load_mwh, Math.round(slot.load_w * slot.duration_hours! * 1000));
  }
});
Deno.test("rules pool preparation uses measured heat/loss and separate compressor/pump members", () => {
  const s = snapshot();
  s.capabilities.pool = true;
  s.pool = { water_temperature_c: 30, volume_m3: 50, heating_running: false };
  s.comfort!.pool = { target_c: 29 };
  s.pool_model = { loss_kw_per_k: null, rated_cop: null, cop_per_air_c: null,
    heater_response: { kind: "steady" }, hardware: { start_c: 28, stop_c: 34, control: "external_enable", source_entity_ids: { start: "number.start", stop: "number.stop" } },
    response: [{ at_c: 28, idle_c_per_h: -.1, heat_c_per_kwh: .1, heated_kwh: 1 }, { at_c: 30, idle_c_per_h: -.2, heat_c_per_kwh: .2, heated_kwh: 3 }] };
  for (const [key, watts, role] of [["heater", 3000, "heater"], ["pump", 700, "circulation"]] as const) {
    s.device_models.push({ key, name: key, statistic_id: key, category: "pool_heating", planning_service: "pool", pool_role: role,
      suggested_load_type: "fixed_full_load", load_type: "fixed_full_load", control_type: "switch_schedule", planning_role: "controllable",
      active_power_w: watts, profile_sample_count: 12, forecast_w_by_slot: s.slots.map(() => watts) });
  }
  const ready = prepare(s);
  assertEquals(ready.problem.pool_stop_c, 34);
  assertEquals(ready.problem.targets.pool_c, 29);
  assertEquals(ready.problem.heater!.compressor_w, 3000);
  assertEquals(ready.problem.heater!.auxiliary_w, 700);
  assertAlmostEquals(ready.problem.heater!.heat_w, .175 * 50 * 1.163 * 3000, 1e-8);
  assertEquals(ready.problem.pool_store!.loss, { kind: "measured", points: [{at_c:28,c_per_h:-.1},{at_c:30,c_per_h:-.2}] });
  assertEquals(ready.problem.slots[0].base_w, s.slots[0].base_load_forecast_w);
  s.pool_model.hardware = undefined;
  assertThrows(() => prepare(s), Error, "independently configured");
});
Deno.test("rules commitment keeps charger commands while fresh above-target state changes physical draw", () => {
  const s = snapshot();
  const prior = generateRulesPlan(prepare(s)).plan;
  const locked = prior.plans.priority.slots.map(slot => ({ ...slot, ev_target_current_a: 16, ev_min_current_a: 0, ev_max_current_a: 16 }));
  s.ev_battery!.soc = .9;
  s.captured_at = new Date(Date.parse(s.captured_at) + 60_000).toISOString();
  const ready = prepare(s, {plan_id: prior.plan_id, slots: locked});
  const revised = generateRulesPlan(ready).plan;
  for (const slot of revised.plans.priority.slots.slice(0, 5)) {
    assertEquals(slot.ev_target_current_a, 16);
    assertEquals(slot.ev_w, 0);
    assertEquals(slot.ev_soc, .9);
  }
});
Deno.test("rules immutable capture anchors duration and commitment despite later preparation", () => {
  const s = snapshot();
  const ready = prepare(s, null, new Date(Date.parse(s.captured_at) + 7 * 60_000).toISOString());
  assertEquals(ready.problem.slots[0].start_seconds, 0);
  assertEquals(ready.snapshot.captured_at, s.captured_at);
  assertEquals(ready.now, new Date(Date.parse(s.captured_at) + 7 * 60_000).toISOString());
});
Deno.test("rules rejects configured hard battery target rather than claiming it was enforced", () => {
  const s = snapshot();
  s.policy.battery_target_is_hard = true;
  assertThrows(() => prepare(s), Error, "Unsupported configured hard battery target");
});
Deno.test("rules boiler baseline forecast respects each declared service window", () => {
  const s = snapshot();
  s.capabilities.boiler = true;
  const boundary = s.slots[4].start;
  for (const [id, start, end] of [["first", s.slots[0].start, boundary], ["second", boundary, new Date(Date.parse(s.slots.at(-1)!.start) + 900000).toISOString()]]) {
    s.services.push({ id, device:"boiler", earliest_start:start, deadline:end, priority:1, required_kwh:1,
      control:{type:"duty_cycle",rated_power_w:1000,expected_power_w_by_slot:s.slots.map(() => 400),max_consecutive_inhibit_slots:2} });
  }
  const prepared = prepare(s);
  assertEquals(prepared.boiler_w, s.slots.map(() => 400));
  assertEquals(prepared.problem.slots.map(slot => slot.base_w), s.slots.map(slot => slot.base_load_forecast_w + 400));
});
Deno.test("rules plans an electrical-only home without fabricated controllable equipment", () => {
  const s = snapshot();
  s.capabilities.ev = false;
  s.ev_battery = null;
  s.services = [];
  s.comfort = null;
  const result = generateRulesPlan(prepare(s)).plan;
  assertEquals(result.plans.priority.dispatched_devices, []);
  assertEquals(result.battery, null);
  assertEquals(result.ev_battery, null);
  assertEquals(result.pool, null);
  assert(result.plans.priority.slots.every(slot => slot.battery_command === null && slot.ev_target_current_a === 0 && slot.pool_command_w === 0));
  assertEquals(result.plans.priority.slots[0].grid_import_w, s.slots[0].base_load_forecast_w);
});

Deno.test("schema9 without optional execution feedback publishes native authority without a fabricated contract", () => {
  const s = snapshot();
  s.schema_version = 9;
  s.capabilities.battery = true;
  s.value_settings = {battery_degradation_sek_per_kwh:.05,vehicle_fallback_sek_per_km:null};
  s.battery = { capacity_kwh: 10, soc: .5, min_soc: .1, max_soc: .9, charge_max_w: 3000, discharge_max_w: 3000, charge_efficiency: .95, discharge_efficiency: .95 };
  s.operating_scope = { modes: { $battery: "controlling", $pool: "monitoring", $ev: "control_verification" }, device_owners: {}, external_demands: {} };
  const result = generateRulesPlan(prepare(s));
  assertEquals(result.plan.status, "ready");
  assertEquals(result.plan.battery_execution, undefined);
  assert(result.plan.execution_plan);
  assert(result.plan.plans.priority.slots.every(slot => slot.battery_command?.schema_version === 3));
  assertEquals(result.battery_projection, {status:"unsupported",reasons:["rules_objective_has_no_conditional_money_projection"]});
  assertEquals(result.plan.battery_value_curve, null);
  assertEquals(result.plan.resolved_value_stores, []);
});

Deno.test("rules preparation levels only base load from matured evidence at local capture", () => {
  const s = snapshot();
  // UTC is still yesterday, but local Stockholm capture is already August 10.
  s.timezone = "Europe/Stockholm";
  s.captured_at = "2026-08-09T22:30:00Z";
  s.slots = s.slots.map((slot, i) => ({ ...slot, start: new Date(Date.parse(s.captured_at) + i * 900000).toISOString() }));
  const days = Array.from({ length: 5 }, (_, i) => ({
    day: `2026-08-0${9-i}`, forecast_kwh: 20, actual_kwh: 24,
  }));
  s.demand_outlook = { days };
  s.device_models.push({ key: "fridge", name: "Fridge", statistic_id: "fridge", category: "other",
    suggested_load_type: "duty_cycle", load_type: "duty_cycle", planning_role: "controllable", control_type: "permit_inhibit",
    active_power_w: 300, profile_sample_count: 12, forecast_w_by_slot: s.slots.map(() => 120) });
  const before = JSON.stringify(s);
  const p = prepare(s, null, "2026-08-12T00:00:00Z");
  assert(p.base_w[0] > s.slots[0].base_load_forecast_w * 1.15);
  assert(p.base_w[0] < s.slots[0].base_load_forecast_w * 1.2);
  assertEquals(p.problem.slots[0].base_w, p.base_w[0] + 120);
  assertEquals(JSON.stringify(s), before);
  s.demand_outlook.days.push({ day: "2026-08-10", forecast_kwh: 20, actual_kwh: 1000 },
    { day: "2026-08-11", forecast_kwh: 20, actual_kwh: 1000 });
  assertEquals(prepare(s).base_w, p.base_w);
});
