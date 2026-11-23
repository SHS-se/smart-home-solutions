/** Independently specified synthetic outage, accepted requests and equipment bounds. */
import { assert, assertEquals } from "@std/assert";
import { syntheticHome, withHotWater, withPool } from "../../../tests/planner-contracts/synthetic.ts";
import { syntheticIdentityConversion } from "./planner/battery-physics.fixture.ts";
import { runRulesPlanner } from "./run-rules-planner.ts";
import { retainUnavailableServices } from "./rules-service-continuity.ts";
import type { PublishedCommandReference } from "./rules-planner.ts";

function household() {
  const snapshot = withPool(syntheticHome(12));
  snapshot.device_models.push({ key: "synthetic_ev", name: "Synthetic charger", statistic_id: "sensor.synthetic_ev",
    category: "ev_charging", planning_role: "controllable", control_type: "variable_power", load_type: "variable_full_load",
    suggested_load_type: "variable_full_load", active_power_w: 11040, profile_sample_count: 20,
    forecast_w_by_slot: snapshot.slots.map(() => 1000) });
  const initial = runRulesPlanner({ snapshot, now: snapshot.captured_at, price_archive: [] }).plan;
  const reference: PublishedCommandReference = { plan_id: initial.plan_id, pool_planning_basis: "thermal", pool_stop_temperature_c: 30,
    ev_charger: { voltage_v: 230, phase_count: 3, min_current_a: 5, max_current_a: 16, current_step_a: 1 },
    slots: initial.plans.priority.slots.slice(0, 8).map((slot, i) => ({ ...slot,
      ev_target_current_a: i % 2 ? 0 : 8, ev_min_current_a: 0, ev_max_current_a: 16,
      pool_permitted: i % 2 === 0, pool_command_w: i % 2 ? 0 : 3600,
      device_loads_w: { synthetic_pool: i % 2 ? 0 : 1000, synthetic_ev: i % 2 ? 0 : 500 },
      device_commands: { synthetic_pool: { type: "switch_schedule", on_seconds: i % 2 ? 0 : 900 },
        synthetic_ev: { type: "variable_power", value: i % 2 ? 0 : 8, unit: "A" } },
    })) };
  snapshot.capabilities.ev = false; snapshot.ev_battery = null;
  snapshot.capabilities.pool = false; snapshot.pool = null; snapshot.services = [];
  snapshot.measurement_issues = ["ev", "pool"].map(device => ({ device: device as "ev" | "pool", field: "soc",
    entity_id: "sensor.synthetic_state", value: "unavailable", reason: "Synthetic observation outage", detected_by: "home_assistant" }));
  return { snapshot, reference };
}

Deno.test("missing store observations retain accepted supported requests and full ON draw without inventing state", () => {
  const { snapshot, reference } = household();
  const before = structuredClone(reference);
  const plan = runRulesPlanner({ snapshot, now: snapshot.captured_at, price_archive: [] }, reference).plan;
  assertEquals(reference, before);
  assertEquals(plan.ev_battery, null);
  assertEquals(plan.pool, null);
  assertEquals(plan.capabilities.ev, false);
  assertEquals(plan.retained_pool_stop_temperature_c, 30);
  assertEquals(plan.retained_ev_charger, reference.ev_charger);
  const slots = plan.plans.priority.slots;
  for (let i = 0; i < 8; i++) {
    assertEquals(slots[i].ev_target_current_a, i % 2 ? 0 : 8);
    assertEquals(slots[i].ev_w, i % 2 ? 0 : 5520, "A finishing-quarter average cannot stand in for commanded current");
    assertEquals(slots[i].device_loads_w.synthetic_pool, i % 2 ? 0 : 3600);
    assertEquals(slots[i].pool_permitted, i % 2 === 0);
    assertEquals(slots[i].device_commands, reference.slots[i].device_commands);
    assertEquals(slots[i].ev_soc, null);
    assertEquals(slots[i].pool_temperature_c, undefined);
    assert(slots[i].grid_import_w <= snapshot.grid.import_limit_w);
  }
  for (const slot of slots.slice(8)) {
    assertEquals(slot.pool_permitted, null);
    assertEquals(slot.pool_command_w, undefined);
    assertEquals(slot.device_commands!.synthetic_ev.type, "unavailable");
    assertEquals(slot.device_commands!.synthetic_pool.type, "unavailable");
    assertEquals(slot.device_loads_w.synthetic_ev, 1000);
  }
});

