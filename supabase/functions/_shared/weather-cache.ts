// One cache for every weather series the planner reads for itself.
//
// The planner asks a provider directly only when the home's own integration
// could not cover the horizon, but "only sometimes" is still once per home per
// quarter-hour push, which is more than any free weather API should be asked
// to absorb. So every provider read goes through here.
//
// Keyed by coordinate rather than by home: weather is a property of a place,
// so homes in the same square kilometre share one row. Rounding to two
// decimals is deliberate on both counts — it raises the hit rate, and it keeps
// an exact house location out of a cache key for rows that carry no customer
// scope of their own.
//
// Expiry comes from the provider's `Expires` header wherever one is offered,
// because that describes the model run better than any interval we could
// invent, and because met.no's terms of service require clients to honour it.

/** One instant a provider described, in that series' own unit. */
export interface WeatherPoint {
  at: string;
  v: number;
}

/** Cache-key precision: ~1 km, comfortably inside a weather model's own grid. */
export const gridRound = (value: number): number =>
  Math.round(value * 100) / 100;

/** How long a response is trusted when the provider names no expiry. */
export const DEFAULT_TTL_MS = 30 * 60_000;

export interface ProviderResponse {
  points: WeatherPoint[];
  expiresAt: string;
}

/**
 * Read a provider's points for a place, fetching and caching on a miss.
 *
 * Returns null rather than throwing on every failure path. A weather outage
 * must cost a home its comfort forecast at worst, never its plan.
 */
export async function cachedProviderPoints(options: {
  // deno-lint-ignore no-explicit-any
  supabase: any;
  provider: string;
  latitude: number;
  longitude: number;
  now: Date;
  fetchPoints: (
    latitude: number,
    longitude: number,
  ) => Promise<ProviderResponse | null>;
}): Promise<WeatherPoint[] | null> {
  const { supabase, provider, now, fetchPoints } = options;
  const latitude = gridRound(options.latitude);
  const longitude = gridRound(options.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  try {
    const { data: cached } = await supabase
      .from("energy_outdoor_forecast_cache")
      .select("points, expires_at")
      .eq("provider", provider)
      .eq("latitude", latitude)
      .eq("longitude", longitude)
      .maybeSingle();
    if (cached && Date.parse(cached.expires_at) > now.getTime()) {
      return cached.points as WeatherPoint[];
    }

    const fresh = await fetchPoints(latitude, longitude);
    if (!fresh || fresh.points.length === 0) return null;
    const { error } = await supabase
      .from("energy_outdoor_forecast_cache")
      .upsert({
        provider,
        latitude,
        longitude,
        points: fresh.points,
        fetched_at: now.toISOString(),
        expires_at: fresh.expiresAt,
      }, { onConflict: "provider,latitude,longitude" });
    // A cache that will not write costs another request next quarter, which is
    // not a reason to withhold a forecast we are already holding.
    if (error) console.error(`[WEATHER] ${provider} cache write failed`, error);
    return fresh.points;
  } catch (error) {
    console.error(`[WEATHER] ${provider} lookup failed`, error);
    return null;
  }
}

/** Expiry from a response's own header, or a default interval from now. */
export function expiryFrom(response: Response, now: Date): string {
  const expires = Date.parse(response.headers.get("expires") ?? "");
  return new Date(
    Number.isFinite(expires) && expires > now.getTime()
      ? expires
      : now.getTime() + DEFAULT_TTL_MS,
  ).toISOString();
}

/**
 * A slot starting within this much of the first point takes that point.
 *
 * Providers publish on the hour and drop the hour already under way, so the
 * planner's first quarter is routinely minutes ahead of the forecast's first
 * entry. Reading that entry a few minutes early is the forecast, not a guess;
 * an hour is the most that can ever be true of, because the gap can never
 * exceed the distance from one quarter to the next hour.
 */
const LEAD_IN_MS = 3_600_000;

/**
 * Resample instantaneous points onto slot starts, linearly between the
 * bracketing pair.
 *
 * Slots past the last point stay null rather than flat-extrapolated: a short
 * provider horizon must stay visibly short instead of inventing weather. A gap
 * wider than `maxStepMs` is treated the same way, so a truncated response
 * cannot be smoothed into a plausible-looking straight line.
 */
export function interpolateOntoSlots(
  points: WeatherPoint[],
  starts: string[],
  maxStepMs: number,
): (number | null)[] {
  const ordered = orderPoints(points);
  if (ordered.length === 0) return starts.map(() => null);

  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  let index = 0;
  return starts.map((start) => {
    const at = Date.parse(start);
    if (!Number.isFinite(at) || at > last.t) return null;
    if (at < first.t) return first.t - at < LEAD_IN_MS ? first.v : null;
    while (index + 1 < ordered.length && ordered[index + 1].t < at) index += 1;
    const left = ordered[index];
    const right = ordered[index + 1] ?? left;
    if (right.t === left.t) return left.v;
    if (right.t - left.t > maxStepMs) return null;
    return left.v + (right.v - left.v) * ((at - left.t) / (right.t - left.t));
  });
}

/**
 * Resample a series of interval means onto slot starts.
 *
 * Some quantities are published as the mean over the hour *ending* at their
 * stamp — Open-Meteo's `shortwave_radiation` is one — and interpolating those
 * linearly would both smear the number and shift it half an hour late. A mean
 * is a step: every slot inside an hour carries that hour's figure, which is
 * the point stamped at the first instant strictly after the slot begins.
 *
 * Getting this wrong is not cosmetic for irradiance. Read an hour late and the
 * sun appears to rise after the room has already warmed, which is exactly the
 * correlation a solar-gain fit would then mistake for something else.
 */
export function stepOntoSlots(
  points: WeatherPoint[],
  starts: string[],
  intervalMs: number,
): (number | null)[] {
  const ordered = orderPoints(points);
  if (ordered.length === 0) return starts.map(() => null);

  let index = 0;
  return starts.map((start) => {
    const at = Date.parse(start);
    if (!Number.isFinite(at)) return null;
    while (index < ordered.length && ordered[index].t <= at) index += 1;
    const covering = ordered[index];
    // The stamp must be the end of an interval that actually contains the
    // slot; a later one describes a different hour, not this one.
    if (!covering || covering.t - at > intervalMs) return null;
    return covering.v;
  });
}

const orderPoints = (points: WeatherPoint[]) =>
  points
    .map((point) => ({ t: Date.parse(point.at), v: point.v }))
    .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.v))
    .sort((left, right) => left.t - right.t);
