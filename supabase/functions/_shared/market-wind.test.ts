import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  forecastCalibration,
  forecastDailyMeans,
  observedDailyMeans,
  parseForecastWind,
  parseObservedWind,
  withWindOutlook,
  ZONE_STATIONS,
  zoneDailyMeans,
  zoneWindDays,
} from "./market-wind.ts";

const HOUR = 3_600_000;
const at = (iso: string) => Date.parse(iso);

Deno.test("observed wind is a mean per UTC day, and a day with too few hours has none", () => {
  const full = Array.from({ length: 24 }, (_, hour) => ({ date: at("2026-09-30T00:00:00Z") + hour * HOUR, value: hour < 12 ? "2.0" : "4.0", quality: "G" }));
  const partial = Array.from({ length: 10 }, (_, hour) => ({ date: at("2026-10-01T00:00:00Z") + hour * HOUR, value: "9.0", quality: "G" }));
  const means = observedDailyMeans(parseObservedWind({ value: [...full, ...partial, { date: 1, value: "junk" }] }));
  assertEquals([...means], [["2026-09-30", 3]]);
});

Deno.test("a forecast is read at every hour between its points, so six-hourly steps weigh as much as hourly ones", () => {
  // Hourly at 2 m/s through the first day, then six-hourly rising to 8.
  const hourly = Array.from({ length: 25 }, (_, hour) => ({ time: new Date(at("2026-10-02T00:00:00Z") + hour * HOUR).toISOString(), data: { wind_speed: 2 } }));
  const coarse = [6, 12, 18, 24].map((hour) => ({ time: new Date(at("2026-10-03T00:00:00Z") + hour * HOUR).toISOString(), data: { wind_speed: 2 + hour / 4 } }));
  const means = forecastDailyMeans(parseForecastWind({ timeSeries: [...hourly, ...coarse] }));
  assertEquals(means.get("2026-10-02"), 2);
  // 2 at 00:00 rising linearly to 7.75 at 23:00.
  assert(Math.abs(means.get("2026-10-03")! - 4.875) < 1e-9);
  // One hour of the last day is not a day.
  assertEquals(means.has("2026-10-04"), false);
});

Deno.test("a zone has a day only when most of its stations do", () => {
  const stations = [new Map([["a", 2], ["b", 2]]), new Map([["a", 4]]), new Map([["a", 6]])];
  assertEquals(zoneDailyMeans(stations, 3), [{ day: "a", mean_speed_m_s: 4, count: 3 }]);
});

/** A database holding the two wind tables, and an SMHI that answers from fixed readings. */
function world(now: Date, options: { observedThrough?: string } = {}) {
  const observed = new Map<string, number>();
  const forecast: { day: string; mean_speed_m_s: number; issued_on: string; issued_at: string }[] = [];
  if (options.observedThrough) {
    for (let ms = now.getTime() - 40 * 24 * HOUR; new Date(ms).toISOString().slice(0, 10) <= options.observedThrough; ms += 24 * HOUR) {
      observed.set(new Date(ms).toISOString().slice(0, 10), 3);
    }
  }
  const requests: string[] = [];
  const table = (name: string) => {
    const query = {
      select: () => query, eq: () => query, gte: () => query,
      order: () => Promise.resolve({
        data: name === "energy_market_wind_observed"
          ? [...observed].sort().map(([day, mean_speed_m_s]) => ({ day, mean_speed_m_s }))
          : [...forecast].sort((a, b) => b.issued_at.localeCompare(a.issued_at)),
        error: null,
      }),
      upsert: (rows: Record<string, unknown>[]) => {
        for (const row of rows) {
          if (name === "energy_market_wind_observed") observed.set(row.day as string, row.mean_speed_m_s as number);
          else forecast.push(row as typeof forecast[number]);
        }
        return Promise.resolve({ error: null });
      },
    };
    return query;
  };
  const fetchImpl = ((url: string) => {
    requests.push(url);
    const hours = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i * HOUR);
    const body = url.includes("metobs")
      ? { value: hours(now.getTime() - (url.includes("latest-day") ? 24 : 60 * 24) * HOUR, url.includes("latest-day") ? 25 : 60 * 24).map((date) => ({ date, value: "5.0" })) }
      : { timeSeries: hours(Math.ceil(now.getTime() / HOUR) * HOUR, 96).map((t) => ({ time: new Date(t).toISOString(), data: { wind_speed: 7 } })) };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  }) as typeof fetch;
  return { supabase: { from: table }, fetchImpl, requests, observed, forecast };
}

