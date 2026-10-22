import { assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import { forecastGenerationMix, scoreGenerationRuns, type GenerationPrediction } from "../supabase/functions/_shared/generation-mix.ts";
import type { EntsoeInterval } from "../supabase/functions/_shared/entsoe-market-data.ts";
import { parseMediumRangeWeather } from "../supabase/functions/_shared/medium-range-weather.ts";
import { mediumRangeWeatherFixture } from "./medium-range-weather.fixture.ts";

const HOUR = 3_600_000;
const ORIGIN = "2026-10-22T12:00:00.000Z";
function interval(start: string, mw: number, psrType = "B14", duration = HOUR, flow: EntsoeInterval["flow"] = "production"): EntsoeInterval {
  return { startMs: Date.parse(start), endMs: Date.parse(start) + duration, value: mw,
    psrType, flow, unit: "MAW", resolution: duration === HOUR ? "PT60M" : "PT15M", businessType: "A01", seriesId: null };
}
function value(prediction: GenerationPrediction): number {
  if (prediction.status !== "predicted") throw new Error(prediction.reason);
  return prediction.mw;
}
function weather(times: string[]) {
  return parseMediumRangeWeather(mediumRangeWeatherFixture(times), ORIGIN);
}
const forecast = (actuals: EntsoeInterval[], origin = ORIGIN) => forecastGenerationMix({ origin, actuals, weather: null, published: [] });

Deno.test("generation panel has 72 distinct hourly targets, exact algorithm and observed production types only", () => {
  const run = forecast([
    interval("2026-10-22T10:00Z", 100), interval("2026-10-22T11:00Z", 200),
    interval("2026-10-22T12:00Z", 999999, "B16"),
    interval("2026-10-22T10:00Z", 999, "B10", HOUR, "consumption"),
    interval("2026-10-22T10:00Z", 777, "B11", HOUR, null),
  ], "2026-10-22T12:30Z");
  assertEquals([run.algorithm, run.zone, run.origin], ["se3-generation-analog-v1", "SE3", "2026-10-22T12:30:00.000Z"]);
  assertEquals(run.hours.length, 72);
  assertEquals(run.hours[0].start, "2026-10-22T13:00:00.000Z");
  assertEquals(run.hours[71].start, "2026-10-25T12:00:00.000Z");
  assertEquals(Object.keys(run.hours[0].byPsr), ["B14"]);
  assertEquals(run.hours[0].byPsr.B14.persistence, {
    status: "predicted", mw: 200, trainingSamples: 1, latestTrainingEnd: "2026-10-22T12:00:00.000Z",
  });
  assertEquals(run.training.B14, { hours: 2, firstStart: "2026-10-22T10:00:00.000Z", lastEnd: ORIGIN, weatherHours: 0 });
  assertEquals(run.hours[0].byPsr.B14.weather.status, "unavailable");
  assertThrows(() => forecast([], "invalid-time"));
});

Deno.test("generation hours duration-weight quarters and union equal duplicate coverage once", () => {
  const rows = [10, 20, 30, 40].map((mw, index) => interval(new Date(Date.parse(ORIGIN) - HOUR + index * HOUR / 4).toISOString(), mw, "B19", HOUR / 4));
  rows.push({ ...rows[0] }, { ...rows[2] });
  const run = forecast(rows);
  assertEquals(value(run.hours[0].byPsr.B19.persistence), 25);
  assertEquals(run.training.B19.hours, 1);
  // An equal-valued enclosing interval is also a union, not double-counted power.
  const equal = forecast([interval("2026-10-22T11:00Z", 40), interval("2026-10-22T11:15Z", 40, "B14", HOUR / 4)]);
  assertEquals(value(equal.hours[0].byPsr.B14.persistence), 40);
});

Deno.test("generation gaps and conflicting overlaps stay unavailable, never become zero or a partial mean", () => {
  for (const rows of [
    [interval("2026-10-22T11:00Z", 10, "B14", HOUR / 4)],
    [interval("2026-10-22T11:00Z", 10), interval("2026-10-22T11:15Z", 20, "B14", HOUR / 4)],
  ]) {
    const run = forecast(rows);
    assertEquals(run.training.B14.hours, 0);
    assertEquals(run.hours[0].byPsr.B14.persistence.status, "unavailable");
    assertEquals(run.hours[0].byPsr.B14.calendar.status, "unavailable");
    assertEquals(run.diagnostics.actuals.completeHours, 0);
  }
});

Deno.test("generation ignores consumption, unknown direction, units and future native labels", () => {
  const base = interval("2026-10-22T10:00Z", 80);
  const rows = [base, interval("2026-10-22T10:00Z", 999, "B14", HOUR, "consumption"),
    interval("2026-10-22T10:00Z", 888, "B14", HOUR, null),
    { ...base, value: 777, unit: "MWH" }, interval("2026-10-22T12:00Z", 1000000),
    interval("2026-10-22T11:00Z", 10000, "B14", 2 * HOUR)];
  const run = forecast(rows);
  assertEquals(value(run.hours[0].byPsr.B14.persistence), 80);
  assertEquals(run.training.B14.hours, 1);
});

Deno.test("calendar analog matches Stockholm hour and weekday/weekend independently of persistence", () => {
  const run = forecast([
    interval("2026-10-17T08:00Z", 10), interval("2026-10-18T08:00Z", 20),
    interval("2026-10-19T08:00Z", 1000), interval("2026-10-18T09:00Z", 2000),
  ], "2026-10-24T08:00Z");
  assertEquals(value(run.hours[0].byPsr.B14.calendar), 15);
  assertEquals(value(run.hours[0].byPsr.B14.persistence), 1000);
  assertEquals(run.hours[1].byPsr.B14.calendar.status, "predicted");
  assertEquals(value(run.hours[1].byPsr.B14.calendar), 2000);
});

Deno.test("calendar analog keeps both Stockholm repeated DST hours as separate UTC predictions", () => {
  const run = forecast([interval("2026-10-18T00:00Z", 21)], "2026-10-25T00:00Z");
  assertEquals(run.hours.slice(0, 2).map(hour => hour.start), ["2026-10-25T00:00:00.000Z", "2026-10-25T01:00:00.000Z"]);
  assertEquals(run.hours.slice(0, 2).map(hour => value(hour.byPsr.B14.calendar)), [21, 21]);
  assertEquals(new Set(run.hours.map(hour => hour.start)).size, 72);
});

Deno.test("wind analog learns MW from ten-site pairs with train-only scaling and excludes future labels", () => {
  const times = ["2026-10-22T09:00", "2026-10-22T10:00", "2026-10-22T12:00", "2026-10-22T13:00"];
  const drivers = weather(times);
  for (const site of drivers.sites) {
    site.series.wind_speed_10m = [1, 9, 9, 1e12];
    site.series.wind_speed_120m = [1, 9, 9, 1e12];
  }
  const actuals = [interval(`${times[0]}Z`, 100, "B19"), interval(`${times[1]}Z`, 900, "B19"),
    interval(`${times[2]}Z`, 1e9, "B19")];
  const run = forecastGenerationMix({ origin: ORIGIN, actuals, weather: drivers, published: [] });
  assertAlmostEquals(value(run.hours[0].byPsr.B19.weather), (900 + 100 / 5) / (1 + 1 / 5));
  assertEquals(run.training.B19.weatherHours, 2);
  const next = structuredClone(drivers);
  for (const site of next.sites) { site.series.wind_speed_10m[3] = 0; site.series.wind_speed_120m[3] = 0; }
  assertEquals(forecastGenerationMix({ origin: ORIGIN, actuals, weather: next, published: [] }).hours[0], run.hours[0]);
});

Deno.test("solar analog shifts preceding-hour radiation to the MW interval it actually represents", () => {
  const times = ["2026-10-22T09:00", "2026-10-22T10:00", "2026-10-22T11:00", "2026-10-22T12:00", "2026-10-22T13:00"];
  const drivers = weather(times);
  for (const site of drivers.sites) site.series.shortwave_radiation = [999, 0, 100, 0, 100];
  const run = forecastGenerationMix({ origin: ORIGIN, actuals: [interval(`${times[0]}Z`, 0, "B16"), interval(`${times[1]}Z`, 100, "B16")], weather: drivers, published: [] });
  assertAlmostEquals(value(run.hours[0].byPsr.B16.weather), 100 / 1.2);
  assertEquals(run.training.B16.weatherHours, 2);
});

Deno.test("weather missing at a single site disables that target independently, without model substitution", () => {
  const drivers = weather(["2026-10-22T10:00", "2026-10-22T11:00", "2026-10-22T12:00"]);
  const actuals = [interval("2026-10-22T10:00Z", 100, "B19"), interval("2026-10-22T11:00Z", 200, "B19")];
  drivers.sites[0].series.wind_speed_120m[1] = null;
  drivers.sites[9].series.wind_speed_10m[2] = null;
  const run = forecastGenerationMix({ origin: ORIGIN, actuals, weather: drivers, published: [] });
  assertEquals(run.training.B19.weatherHours, 1);
  assertEquals(run.hours[0].byPsr.B19.weather.status, "unavailable");
  assertEquals(value(run.hours[0].byPsr.B19.persistence), 200);
  const missingSite = structuredClone(drivers);
  missingSite.sites.pop();
  const short = forecastGenerationMix({ origin: ORIGIN, actuals, weather: missingSite, published: [] });
  assertEquals(short.training.B19.weatherHours, 0);
  assertEquals(short.diagnostics.weather.status, "unavailable");
});

Deno.test("published MW is a separate complete-production comparator, never weather or empirical substitution", () => {
  const input = { origin: ORIGIN, actuals: [interval("2026-10-22T11:00Z", 40, "B19")], weather: null,
    published: [interval("2026-10-22T12:00Z", 123, "B19"), interval("2026-10-22T13:00Z", 200, "B19", HOUR / 4),
      interval("2026-10-22T14:00Z", 300, "B19", HOUR, "consumption"), interval("2026-10-22T12:00Z", 5, "B16")] };
  const run = forecastGenerationMix(input);
  assertEquals(run.hours[0].byPsr.B19.published, { status: "predicted", mw: 123, trainingSamples: 0, latestTrainingEnd: null });
  assertEquals(run.hours[1].byPsr.B19.published.status, "unavailable");
  assertEquals(run.hours[2].byPsr.B19.published.status, "unavailable");
  assertEquals(Object.keys(run.hours[0].byPsr), ["B19"]);
});

Deno.test("empty source failure still returns a diagnostic run without invented PSR zeros", () => {
  const run = forecast([]);
  assertEquals(run.hours.length, 72);
  assertEquals(run.hours[0].byPsr, {});
  assertEquals(run.training, {});
  assertEquals(run.diagnostics.actuals.completeHours, 0);
  assertEquals(run.diagnostics.actuals.reason !== null, true);
  assertEquals(run.diagnostics.published.reason !== null, true);
  assertEquals(run.diagnostics.weather.status, "unavailable");
  assertEquals(scoreGenerationRuns([run], []), []);
});

Deno.test("generation scoring counts later complete actuals, model coverage, lead bands and distinct local dates", () => {
  const run = forecast([interval("2026-10-22T11:00Z", 100)]);
  const actuals = [interval("2026-10-22T12:00Z", 90), interval("2026-10-22T23:00Z", 120),
    interval("2026-10-23T12:00Z", 140), interval("2026-10-24T12:00Z", 160),
    interval("2026-10-22T13:00Z", 999, "B14", HOUR / 4)];
  const results = scoreGenerationRuns([run, structuredClone(run)], actuals);
  assertEquals(results.map(score => ({ psrType: score.psrType, model: score.model, lead: score.lead,
    hours: score.hours, origins: score.origins, targetDays: score.targetDays, maeMw: score.maeMw, biasMw: score.biasMw })), [
    { psrType: "B14", model: "persistence", lead: "0–24h", hours: 2, origins: 1, targetDays: 2, maeMw: 15, biasMw: -5 },
    { psrType: "B14", model: "persistence", lead: "24–48h", hours: 1, origins: 1, targetDays: 1, maeMw: 40, biasMw: -40 },
    { psrType: "B14", model: "persistence", lead: "48–72h", hours: 1, origins: 1, targetDays: 1, maeMw: 60, biasMw: -60 },
  ]);
  assertEquals(results.map(score => score.pairedBaseline), [15, 40, 60].map((mae, index) => ({
    persistence: { hours: index === 0 ? 2 : 1, origins: 1, targetDays: index === 0 ? 2 : 1,
      baselineMaeMw: mae, candidateMaeMw: mae, deltaMaeMw: 0 }, calendar: null,
  })));
  const conflicting = [...actuals, interval("2026-10-22T12:00Z", 95)];
  assertEquals(scoreGenerationRuns([run], conflicting)[0].hours, 1);
});

Deno.test("paired scores compare partial weather/published coverage against each baseline on identical targets", () => {
  const run = forecast([interval("2026-10-22T11:00Z", 100, "B19")]);
  const prediction = (mw: number): GenerationPrediction => ({ status: "predicted", mw,
    trainingSamples: 1, latestTrainingEnd: ORIGIN });
  const missing: GenerationPrediction = { status: "unavailable", reason: "Fixture has no matching input." };
  const first = run.hours[0].byPsr.B19, second = run.hours[1].byPsr.B19, third = run.hours[2].byPsr.B19;
  first.calendar = prediction(90); second.calendar = missing; third.calendar = prediction(1000);
  first.weather = missing; second.weather = prediction(1000); third.weather = prediction(1000);
  first.published = prediction(110);
  const actuals = [interval("2026-10-22T12:00Z", 100, "B19"), interval("2026-10-22T13:00Z", 1000, "B19"),
    interval("2026-10-22T14:00Z", 1000, "B19")];
  const scores = scoreGenerationRuns([run], actuals);
  const published = scores.find(score => score.model === "published")!;
  const wind = scores.find(score => score.model === "weather")!;
  assertEquals(scores.find(score => score.model === "persistence")!.maeMw, 600);
  assertEquals(published.maeMw, 10); // The independent means misleadingly suggest improvement.
  assertEquals(published.pairedBaseline.persistence, { hours: 1, origins: 1, targetDays: 1,
    baselineMaeMw: 0, candidateMaeMw: 10, deltaMaeMw: 10 }); // Same targets show deterioration.
  assertEquals(scores.find(score => score.model === "calendar")!.maeMw, 5);
  assertEquals(wind.maeMw, 0); // Independent weather/calendar means suggest improvement.
  assertEquals(wind.pairedBaseline, {
    persistence: { hours: 2, origins: 1, targetDays: 1, baselineMaeMw: 900, candidateMaeMw: 0, deltaMaeMw: -900 },
    calendar: { hours: 1, origins: 1, targetDays: 1, baselineMaeMw: 0, candidateMaeMw: 0, deltaMaeMw: 0 },
  }); // The only common weather/calendar hour is a tie.
  first.calendar = missing;
  assertEquals(scoreGenerationRuns([run], actuals).find(score => score.model === "published")!.pairedBaseline.calendar, null);
});

Deno.test("generation forecast is deterministic, leaves evidence untouched and bounds neighbour count by policy", () => {
  const actuals = Array.from({ length: 18 }, (_, index) => interval(new Date(Date.parse(ORIGIN) - (index + 1) * HOUR).toISOString(), index, "B19"));
  const times = [...actuals].reverse().map(row => new Date(row.startMs).toISOString());
  times.push(ORIGIN);
  const drivers = weather(times);
  const input = { origin: ORIGIN, actuals, weather: drivers, published: [] };
  const before = structuredClone(input);
  const first = forecastGenerationMix(input);
  assertEquals(forecastGenerationMix(input), first);
  assertEquals(input, before);
  assertEquals(first.hours[0].byPsr.B19.weather.status, "predicted");
  const candidate = first.hours[0].byPsr.B19.weather;
  if (candidate.status === "predicted") assertEquals(candidate.trainingSamples, 12);
});