Deno.test("repeated outage captures preserve cutoff and exact coverage; recovery resumes ordinary planning", () => {
  const { snapshot, reference } = household();
  const input = { snapshot, now: snapshot.captured_at, price_archive: [] };
  const first = runRulesPlanner(input, reference).plan;
  const next: PublishedCommandReference = { plan_id: first.plan_id, slots: first.plans.priority.slots,
    pool_stop_temperature_c: first.retained_pool_stop_temperature_c, ev_charger: first.retained_ev_charger };
  const repeated = runRulesPlanner(input, next).plan;
  assertEquals(repeated.plans.priority.slots.map(slot => [slot.pool_permitted, slot.ev_target_current_a]),
    first.plans.priority.slots.map(slot => [slot.pool_permitted, slot.ev_target_current_a]));
  assertEquals(repeated.retained_pool_stop_temperature_c, 30);
  const healthy = withPool(syntheticHome(12));
  healthy.device_models = snapshot.device_models;
  const recovered = runRulesPlanner({ snapshot: healthy, now: healthy.captured_at, price_archive: [] }).plan;
  assert(recovered.ev_battery);
  assert(recovered.pool);
  assertEquals(recovered.retained_pool_stop_temperature_c, undefined);
  assert(recovered.plans.priority.slots.every(slot => Number.isFinite(slot.pool_temperature_c)));
});

Deno.test("explicit disables, impossible readings, removed meters and changed controls do not resurrect requests", () => {
  for (const change of ["disabled", "impossible", "removed", "control"] as const) {
    const { snapshot, reference } = household();
    if (change === "disabled") snapshot.measurement_issues = [];
    if (change === "impossible") snapshot.measurement_issues!.forEach(issue => issue.value = 500);
    if (change === "removed") snapshot.device_models = [];
    if (change === "control") snapshot.device_models.forEach(model => model.control_type = "setpoint");
    const result = retainUnavailableServices(snapshot, reference, new Set());
    assert(result.ev.every(value => !value));
    assert(result.pool.every(value => !value));
  }
});

Deno.test("repair releases affect the held hour and blocked opportunities; a missing EV bound never invents a rating", () => {
  const { snapshot, reference } = household();
  const released = retainUnavailableServices(snapshot, reference, new Set(), null, new Set(["$ev", "$pool"]));
  assertEquals(released.ev[0], undefined);
  assertEquals(released.pool[2], undefined);
  assertEquals(released.ev[4]!.ev_target_current_a, 8);
  assertEquals(released.pool[4]!.pool_permitted, true);
  snapshot.execution_availability = [{ owner: "$ev", status: "temporarily_absent", cause: "vehicle_disconnected",
    blocked_intervals: [{ start: snapshot.slots[0].start, end: snapshot.slots[1].start }] }];
  const blocked = retainUnavailableServices(snapshot, reference, new Set());
  assertEquals(blocked.ev[0], undefined);
  assertEquals(blocked.ev[2]!.ev_target_current_a, 8);
  delete reference.ev_charger;
  const unbounded = retainUnavailableServices(snapshot, reference, new Set());
  assertEquals(unbounded.ev[2], undefined);
  assertEquals(unbounded.ev[1]!.ev_target_current_a, 0, "An accepted OFF instruction needs no invented power bound");
});