Deno.test("an empty database is filled from four months of observations and the current forecast", async () => {
  const now = new Date("2026-10-02T00:30:00Z");
  const w = world(now);
  const days = await zoneWindDays({ supabase: w.supabase, zone: "SE3", now, fetchImpl: w.fetchImpl });
  assert(days);
  assertEquals(w.requests.filter((url) => url.includes("latest-months")).length, ZONE_STATIONS.SE3.length);
  assertEquals(days.find((entry) => entry.day === "2026-10-01")?.mean_speed_m_s, 5);
  // Issued in the first hour of the day, the forecast covers the day itself.
  assertEquals(days.find((entry) => entry.day === "2026-10-02")?.mean_speed_m_s, 7);
  assertEquals(days.find((entry) => entry.day === "2026-10-04")?.mean_speed_m_s, 7);
  assertEquals(w.observed.has("2026-10-02"), false);
  assert(w.forecast.every((row) => row.issued_on === "2026-10-02"));
});

Deno.test("one missing day is read from the last 24 hours, and a current database asks SMHI nothing", async () => {
  // Late enough that the last 24 hours hold most of yesterday.
  const now = new Date("2026-10-02T02:30:00Z");
  const w = world(now, { observedThrough: "2026-09-30" });
  await zoneWindDays({ supabase: w.supabase, zone: "SE3", now, fetchImpl: w.fetchImpl });
  assertEquals(w.requests.filter((url) => url.includes("latest-months")).length, 0);
  assertEquals(w.requests.filter((url) => url.includes("latest-day")).length, ZONE_STATIONS.SE3.length);
  assertEquals(w.observed.get("2026-10-01"), 5);

  const before = w.requests.length;
  const again = await zoneWindDays({ supabase: w.supabase, zone: "SE3", now: new Date(now.getTime() + 15 * 60_000), fetchImpl: w.fetchImpl });
  assertEquals(w.requests.length, before);
  assertEquals(again?.find((entry) => entry.day === "2026-10-03")?.mean_speed_m_s, 7);
});

Deno.test("a snapshot gets the wind of its own price area, and none where the zone has no stations", async () => {
  // Days after the tests above, whose attempts would otherwise still be waited out.
  const now = new Date("2026-10-05T00:30:00Z");
  const w = world(now);
  const snapshot = (area: string) => ({ sources: { import_price: { location: { market_area: area } } }, wind_outlook: { days: "sent by the house" } });
  const se3 = await withWindOutlook(w.supabase, snapshot("SE3"), { now, fetchImpl: w.fetchImpl }) as unknown as { wind_outlook?: { zone: string; days: unknown[] } };
  assertEquals(se3.wind_outlook?.zone, "SE3");
  assert(Array.isArray(se3.wind_outlook?.days) && se3.wind_outlook.days.length > 40);
  const se1 = await withWindOutlook(w.supabase, snapshot("SE1"), { now, fetchImpl: w.fetchImpl });
  assertEquals("wind_outlook" in se1, false);
});

Deno.test("forecasts are scaled to read like observations once enough days have both", () => {
  const observed = Array.from({ length: 6 }, (_, i) => ({ day: `2026-09-2${i}`, mean_speed_m_s: 3 }));
  const issued = observed.map((entry) => ({ day: entry.day, mean_speed_m_s: 4, issued_on: entry.day }));
  // Four days are not a comparison.
  assertEquals(forecastCalibration(observed, issued.slice(0, 4)), 1);
  assertEquals(forecastCalibration(observed, issued), 0.75);
  // An earlier issue for the same day does not count twice or win.
  assertEquals(forecastCalibration(observed, [...issued, { day: "2026-09-20", mean_speed_m_s: 40, issued_on: "2026-09-19" }]), 0.75);
});
