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
// itself before giving up on comfort, using the coordinates the snapshot
// already declares for its PV forecast.
//
// Reading the provider directly is a wider change than it looks: until now
// every forecast reached the planner through the home's own integration, and
// a server that fetches weather is a second source of truth about the same
// quantity. It is deliberately the fallback and never the default. Whatever
// the home's own adapter can cover, it covers; this only answers for the part
// no adapter reached.

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

/** One instant a provider described, at whatever resolution it issued. */
export interface ForecastPoint {
  at: string;
  c: number;
}

/**
 * A quarter starting within this much of the first point takes that point.
 *
 * Providers publish on the hour and drop the hour already under way, so the
 * planner's first quarter is routinely minutes ahead of the forecast's first
 * entry. Reading that entry a few minutes early is the forecast, not a guess;
 * an hour is the most that can be true of, because the gap can never exceed
 * the distance from one quarter to the next hour.
 */
const LEAD_IN_MS = 3_600_000;

/** Widest provider step worth interpolating across. met.no issues six. */
const MAX_STEP_MS = 6 * 3_600_000;

/**
 * Resample provider points onto slot starts, linearly between the bracketing
 * pair. Slots past the last point stay null rather than flat-extrapolated:
 * a short provider horizon must stay visibly short instead of inventing
 * weather. A gap wider than a provider ever issues is treated the same way,
 * so a truncated response cannot be smoothed into a plausible-looking line.
 */
export function interpolateOntoSlots(
  points: ForecastPoint[],
  starts: string[],
): (number | null)[] {
  const ordered = points
    .map((point) => ({ t: Date.parse(point.at), c: point.c }))
    .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.c))
    .sort((left, right) => left.t - right.t);
  if (ordered.length === 0) return starts.map(() => null);

  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  let index = 0;
  return starts.map((start) => {
    const at = Date.parse(start);
    if (!Number.isFinite(at) || at > last.t) return null;
    if (at < first.t) return first.t - at < LEAD_IN_MS ? first.c : null;
    while (index + 1 < ordered.length && ordered[index + 1].t < at) index += 1;
    const left = ordered[index];
    const right = ordered[index + 1] ?? left;
    if (right.t === left.t) return left.c;
    if (right.t - left.t > MAX_STEP_MS) return null;
    return left.c + (right.c - left.c) * ((at - left.t) / (right.t - left.t));
  });
}

/**
 * Read `properties.timeseries[].data.instant.details.air_temperature` out of a
 * met.no locationforecast response, skipping anything malformed rather than
 * failing the whole plan over one bad entry.
 */
export function parseMetNoForecast(body: unknown): ForecastPoint[] {
  const series = (body as {
    properties?: { timeseries?: unknown[] };
  })?.properties?.timeseries;
  if (!Array.isArray(series)) return [];
  const points: ForecastPoint[] = [];
  for (const entry of series) {
    const time = (entry as { time?: unknown })?.time;
    const celsius = (entry as {
      data?: { instant?: { details?: { air_temperature?: unknown } } };
    })?.data?.instant?.details?.air_temperature;
    if (typeof time !== "string" || typeof celsius !== "number") continue;
    if (!Number.isFinite(Date.parse(time)) || !Number.isFinite(celsius)) {
      continue;
    }
    points.push({ at: time, c: celsius });
  }
  return points;
}

/**
 * met.no requires an identifying User-Agent with a way to reach whoever runs
 * the client, and blocks requests without one. It also asks for coordinates
 * truncated to at most four decimals; we round harder still, to the two
 * decimals the cache is keyed by, so the request and the cache describe the
 * same square kilometre.
 */
const MET_NO_USER_AGENT =
  "SmartHomeSolutions-EnergyPlanner/1.0 support@smarthomesolutions.se";
const MET_NO_ENDPOINT =
  "https://api.met.no/weatherapi/locationforecast/2.0/compact";
const PROVIDER = "met_no_locationforecast";

/** Cache-key precision: ~1 km, comfortably inside met.no's own grid. */
export const gridRound = (value: number): number =>
  Math.round(value * 100) / 100;

/** How long a response is trusted when the provider names no expiry. */
const DEFAULT_TTL_MS = 30 * 60_000;

interface CachedForecast {
  points: ForecastPoint[];
  expiresAt: string;
  fetchedAt: string;
}

async function fetchMetNo(
  latitude: number,
  longitude: number,
  now: Date,
  fetchImpl: typeof fetch,
): Promise<CachedForecast | null> {
  const url = `${MET_NO_ENDPOINT}?lat=${latitude.toFixed(2)}&lon=${
    longitude.toFixed(2)
  }`;
  const response = await fetchImpl(url, {
    headers: { "User-Agent": MET_NO_USER_AGENT, Accept: "application/json" },
  });
  if (!response.ok) {
    console.error("[OUTDOOR-FORECAST] met.no responded", response.status);
    return null;
  }
  const points = parseMetNoForecast(await response.json());
  if (points.length === 0) return null;
  const expires = Date.parse(response.headers.get("expires") ?? "");
  return {
    points,
    fetchedAt: now.toISOString(),
    expiresAt: new Date(
      Number.isFinite(expires) && expires > now.getTime()
        ? expires
        : now.getTime() + DEFAULT_TTL_MS,
    ).toISOString(),
  };
}

/**
 * Outdoor temperature for every slot start, from met.no via a shared cache.
 *
 * Returns null whenever the horizon cannot be covered end to end — provider
 * unreachable, response unusable, or a forecast that still falls short. A
 * partial answer is worth nothing here: the caller's alternative is to plan
 * without comfort forecasting, which is strictly better than projecting a
 * room against weather that was interpolated out of nothing.
 *
 * A weather outage must never stop a home from planning, so every failure
 * path is a logged null rather than a throw.
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
  const {
    supabase,
    starts,
    now = new Date(),
    fetchImpl = fetch,
  } = options;
  if (starts.length === 0) return null;
  const latitude = gridRound(options.latitude);
  const longitude = gridRound(options.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  try {
    const { data: cached } = await supabase
      .from("energy_outdoor_forecast_cache")
      .select("points, fetched_at, expires_at")
      .eq("provider", PROVIDER)
      .eq("latitude", latitude)
      .eq("longitude", longitude)
      .maybeSingle();

    let forecast: CachedForecast | null =
      cached && Date.parse(cached.expires_at) > now.getTime()
        ? {
          points: cached.points as ForecastPoint[],
          fetchedAt: cached.fetched_at,
          expiresAt: cached.expires_at,
        }
        : null;

    if (!forecast) {
      forecast = await fetchMetNo(latitude, longitude, now, fetchImpl);
      if (!forecast) return null;
      const { error } = await supabase
        .from("energy_outdoor_forecast_cache")
        .upsert({
          provider: PROVIDER,
          latitude,
          longitude,
          points: forecast.points,
          fetched_at: forecast.fetchedAt,
          expires_at: forecast.expiresAt,
        }, { onConflict: "provider,latitude,longitude" });
      // A cache that will not write costs another request next quarter, which
      // is not a reason to withhold a forecast we already hold.
      if (error) console.error("[OUTDOOR-FORECAST] cache write failed", error);
    }

    const series = interpolateOntoSlots(forecast.points, starts);
    if (series.some((value) => value === null)) return null;
    return {
      series: series as number[],
      issuedAt: forecast.fetchedAt,
      points: forecast.points.length,
    };
  } catch (error) {
    console.error("[OUTDOOR-FORECAST] met.no lookup failed", error);
    return null;
  }
}
