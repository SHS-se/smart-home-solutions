import { heatingWatts, readWeatherHeating } from "../planner/weather-heating.ts";
import { assertEquals, assertAlmostEquals } from "@std/assert";
import { fitWeatherHeating } from "./weather-heating.ts";

Deno.test("weather heating keeps cold evidence and limits support to observed temperatures", () => {
  const cold = [{ day: "2025-12-01", outdoor_c: -6, watts: 950, hours: 3 },
    { day: "2025-12-02", outdoor_c: -6, watts: 1050, hours: 2 }];
  const mild = Array.from({ length: 60 }, (_, i) => ({ day: String(i), outdoor_c: 6, watts: 400, hours: 1 }));
  const profile = fitWeatherHeating("old-meter", [...cold, ...mild]);
  assertEquals(profile.points.map(p => [p.watts, p.days, p.hours, p.spread_w]), [[1000, 2, 5, 50], [400, 60, 60, 0]]);
  assertEquals(heatingWatts(profile, -6), 1000);
  assertEquals(heatingWatts(profile, 0), 700);
  assertEquals(heatingWatts(profile, 6), 400);
  assertEquals(heatingWatts(profile, -7), null);
  assertEquals(heatingWatts(profile, null), null);
  assertEquals(readWeatherHeating(profile, "new-meter"), null);
  assertEquals(readWeatherHeating(profile, "old-meter"), profile);
});

Deno.test("weather heating retains bounded deterministic summaries without using missing data", () => {
  const samples = Array.from({ length: 90 }, (_, i) => ({ day: String(i), outdoor_c: i - 45, watts: 600 - 4 * i, hours: 1 }));
  const profile = fitWeatherHeating("meter", [...samples, { day: "missing", outdoor_c: 70, watts: NaN, hours: 1 }]);
  assertEquals(profile.points.length, 10);
  assertEquals(profile.points[0].min_c, -45);
  assertEquals(profile.points.at(-1)?.max_c, 44);
  assertAlmostEquals(profile.points.reduce((sum, p) => sum + p.hours, 0), 90);
  assertEquals(heatingWatts(profile, 70), null);
  assertEquals(readWeatherHeating(fitWeatherHeating("meter", samples.slice(0, 1)), "meter"), null);
});
