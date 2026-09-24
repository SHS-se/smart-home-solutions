import { PROVIDER_TIMEOUT_MS } from "./weather-cache.ts";
// How much sun is going to fall on the house, for every home.
//
// A heated room gains far more from the sun than from anything the planner
// switches on. South-facing glass on a clear winter day can put a kilowatt
// into a living room for free, which is why §9.1 has listed solar gain as a
// missing input since the thermal model was first written: the 1R1C fit
// currently sweeps it into `background_gain_c_per_h`, a single constant that
// has to stand for sunshine, cooking, occupants and lighting at once. A
// constant cannot tell a bright Sunday from an overcast one, so the model
// under-heats the bright day and over-heats the dull one by the same amount.
//
// Fixing that needs irradiance as a series, and needs it for every home —
// including homes with no panels at all. Solar gain through a window has
// nothing to do with owning an inverter, so this deliberately does not read
// the home's PV forecast even when there is one: a PV entity reports expected
// AC output, which has already been through an array's orientation, shading,
// temperature derating and inverter efficiency. What a wall needs is the plain
// weather quantity, before any of that.
//
// Open-Meteo supplies it — `shortwave_radiation`, global horizontal irradiance
// in W/m² — free, hourly, and with no API key. One call returns both the
// forecast and up to 92 days of history, which is what makes fitting a solar
// term possible at all: without the history a home would have to accumulate
// months of observations before its rooms could learn anything from the sun.
//
// met.no stays the temperature source. It is Nordic-specialised where these
// homes are, and it publishes no irradiance, so the two providers are used for
// what each actually offers rather than one being made to answer for both.

import {
  cachedProviderPoints,
  expiryFrom,
  type ProviderResponse,
  stepOntoSlots,
  type WeatherPoint,
} from "./weather-cache.ts";

const OPEN_METEO_ENDPOINT = "https://api.open-meteo.com/v1/forecast";
export const OPEN_METEO_PROVIDER = "open_meteo_shortwave_radiation";

/**
 * History depth requested alongside the forecast.
 *
 * The thermal fit trains on a window measured in weeks, and one request that
 * carries both directions means a home can fit a solar term the first time it
 * asks rather than after a season of collecting. 92 days is Open-Meteo's own
 * ceiling for `past_days`.
 */
const PAST_DAYS = 92;
const FORECAST_DAYS = 7;

/**
 * Open-Meteo publishes `shortwave_radiation` as the mean over the hour ending
 * at each stamp, so every point covers exactly one hour and none is ever
 * stretched further.
 */
const INTERVAL_MS = 3_600_000;

/**
 * Pull the hourly irradiance series out of an Open-Meteo response.
 *
 * Times come back without a zone under `timezone=UTC`, so they are stamped
 * explicitly here rather than left to the parser's local-time default — an
 * hour's drift either way would misplace sunrise against the room's own
 * history, which is precisely the correlation a solar fit is looking for.
 */
export function parseOpenMeteoIrradiance(body: unknown): WeatherPoint[] {
  const hourly = (body as {
    hourly?: { time?: unknown; shortwave_radiation?: unknown };
  })?.hourly;
  const times = hourly?.time;
  const values = hourly?.shortwave_radiation;
  if (!Array.isArray(times) || !Array.isArray(values)) return [];
  const points: WeatherPoint[] = [];
  for (const [index, time] of times.entries()) {
    const value = values[index];
    // Nulls are expected: the oldest days of the history window predate the
    // radiation reanalysis, and they are simply hours we cannot train on.
    if (typeof time !== "string" || typeof value !== "number") continue;
    if (!Number.isFinite(value)) continue;
    // `timezone=UTC` returns "2026-08-30T04:00": no seconds and no zone, which
    // a parser would otherwise read as local time. Length alone distinguishes
    // it, which matters at 2200 stamps a request — a regex per point is real
    // CPU against a 50 ms budget.
    const parsed = Date.parse(
      time.length === 16
        ? `${time}:00Z`
        : time.length === 19
        ? `${time}Z`
        : time,
    );
    if (!Number.isFinite(parsed)) continue;
    points.push({ t: parsed, v: value });
  }
  return points;
}

/** Fetch and cache the irradiance series covering this place. */
export async function irradiancePoints(options: {
  // deno-lint-ignore no-explicit-any
  supabase: any;
  latitude: number;
  longitude: number;
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<WeatherPoint[] | null> {
  const { supabase, now = new Date(), fetchImpl = fetch } = options;
  return await cachedProviderPoints({
    supabase,
    provider: OPEN_METEO_PROVIDER,
    latitude: options.latitude,
    longitude: options.longitude,
    now,
    fetchPoints: async (
      latitude,
      longitude,
    ): Promise<ProviderResponse | null> => {
      const url = `${OPEN_METEO_ENDPOINT}?latitude=${latitude.toFixed(2)}` +
        `&longitude=${longitude.toFixed(2)}` +
        `&hourly=shortwave_radiation&past_days=${PAST_DAYS}` +
        `&forecast_days=${FORECAST_DAYS}&timezone=UTC`;
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        console.error("[WEATHER] open-meteo responded", response.status);
        return null;
      }
      return {
        points: parseOpenMeteoIrradiance(await response.json()),
        expiresAt: expiryFrom(response, now),
      };
    },
  });
}

/**
 * Irradiance for each quarter, null where the provider cannot answer.
 *
 * Unlike a forecast, a partial answer is worth keeping here. This is a record
 * of what the sky did, and a quarter with no figure is simply one the fit will
 * not learn sunshine from — whereas a room *projected* against half a day of
 * sun and half a day of nothing would be worse than one projected against no
 * sun at all, because the error would land mid-horizon instead of uniformly.
 */
export async function irradianceForQuarters(options: {
  // deno-lint-ignore no-explicit-any
  supabase: any;
  latitude: number;
  longitude: number;
  starts: (string | number)[];
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<(number | null)[] | null> {
  if (options.starts.length === 0) return null;
  const points = await irradiancePoints(options);
  if (!points) return null;
  return stepOntoSlots(points, options.starts, INTERVAL_MS);
}

/**
 * Resample a series already in hand.
 *
 * One request needs irradiance twice — once across the planning horizon and
 * once across the training quarters being backfilled — and fetching it twice
 * meant reading and re-checking a 2200-point series twice inside a 50 ms CPU
 * budget. The series is fetched once and resampled here as many times as the
 * request needs.
 */
export function irradianceOnto(
  points: WeatherPoint[],
  starts: (string | number)[],
): (number | null)[] {
  return stepOntoSlots(points, starts, INTERVAL_MS);
}
