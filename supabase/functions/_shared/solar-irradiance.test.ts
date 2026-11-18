import { assertEquals, assertRejects } from "@std/assert";
import { hourlyGfsIrradiance, irradianceForQuarters, historicalIrradiancePoints, irradianceOnto } from "./solar-irradiance.ts";

const at = (hour: string) => Date.parse(`2026-11-13T${hour}:00:00Z`);
const times = ["01", "02", "03", "04", "05", "06", "07"].map(h => new Date(at(h)).toISOString());
const field = "downward_short_wave_radiation_flux_surface";
const cache = (points: unknown = null) => ({
  from() {
    const builder = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: () => Promise.resolve({ data: points ? { points, expires_at: "2099-01-01T00:00:00Z" } : null }),
      upsert: () => Promise.resolve({ error: null }),
    };
    return builder;
  },
});

Deno.test("GFS hourly irradiance differences cumulative averages and keeps gaps", () => {
  assertEquals(hourlyGfsIrradiance({ times, values: [100, 150, null, 150, 160, 170, 50] }), [
    { t: at("01"), v: 100 }, { t: at("02"), v: 200 }, { t: at("05"), v: 200 }, { t: at("06"), v: 220 }, { t: at("07"), v: 50 },
  ]);
});

Deno.test("the analysis owns completed overlapping hours and quarters use the preceding-hour mean", async () => {
  const requests: string[] = [];
  const values = await irradianceForQuarters({ supabase: cache(), latitude: 59, longitude: 18, now: new Date(at("08")),
    starts: [at("00"), at("00") + 2_700_000, at("01"), at("06"), at("07")], fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      assertEquals(url.hostname, "api.dynamical.org");
      const query = JSON.parse(String(init?.body)).queries[0];
      requests.push(query.dataProductId);
      const result = url.pathname.endsWith("analyses")
        ? { analysisTimes: times.slice(0, 2), data: { [field]: [100, 150] } }
        : { forecasts: [{ validTimes: times, data: { [field]: [10, 20, 30, 40, 50, 60, 70] } }] };
      return await Promise.resolve(Response.json({ results: [{ queryId: "irradiance", ...result }] }));
    } });
  assertEquals(requests.sort(), ["noaa-gfs-analysis", "noaa-gfs-forecast"]);
  assertEquals(values, [100, 100, 200, 70, null]);
});

Deno.test("irradiance stays optional when the provider is unreachable", async () => {
  assertEquals(await irradianceForQuarters({ supabase: cache(), latitude: 59, longitude: 18, starts: [at("00")],
    fetchImpl: () => Promise.reject(new Error("synthetic network failure")) }), null);
});


function archiveCache() {
  const rows = new Map<string, Record<string, unknown>>();
  return { rows, from() {
    const where: Record<string, unknown> = {};
    const key = (row: Record<string, unknown>) => JSON.stringify([row.provider, row.latitude, row.longitude]);
    const builder = {
      select: () => builder,
      eq: (field: string, value: unknown) => { where[field] = value; return builder; },
      maybeSingle: () => Promise.resolve({ data: rows.get(key(where)) ?? null }),
      upsert: (row: Record<string, unknown>) => { rows.set(key(row), row); return Promise.resolve({ error: null }); },
    };
    return builder;
  } };
}

Deno.test("historical irradiance requests bounded analyses with six-hour lookback and inclusive final mean", async () => {
  const db = archiveCache(), requests: Record<string, unknown>[] = [];
  const start = Date.parse("2025-10-25T02:15:00Z"), end = Date.parse("2025-10-25T05:45:00Z");
  const fetchImpl: typeof fetch = (url, init) => {
    assertEquals(String(url), "https://api.dynamical.org/v1/analyses");
    requests.push(JSON.parse(String(init?.body)).queries[0]);
    return Promise.resolve(Response.json({ results: [{ queryId: "irradiance",
      analysisTimes: Array.from({ length: 7 }, (_, i) => new Date(Date.parse("2025-10-25T00:00:00Z") + i * 3600000).toISOString()),
      data: { [field]: [0, 10, 20, 30, 40, 50, 60] },
    }] }, { headers: { expires: "Thu, 01 Jan 2099 00:00:00 GMT" } }));
  };
  const options = { supabase: db, latitude: 59, longitude: 18, from: start, to: end, fetchImpl };
  const points = await historicalIrradiancePoints(options);
  assertEquals(requests[0].startTime, "2025-10-24T20:00:00.000Z");
  assertEquals(requests[0].endTime, "2025-10-25T07:00:00.000Z");
  assertEquals(requests[0].dataProductId, "noaa-gfs-analysis");
  assertEquals(irradianceOnto(points!, [start, Date.parse("2025-10-25T03:00:00Z"), end]), [50, 70, 110]);
  assertEquals(await historicalIrradiancePoints(options), points);
  assertEquals(requests.length, 1);
  assertEquals([...db.rows.values()][0].provider,
    `dynamical_noaa_gfs_shortwave_radiation_analysis_${Date.parse("2025-10-25T02:00:00Z")}_${Date.parse("2025-10-25T06:00:00Z")}`);
});

Deno.test("successful empty archive windows are cached separately from provider failures", async () => {
  const db = archiveCache();
  let calls = 0;
  const options = { supabase: db, latitude: 59, longitude: 18, from: at("01"), to: at("03"),
    fetchImpl: (() => { calls++; return Promise.resolve(Response.json({ results: [{ queryId: "irradiance", analysisTimes: [], data: { [field]: [] } }] })); }) as typeof fetch };
  assertEquals(await historicalIrradiancePoints(options), []);
  assertEquals(await historicalIrradiancePoints(options), []);
  assertEquals(calls, 1);
  assertEquals(await historicalIrradiancePoints({ ...options, supabase: archiveCache(),
    fetchImpl: () => Promise.reject(new Error("synthetic archive outage")) }), null);
});

Deno.test("historical irradiance leaves missing archive hours unobserved and rejects oversized reads", async () => {
  const points = await historicalIrradiancePoints({ supabase: archiveCache(), latitude: 59, longitude: 18,
    from: at("00"), to: at("07"), fetchImpl: () => Promise.resolve(Response.json({ results: [{ queryId: "irradiance",
      analysisTimes: times, data: { [field]: [100, 150, null, 150, 160, 170, 50] } }] })) });
  assertEquals(irradianceOnto(points!, [at("00"), at("02"), at("03"), at("04"), at("06")]), [100, null, null, 200, 50]);
  await assertRejects(() => historicalIrradiancePoints({ supabase: archiveCache(), latitude: 59, longitude: 18,
    from: at("00"), to: at("00") + 32 * 86400000, fetchImpl: () => { throw new Error("must not fetch"); } }), RangeError);
});
