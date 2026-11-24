import { assertEquals } from "jsr:@std/assert@1";
import { fitStoredWeatherHeating } from "./weather-heating.ts";
import type { ModelDatabase } from "../device-model-store.ts";

// Independently generated synthetic intervals, not household captures.
const NOW = Date.UTC(2026, 0, 3);
const binding = "climate.synthetic|sensor.synthetic_power|sensor.synthetic_energy";
const hours = Array.from({ length: 48 }, (_, h) => [NOW / 1000 - (48 - h) * 3600, 3600,
  h % 24 < 6 ? 0.04 : 1, -8, h % 24 === 6 ? 2900 : 1600]);

const database = (intervals: unknown, fail = false) => ({
  rpc: (name: string) => {
    if (name === "get_energy_heat_pump_intervals") {
      return Promise.resolve(fail ? { data: null, error: { message: "synthetic timeout" } } : { data: intervals, error: null });
    }
    return Promise.resolve({ data: [], error: null });
  },
}) as unknown as ModelDatabase;

Deno.test("a heat pump's refit carries its start-up model beside the draw", async () => {
  const row = await fitStoredWeatherHeating(database(hours), "home", "customer", "pump", binding, null, NOW, true);
  const points = row.operating_points as Record<string, unknown> & { heat_pump: { bands: { start_peak_w: number }[] } };
  assertEquals(points.binding, binding);
  assertEquals(points.heat_pump.bands[0].start_peak_w, 2900);
});

Deno.test("any other device has no start-up model", async () => {
  const row = await fitStoredWeatherHeating(database(null), "home", "customer", "heater", binding, null, NOW, true);
  assertEquals(Object.hasOwn(row.operating_points as object, "heat_pump"), false);
});

Deno.test("a failed interval read keeps the last start-up model and the draw refit still publishes", async () => {
  const previous = { heat_pump: { method: "heat_pump_startup_v1", bands: [] } };
  const row = await fitStoredWeatherHeating(database(null, true), "home", "customer", "pump", binding, previous, NOW, true);
  assertEquals((row.operating_points as { heat_pump: unknown }).heat_pump, previous.heat_pump);
  assertEquals((row.last_fit_attempt as { issues: string[] }).issues.includes("heat_pump_startup_unavailable"), true);
});
