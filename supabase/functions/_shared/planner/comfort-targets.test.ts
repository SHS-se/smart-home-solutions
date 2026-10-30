import { runRulesPlanner } from "../run-rules-planner.ts";
import { assert, assertEquals } from "@std/assert";
import { type OptimisationSnapshot } from "./planning-contracts.ts";
import { horizon, NOW, routedEvService } from "./energy-optimisation.fixture.ts";

/** Sanitized home-scale case: real physical quantities, synthetic prices and identifiers. */
function comfortHome(): OptimisationSnapshot {
  const input = horizon({
    battery: null,
    capabilities: { pv: true, battery: false, pool: true, boiler: false, ev: true },
    comfort: { pool: { target_c: 30.5 }, ev: { floor_soc: .3 } },
    pool: { water_temperature_c: 30.08, volume_m3: 55, heating_running: false },
    ev_battery: { name: "Car", soc: .67, capacity_kwh: 76.119, kwh_per_km: .16,
      charge_efficiency: .92, connected: true, available_from: "2026-08-10T08:00:00Z",
      charge_limit_soc: .8, priority: 3,
      source_entity_ids: { connected: "binary_sensor.car_cable", soc: "sensor.car_soc",
        target_soc: "number.car_limit", energy_remaining: null, charge_current: "number.car_current" } },
    pool_model: {
      loss_kw_per_k: .1487, rated_cop: null, cop_per_air_c: null,
      response: [
        { at_c: 28.625, idle_c_per_h: -.006, heat_c_per_kwh: .072 },
        { at_c: 29.125, idle_c_per_h: -.044, heat_c_per_kwh: .072 },
        { at_c: 30.625, idle_c_per_h: -.04, heat_c_per_kwh: .072 },
      ],
      heater_response: { kind: "bergvarme", startup: [
        { elapsed_seconds: 0, electric_fraction: 0, heat_fraction: 0 },
        { elapsed_seconds: 335, electric_fraction: 0, heat_fraction: 0 },
        { elapsed_seconds: 1080, electric_fraction: 1, heat_fraction: 1 },
      ] },
    },
  }, { peakPvW: 0, baseLoadW: 800, pricedSlots: 288 });
  input.device_models=[{key:"pool_heater",name:"Pool heater",statistic_id:"pool_heater",category:"pool_heating",planning_service:"pool",
    control_type:"setpoint",planning_role:"controllable",load_type:"fixed_full_load",suggested_load_type:"fixed_full_load",
    active_power_w:3736,profile_sample_count:1000,forecast_w_by_slot:input.slots.map(()=>1000)}];
  input.pool_model!.response=input.pool_model!.response!.map(bin=>({...bin,heated_kwh:10,idle_hours:10}));
  input.pool_model!.hardware={start_c:28,stop_c:34,control:"external_enable",source_entity_ids:{start:"number.start",stop:"number.stop"}};
  input.policy = { ...input.policy, battery_target_is_hard: false, terminal_soc_min: 0,
    terminal_energy_value_sek_per_kwh: 0, battery_end_of_solar_target_soc: 0,
    battery_export_enabled: false, battery_export_reserve_soc: 0,
    battery_export_min_price_sek_per_kwh: 0 };
  input.sources.battery = null;
  input.slots = input.slots.map((slot, index) => ({ ...slot,
    import_price_sek_per_kwh: index % 96 >= 16 && index % 96 < 76 ? .8 : 2.4,
    export_price_sek_per_kwh: 0,
  }));
  input.services = [{ id: "pool", device: "pool", priority: 2, required_kwh: 0,
    earliest_start: input.slots[0].start,
    deadline: new Date(Date.parse(input.slots.at(-1)!.start) + 900_000).toISOString(),
    control: { type: "fixed_power", power_w: 3736 } }, routedEvService(input)];
  return input;
}

Deno.test("ordinary cheap windows restore pool comfort and meet the native car readiness rule", () => {
  const plan = runRulesPlanner({ snapshot: comfortHome(), now: (new Date(NOW)).toISOString(), price_archive: [] }).plan;
  assertEquals(plan.status, "ready");
  const slots = plan.plans.priority.slots;
  const firstDay = slots.slice(0, 96), input_floor = .3;
  assert(firstDay.some(slot => slot.pool_w > 0), "pool waited beyond today's cheap window");
  assert(Math.max(...firstDay.map(slot => slot.pool_temperature_c!)) >= 30.4,
    "pool failed to restore its target in the affordable first day");
  const soc = firstDay.at(-1)!.ev_soc!;
  assert(soc >= input_floor && soc <= .8 + 1e-9, `car ended the first day at ${soc} instead of above its floor and within its limit`);
});

Deno.test("free forecast solar does not erase the value of unmet car readiness", () => {
  const input = comfortHome();
  input.capabilities.pool = false;
  input.pool = null;
  input.services = [routedEvService(input)];
  input.slots = input.slots.map(slot => ({ ...slot, pv_forecast_w: 12_000 }));
  const plan = runRulesPlanner({ snapshot: input, now: (new Date(NOW)).toISOString(), price_archive: [] }).plan;
  assertEquals(plan.status, "ready");
  const slots = plan.plans.priority.slots;
  assert(slots.some(slot => slot.ev_w > 0), "free PV turned readiness willingness into zero");
  assert(slots.at(-1)!.ev_soc! >= .79, "the car was not filled from free solar");
});

Deno.test("the car's own charge limit is the ceiling, whatever it is set to", () => {
  for (const limit of [.5, .8, 1]) {
    const input = comfortHome();
    input.ev_battery!.charge_limit_soc = limit;
    input.ev_battery!.soc = .2;
    const plan = runRulesPlanner({ snapshot: input, now: (new Date(NOW)).toISOString(), price_archive: [] }).plan;
    assertEquals(plan.status, "ready");
    assert(plan.plans.priority.slots.every(slot => slot.ev_soc! <= limit + 1e-9), `past the ${limit} limit`);
    // This tariff has only two prices, so nothing is cheaper than its 25th percentile: the car fills to the middle.
    assert(plan.plans.priority.slots.at(-1)!.ev_soc! >= (.3 + limit) / 2 - .02, `did not fill to the middle below the ${limit} limit`);
  }
});
