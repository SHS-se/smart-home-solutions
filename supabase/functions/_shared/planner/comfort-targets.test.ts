import { assert, assertEquals } from "@std/assert";
import { dispatchWorkbenchInputs, generateOptimisationPlan, type OptimisationSnapshot } from "./energy-optimisation.ts";
import { scoreDispatch } from "./dispatch-plan.ts";
import { assembleOptimisationPlan, energyPlanningStep } from "../energy-planning-step.ts";
import type { EnergyPlanningContinuation } from "../energy-planning-protocol.ts";
import { horizon, NOW, routedEvService } from "./energy-optimisation.fixture.ts";

/** Sanitized home-scale case: real physical quantities, synthetic prices and identifiers. */
function comfortHome(): OptimisationSnapshot {
  const input = horizon({
    battery: null,
    capabilities: { pv: true, battery: false, pool: true, boiler: false, ev: true },
    comfort: { pool: { target_c: 30.5 }, ev: { target_km: 360 } },
    pool: { water_temperature_c: 30.08, volume_m3: 55, heating_running: false },
    ev_battery: { name: "Car", soc: .67, capacity_kwh: 76.119, kwh_per_km: .16,
      charge_efficiency: .92, connected: true, available_from: "2026-08-10T08:00:00Z",
      departure: null, departure_target_soc: .8, priority: 3,
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

Deno.test("ordinary cheap windows restore pool comfort and car readiness on the first day", () => {
  const plan = generateOptimisationPlan(comfortHome(), new Date(NOW));
  assertEquals(plan.status, "ready");
  const slots = plan.plans.priority.slots;
  const firstDay = slots.slice(0, 96);
  assert(firstDay.some(slot => slot.pool_w > 0), "pool waited beyond today's cheap window");
  assert(Math.max(...firstDay.map(slot => slot.pool_temperature_c!)) >= 30.4,
    "pool failed to restore its target in the affordable first day");
  const range = firstDay.at(-1)!.ev_soc! * 76.119 / .16;
  assert(range >= 360 && range <= .8 * 76.119 / .16,
    `car ended the first day at ${range} km instead of its reachable preference`);
});

Deno.test("free forecast solar does not erase the value of unmet car readiness", () => {
  const input = comfortHome();
  input.capabilities.pool = false;
  input.pool = null;
  input.services = [routedEvService(input)];
  input.slots = input.slots.map(slot => ({ ...slot, pv_forecast_w: 12_000 }));
  const plan = generateOptimisationPlan(input, new Date(NOW));
  assertEquals(plan.status, "ready");
  const slots = plan.plans.priority.slots;
  assert(slots.some(slot => slot.ev_w > 0), "free PV turned readiness willingness into zero");
  assert(slots.at(-1)!.ev_soc! * 76.119 / .16 >= 360, "reachable car target was not supplied");
});

Deno.test("an unreachable car preference respects the hardware charge ceiling", () => {
  const input = comfortHome();
  input.comfort!.ev!.target_km = 450;
  const plan = generateOptimisationPlan(input, new Date(NOW));
  assertEquals(plan.status, "ready");
  const range = plan.plans.priority.slots.at(-1)!.ev_soc! * 76.119 / .16;
  assert(range > 370 && range <= .8 * 76.119 / .16, `hardware ceiling was lost: ${range}`);
});

Deno.test("target selection preserves the measured passive cooling stall exactly", () => {
  const input = comfortHome();
  const cold = dispatchWorkbenchInputs(input, [], undefined, new Date(NOW))!;
  const warmer = dispatchWorkbenchInputs({ ...input, comfort: { pool: { target_c: 31 }, ev: { target_km: 300 } } },
    [], undefined, new Date(NOW))!;
  const off = (bench: typeof cold) => scoreDispatch(bench.slots, bench.stores, bench.limits, {
    power_w: Object.fromEntries(bench.stores.map(store => [store.key, bench.slots.map(() => 0)])),
    discharge_w: Object.fromEntries(bench.stores.map(store => [store.key, bench.slots.map(() => 0)])),
  }).state.pool;
  assertEquals(off(cold), off(warmer));
  const pool = cold.stores.find(store => store.key === "pool")!;
  assert(Math.abs(pool.drift(28.625, 0) - (28.625 - .006 * .25)) < 1e-9);
  assert(Math.abs(pool.drift(30.625, 0) - (30.625 - .04 * .25)) < 1e-9);
});

Deno.test("pool and car target economics survive JSON worker continuations", () => {
  const input = comfortHome();
  input.slots = input.slots.slice(0, 4);
  input.outdoor_temperature_c = input.outdoor_temperature_c!.slice(0, 4);
  input.services = input.services.map(service => ({ ...service,
    deadline: new Date(Date.parse(input.slots.at(-1)!.start) + 900000).toISOString() }));
  const expected = generateOptimisationPlan(input, new Date(NOW));
  assertEquals(expected.status, "ready");
  const request = { snapshot: input, now: NOW, price_archive: [] };
  let continuation: EnergyPlanningContinuation = { completed: [], rankings: [] };
  for (let calls = 0; calls < 128; calls++) {
    const step = energyPlanningStep(request, continuation);
    continuation = JSON.parse(JSON.stringify({ completed: [...continuation.completed, ...step.completed],
      checkpoint: step.checkpoint, rankings: [...continuation.rankings, ...step.rankings] }));
    if (step.done) {
      assertEquals(assembleOptimisationPlan(request, continuation.completed, continuation.rankings).plan, expected);
      return;
    }
  }
  throw new Error("Target service continuation did not finish");
});
