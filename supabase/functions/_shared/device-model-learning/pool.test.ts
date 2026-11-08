import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { WATER_KWH_PER_M3_K } from "../planner/device-models.ts";
import { SYNTHETIC_POOL_CAPACITY, syntheticPoolMeanHistory } from "../pool-model-selection.fixture.ts";
import type { PoolDynamics } from "../device-learning/pool/response.ts";
import { fitStoredPool } from "./pool.ts";

Deno.test("the pool refit records isolated temperature estimates and retains the thermal response", async () => {
  const history = syntheticPoolMeanHistory(false).slice(0, 10 * 96);
  const water = history.map((row, i) => ({
    start_ts: new Date(row.start_ms).toISOString(),
    water_temperature_c: row.water_temperature_c + (i === 100 || i === 900 ? 18 : 0),
  }));
  const rows: Record<string, unknown[]> = {
    energy_optimisation_pool_slots: water,
    energy_optimisation_outdoor_slots: [],
    energy_optimisation_device_slots: history.map(row => ({
      start_ts: new Date(row.start_ms).toISOString(),
      device_id: "heater",
      energy_kwh: row.electrical_kwh,
    })),
  };
  const db = { from(table: string) {
    const query = {
      select: () => query, eq: () => query, gte: () => query, order: () => query,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      in: () => table === "energy_optimisation_devices"
        ? Promise.resolve({ data: [{ id: "heater", device_key: "heater" }], error: null }) : query,
      range: (from: number, to: number) => Promise.resolve({ data: rows[table].slice(from, to + 1), error: null }),
    };
    return query;
  } };
  const row = await fitStoredPool(db, "customer", "home", SYNTHETIC_POOL_CAPACITY / WATER_KWH_PER_M3_K,
    ["heater"], history.length * 900_000);
  assert(row);
  const evidence = row.last_fit_attempt as { learning: { estimated_temperature_readings: number } };
  assertEquals(evidence.learning.estimated_temperature_readings, 2);
  const dynamics = row.thermal_dynamics as PoolDynamics;
  assertAlmostEquals(dynamics.heat_c_per_kwh, 4.5 / SYNTHETIC_POOL_CAPACITY, .002);
  assert(dynamics.rmse_c < .01);
  assert(water[100].water_temperature_c > 40);
});
