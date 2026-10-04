import { assertAlmostEquals, assertEquals } from "@std/assert";
import { heaterInputResponse } from "./heat-pump-dispatch.ts";
import { physicalDispatchStores, planDispatch, scoreDispatch, type DispatchStore, type DispatchSlot } from "./dispatch-plan.ts";
import { dispatchWithPrefix } from "./fixed-energy-plan.ts";
import { snapshotV8 } from "../../../../src/lib/energy-shift/optimisation-snapshot.fixture.ts";
import { generateOptimisationPlan } from "./energy-optimisation.ts";
import { assembleOptimisationPlan, energyPlanningStep } from "../energy-planning-step.ts";
import type { EnergyPlanningContinuation } from "../energy-planning-protocol.ts";

const model = { kind: "bergvarme" as const, startup: [
  { elapsed_seconds: 0, electric_fraction: 0, heat_fraction: 0 },
  { elapsed_seconds: 300, electric_fraction: 0, heat_fraction: 0 },
  { elapsed_seconds: 900, electric_fraction: 1, heat_fraction: 1 },
] };
const store = (auxiliary = 600): DispatchStore => ({
  key: "heater", curve: { unit: "celsius", points: [{ at: 0, sek_per_unit: 4 }, { at: 100, sek_per_unit: 4 }] },
  initial_state: 0, max_power_w: 3000 + auxiliary, min_power_w: 3000 + auxiliary,
  power_step_w: 3000 + auxiliary, start_cost_sek: 0.5, wear_sek_per_kwh: 0.01,
  retention_per_slot: 1, usage_weight: [0, 0, 0, 0], terminal_weight: 1,
  units_per_kwh: () => 1, drift: state => state,
  input_response: heaterInputResponse(model, { compressor_w: 3000, auxiliary_w: auxiliary }, null),
});
const slots: DispatchSlot[] = [0.1, 0.8, 0.8, 0.1].map(price => ({ pv_w: 0, fixed_load_w: 200,
  import_price_sek_per_kwh: price, export_price_sek_per_kwh: 0.05 }));
const limits = { grid_import_limit_w: 10000, grid_export_limit_w: 10000, grid_import_shaping_w: 10000, peak_shaping_sek_per_kwh_per_kw: 0 };

Deno.test("command-aware scoring and frozen physical adapter agree on heat, electricity and wear", () => {
  const s = store();
  const schedule = { power_w: { heater: [3600, 3600, 0, 3600] }, discharge_w: { heater: [0, 0, 0, 0] } };
  const exact = scoreDispatch(slots, [s], limits, schedule);
  const frozen = physicalDispatchStores(slots, [s], schedule.power_w);
  const physical = scoreDispatch(slots, frozen, limits, { ...schedule, power_w: exact.draw_w });
  assertEquals(exact.infeasibilities, []);
  assertEquals(physical.infeasibilities, []);
  exact.state.heater.forEach((value, i) => assertAlmostEquals(value, physical.state.heater[i]));
  assertEquals(exact.import_w, physical.import_w);
  assertAlmostEquals(exact.wear_sek, physical.wear_sek);
  assertAlmostEquals(exact.total_sek - physical.total_sek, 1);
  assertEquals(exact.draw_w.heater, [1600, 3600, 0, 1600]);
  assertEquals(exact.stores[0].runs, 2);
});

Deno.test("enabled zero-draw startup is an executable command and pays its start once", () => {
  const s = store(0);
  const short = [{ ...slots[0], duration_hours: 1 / 12 }];
  const score = scoreDispatch(short, [s], limits, { power_w: { heater: [3000] }, discharge_w: { heater: [0] } });
  assertEquals(score.infeasibilities, []);
  assertEquals(score.draw_w.heater, [0]);
  assertEquals(score.state.heater, [0, 0]);
  assertEquals(score.start_sek, 0.5);
});

Deno.test("fixed-prefix continuation carries startup age and preserves the specified command", () => {
  const s = store();
  const short = [{ ...slots[0], duration_hours: 1 / 12 }, { ...slots[1], duration_hours: 1 / 6 }];
  const prefix = { power_w: { heater: [3600] }, discharge_w: { heater: [0] } };
  const result = dispatchWithPrefix(short, [s], limits, prefix, 1);
  assertEquals(result.power_w.heater, [3600, 3600]);
  const scored = scoreDispatch(short, [s], limits, result);
  assertEquals(scored.draw_w.heater, [600, 2100]);
  assertEquals(scored.infeasibilities, []);
  assertEquals(scored.start_sek, 0.5);
});

Deno.test("responsive whole-run search matches exhaustive command oracle on a small horizon", () => {
  const s = store();
  let oracle = Infinity;
  for (let mask = 0; mask < 16; mask++) {
    const power = slots.map((_, i) => mask & (1 << i) ? 3600 : 0);
    const score = scoreDispatch(slots, [s], limits, { power_w: { heater: power }, discharge_w: { heater: [0, 0, 0, 0] } });
    oracle = Math.min(oracle, score.total_sek);
  }
  const result = planDispatch(slots, [s], limits);
  const score = scoreDispatch(slots, [s], limits, result);
  assertEquals(score.infeasibilities, []);
  assertAlmostEquals(score.total_sek, oracle);
  assertEquals(result.power_w.heater, [3600, 3600, 3600, 3600]);
});

Deno.test("production materialization and JSON continuation retain an enabled zero-draw startup", () => {
  const input = snapshotV8();
  input.slots = input.slots.slice(0, 4);
  input.outdoor_temperature_c = input.outdoor_temperature_c!.slice(0, 4);
  input.device_models = input.device_models.map(device => ({ ...device, forecast_w_by_slot: device.forecast_w_by_slot.slice(0, 4) }));
  input.battery = null; input.capabilities.battery = false; input.sources.battery = null;
  input.policy = { ...input.policy, battery_end_of_solar_target_soc: 0, battery_target_is_hard: false,
    terminal_soc_min: 0, terminal_energy_value_sek_per_kwh: 0, battery_export_enabled: false,
    battery_export_reserve_soc: 0, battery_export_min_price_sek_per_kwh: 0 };
  input.services = input.services.map(service => ({ ...service, deadline: new Date(Date.parse(input.slots.at(-1)!.start) + 900000).toISOString() }));
  input.captured_at = new Date(Date.parse(input.slots[0].start) + 600000).toISOString();
  input.pool!.heating_running = false;
  input.comfort = { pool: { target_c: 30.5 } };
  input.valuation = { pool: 4 };
  input.pool_model = { loss_kw_per_k: null, rated_cop: null, cop_per_air_c: null, heater_response: model };
  const now = new Date(input.captured_at);
  const expected = generateOptimisationPlan(input, now);
  assertEquals(expected.status, "ready");
  assertEquals(expected.plans.priority.slots[0].pool_command_w, 3500);
  assertEquals(expected.plans.priority.slots[0].pool_w, 0);
  const request = { snapshot: input, now: input.captured_at, price_archive: [] };
  let continuation: EnergyPlanningContinuation = { completed: [] };
  for (let calls = 0; calls < 128; calls++) {
    const step = energyPlanningStep(request, continuation);
    continuation = JSON.parse(JSON.stringify({ completed: [...continuation.completed, ...step.completed], checkpoint: step.checkpoint }));
    if (step.done) {
      assertEquals(assembleOptimisationPlan(request, continuation.completed).plan, expected);
      return;
    }
  }
  throw new Error("Responsive continuation did not finish");
});
