import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyOutdoorSeries,
  gridRound,
  interpolateOntoSlots,
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

Deno.test("interpolates linearly between two provider hours", () => {
  const points = [
    { at: "2026-08-30T04:00:00Z", c: 10 },
    { at: "2026-08-30T05:00:00Z", c: 14 },
  ];
  assertEquals(
    interpolateOntoSlots(points, quarters("2026-08-30T04:00:00Z", 5)),
    [10, 11, 12, 13, 14],
  );
});

Deno.test("interpolates across met.no's six-hourly tail", () => {
  const points = [
    { at: "2026-09-01T00:00:00Z", c: 12 },
    { at: "2026-09-01T06:00:00Z", c: 18 },
  ];
  assertEquals(
    interpolateOntoSlots(points, ["2026-09-01T03:00:00Z"]),
    [15],
  );
});

Deno.test("reads the first entry for a quarter just before the forecast starts", () => {
  const points = [
    { at: "2026-08-30T04:00:00Z", c: 10 },
    { at: "2026-08-30T05:00:00Z", c: 14 },
  ];
  assertEquals(
    interpolateOntoSlots(points, ["2026-08-30T03:45:00Z"]),
    [10],
  );
  assertEquals(
    interpolateOntoSlots(points, ["2026-08-30T03:00:00Z"]),
    [null],
  );
});

Deno.test("never extrapolates past the last point", () => {
  const points = [{ at: "2026-08-30T04:00:00Z", c: 10 }];
  assertEquals(
    interpolateOntoSlots(points, ["2026-08-30T04:15:00Z"]),
    [null],
  );
});

Deno.test("a gap wider than a provider issues is a gap, not a long straight line", () => {
  const points = [
    { at: "2026-08-30T04:00:00Z", c: 10 },
    { at: "2026-09-01T04:00:00Z", c: 20 },
  ];
  assertEquals(
    interpolateOntoSlots(points, ["2026-08-31T04:00:00Z"]),
    [null],
  );
});

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
    { at: "2026-08-30T04:00:00Z", c: 14.4 },
  ]);
  assertEquals(parseMetNoForecast({}), []);
  assertEquals(parseMetNoForecast(null), []);
});

Deno.test("coordinates are rounded to the cache's kilometre grid", () => {
  assertEquals(gridRound(59.456128864845056), 59.46);
  assertEquals(gridRound(18.04084897041321), 18.04);
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
        { at: "2026-08-30T04:00:00Z", c: 10 },
        { at: "2026-08-30T05:00:00Z", c: 14 },
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
      points: [{ at: "2026-08-30T00:00:00Z", c: 1 }],
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

Deno.test("the real met.no response shape covers a 72 hour horizon", () => {
  // Two days of hourly followed by a six-hourly tail, as met.no issues it.
  const points = [
    ...Array.from({ length: 57 }, (_unused, index) => ({
      at: new Date(Date.parse("2026-08-30T04:00:00Z") + index * 3_600_000)
        .toISOString(),
      c: 15,
    })),
    ...Array.from({ length: 30 }, (_unused, index) => ({
      at: new Date(
        Date.parse("2026-09-01T12:00:00Z") + index * 6 * 3_600_000,
      ).toISOString(),
      c: 15,
    })),
  ];
  const series = interpolateOntoSlots(
    points,
    quarters("2026-08-30T04:00:00Z", 288),
  );
  assert(
    series.every((value) => value !== null),
    "met.no's own resolution left a hole in the 72 hour horizon",
  );
});
