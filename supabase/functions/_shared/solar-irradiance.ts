import { cachedProviderPoints, expiryFrom, PROVIDER_TIMEOUT_MS, stepOntoSlots, type WeatherPoint } from "./weather-cache.ts";

// NOAA NWS NCEP GFS data processed by dynamical.org, CC BY 4.0.
// https://dynamical.org/catalog/noaa-gfs-forecast/ and /noaa-gfs-analysis/
const PROVIDER = "dynamical_noaa_gfs_shortwave_radiation";
const ENDPOINT = "https://api.dynamical.org/v1";
const FIELD = "downward_short_wave_radiation_flux_surface";
const HOUR = 3_600_000;
const HISTORY_DAYS = 22;

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

async function fetchFlux(kind: "analysis" | "forecast", latitude: number, longitude: number, now: Date, fetchImpl: typeof fetch) {
  const hour = Math.floor(now.getTime() / HOUR) * HOUR;
  const window = kind === "analysis" ? {
    startTime: new Date(hour - HISTORY_DAYS * 24 * HOUR).toISOString(), endTime: new Date(hour).toISOString(),
  } : { maxLeadTimeHours: 108 };
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

export async function irradianceForQuarters(options: Parameters<typeof irradiancePoints>[0] & { starts: (string | number)[] }): Promise<(number | null)[] | null> {
  if (!options.starts.length) return null;
  const points = await irradiancePoints(options);
  return points ? irradianceOnto(points, options.starts) : null;
}

export function irradianceOnto(points: WeatherPoint[], starts: (string | number)[]): (number | null)[] {
  return stepOntoSlots(points, starts, HOUR);
}
