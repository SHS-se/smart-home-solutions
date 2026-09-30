import { PROVIDER_TIMEOUT_MS } from "./weather-cache.ts";
// Where the outdoor temperature a plan is built on comes from.
//
// The server provides it, never Home Assistant: SMHI's point forecast for the
// model grid point nearest the home, for every home and every plan. Rooms need
// it to be projected forward, and the pool's losses and heat-pump COP depend
// on it. Whatever series a snapshot arrives with is replaced.
//
// There is no second provider. If SMHI cannot cover the horizon the plan goes
// without outdoor temperature: rooms lose their comfort forecast and the pool
// is planned without it, as it always was when no weather arrived.

import {
  cachedProviderPoints,
  expiryFrom,
  interpolateOntoSlots,
  type ProviderResponse,
  type WeatherPoint,
} from "./weather-cache.ts";

/** Slot-aligned outdoor temperatures, or why there are none. */
export type OutdoorSeries =
  | { status: "complete"; series: number[] }
  | { status: "absent" }
  | { status: "holed" };

/**
 * Classify the outdoor series a snapshot carries against its own horizon.
 *
 * `slotCount` is the snapshot's slot count rather than a constant, because
 * the horizon is a planner parameter and a series is only complete relative
 * to the plan it is for.
 */
export function classifyOutdoorSeries(
  outdoor: (number | null)[] | null | undefined,
  slotCount: number,
): OutdoorSeries {
  if (outdoor === null || outdoor === undefined) return { status: "absent" };
  if (outdoor.length !== slotCount) return { status: "holed" };
  const series: number[] = [];
  for (const value of outdoor) {
    if (value === null || !Number.isFinite(value)) return { status: "holed" };
    series.push(value);
  }
  return { status: "complete", series };
}

/**
 * Where the home is, from wherever this snapshot happens to carry it.
 *
 * Integrations before 0.8.0-beta.7 published coordinates only under
 * `sources.pv`, which tied weather to owning panels. A house without panels
 * sits in the same weather and its rooms gain heat from the same sun, so the
 * top-level field is preferred and the PV one is only a fallback for homes
 * that have not updated yet.
 */
export function homeLocation(
  snapshot:
    | {
      location?: { latitude?: number; longitude?: number } | null;
      sources?: {
        pv?: { location?: { latitude?: number; longitude?: number } } | null;
      };
    }
    | null
    | undefined,
): { latitude: number; longitude: number } | null {
  // A push may carry completed quarters with no snapshot at all, so an absent
  // snapshot is an ordinary answer here rather than a caller's mistake.
  if (!snapshot) return null;
  for (const candidate of [snapshot.location, snapshot.sources?.pv?.location]) {
    const { latitude, longitude } = candidate ?? {};
    if (
      typeof latitude === "number" && typeof longitude === "number" &&
      Number.isFinite(latitude) && Number.isFinite(longitude) &&
      Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180
    ) {
      return { latitude, longitude };
    }
  }
  return null;
}

/**
 * SMHI's point forecast (snow1g): hourly for about two days, then three- and
 * six-hourly out to ten days, for the grid point nearest the coordinates.
 * The grid is 2.5 km apart, so the request and its cache key carry four
 * decimals (~11 m) and name the home's own point, not a neighbour's.
 */
const SMHI_ENDPOINT =
  "https://opendata-download-metfcst.smhi.se/api/category/snow1g/version/1/geotype/point";
export const SMHI_PROVIDER = "smhi_snow1g";
const SMHI_DECIMALS = 4;
/** SMHI's missing-value marker. */
const SMHI_MISSING = 9999;

/** Widest step SMHI issues inside a three-day horizon. */
const SMHI_MAX_STEP_MS = 6 * 3_600_000;

/**
 * Read `timeSeries[].data.air_temperature` out of an SMHI snow1g response,
 * skipping anything malformed or marked missing rather than failing the whole
 * plan over one bad entry.
 */
