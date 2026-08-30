import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  irradianceForQuarters,
  parseOpenMeteoIrradiance,
} from "./solar-irradiance.ts";

Deno.test("reads the hourly irradiance series, stamping bare times as UTC", () => {
  const body = {
    hourly: {
      time: ["2026-08-30T04:00", "2026-08-30T05:00"],
      shortwave_radiation: [0, 63],
    },
  };
  assertEquals(parseOpenMeteoIrradiance(body), [
    { at: "2026-08-30T04:00:00.000Z", v: 0 },
    { at: "2026-08-30T05:00:00.000Z", v: 63 },
  ]);
});

Deno.test("an hour with no reanalysis behind it is skipped, not zeroed", () => {
  // Nulls appear at the oldest end of the history window. Reading one as zero
  // would teach a zone that the sun was down on a day nobody measured.
  const body = {
    hourly: {
      time: ["2026-06-01T12:00", "2026-08-30T12:00"],
      shortwave_radiation: [null, 457],
    },
  };
  assertEquals(parseOpenMeteoIrradiance(body), [
    { at: "2026-08-30T12:00:00.000Z", v: 457 },
  ]);
});

Deno.test("a malformed response is empty rather than fatal", () => {
  assertEquals(parseOpenMeteoIrradiance({}), []);
  assertEquals(parseOpenMeteoIrradiance(null), []);
  assertEquals(
    parseOpenMeteoIrradiance({ hourly: { time: ["2026-08-30T04:00"] } }),
    [],
  );
});

const fakeSupabase = (points: unknown) => ({
  from() {
    const builder = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: () =>
        Promise.resolve({
          data: { points, expires_at: "2099-01-01T00:00:00Z" },
        }),
      upsert: () => Promise.resolve({ error: null }),
    };
    return builder;
  },
});

Deno.test("each quarter carries the mean of the hour it falls in", async () => {
  const result = await irradianceForQuarters({
    supabase: fakeSupabase([
      { at: "2026-08-30T05:00:00.000Z", v: 100 },
      { at: "2026-08-30T06:00:00.000Z", v: 200 },
    ]),
    latitude: 59.46,
    longitude: 18.04,
    starts: [
      "2026-08-30T04:00:00.000Z",
      "2026-08-30T04:45:00.000Z",
      "2026-08-30T05:00:00.000Z",
      "2026-08-30T05:45:00.000Z",
    ],
    now: new Date("2026-08-30T04:10:00Z"),
  });
  assertEquals(result, [100, 100, 200, 200]);
});

Deno.test("recording keeps what it knows and leaves the rest null", async () => {
  // Unlike a forecast, a partial record is worth having: the covered quarters
  // are still quarters a zone can learn sunshine from.
  const result = await irradianceForQuarters({
    supabase: fakeSupabase([{ at: "2026-08-30T05:00:00.000Z", v: 100 }]),
    latitude: 59.46,
    longitude: 18.04,
    starts: ["2026-08-30T04:30:00.000Z", "2026-08-30T09:00:00.000Z"],
    now: new Date("2026-08-30T04:10:00Z"),
  });
  assertEquals(result, [100, null]);
});

Deno.test("an unreachable provider records nothing rather than guessing", async () => {
  const result = await irradianceForQuarters({
    supabase: {
      from() {
        const builder = {
          select: () => builder,
          eq: () => builder,
          maybeSingle: () => Promise.resolve({ data: null }),
          upsert: () => Promise.resolve({ error: null }),
        };
        return builder;
      },
    },
    latitude: 59.46,
    longitude: 18.04,
    starts: ["2026-08-30T04:30:00.000Z"],
    now: new Date("2026-08-30T04:10:00Z"),
    fetchImpl: () => Promise.reject(new Error("network down")),
  });
  assertEquals(result, null);
});

Deno.test("the request asks Open-Meteo for history as well as forecast", async () => {
  let url = "";
  await irradianceForQuarters({
    supabase: {
      from() {
        const builder = {
          select: () => builder,
          eq: () => builder,
          maybeSingle: () => Promise.resolve({ data: null }),
          upsert: () => Promise.resolve({ error: null }),
        };
        return builder;
      },
    },
    latitude: 59.46,
    longitude: 18.04,
    starts: ["2026-08-30T04:30:00.000Z"],
    now: new Date("2026-08-30T04:10:00Z"),
    fetchImpl: (input) => {
      url = String(input);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            hourly: {
              time: ["2026-08-30T05:00"],
              shortwave_radiation: [100],
            },
          }),
        ),
      );
    },
  });
  assert(url.includes("past_days=92"), `history not requested: ${url}`);
  assert(url.includes("shortwave_radiation"), url);
  assert(url.includes("timezone=UTC"), url);
  assert(
    url.includes("latitude=59.46") && url.includes("longitude=18.04"),
    `coordinates not on the cache grid: ${url}`,
  );
});
