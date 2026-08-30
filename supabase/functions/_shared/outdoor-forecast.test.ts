import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyOutdoorSeries,
  homeLocation,
  outdoorSeriesFromProvider,
  parseMetNoForecast,
} from "./outdoor-forecast.ts";

Deno.test("a complete series is handed back as numbers", () => {
  assertEquals(classifyOutdoorSeries([4, 5, 6], 3), {
    status: "complete",
    series: [4, 5, 6],
  });
});

Deno.test("no provider reached the horizon, so the plan goes on without one", () => {
  assertEquals(classifyOutdoorSeries(undefined, 3), { status: "absent" });
  assertEquals(classifyOutdoorSeries(null, 3), { status: "absent" });
});

Deno.test("a hole is not an absence: it is a series that was built and not filled", () => {
  assertEquals(classifyOutdoorSeries([4, null, 6], 3), { status: "holed" });
});

Deno.test("a short series is rejected rather than planned against its own length", () => {
  assertEquals(classifyOutdoorSeries([4, 5], 3), { status: "holed" });
});

Deno.test("a non-finite reading is a hole, whatever produced it", () => {
  assertEquals(classifyOutdoorSeries([4, Number.NaN, 6], 3), {
    status: "holed",
  });
  assertEquals(classifyOutdoorSeries([4, Number.POSITIVE_INFINITY, 6], 3), {
    status: "holed",
  });
});

Deno.test("an empty horizon carries an empty series, not a hole", () => {
  assertEquals(classifyOutdoorSeries([], 0), {
    status: "complete",
    series: [],
  });
});

const quarters = (from: string, count: number): string[] => {
  const first = Date.parse(from);
  return Array.from(
    { length: count },
    (_unused, index) => new Date(first + index * 900_000).toISOString(),
  );
};

Deno.test("parses air temperature out of a met.no response and skips junk", () => {
  const body = {
    properties: {
      timeseries: [
        {
          time: "2026-08-30T04:00:00Z",
          data: { instant: { details: { air_temperature: 14.4 } } },
        },
        { time: "2026-08-30T05:00:00Z", data: { instant: { details: {} } } },
        { data: { instant: { details: { air_temperature: 15 } } } },
        {
          time: "not-a-time",
          data: { instant: { details: { air_temperature: 15 } } },
        },
      ],
    },
  };
  assertEquals(parseMetNoForecast(body), [
    { t: Date.parse("2026-08-30T04:00:00Z"), v: 14.4 },
  ]);
  assertEquals(parseMetNoForecast({}), []);
  assertEquals(parseMetNoForecast(null), []);
});

/** Minimal stand-in for the query builder the edge functions use. */
const fakeSupabase = (
  cached: Record<string, unknown> | null,
  written: Record<string, unknown>[],
) => ({
  from() {
    const builder = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: () => Promise.resolve({ data: cached }),
      upsert: (row: Record<string, unknown>) => {
        written.push(row);
        return Promise.resolve({ error: null });
      },
    };
    return builder;
  },
});

const metNoResponse = (from: string, hours: number) =>
  new Response(
    JSON.stringify({
      properties: {
        timeseries: Array.from({ length: hours }, (_unused, index) => ({
          time: new Date(Date.parse(from) + index * 3_600_000).toISOString(),
          data: { instant: { details: { air_temperature: 10 + index } } },
        })),
      },
    }),
    { headers: { expires: "Sun, 30 Aug 2026 04:42:35 GMT" } },
  );

Deno.test("fetches met.no, caches the response and covers the horizon", async () => {
  const written: Record<string, unknown>[] = [];
  const result = await outdoorSeriesFromProvider({
    supabase: fakeSupabase(null, written),
    latitude: 59.456128864845056,
    longitude: 18.04084897041321,
    starts: quarters("2026-08-30T04:00:00Z", 8),
    now: new Date("2026-08-30T04:10:00Z"),
    fetchImpl: (input) => {
      assertEquals(
        String(input),
        "https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=59.46&lon=18.04",
      );
      return Promise.resolve(metNoResponse("2026-08-30T04:00:00Z", 4));
    },
  });
  assertEquals(result?.series, [
    10,
    10.25,
    10.5,
    10.75,
    11,
    11.25,
    11.5,
    11.75,
  ]);
  assertEquals(written.length, 1);
  assertEquals(written[0].latitude, 59.46);
  assertEquals(written[0].expires_at, "2026-08-30T04:42:35.000Z");
});

