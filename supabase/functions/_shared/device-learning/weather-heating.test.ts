import { heatingDraw, heatingWatts, readWeatherHeating } from "../planner/weather-heating.ts";
import { assertEquals, assertAlmostEquals } from "@std/assert";
import { advanceWeatherHeatingBands, fitWeatherHeating, WEATHER_HEATING_BAND_IMPLEMENTATION } from "./weather-heating.ts";

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

Deno.test("an empirical electrical refit immediately replaces only its own independently measured band", () => {
  const days = (start: number, end: number, outdoor_c: number, watts: number) =>
    Array.from({ length: end - start + 1 }, (_, index) => ({
      day: new Date(Date.UTC(2026, 9, start + index)).toISOString().slice(0, 10), outdoor_c, watts, hours: 2,
      evidence_updated_at: new Date(Date.UTC(2026, 9, end + 1)).toISOString(),
    }));
  const cold = days(1, 2, -7, 1100);
  const mild = [...days(3, 3, 5.3, 650), ...days(4, 4, 6, 650)];
  let profile = advanceWeatherHeatingBands("meter", null, cold, "2026-10-03");
  profile = advanceWeatherHeatingBands("meter", profile, [...cold, ...mild], "2026-10-05");
  const [oldCold] = profile.points;
  const refit = days(8, 11, 6, 450);
  profile = advanceWeatherHeatingBands("meter", profile, [...cold, ...mild, ...refit], "2026-10-12");
  assertEquals(profile.points.map(point => point.watts), [1100, 450]);
  assertEquals(profile.versioned?.candidates, []);
  assertEquals(profile.points[0], oldCold);
  assertEquals(heatingWatts(profile, 5.3), 450);
  assertEquals(heatingWatts(profile, 6), 450);
  assertEquals(heatingWatts(profile, 5), 450);
  assertEquals(heatingWatts(profile, 9.999), 450);
  assertEquals(heatingWatts(profile, 10), null);
});

Deno.test("electrical quarter forecasts use the whole fixed band rather than observed edges", () => {
  const profile = advanceWeatherHeatingBands("meter", null, measured(), "2026-01-05");
  const revision = (profile.points[0] as { revision?: string }).revision;
  assertEquals([-10,-9,-7,-5.001,-5].map(c => heatingDraw(profile,c)?.band?.revision ?? null),
    [revision,revision,revision,revision,null]);
});

const measured = (watts = 900, updated = "2026-01-04T00:00:00Z") => [
  { day: "2026-01-01", outdoor_c: -7, watts, hours: 3, evidence_updated_at: updated },
  { day: "2026-01-02", outdoor_c: -6, watts, hours: 2, evidence_updated_at: updated },
];

Deno.test("corrected electrical evidence refits unchanged latest dates without requiring future samples", () => {
  const old = advanceWeatherHeatingBands("meter", null, measured(), "2026-01-05");
  const corrected = advanceWeatherHeatingBands("meter", old, measured(750, "2026-01-05T00:00:00Z"), "2026-01-06");
  assertEquals(corrected.points[0].watts, 750);
  assertEquals(corrected.versioned?.attempted[-10], old.versioned?.attempted[-10]);
  assertEquals(corrected.points[0].hours, 5);
  assertEquals(corrected.versioned?.pending_bands, 0);
  assertEquals(corrected.versioned?.implementation, WEATHER_HEATING_BAND_IMPLEMENTATION);
});

Deno.test("missing heating, withdrawn readings, and retention expiry never become zero-power replacements", () => {
  const old = advanceWeatherHeatingBands("meter", null, measured(), "2026-01-05");
  assertEquals(advanceWeatherHeatingBands("meter", old, [], "2026-01-06").points, old.points);
  assertEquals(advanceWeatherHeatingBands("meter", old, measured().slice(1), "2026-01-06").points, old.points);
  const withdrawn = advanceWeatherHeatingBands("meter", old, [
    { day: "2026-01-02", outdoor_c: -10, watts: null, hours: 0, evidence_updated_at: "2026-01-06T00:00:00Z" },
  ], "2026-01-07");
  assertEquals(withdrawn.points, old.points);
  assertEquals(withdrawn.versioned?.evidence_updated_at?.[-10], "2026-01-06T00:00:00Z");
  assertEquals(withdrawn.versioned?.pending_bands, 0);
});

Deno.test("each electrical band drains independently and algorithm changes reconsider retained evidence", () => {
  const cold = measured(), warm = measured(400).map(row => ({ ...row, outdoor_c: 8 }));
  let profile = advanceWeatherHeatingBands("meter", null, [...cold, ...warm], "2026-01-05");
  assertEquals(profile.points.length, 1);
  assertEquals(profile.versioned?.pending_bands, 1);
  profile = advanceWeatherHeatingBands("meter", profile, [...cold, ...warm], "2026-01-05");
  assertEquals(profile.points.length, 2);
  assertEquals(profile.versioned?.pending_bands, 0);
  const previousRevisions = profile.points.map(point => (point as { revision?: string }).revision);
  profile.versioned!.implementation = "older-learner";
  profile = advanceWeatherHeatingBands("meter", profile, [...cold, ...warm], "2026-01-05");
  assertEquals(profile.points.length, 2);
  assertEquals(profile.versioned?.pending_bands, 1);
  assertEquals(profile.points.map(point => (point as { revision?: string }).revision).filter(revision => previousRevisions.includes(revision)).length, 1);
});
