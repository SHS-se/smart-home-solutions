import { assert, assertAlmostEquals } from "@std/assert";
import { chargeDcPower, chargeAcPower, convertedFlows, gridPower, refinedBatteryFlow } from "./battery-conversion.ts";
import vectors from "../../../../contracts/battery-physics-v1.json" with { type: "json" };

Deno.test("tiny battery commands cannot erase independently synthetic installation overhead", () => {
  const model = {
    revision: "synthetic-low-power-overhead-v1",
    grid_charge: { gain: .95, overhead_w: 0 },
    surplus_charge: { gain: .95, overhead_w: 0 },
    discharge: { gain: .97, overhead_w: 170 },
    idle_loss_w: 130,
  };
  const idle = gridPower(model, 0, 0, 0, 800);
  for (const watts of [1, 65, 73, 150, 1000]) {
    assertAlmostEquals(gridPower(model, watts, 0, 0, 800) - idle, watts / .95);
    assert(idle - gridPower(model, 0, watts, 0, 800) <= watts);
  }
  assertAlmostEquals(gridPower(model, 0, 65, 0, 800), 800 + 170 - .97 * 65);
});

Deno.test("active directional overhead is counted once and idle floor survives partial curves", () => {
  const model = {
    revision: "synthetic-partial-overhead-v1",
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

// These vectors are hand-calculated for independently invented equipment and are
// shared with Rust and Python. They are not generated planner snapshots.

Deno.test('refined battery conversion agrees with independent cross-runtime vectors', () => {
  const b = vectors.battery;
  for (const row of vectors.forward) {
    const f = convertedFlows(b.conversion, row.charge_dc_w, row.discharge_dc_w, row.pv_w, row.house_w);
    assertAlmostEquals(f.charge, row.expected.charge_w, 1e-9, row.name);
    assertAlmostEquals(f.discharge, row.expected.discharge_w, 1e-9, row.name);
    assertAlmostEquals(f.idle, row.expected.battery_idle_w, 1e-9, row.name);
    assertAlmostEquals(row.house_w - row.pv_w + f.charge - f.discharge + f.idle, row.expected.net_w, 1e-9, row.name);
    const stored = row.stored_kwh + row.hours / 1000 *
      (row.charge_dc_w * b.charge_efficiency - row.discharge_dc_w / b.discharge_efficiency);
    assertAlmostEquals(stored, row.expected.battery_kwh, 1e-9, row.name);
  }
});

Deno.test('source-specific charging inverse preserves inactive branches and activation gaps', () => {
  for (const row of vectors.charge_inverse) {
    const dc = chargeDcPower(vectors.battery.conversion, row.ac_w, row.pv_w, row.house_w);
    assertAlmostEquals(dc, row.expected_dc_w, 1e-9, row.name);
    const used = chargeAcPower(vectors.battery.conversion, dc, row.pv_w, row.house_w);
    assert(used <= row.ac_w + 1e-9, `${row.name}: inverse exceeded its AC allocation`);
  }
});

Deno.test('refined battery projection respects terminal ratings and stored-energy limits', () => {
  for (const row of vectors.projection) {
    const actual = refinedBatteryFlow(vectors.battery, row);
    for (const key of Object.keys(row.expected) as (keyof typeof row.expected)[]) {
      assertAlmostEquals(actual[key], row.expected[key], 1e-9, `${row.name}: ${key}`);
    }
  }
});