Deno.test("a live cache entry is used without calling the provider", async () => {
  const written: Record<string, unknown>[] = [];
  const result = await outdoorSeriesFromProvider({
    supabase: fakeSupabase({
      points: [
        { t: Date.parse("2026-08-30T04:00:00Z"), v: 10 },
        { t: Date.parse("2026-08-30T05:00:00Z"), v: 14 },
      ],
      fetched_at: "2026-08-30T04:00:00Z",
      expires_at: "2026-08-30T04:42:35Z",
    }, written),
    latitude: 59.46,
    longitude: 18.04,
    starts: quarters("2026-08-30T04:00:00Z", 2),
    now: new Date("2026-08-30T04:10:00Z"),
    fetchImpl: () => {
      throw new Error("the provider must not be called on a cache hit");
    },
  });
  assertEquals(result?.series, [10, 11]);
  assertEquals(written.length, 0);
});

Deno.test("an expired cache entry is refetched", async () => {
  const written: Record<string, unknown>[] = [];
  let calls = 0;
  const result = await outdoorSeriesFromProvider({
    supabase: fakeSupabase({
      points: [{ t: Date.parse("2026-08-30T00:00:00Z"), v: 1 }],
      fetched_at: "2026-08-30T00:00:00Z",
      expires_at: "2026-08-30T00:30:00Z",
    }, written),
    latitude: 59.46,
    longitude: 18.04,
    starts: quarters("2026-08-30T04:00:00Z", 2),
    now: new Date("2026-08-30T04:10:00Z"),
    fetchImpl: () => {
      calls += 1;
      return Promise.resolve(metNoResponse("2026-08-30T04:00:00Z", 4));
    },
  });
  assertEquals(calls, 1);
  assertEquals(result?.series, [10, 10.25]);
});

Deno.test("a forecast that still falls short yields nothing rather than a partial series", async () => {
  const result = await outdoorSeriesFromProvider({
    supabase: fakeSupabase(null, []),
    latitude: 59.46,
    longitude: 18.04,
    starts: quarters("2026-08-30T04:00:00Z", 288),
    now: new Date("2026-08-30T04:10:00Z"),
    fetchImpl: () => Promise.resolve(metNoResponse("2026-08-30T04:00:00Z", 4)),
  });
  assertEquals(result, null);
});

Deno.test("a weather outage never stops a plan", async () => {
  const unreachable = await outdoorSeriesFromProvider({
    supabase: fakeSupabase(null, []),
    latitude: 59.46,
    longitude: 18.04,
    starts: quarters("2026-08-30T04:00:00Z", 2),
    now: new Date("2026-08-30T04:10:00Z"),
    fetchImpl: () => Promise.reject(new Error("network down")),
  });
  assertEquals(unreachable, null);

  const refused = await outdoorSeriesFromProvider({
    supabase: fakeSupabase(null, []),
    latitude: 59.46,
    longitude: 18.04,
    starts: quarters("2026-08-30T04:00:00Z", 2),
    now: new Date("2026-08-30T04:10:00Z"),
    fetchImpl: () =>
      Promise.resolve(new Response("rate limited", { status: 429 })),
  });
  assertEquals(refused, null);
});

Deno.test("the home's own location is preferred over the PV forecast's", () => {
  assertEquals(
    homeLocation({
      location: { latitude: 59.46, longitude: 18.04 },
      sources: { pv: { location: { latitude: 1, longitude: 2 } } },
    }),
    { latitude: 59.46, longitude: 18.04 },
  );
});

Deno.test("an older integration is still located through its PV forecast", () => {
  assertEquals(
    homeLocation({
      sources: { pv: { location: { latitude: 59, longitude: 18 } } },
    }),
    { latitude: 59, longitude: 18 },
  );
});

Deno.test("a home with neither is simply unlocated, not an error", () => {
  assertEquals(homeLocation({ sources: { pv: null } }), null);
  assertEquals(homeLocation({}), null);
  assertEquals(homeLocation(null), null);
  assertEquals(
    homeLocation({ location: { latitude: 91, longitude: 18 } }),
    null,
    "an impossible latitude is not a location",
  );
});
