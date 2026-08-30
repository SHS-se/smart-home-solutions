// Where the outdoor temperature a plan is built on comes from.
//
// Room comfort forecasting is the one part of the plan that needs tomorrow's
// weather: a 1R1C zone cannot be projected forward without knowing what it is
// losing heat to. Every other load — battery, boiler, pool, EV — plans on
// prices and its own recent history and needs no forecast at all.
//
// That asymmetry decides how a missing forecast is handled. A home whose
// weather provider stops short of the horizon should lose its comfort
// forecast, not its plan, so an absent series degrades rather than rejects.
//
// A series that arrives holed is the opposite case and is rejected. Home
// Assistant's contract is all-or-nothing precisely so that the two are
// distinguishable here: absence means "no provider reached that far", while a
// hole means something built a series it could not fill, and averaging over
// it would quietly plan a room against weather nobody forecast.
//
// Absence is then a question rather than a verdict, because it usually means
// the adapter fell short rather than the weather being unknown. Home
// Assistant's weather platform exposes only the part of a forecast the
// provider marks hourly — for met.no about two days, against a three-day
// horizon — while the same met.no response describes temperature for ten
// days, hourly at first and six-hourly after. So the planner asks met.no
// itself before giving up on comfort.
//
// Reading the provider directly is a wider change than it looks: until now
// every forecast reached the planner through the home's own integration, and
// a server that fetches weather is a second source of truth about the same
// quantity. It is deliberately the fallback and never the default. Whatever
// the home's own adapter can cover, it covers; this only answers for the part
// no adapter reached.

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
 * met.no requires an identifying User-Agent with a way to reach whoever runs
 * the client, and blocks requests without one. It also asks for coordinates
 * truncated to at most four decimals; the cache rounds harder still, to two,
 * so the request and the cache describe the same square kilometre.
 */
const MET_NO_USER_AGENT =
  "SmartHomeSolutions-EnergyPlanner/1.0 support@smarthomesolutions.se";
const MET_NO_ENDPOINT =
  "https://api.met.no/weatherapi/locationforecast/2.0/compact";
export const MET_NO_PROVIDER = "met_no_locationforecast";

/** Widest step met.no issues, once past its first two hourly days. */
const MET_NO_MAX_STEP_MS = 6 * 3_600_000;

/**
 * Read `properties.timeseries[].data.instant.details.air_temperature` out of a
 * met.no locationforecast response, skipping anything malformed rather than
 * failing the whole plan over one bad entry.
 */
export function parseMetNoForecast(body: unknown): WeatherPoint[] {
  const series = (body as {
    properties?: { timeseries?: unknown[] };
  })?.properties?.timeseries;
  if (!Array.isArray(series)) return [];
  const points: WeatherPoint[] = [];
  for (const entry of series) {
    const time = (entry as { time?: unknown })?.time;
    const celsius = (entry as {
      data?: { instant?: { details?: { air_temperature?: unknown } } };
    })?.data?.instant?.details?.air_temperature;
    if (typeof time !== "string" || typeof celsius !== "number") continue;
    if (!Number.isFinite(Date.parse(time)) || !Number.isFinite(celsius)) {
      continue;
    }
    points.push({ at: time, v: celsius });
  }
  return points;
}

/**
 * Outdoor temperature for every slot start, from met.no via the shared cache.
 *
 * Returns null whenever the horizon cannot be covered end to end — provider
 * unreachable, response unusable, or a forecast that still falls short. A
 * partial answer is worth nothing here: the caller's alternative is to plan
 * without comfort forecasting, which is strictly better than projecting a
 * room against weather that was interpolated out of nothing.
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
    provider: MET_NO_PROVIDER,
    latitude: options.latitude,
    longitude: options.longitude,
    now,
    fetchPoints: async (
      latitude,
      longitude,
    ): Promise<ProviderResponse | null> => {
      const response = await fetchImpl(
        `${MET_NO_ENDPOINT}?lat=${latitude.toFixed(2)}&lon=${
          longitude.toFixed(2)
        }`,
        {
          headers: {
            "User-Agent": MET_NO_USER_AGENT,
            Accept: "application/json",
          },
        },
      );
      if (!response.ok) {
        console.error("[WEATHER] met.no responded", response.status);
        return null;
      }
      return {
        points: parseMetNoForecast(await response.json()),
        expiresAt: expiryFrom(response, now),
      };
    },
  });
  if (!points) return null;

  const series = interpolateOntoSlots(points, starts, MET_NO_MAX_STEP_MS);
  if (series.some((value) => value === null)) return null;
  return {
    series: series as number[],
    issuedAt: now.toISOString(),
    points: points.length,
  };
}
