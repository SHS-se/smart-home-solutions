import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { hourlyGfsIrradiance, irradianceForQuarters } from "./solar-irradiance.ts";

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
