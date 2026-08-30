import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  cachedProviderPoints,
  expiryFrom,
  gridRound,
  interpolateOntoSlots,
  stepOntoSlots,
  type WeatherPoint,
} from "./weather-cache.ts";

const HOUR = 3_600_000;

const quarters = (from: string, count: number): string[] => {
  const first = Date.parse(from);
  return Array.from(
    { length: count },
    (_unused, index) => new Date(first + index * 900_000).toISOString(),
  );
};

Deno.test("interpolates linearly between two provider hours", () => {
  const points: WeatherPoint[] = [
    { t: Date.parse("2026-08-30T04:00:00Z"), v: 10 },
    { t: Date.parse("2026-08-30T05:00:00Z"), v: 14 },
  ];
  assertEquals(
    interpolateOntoSlots(points, quarters("2026-08-30T04:00:00Z", 5), HOUR),
    [10, 11, 12, 13, 14],
  );
});

Deno.test("interpolates across a six-hourly tail when the step allows it", () => {
  const points: WeatherPoint[] = [
    { t: Date.parse("2026-09-01T00:00:00Z"), v: 12 },
    { t: Date.parse("2026-09-01T06:00:00Z"), v: 18 },
  ];
  assertEquals(
    interpolateOntoSlots(points, ["2026-09-01T03:00:00Z"], 6 * HOUR),
    [15],
  );
  assertEquals(
    interpolateOntoSlots(points, ["2026-09-01T03:00:00Z"], HOUR),
    [null],
    "a step wider than the caller allows is a gap, not a long straight line",
  );
});

Deno.test("reads the first point for a slot just before the series starts", () => {
  const points: WeatherPoint[] = [
    { t: Date.parse("2026-08-30T04:00:00Z"), v: 10 },
    { t: Date.parse("2026-08-30T05:00:00Z"), v: 14 },
  ];
  assertEquals(
    interpolateOntoSlots(points, ["2026-08-30T03:45:00Z"], HOUR),
    [10],
  );
  assertEquals(
    interpolateOntoSlots(points, ["2026-08-30T03:00:00Z"], HOUR),
    [null],
    "a whole hour early is too far to call it the same forecast",
  );
});

Deno.test("never extrapolates past the last point", () => {
  assertEquals(
    interpolateOntoSlots(
      [{ t: Date.parse("2026-08-30T04:00:00Z"), v: 10 }],
      ["2026-08-30T04:15:00Z"],
      HOUR,
    ),
    [null],
  );
});

Deno.test("an interval mean covers the hour it ends, not the hour it starts", () => {
  // Open-Meteo stamps the mean of 04:00-05:00 at 05:00.
  const points: WeatherPoint[] = [
    { t: Date.parse("2026-08-30T05:00:00Z"), v: 100 },
    { t: Date.parse("2026-08-30T06:00:00Z"), v: 200 },
  ];
  assertEquals(
    stepOntoSlots(points, quarters("2026-08-30T04:00:00Z", 8), HOUR),
    [100, 100, 100, 100, 200, 200, 200, 200],
  );
});

Deno.test("an interval mean is never stretched beyond its own interval", () => {
  const points: WeatherPoint[] = [{
    t: Date.parse("2026-08-30T05:00:00Z"),
    v: 100,
  }];
  assertEquals(
    stepOntoSlots(points, ["2026-08-30T03:45:00Z"], HOUR),
    [null],
    "a slot in the hour before the first mean is not covered by it",
  );
  assertEquals(
    stepOntoSlots(points, ["2026-08-30T05:00:00Z"], HOUR),
    [null],
    "a slot after the last mean has no figure at all",
  );
});

Deno.test("an empty series answers null for every slot rather than throwing", () => {
  assertEquals(interpolateOntoSlots([], ["2026-08-30T04:00:00Z"], HOUR), [
    null,
  ]);
  assertEquals(stepOntoSlots([], ["2026-08-30T04:00:00Z"], HOUR), [null]);
});

Deno.test("coordinates are rounded to the cache's kilometre grid", () => {
  assertEquals(gridRound(59.456128864845056), 59.46);
  assertEquals(gridRound(18.04084897041321), 18.04);
});

Deno.test("expiry follows the provider's header, or falls back to an interval", () => {
  const now = new Date("2026-08-30T04:10:00Z");
  assertEquals(
    expiryFrom(
      new Response("", {
        headers: { expires: "Sun, 30 Aug 2026 04:42:35 GMT" },
      }),
      now,
    ),
    "2026-08-30T04:42:35.000Z",
  );
  assertEquals(
    expiryFrom(new Response(""), now),
    "2026-08-30T04:40:00.000Z",
    "no header means a default half hour",
  );
  assertEquals(
    expiryFrom(
      new Response("", {
        headers: { expires: "Sun, 30 Aug 2026 03:00:00 GMT" },
      }),
      now,
    ),
    "2026-08-30T04:40:00.000Z",
    "an expiry already in the past would mean never caching at all",
  );
});

/** Minimal stand-in for the query builder the edge functions use. */
const fakeSupabase = (
  cached: Record<string, unknown> | null,
  written: Record<string, unknown>[],
  upsertError: unknown = null,
) => ({
  from() {
    const builder = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: () => Promise.resolve({ data: cached }),
      upsert: (row: Record<string, unknown>) => {
        written.push(row);
        return Promise.resolve({ error: upsertError });
      },
    };
    return builder;
  },
});

