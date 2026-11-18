import { cachedProviderPoints, expiryFrom, PROVIDER_TIMEOUT_MS, stepOntoSlots, type WeatherPoint } from "./weather-cache.ts";

// NOAA NWS NCEP GFS data processed by dynamical.org, CC BY 4.0.
// https://dynamical.org/catalog/noaa-gfs-forecast/ and /noaa-gfs-analysis/
const PROVIDER = "dynamical_noaa_gfs_shortwave_radiation";
const ENDPOINT = "https://api.dynamical.org/v1";
const FIELD = "downward_short_wave_radiation_flux_surface";
const HOUR = 3_600_000;
const HISTORY_DAYS = 22;
export const MAX_HISTORICAL_IRRADIANCE_DAYS = 31;

interface FluxSeries { times: unknown[]; values: unknown[] }

/** GFS reports a cumulative mean since the preceding six-hour cycle boundary. */
export function hourlyGfsIrradiance(series: FluxSeries): WeatherPoint[] {
  const points: WeatherPoint[] = [];
  let previous: WeatherPoint | null = null;
  for (const [index, stamp] of series.times.entries()) {
    const t = typeof stamp === "string" ? Date.parse(stamp) : NaN;
    const value = series.values[index];
    if (!Number.isFinite(t) || t % HOUR || typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      previous = null;
      continue;
    }
    const hours = ((t / HOUR) % 6 + 6) % 6 || 6;
    if (hours === 1) points.push({ t, v: value });
    else if (previous?.t === t - HOUR) {
      points.push({ t, v: Math.max(0, value * hours - previous.v * (hours - 1)) });
    }
    previous = { t, v: value };
  }
  return points;
}

async function fetchFlux(kind: "analysis" | "forecast", latitude: number, longitude: number, now: Date, fetchImpl: typeof fetch,
  analysisWindow?: { startTime: string; endTime: string }) {
  const hour = Math.floor(now.getTime() / HOUR) * HOUR;
  const window = analysisWindow ?? (kind === "analysis" ? {
    startTime: new Date(hour - HISTORY_DAYS * 24 * HOUR).toISOString(), endTime: new Date(hour).toISOString(),
  } : { maxLeadTimeHours: 108 });
  const response = await fetchImpl(`${ENDPOINT}/${kind === "analysis" ? "analyses" : "forecasts"}`, {
    method: "POST", signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS), headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ queries: [{ dataProductId: `noaa-gfs-${kind}`, queryId: "irradiance",
      location: { latitude, longitude }, variables: [FIELD], ...window }] }),
  });
  if (!response.ok) throw new Error(`NOAA GFS ${kind} returned HTTP ${response.status}`);
  const body = await response.json();
  const result = body?.results?.[0];
  if (result?.queryId !== "irradiance") throw new Error(`Unexpected NOAA GFS ${kind} result`);
  const run = kind === "forecast" ? result.forecasts?.[0] : result;
  const times = kind === "forecast" ? run?.validTimes : run?.analysisTimes;
  const values = run?.data?.[FIELD];
  if (!Array.isArray(times) || !Array.isArray(values) || times.length !== values.length) {
    throw new Error(`Invalid NOAA GFS ${kind} radiation series`);
  }
  return { response, points: hourlyGfsIrradiance({ times, values }) };
}

export async function irradiancePoints(options: {
  // deno-lint-ignore no-explicit-any
  supabase: any;
  latitude: number;
  longitude: number;
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<WeatherPoint[] | null> {
  const { now = new Date(), fetchImpl = fetch } = options;
  return await cachedProviderPoints({ ...options, now, provider: PROVIDER,
    fetchPoints: async (latitude, longitude) => {
      const results = await Promise.allSettled([
        fetchFlux("forecast", latitude, longitude, now, fetchImpl),
        fetchFlux("analysis", latitude, longitude, now, fetchImpl),
      ]);
      const points = new Map<number, WeatherPoint>();
      const expiries: string[] = [];
      // Overlapping analyses supersede forecast values for the same hour.
      for (const result of results) {
        if (result.status === "rejected") {
          console.warn("[WEATHER] NOAA GFS irradiance unavailable", String(result.reason));
          continue;
        }
        for (const point of result.value.points) points.set(point.t, point);
        expiries.push(expiryFrom(result.value.response, now));
      }
      return expiries.length ? { points: [...points.values()].sort((a, b) => a.t - b.t), expiresAt: expiries.sort()[0] } : null;
    },
  });
}

/** Bounded archive read for a historical fitting window. The cache key includes
 * the requested hours, so history never replaces the current forecast cache.
 * A successful gap stays absent; only a failed provider read returns null.
 * https://dynamical.org/api/ documents inclusive start/exclusive end axes. */
export async function historicalIrradiancePoints(options: Parameters<typeof irradiancePoints>[0] & {
  from: string | number; to: string | number;
}): Promise<WeatherPoint[] | null> {
  const from = typeof options.from === "number" ? options.from : Date.parse(options.from);
  const to = typeof options.to === "number" ? options.to : Date.parse(options.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from ||
      to - from > MAX_HISTORICAL_IRRADIANCE_DAYS * 24 * HOUR) {
    throw new RangeError("Historical irradiance requires a positive window of at most 31 days");
  }
  const first = Math.floor(from / HOUR) * HOUR, last = Math.ceil(to / HOUR) * HOUR;
  const { now = new Date(), fetchImpl = fetch } = options;
  return await cachedProviderPoints({ ...options, now,
    provider: `${PROVIDER}_analysis_${first}_${last}`, cacheEmpty: true,
    fetchPoints: async (latitude, longitude) => {
      // Six hours carry the cumulative-mean cycle into the requested window.
      // Include the point at last: its preceding-hour mean covers the final
      // observation, while the API's endTime itself is exclusive.
      const result = await fetchFlux("analysis", latitude, longitude, now, fetchImpl, {
        startTime: new Date(first - 6 * HOUR).toISOString(), endTime: new Date(last + HOUR).toISOString(),
      });
      return { points: result.points.filter(point => point.t > first && point.t <= last),
        expiresAt: expiryFrom(result.response, now) };
    },
  });
}

export async function irradianceForQuarters(options: Parameters<typeof irradiancePoints>[0] & { starts: (string | number)[] }): Promise<(number | null)[] | null> {
  if (!options.starts.length) return null;
  const points = await irradiancePoints(options);
  return points ? irradianceOnto(points, options.starts) : null;
}

export function irradianceOnto(points: WeatherPoint[], starts: (string | number)[]): (number | null)[] {
  return stepOntoSlots(points, starts, HOUR);
}
