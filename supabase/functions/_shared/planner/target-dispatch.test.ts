import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { planDispatch, scoreDispatch, type DispatchSlot, type DispatchStore } from "./dispatch-plan.ts";
import { targetEconomics } from "./target-economics.ts";
import { heaterInputResponse } from "./heat-pump-dispatch.ts";

const limits = { grid_import_limit_w: 10000, grid_export_limit_w: 10000,
  grid_import_shaping_w: 10000, peak_shaping_sek_per_kwh_per_kw: 0 };
const slots: DispatchSlot[] = [4, .1, .1, 4].map(price => ({ pv_w: 0, fixed_load_w: 0,
  import_price_sek_per_kwh: price, export_price_sek_per_kwh: 0 }));

/** Independent small oracle: integrate capped target service and actual meter draw. */
function targetCost(store: DispatchStore, power: number[], target: number, value: number): number {
  const projection = store.input_response?.project(power, power.map(() => .25));
  let state = store.initial_state, cost = 0;
  for (let i = 0; i < power.length; i++) {
    cost -= (store.usage_weight[i] ?? 0) * value * (Math.min(state, target) - Math.min(store.initial_state, target));
    const draw = projection?.draw_w[i] ?? power[i];
    cost += draw / 4000 * slots[i].import_price_sek_per_kwh;
    if (power[i] > 0 && (i === 0 || power[i - 1] === 0)) cost += store.start_cost_sek ?? 0;
    state = state + power[i] / 4000 * (projection?.gain_fraction[i] ?? 1);
    if (state > store.max_state! + 1e-9) return Infinity;
  }
  return cost - (store.terminal_weight ?? 0) * value * (Math.min(state, target) - Math.min(store.initial_state, target));
}

for (const [native, event] of [[false, false], [false, true], [true, false]]) Deno.test(`${native ? "native pool" : event ? "EV departure" : "discrete EV"} target scheduling matches an independent exhaustive service oracle`, () => {
  const target = native ? 1.25 : .75;
  const economics = targetEconomics({ unit: native ? "celsius" : "km", target, step: .25,
    units_per_kwh: 1, reference_sek_per_kwh: .5, scale: 1,
    timing: event ? { kind: "event", slot: 2, slots: 4 } : { kind: "held", slot_hours: [.25, .25, .25, .25] } });
  const store: DispatchStore = { key: native ? "pool" : "ev", curve: economics.curve,
    initial_state: 0, max_state: 2, min_power_w: native ? 3600 : 1000,
    max_power_w: native ? 3600 : 2000, power_step_w: native ? 3600 : 1000,
    retention_per_slot: 1, usage_weight: economics.usage_weight,
    terminal_weight: economics.terminal_weight, units_per_kwh: () => 1, drift: state => state,
    start_cost_sek: native ? .2 : 0,
    ...(native ? { input_response: heaterInputResponse({ kind: "bergvarme", startup: [
      { elapsed_seconds: 0, electric_fraction: 0, heat_fraction: 0 },
      { elapsed_seconds: 300, electric_fraction: 0, heat_fraction: 0 },
      { elapsed_seconds: 900, electric_fraction: 1, heat_fraction: 1 },
    ] }, { compressor_w: 3000, auxiliary_w: 600 }, null) } : {}) };
  const choices = native ? [0, 3600] : [0, 1000, 2000];
  let oracle = Infinity;
  for (let n = 0; n < choices.length ** 4; n++) {
    let code = n;
    const power = slots.map(() => { const watts = choices[code % choices.length]; code = Math.floor(code / choices.length); return watts; });
    oracle = Math.min(oracle, targetCost(store, power, target, 1.5));
  }
  const result = planDispatch(slots, [store], limits);
  const score = scoreDispatch(slots, [store], limits, result);
  assertEquals(score.infeasibilities, []);
  assertAlmostEquals(targetCost(store, result.power_w[store.key], target, 1.5), oracle);
  assertAlmostEquals(score.total_sek, oracle);
  assert(result.power_w[store.key][1] > 0, "missed the cheap period");
});