export function parseSmhiForecast(body: unknown): WeatherPoint[] {
  const series = (body as { timeSeries?: unknown[] })?.timeSeries;
  if (!Array.isArray(series)) return [];
  const points: WeatherPoint[] = [];
  for (const entry of series) {
    const time = (entry as { time?: unknown })?.time;
    const celsius = (entry as { data?: { air_temperature?: unknown } })?.data?.air_temperature;
    if (typeof time !== "string" || typeof celsius !== "number") continue;
    const at = Date.parse(time);
    if (!Number.isFinite(at) || !Number.isFinite(celsius) || celsius === SMHI_MISSING) continue;
    points.push({ t: at, v: celsius });
  }
  return points;
}

/**
 * Outdoor temperature for every slot start, from SMHI via the shared cache.
 *
 * Returns null whenever the horizon cannot be covered end to end — provider
 * unreachable, response unusable, or a forecast that still falls short. A
 * partial answer is worth nothing here: the caller's alternative is to plan
 * without outdoor temperature, which is strictly better than projecting
 * against weather that was interpolated out of nothing.
 */
export async function outdoorSeriesFromProvider(options: {
  // deno-lint-ignore no-explicit-any
  supabase: any;
  latitude: number;
  longitude: number;
  starts: string[];
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<{ series: number[]; issuedAt: string; points: number } | null> {
  const { supabase, starts, now = new Date(), fetchImpl = fetch } = options;
  if (starts.length === 0) return null;

  const points = await cachedProviderPoints({
    supabase,
    provider: SMHI_PROVIDER,
    latitude: options.latitude,
    longitude: options.longitude,
    decimals: SMHI_DECIMALS,
    now,
    fetchPoints: async (
      latitude,
      longitude,
    ): Promise<ProviderResponse | null> => {
      const response = await fetchImpl(
        `${SMHI_ENDPOINT}/lon/${longitude.toFixed(SMHI_DECIMALS)}/lat/${
          latitude.toFixed(SMHI_DECIMALS)
        }/data.json`,
        {
          signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
          headers: { Accept: "application/json" },
        },
      );
      if (!response.ok) {
        console.error("[WEATHER] SMHI responded", response.status);
        return null;
      }
      return {
        points: parseSmhiForecast(await response.json()),
        expiresAt: expiryFrom(response, now),
      };
    },
  });
  if (!points) return null;

  const series = interpolateOntoSlots(points, starts, SMHI_MAX_STEP_MS);
  if (series.some((value) => value === null)) return null;
  return {
    series: series as number[],
    issuedAt: now.toISOString(),
    points: points.length,
  };
}

/**
 * The snapshot with the server's outdoor temperature: SMHI's forecast over its
 * slots, or none at all. A series Home Assistant sent is never kept.
 */
export async function withServerOutdoorTemperature<
  S extends {
    slots: { start: string }[];
    outdoor_temperature_c?: (number | null)[];
    location?: { latitude?: number; longitude?: number } | null;
    sources: { pv?: { location?: { latitude?: number; longitude?: number } } | null; outdoor_temperature?: unknown };
  },
>(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  snapshot: S,
  options: { now?: Date; fetchImpl?: typeof fetch } = {},
): Promise<S> {
  const { outdoor_temperature_c: _ignored, ...rest } = snapshot;
  const { outdoor_temperature: _unused, ...sources } = snapshot.sources;
  const without = { ...rest, sources } as S;
  const location = homeLocation(snapshot);
  if (!location) return without;
  const starts = snapshot.slots.map((slot) => slot.start);
  const provided = await outdoorSeriesFromProvider({ supabase, ...location, starts, ...options });
  if (!provided) return without;
  return {
    ...without,
    outdoor_temperature_c: provided.series,
    sources: {
      ...sources,
      outdoor_temperature: {
        provider: SMHI_PROVIDER,
        // No Home Assistant entity stands behind this one; the portal reads
        // the empty list as "the server fetched this itself".
        entity_ids: [],
        issued_at: provided.issuedAt,
        valid_until: new Date(Date.parse(starts[starts.length - 1]) + 15 * 60_000).toISOString(),
        quality: "provider_raw",
        sample_count: provided.points,
        location: {
          latitude: Math.round(location.latitude * 1e4) / 1e4,
          longitude: Math.round(location.longitude * 1e4) / 1e4,
        },
      },
    },
  };
}
