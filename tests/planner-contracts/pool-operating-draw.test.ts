// User requirement, 15 November 2026: keep the home's safety bound available
// for electrical admission and use measured operating evidence for the pool's
// expected draw. Synthetic equipment; expectations are handwritten.
import { assert, assertEquals } from "@std/assert";
import { syntheticHome, withPool } from "./synthetic.ts";
import { poolElectricalDemand, poolElectricalReservation } from "../../supabase/functions/_shared/planner/models/pool/electrical.ts";
import { poolPhysics } from "../../supabase/functions/_shared/planner/pool-physics.ts";
import { runRulesPlanner } from "../../supabase/functions/_shared/run-rules-planner.ts";

/** A heater the home bounds at 3600 W, measured to draw 3000 W while running at its present setting. */
function installation(measuredW: number | null) {
  const s = withPool(syntheticHome(24));
  if (measuredW !== null) s.pool_model!.operating_draw = { member_w: { synthetic_pool: measuredW },
    settings: { synthetic_pool: 12 }, steady_hours: 40, last_observed_at: s.captured_at, basis: "reported_settings" };
  return s;
}

Deno.test("CONTRACT POOL-5: a measured operating point is the expected draw and never lowers the 3600 W reservation", () => {
  const s = installation(3000);
  assertEquals(poolElectricalDemand(s), { compressor_w: 3000, auxiliary_w: 0, member_w: { synthetic_pool: 3000 } });
  assertEquals(poolElectricalReservation(s), { compressor_w: 3600, auxiliary_w: 0 });
  const heater = poolPhysics(s).heater;
  assertEquals([heater.compressor_w, heater.reservation], [3000, { compressor_w: 3600, auxiliary_w: 0 }]);
  // Heat follows the electricity actually drawn: COP 4 of 3000 W, not of 3600 W.
  assertEquals(heater.heat_w, 12000);
  // Without measured evidence the bound stands in, exactly as before.
  const unmeasured = installation(null);
  assertEquals(poolElectricalDemand(unmeasured).compressor_w, 3600);
  assertEquals(poolPhysics(unmeasured).heater.heat_w, 14400);
  assert(!("reservation" in poolPhysics(unmeasured).heater));
  // A measured draw above the bound is still drawn, and reserved.
  assertEquals(poolElectricalReservation(installation(3900)), { compressor_w: 3900, auxiliary_w: 0 });
});

Deno.test("CONTRACT POOL-5: a published plan forecasts the measured draw and admits the car beside the reservation", () => {
  const s = installation(3000);
  // 100 W more than 12 A needs beside the 3600 W bound. Beside the measured
  // 3000 W alone, 13 A (8970 W) would fit; admission must not offer it.
  s.grid.import_limit_w = 500 + 3600 + 3 * 230 * 12 + 100;
  const plan = runRulesPlanner({ snapshot: s, now: s.captured_at, price_archive: [] }).plan;
  const opening = plan.plans.priority.slots[0];
  assertEquals(opening.pool_w, 3000);
  assertEquals(opening.ev_target_current_a, 12);
  assert(opening.grid_import_w <= s.grid.import_limit_w);
});
