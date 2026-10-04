import { assert, assertEquals } from "jsr:@std/assert@1";
import { planDispatch, scoreDispatch, type DispatchStore, type DispatchSlot } from "./planner/dispatch-plan.ts";
import { dispatchWithPrefix } from "./planner/fixed-energy-plan.ts";

const limits = { grid_import_limit_w: 10000, grid_export_limit_w: 10000,
  grid_import_shaping_w: 10000, peak_shaping_sek_per_kwh_per_kw: 0 };
const slots = (prices: number[], hours = prices.map(() => 0.25)): DispatchSlot[] => prices.map((price, index) => ({
  duration_hours: hours[index], pv_w: 0, fixed_load_w: 500, import_price_sek_per_kwh: price,
  export_price_sek_per_kwh: 0, binding: true, published_price: true,
}));
const store = (count: number): DispatchStore => ({ key: "pool", initial_state: 0, max_state: 1,
  min_power_w: 1000, max_power_w: 1000, retention_per_slot: 1,
  curve: { unit: "celsius", points: [{ at: 0, sek_per_unit: 4 }, { at: 1, sek_per_unit: 0 }] },
  usage_weight: new Array(count).fill(0), terminal_weight: 1,
  drift: state => state, units_per_kwh: () => 1 });

Deno.test("a running pool above its ceiling stops even in a partial quarter", () => {
  const input = slots([20, 20, 20, 20], [0.1, 0.25, 0.25, 0.25]);
  const pool = { ...store(4), initial_state: 2, initially_charging: true, slot_hours: input.map(slot => slot.duration_hours!) };
  const plan = planDispatch(input, [pool], limits);
  assertEquals(plan.power_w.pool, [0, 0, 0, 0]);
  assertEquals(scoreDispatch(input, [pool], limits, plan).infeasibilities, []);
  assertEquals(plan.state.pool.at(-1), 2);
});

Deno.test("one cheap quarter can heat without committing to later expensive quarters", () => {
  const input = slots([0.1, 20, 20, 20]);
  const device = store(4);
  const plan = planDispatch(input, [device], limits);
  assertEquals(plan.power_w.pool, [1000, 0, 0, 0]);
  assertEquals(scoreDispatch(input, [device], limits, plan).infeasibilities, []);
  assert(plan.state.pool.at(-1)! > 0);
});

Deno.test("a fixed prefix start creates no runtime obligation for its suffix", () => {
  const input = slots([0.1, 20, 20, 20]);
  const device = store(4);
  const plan = dispatchWithPrefix(input, [device], limits,
    { power_w: { pool: [1000] }, discharge_w: { pool: [0] } }, 1);
  assertEquals(plan.power_w.pool, [1000, 0, 0, 0]);
  assertEquals(scoreDispatch(input, [device], limits, plan).infeasibilities, []);
});
