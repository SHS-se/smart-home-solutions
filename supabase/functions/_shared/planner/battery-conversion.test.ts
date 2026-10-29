import { assert, assertAlmostEquals } from "@std/assert";
import { gridPower } from "./battery-conversion.ts";

Deno.test("tiny battery commands cannot erase measured installation overhead", () => {
  const model = {
    revision: "diagnostics18",
    grid_charge: { gain: .95, overhead_w: 0 },
    surplus_charge: { gain: .95, overhead_w: 0 },
    discharge: { gain: .9885020822325284, overhead_w: 162.58072673773927 },
    idle_loss_w: 125.82819513666756,
  };
  const idle = gridPower(model, 0, 0, 0, 808);
  for (const watts of [1, 65, 73, 150, 1000]) {
    assertAlmostEquals(gridPower(model, watts, 0, 0, 808) - idle, watts / .95);
    assert(idle - gridPower(model, 0, watts, 0, 808) <= watts);
  }
  assertAlmostEquals(gridPower(model, 0, 65, 0, 808), 808 + 162.58072673773927 - .9885020822325284 * 65);
});

Deno.test("active fitted overhead is counted once and idle floor survives partial fits", () => {
  const model = {
    revision: "fits",
    grid_charge: { gain: .95, overhead_w: 100 },
    surplus_charge: { gain: .98, overhead_w: 20 },
    discharge: { gain: .99, overhead_w: 160 },
    idle_loss_w: 30,
  };
  assertAlmostEquals(gridPower(model, 950, 0, 0, 1000), 1000 + 1050 / .95);
  assertAlmostEquals(gridPower(model, 0, 2000, 0, 1000), 1000 - (.99 * 2000 - 160));
  // Solar curve accounts for only ~20 W; preserve the remaining site overhead.
  assertAlmostEquals(gridPower(model, 980, 0, 3000, 1000), 1000 - 3000 + 1000 + 30);
});