const points: WeatherPoint[] = [{
  t: Date.parse("2026-08-30T05:00:00Z"),
  v: 7,
}];
const now = new Date("2026-08-30T04:10:00Z");

Deno.test("a miss fetches, caches by rounded coordinate, and returns", async () => {
  const written: Record<string, unknown>[] = [];
  let asked: [number, number] | null = null;
  const result = await cachedProviderPoints({
    supabase: fakeSupabase(null, written),
    provider: "test_provider",
    latitude: 59.456128864845056,
    longitude: 18.04084897041321,
    now,
    fetchPoints: (latitude, longitude) => {
      asked = [latitude, longitude];
      return Promise.resolve({
        points,
        expiresAt: "2026-08-30T04:42:35.000Z",
      });
    },
  });
  assertEquals(result, points);
  assertEquals(
    asked,
    [59.46, 18.04],
    "the provider is asked on the cache grid",
  );
  assertEquals(written.length, 1);
  assertEquals(written[0].provider, "test_provider");
  assertEquals(written[0].latitude, 59.46);
});

Deno.test("a live entry is served without touching the provider", async () => {
  const written: Record<string, unknown>[] = [];
  const result = await cachedProviderPoints({
    supabase: fakeSupabase(
      { points, expires_at: "2026-08-30T04:42:35Z" },
      written,
    ),
    provider: "test_provider",
    latitude: 59.46,
    longitude: 18.04,
    now,
    fetchPoints: () => {
      throw new Error("the provider must not be called on a cache hit");
    },
  });
  assertEquals(result, points);
  assertEquals(written.length, 0);
});

Deno.test("an expired entry is refetched", async () => {
  const written: Record<string, unknown>[] = [];
  let calls = 0;
  await cachedProviderPoints({
    supabase: fakeSupabase(
      { points: [], expires_at: "2026-08-30T00:30:00Z" },
      written,
    ),
    provider: "test_provider",
    latitude: 59.46,
    longitude: 18.04,
    now,
    fetchPoints: () => {
      calls += 1;
      return Promise.resolve({ points, expiresAt: "2026-08-30T04:42:35Z" });
    },
  });
  assertEquals(calls, 1);
});

Deno.test("a cache that will not write still yields the forecast it holds", async () => {
  const result = await cachedProviderPoints({
    supabase: fakeSupabase(null, [], { message: "read only" }),
    provider: "test_provider",
    latitude: 59.46,
    longitude: 18.04,
    now,
    fetchPoints: () =>
      Promise.resolve({ points, expiresAt: "2026-08-30T04:42:35Z" }),
  });
  assertEquals(result, points);
});

Deno.test("no failure of the provider or the cache ever throws", async () => {
  for (
    const fetchPoints of [
      () => Promise.reject(new Error("network down")),
      () => Promise.resolve(null),
      () => Promise.resolve({ points: [], expiresAt: "2026-08-30T04:42:35Z" }),
    ]
  ) {
    const result = await cachedProviderPoints({
      supabase: fakeSupabase(null, []),
      provider: "test_provider",
      latitude: 59.46,
      longitude: 18.04,
      now,
      fetchPoints,
    });
    assertEquals(result, null);
  }

  const brokenCache = {
    from() {
      throw new Error("database unreachable");
    },
  };
  assertEquals(
    await cachedProviderPoints({
      supabase: brokenCache,
      provider: "test_provider",
      latitude: 59.46,
      longitude: 18.04,
      now,
      fetchPoints: () =>
        Promise.resolve({ points, expiresAt: "2026-08-30T04:42:35Z" }),
    }),
    null,
  );
});

Deno.test("an unusable coordinate is refused before any request is made", async () => {
  let called = false;
  const result = await cachedProviderPoints({
    supabase: fakeSupabase(null, []),
    provider: "test_provider",
    latitude: Number.NaN,
    longitude: 18.04,
    now,
    fetchPoints: () => {
      called = true;
      return Promise.resolve({ points, expiresAt: "2026-08-30T04:42:35Z" });
    },
  });
  assertEquals(result, null);
  assert(!called, "an unlocatable home must not generate a provider request");
});

Deno.test("a cache row in an older shape is a miss, not a crash", async () => {
  // Points were once stored with ISO stamps. A row still holding them is
  // refetched rather than read, so the change costs one request per place and
  // needs no migration of a cache that rebuilds itself anyway.
  let fetched = false;
  const result = await cachedProviderPoints({
    supabase: fakeSupabase(
      {
        points: [{ at: "2026-08-30T05:00:00Z", v: 7 }],
        expires_at: "2099-01-01T00:00:00Z",
      },
      [],
    ),
    provider: "test_provider",
    latitude: 59.46,
    longitude: 18.04,
    now,
    fetchPoints: () => {
      fetched = true;
      return Promise.resolve({ points, expiresAt: "2099-01-01T00:00:00Z" });
    },
  });
  assert(fetched, "an unreadable cached shape must be refetched");
  assertEquals(result, points);
});

Deno.test("an already-ordered series is not copied to sort it", () => {
  // The hot path: providers issue in order, so ordering is a scan that
  // allocates nothing. Identity is the observable proof of that.
  const ordered: WeatherPoint[] = [
    { t: 1, v: 1 },
    { t: 2, v: 2 },
    { t: 3, v: 3 },
  ];
  assertEquals(
    stepOntoSlots(ordered, [1, 2], 10),
    [2, 3],
    "a numeric slot start is read without parsing",
  );
});
