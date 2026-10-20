import { assertAlmostEquals, assertEquals } from "@std/assert";
import { houseTemperatureForecast, type HouseProfileRow } from "./house-temperature.ts";

const week = (f: (quarter: number) => number, day?: (quarter: number) => number | null): HouseProfileRow[] =>
  Array.from({ length: 96 }, (_v, quarter) => ({ quarter_of_day: quarter, week_mean_c: f(quarter), day_mean_c: day?.(quarter) ?? null }));

Deno.test("the house repeats last week's routine by local time of day", () => {
  // Cooler 22:00-05:00 local, as when the aircons rest overnight.
  const profile = week(q => q >= 88 || q < 20 ? 21.5 : 22.8);
  // 2026-10-20 is summer time in Stockholm: 20:00Z is 22:00 local.
  const forecast = houseTemperatureForecast(["2026-10-20T19:45:00Z", "2026-10-20T20:00:00Z", "2026-10-21T03:00:00Z"],
    "Europe/Stockholm", profile)!;
  assertEquals(forecast, [22.8, 21.5, 22.8]);
});

Deno.test("the last day sets the level and the week the shape", () => {
  const profile = week(q => 22 + q / 96, q => q < 48 ? 21 + q / 96 : null);
  const [first] = houseTemperatureForecast(["2026-10-20T10:00:00Z"], "UTC", profile)!;
  assertAlmostEquals(first, 22 + 40 / 96 - 1, 1e-3);
});

Deno.test("a few missing quarters are bridged, a thin week is no forecast", () => {
  const gaps = week(q => 20 + q * .01).map(row => row.quarter_of_day === 10 ? { ...row, week_mean_c: null } : row);
  assertAlmostEquals(houseTemperatureForecast(["2026-10-20T02:30:00Z"], "UTC", gaps)![0], 20.1, 1e-9);
  assertEquals(houseTemperatureForecast(["2026-10-20T02:30:00Z"], "UTC", week(() => 21).slice(0, 80)), null);
});
