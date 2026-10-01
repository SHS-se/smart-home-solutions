import { assert, assertEquals } from "@std/assert";
import { loadPlanner } from "../bench/adapter.ts";
import { loadCase, QUARTERS, type BenchRecorded, type BenchScenarioData } from "../src/lib/planner-bench/case.ts";
import { evaluate } from "../src/lib/planner-bench/evaluate.ts";
import { HOUSEHOLD } from "../src/lib/planner-bench/household.ts";

const root = new URL("..", import.meta.url).pathname;
const START = Date.parse("2026-09-24T07:15:00Z");
const quarters = <T>(make: (i: number) => T): T[] => Array.from({ length: QUARTERS }, (_, i) => make(i));
const hourOf = (i: number) => new Date(START + i * 900_000).getUTCHours();

/** Sunny days, dear evenings, a day and a half of published prices, a cool pool and a car wanting range. */
const dataset = (): BenchScenarioData => ({
  format: "shs-bench-case", version: 1, origin: { kind: "manual", detail: "test", created_at: "2026-09-24T07:15:00Z" },
  start: new Date(START).toISOString(), timezone: "Europe/Stockholm", location: { latitude: 59.4, longitude: 18 },
  known_prices: {
    import_sek_per_kwh: quarters(i => i < 132 ? (hourOf(i) >= 16 && hourOf(i) < 20 ? 3 : 1) : null),
    export_sek_per_kwh: quarters(i => i < 132 ? 0.4 : null),
  },
  solar_forecast_w: quarters(i => hourOf(i) >= 8 && hourOf(i) < 14 ? 5000 : 0),
  base_load_forecast_w: quarters(() => 600),
  other_devices_w: {},
  start_state: { battery_soc: 0.3, pool_water_c: 27.5, ev: { soc: 0.3, plugged_in: true, target_soc: 0.8 } },
  comfort: null,
});
const recorded = (): BenchRecorded => ({
  prices: { import_sek_per_kwh: quarters(i => hourOf(i) >= 16 && hourOf(i) < 20 ? 3 : 1), export_sek_per_kwh: quarters(() => 0.4) },
  outdoor_temperature_c: quarters(() => 12),
  solar_irradiance_w_per_m2: quarters(() => null),
  history: {
    prices: { start: new Date(START - 96 * 900_000).toISOString(), import_sek_per_kwh: new Array(96).fill(1.2), export_sek_per_kwh: new Array(96).fill(0.4) },
    grid_import_kwh: { start: "2026-08-31T22:00:00.000Z", kwh: [] },
  },
  recorded_at: "2026-09-28T00:00:00Z",
});

Deno.test("the current planner plans a bench case built from nothing but the case and the household", async () => {
  const planner = await loadPlanner(root);
  assertEquals(planner.generation, "snapshot");
  const c = loadCase(dataset(), recorded());
  const { record } = planner.plan(c, HOUSEHOLD);
  assertEquals(record.status, "ready");
  // It works its own curves out: the battery's from the forecast, the pool's and the car's from comfort.
  assertEquals(record.curves.map(curve => curve.store).sort(), ["battery", "ev", "pool"]);
  assertEquals(record.curves.find(curve => curve.store === "battery")!.mode, "balanced");
  // And it estimates the unpublished prices itself.
  assert(record.beliefs.import_sek_per_kwh.every(price => typeof price === "number" && price > 0));

  const { outcome, stats } = evaluate(c, record, {});
  assert(stats.pool_kwh > 1 && stats.ev_kwh > 1 && stats.battery_charge_kwh > 1, JSON.stringify(stats));
  // The referee's physics and the planner's agree on what the household can do.
  assert(outcome.violations.length <= 2, JSON.stringify(outcome.violations.slice(0, 5)));
});