Deno.test("an outage during selective execution repair preserves future unblocked accepted opportunities", () => {
  const { snapshot, reference } = household();
  const changes = [{ owner: "$ev", status: "temporarily_absent" as const, cause: "vehicle_disconnected",
    blocked_intervals: [{ start: snapshot.slots[0].start, end: snapshot.slots[1].start }] }];
  const plan = runRulesPlanner({ snapshot, now: snapshot.captured_at, price_archive: [],
    execution_replan: { request_id: "synthetic-repair", accepted_plan_id: reference.plan_id,
      observed_at: snapshot.captured_at, changes } }, reference).plan;
  const slots = plan.plans.priority.slots;
  assertEquals(slots[0].device_commands!.synthetic_ev.type, "unavailable");
  assertEquals(slots[2].device_commands!.synthetic_ev.type, "unavailable");
  assertEquals(slots[4].device_commands!.synthetic_ev, reference.slots[4].device_commands!.synthetic_ev);
  assertEquals(slots[4].ev_target_current_a, 8);
  assertEquals(slots[0].pool_permitted, true, "Unrelated pool instructions remain accepted");
  snapshot.execution_availability = [{ owner: "$ev", status: "capacity_limited", cause: "house_import_capacity",
    maximum_current_a: 6, blocked_intervals: [{ start: snapshot.slots[4].start, end: snapshot.slots[5].start }] }];
  const limited = retainUnavailableServices(snapshot, reference, new Set());
  assertEquals(limited.ev[4], undefined);
  assertEquals(limited.ev[6]!.ev_target_current_a, 8);
});

Deno.test("generic device continuity retains only compatible current Planned members", () => {
  const { snapshot, reference } = household();
  snapshot.device_models.push({ ...snapshot.device_models[0], key: "synthetic_heater", name: "Synthetic heater",
    category: "heating", planning_service: undefined, active_power_w: 1200 });
  for (const slot of reference.slots) {
    slot.device_commands!.synthetic_heater = { type: "switch_schedule", on_seconds: 900 };
    slot.device_loads_w!.synthetic_heater = 300;
  }
  const retained = retainUnavailableServices(snapshot, reference, new Set());
  assertEquals(retained.power.synthetic_heater.slice(0, 8), Array(8).fill(1200));
  assertEquals(retained.commands.synthetic_heater[8], undefined);
  snapshot.device_models.at(-1)!.active_power_w = null;
  assertEquals(retainUnavailableServices(snapshot, reference, new Set()).commands.synthetic_heater, undefined,
    "A previous quarter average is not a bound for an enabled appliance");
  snapshot.device_models.at(-1)!.active_power_w = 1200;
  snapshot.device_models.at(-1)!.category = "hot_water";
  snapshot.capabilities.boiler = false;
  assertEquals(retainUnavailableServices(snapshot, reference, new Set()).commands.synthetic_heater, undefined,
    "An explicitly disabled native service cannot gain commands through generic continuity");
  snapshot.device_models.at(-1)!.category = "heating";
  Reflect.set(snapshot.device_models.at(-1)!, "planning_role", "base_load");
  assertEquals(retainUnavailableServices(snapshot, reference, new Set()).commands.synthetic_heater, undefined);
});

