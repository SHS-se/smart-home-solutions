import { assert, assertEquals } from "jsr:@std/assert@1";
import { syntheticOvernightReadiness } from "../../../../scripts/ev-readiness-synthetic.fixture.ts";
import { nativePlanner } from "./runtime.ts";

Deno.test("expected driving makes the EV buy ahead of a high-price period", () => {
  const problem = syntheticOvernightReadiness().problem;
  problem.accepted = null;
  problem.locked_through_seconds = 0;
  problem.battery = null;
  problem.initial.battery_kwh = null;
  problem.end_credit.battery = null;
  problem.initial.ev_kwh = 20;
  problem.end_credit.ev = { grid_kwh_per_unit: 1 / 0.92, tiers: [{ up_to: 40, sek_per_kwh: 0.8 }] };
  problem.car_policy.breach_permille = problem.slots.map(() => 199);
  problem.slots = problem.slots.map((slot, i) => ({ ...slot, solar_w: 0, import_price: i < 20 ? 1 : 3 }));
  const engine = nativePlanner();
  const stationary = engine.solve(problem).outcome;
  const driving = engine.solve({ ...problem,
    slots: problem.slots.map((slot, i) => ({ ...slot, ev_usage_kw: i < 20 ? 0 : 1 })) }).outcome;
  assert(stationary.kind === "selected" && driving.kind === "selected");
  assert(stationary.selection.quarters.every(slot => slot.ev_w === 0));
  assert(driving.selection.quarters.slice(0, 20).some(slot => slot.ev_w > 0));
  assert(driving.selection.quarters.slice(20).every(slot => slot.ev_w === 0));
  assertEquals(driving.selection.quarters.reduce((sum, slot) => sum + slot.ev_usage_unserved_kwh, 0), 0);
});
