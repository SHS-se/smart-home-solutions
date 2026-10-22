import { assertEquals, assertThrows } from "@std/assert";
import { MEDIUM_RANGE_VARIABLES, mediumRangeWeatherRequest, parseMediumRangeWeather } from "../supabase/functions/_shared/medium-range-weather.ts";

import { mediumRangeWeatherFixture as fixture } from "./medium-range-weather.fixture.ts";

const acquired = "2026-10-22T22:30:00Z"; // October 23 in Stockholm: D+2 is the DST date October 25.

Deno.test("medium-range request fixes model, seven days, native variables and existing ten SE3 sites", () => {
  const { url, record } = mediumRangeWeatherRequest();
  assertEquals(url.origin, "https://api.open-meteo.com");
  assertEquals(url.searchParams.get("models"), "ecmwf_ifs025");
  assertEquals(url.searchParams.get("forecast_days"), "7");
  assertEquals(url.searchParams.get("timezone"), "UTC");
  assertEquals(url.searchParams.get("wind_speed_unit"), "ms");
  assertEquals(url.searchParams.get("hourly"), MEDIUM_RANGE_VARIABLES.join(","));
  assertEquals(record.sites.length, 10);
  assertEquals(record.sites[0], { station_id: "83190", latitude: 58.3218, longitude: 13.0379 });
  assertEquals(record.sites[9].station_id, "96040");
  assertEquals(url.searchParams.get("latitude"), record.sites.map(site => site.latitude).join(","));
});

Deno.test("weather parsing retains native nulls, zeros, request order and independently returned grid positions", () => {
  const raw = fixture();
  raw[0].hourly.wind_speed_10m[1] = null;
  raw[1].latitude = 59; // Grid selection is not an arbitrary distance validity gate.
  const parsed = parseMediumRangeWeather(raw, acquired);
  assertEquals(parsed.sites.length, 10);
  assertEquals(parsed.sites[0].requested, { latitude: 58.3218, longitude: 13.0379 });
  assertEquals(parsed.sites[0].grid, { latitude: 58.25, longitude: 13, elevation_m: null });
  assertEquals(parsed.sites[1].grid.latitude, 59);
  assertEquals(parsed.sites[1].station_id, "81350");
  assertEquals(parsed.sites[0].series.wind_speed_10m[1], null);
  assertEquals(parsed.sites[0].series.shortwave_radiation, [0, 0, 0, 0, 0]);
  assertEquals(parsed.sites[0].times[0], "2026-10-24T22:00:00.000Z");
  assertEquals(parsed.issue_time, null);
  assertEquals(parsed.semantics.shortwave_radiation.time, "preceding_hour_mean");
});

Deno.test("coverage counts actual non-null hours on local target days, including DST and preceding-hour radiation", () => {
  const raw = fixture();
  raw[0].hourly.wind_speed_10m[1] = null;
  const parsed = parseMediumRangeWeather(raw, acquired);
  assertEquals(parsed.coverage.map(({ day, lead_days, expected_samples }) => ({ day, lead_days, expected_samples })), [
    { day: "2026-10-25", lead_days: 2, expected_samples: 25 },
    { day: "2026-10-26", lead_days: 3, expected_samples: 24 },
  ]);
  assertEquals(parsed.coverage[0].sites[0].non_null_samples, {
    wind_speed_10m: 3, wind_speed_120m: 4, temperature_2m: 4, shortwave_radiation: 4,
  });
  assertEquals(parsed.coverage[1].sites[0].non_null_samples, {
    wind_speed_10m: 1, wind_speed_120m: 1, temperature_2m: 1, shortwave_radiation: 0,
  });
});

Deno.test("coverage distinguishes the midnight instant from the preceding radiation hour and spring DST", () => {
  const raw = fixture(["2026-03-28T23:00", "2026-03-29T00:00"]);
  const parsed = parseMediumRangeWeather(raw, "2026-03-27T12:00:00Z");
  assertEquals(parsed.coverage[0].day, "2026-03-29");
  assertEquals(parsed.coverage[0].expected_samples, 23);
  assertEquals(parsed.coverage[0].sites[0].non_null_samples.wind_speed_10m, 2);
  assertEquals(parsed.coverage[0].sites[0].non_null_samples.shortwave_radiation, 1);
  const empty = parseMediumRangeWeather(fixture([]), acquired);
  assertEquals(empty.coverage[0].sites[0].non_null_samples.wind_speed_10m, 0);
});

Deno.test("weather rejects malformed batches, calendars, units, offsets and non-finite or misaligned series", () => {
  assertThrows(() => parseMediumRangeWeather({}, acquired));
  assertThrows(() => parseMediumRangeWeather(fixture().slice(1), acquired));
  assertThrows(() => parseMediumRangeWeather(fixture(), "bad-time"));
  const cases: ((raw: ReturnType<typeof fixture>) => void)[] = [
    raw => { raw[0].utc_offset_seconds = 3600; },
    raw => { raw[0].timezone = "Europe/Stockholm"; },
    raw => { raw[0].hourly_units.wind_speed_10m = "km/h"; },
    raw => { raw[0].hourly.wind_speed_120m.pop(); },
    raw => { raw[0].hourly.wind_speed_10m[0] = Number.NaN; },
    raw => { raw[0].hourly.wind_speed_10m[0] = Number.POSITIVE_INFINITY; },
    raw => { raw[0].hourly.time[0] = "2026-10-24T22:30"; },
    raw => { raw[0].hourly.time[0] = "2026-02-30T22:00"; },
    raw => { raw[0].hourly.time[1] = raw[0].hourly.time[0]; },
    raw => { raw[0].hourly.time.reverse(); },
    raw => { raw[0].latitude = Number.NaN; },
    raw => { raw[0].longitude = 181; },
  ];
  for (const mutate of cases) {
    const raw = fixture();
    mutate(raw);
    assertThrows(() => parseMediumRangeWeather(raw, acquired));
  }
});

Deno.test("generation research weather explicitly requests and records 28 past days", () => {
  assertEquals(mediumRangeWeatherRequest().url.searchParams.get("past_days"), null);
  assertEquals(mediumRangeWeatherRequest().record.past_days, 0);
  const research = mediumRangeWeatherRequest(28);
  assertEquals(research.url.searchParams.get("past_days"), "28");
  assertEquals(research.record.past_days, 28);
  assertEquals(research.url.searchParams.get("forecast_days"), "7");
});