Deno.test("a configured boiler with missing service evidence retains permits and battery permissions without double counting demand", () => {
  for (const batteryAllowed of [false, true]) {
    const snapshot = withHotWater(syntheticHome(12));
    snapshot.capabilities.ev = false;
    snapshot.ev_battery = null;
    snapshot.capabilities.battery = true;
    snapshot.battery = { capacity_kwh: 20, soc: 0.8, min_soc: 0.05, max_soc: 0.95,
      charge_max_w: 6000, discharge_max_w: 6000, charge_efficiency: 0.95, discharge_efficiency: 0.95,
      conversion: syntheticIdentityConversion() };
    snapshot.services = snapshot.services.filter(service => service.device === "boiler");
    const healthy = runRulesPlanner({ snapshot, now: snapshot.captured_at, price_archive: [] }).plan;
    const reference: PublishedCommandReference = { plan_id: healthy.plan_id,
      slots: healthy.plans.priority.slots.slice(0, 8).map(slot => ({ ...slot,
        boiler_permitted: true, boiler_expected_w: 500, boiler_battery_allowed: batteryAllowed,
        device_commands: { synthetic_water: { type: "permit_inhibit", permitted: true } },
        battery_command: { schema_version: 3, operation: "self_consumption", charge_limit_w: 6000,
          discharge_limit_w: 6000, allow_grid_charge: false, allow_battery_export: false },
      })) };
    snapshot.services = [];
    const degraded = runRulesPlanner({ snapshot, now: snapshot.captured_at, price_archive: [] }, reference).plan;
    assertEquals(degraded.capabilities.boiler, false);
    const slots = degraded.plans.priority.slots;
    for (const slot of slots.slice(0, 8)) {
      assertEquals(slot.device_commands!.synthetic_water, { type: "permit_inhibit", permitted: true });
      assertEquals(slot.device_loads_w.synthetic_water, 2000);
      assertEquals(slot.boiler_expected_w, 2000);
      assertEquals(slot.boiler_battery_allowed, batteryAllowed);
      assertEquals(slot.load_w, slot.base_w + Object.values(slot.device_loads_w).reduce((sum, watts) => sum + watts, 0));
    }
    assert(slots[0].battery_discharge_w <= (batteryAllowed ? 2500 : 500) + 1e-6);
    if (batteryAllowed) assert(slots[0].battery_discharge_w > 500);
    for (const slot of slots.slice(8)) {
      assertEquals(slot.device_commands!.synthetic_water.type, "unavailable");
      assertEquals(slot.device_loads_w.synthetic_water, 500);
      assert(slot.battery_discharge_w <= 500 + 1e-6, "An uncovered interval cannot grant battery supply to the boiler");
    }
  }
});

Deno.test("missing boiler ratings cannot remove the profile referenced by a held battery instruction", () => {
  const snapshot = withHotWater(syntheticHome(12));
  snapshot.schema_version = 10;
  snapshot.operating_scope = { modes: { $battery: "controlling", $ev: "controlling", $pool: "controlling",
    synthetic_water: "controlling" }, device_owners: { synthetic_water: "synthetic_water" }, external_demands: {} };
  snapshot.capabilities.ev = false;
  snapshot.ev_battery = null;
  snapshot.capabilities.battery = true;
  snapshot.battery = { capacity_kwh: 20, soc: 0.8, min_soc: 0.05, max_soc: 0.95,
    charge_max_w: 6000, discharge_max_w: 6000, charge_efficiency: 0.95, discharge_efficiency: 0.95,
    conversion: syntheticIdentityConversion() };
  snapshot.services = snapshot.services.filter(service => service.device === "boiler");
  const healthy = runRulesPlanner({ snapshot, now: snapshot.captured_at, price_archive: [] }).plan;
  const reference: PublishedCommandReference = { plan_id: healthy.plan_id,
    slots: healthy.plans.priority.slots.slice(0, 8).map(slot => ({ ...slot,
      boiler_permitted: true, boiler_expected_w: 500, boiler_battery_allowed: true,
      device_commands: { synthetic_water: { type: "permit_inhibit", permitted: true } },
      battery_instruction: { kind: "supply", profile_id: "base+loads", charge_ac_limit_w: 6000,
        discharge_ac_limit_w: 6000, response: { mode: "follow_demand" } },
    })) };
  snapshot.services = [];
  snapshot.device_models[0].active_power_w = null;
  const degraded = runRulesPlanner({ snapshot, now: snapshot.captured_at, price_archive: [] }, reference).plan;
  const profiles = new Map(degraded.battery_demand!.profiles.map(profile => [profile.id, profile]));
  for (const slot of degraded.plans.priority.slots) {
    const instruction = slot.battery_instruction;
    if (instruction && "profile_id" in instruction) assert(profiles.has(instruction.profile_id));
  }
  assertEquals(degraded.plans.priority.slots[8].device_commands!.synthetic_water.type, "unavailable");
  assertEquals(degraded.plans.priority.slots[0].battery_instruction, reference.slots[0].battery_instruction);
  assertEquals(degraded.plans.priority.slots[0].boiler_battery_allowed, true);
  assert(profiles.get("base+loads")!.eligible_keys.includes("synthetic_water"));
});
