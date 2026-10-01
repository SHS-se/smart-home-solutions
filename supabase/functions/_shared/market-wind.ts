// How windy the home's bidding zone has been and is forecast to be.
//
// The market publishes prices through tomorrow and a plan runs three days, so
// the level of the days after tomorrow has to be estimated. Wind is the largest
// thing that moves it, and the weather forecast reaches ten days where the
// market's own wind forecast stops at tomorrow. The planner fits its recent
// prices to the wind that blew (planner/energy-price-shape.ts) and reads the
// days ahead off the forecast; this module supplies both halves from SMHI.
//
// One number per UTC day: the mean 10 m wind speed over a fixed set of weather
// stations spread across the zone. Over 93 days (July to September 2026) that
// mean followed SE3's wind generation with a correlation of 0.97, better than a
// turbine power curve applied to the same speeds, so nothing cleverer is done.
//
//   observed   SMHI's hourly observations at the stations, kept per day.
//   forecast   SMHI's point forecast at the same coordinates, kept per day it
//              was issued on, so a bench case can later be told what a plan
//              made that day was told.
//
// Every failure leaves the plan without wind, which is the estimate it had
// before: the published level drawn toward the recent norm.

import { PROVIDER_TIMEOUT_MS } from "./weather-cache.ts";

export interface WindStation {
  /** SMHI station key for hourly wind speed (parameter 4). */
  id: string;
  name: string;
  latitude: number;
  longitude: number;
}

/**
 * The stations behind each zone's number. Only SE3 has been checked against
 * the zone's wind generation; a zone without stations gets no wind outlook.
 */
export const ZONE_STATIONS: Record<string, WindStation[]> = {
  SE3: [
    { id: "83190", name: "Hällum A", latitude: 58.3218, longitude: 13.0379 },
    { id: "81350", name: "Väderöarna A", latitude: 58.576, longitude: 11.0661 },
    { id: "85240", name: "Linköping-Malmslätt", latitude: 58.398, longitude: 15.523 },
    { id: "95130", name: "Örebro Flygplats", latitude: 59.2289, longitude: 15.0455 },
    { id: "105220", name: "Stora Spånsberget A", latitude: 60.3817, longitude: 15.1374 },
    { id: "93520", name: "Sunne A", latitude: 59.8639, longitude: 13.1166 },
    { id: "74300", name: "Tomtabacken A", latitude: 57.4981, longitude: 14.4645 },
    { id: "107140", name: "Film A", latitude: 60.2358, longitude: 17.9043 },
    { id: "106570", name: "Åmot A", latitude: 60.9614, longitude: 16.4279 },
    { id: "96040", name: "Floda A", latitude: 59.0558, longitude: 16.3944 },
  ],
};

export interface WindDay {
  /** YYYY-MM-DD, UTC. */
  day: string;
  mean_speed_m_s: number;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Hours of a day that must be on record for its mean to count. */
const MIN_HOURS = 20;
/** Share of the zone's stations that must have a day for the zone to have it. */
const MIN_STATION_SHARE = 0.6;
/** Days of observations handed to the planner, a little more than it fits on. */
export const OBSERVED_DAYS = 45;
/** How long a stored forecast is used before SMHI is asked again. */
const FORECAST_TTL_MS = 3 * HOUR_MS;
/** How long a failed observation sync waits before the next attempt. */
const OBSERVED_RETRY_MS = HOUR_MS;
/** Days of past forecasts compared with what was then observed. */
const CALIBRATION_DAYS = 14;
/** Fewer days than this with both is not a comparison. */
const CALIBRATION_MIN_DAYS = 5;
/** Widest step SMHI's point forecast takes inside the days a plan reads. */
const FORECAST_MAX_STEP_MS = 6 * HOUR_MS;

const OBSERVATIONS = "https://opendata-download-metobs.smhi.se/api/version/1.0/parameter/4/station";
const FORECAST = "https://opendata-download-metfcst.smhi.se/api/category/snow1g/version/1/geotype/point";

export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

interface HourlyPoint {
  t: number;
  v: number;
}

/** `value[]` of an SMHI observation response, skipping anything unreadable. */
export function parseObservedWind(body: unknown): HourlyPoint[] {
  const values = (body as { value?: unknown[] })?.value;
  if (!Array.isArray(values)) return [];
  const points: HourlyPoint[] = [];
  for (const entry of values) {
    const { date, value } = (entry ?? {}) as { date?: unknown; value?: unknown };
    const speed = typeof value === "string" ? Number(value) : value;
    if (typeof date !== "number" || typeof speed !== "number" || !Number.isFinite(speed) || speed < 0 || speed > 75) continue;
    points.push({ t: date, v: speed });
  }
  return points;
}

/** `timeSeries[].data.wind_speed` of an SMHI point forecast. */
export function parseForecastWind(body: unknown): HourlyPoint[] {
  const series = (body as { timeSeries?: unknown[] })?.timeSeries;
  if (!Array.isArray(series)) return [];
  const points: HourlyPoint[] = [];
  for (const entry of series) {
    const time = (entry as { time?: unknown })?.time;
    const speed = (entry as { data?: { wind_speed?: unknown } })?.data?.wind_speed;
    if (typeof time !== "string" || typeof speed !== "number" || !Number.isFinite(speed) || speed < 0 || speed > 75) continue;
    const at = Date.parse(time);
    if (Number.isFinite(at)) points.push({ t: at, v: speed });
  }
  return points.sort((a, b) => a.t - b.t);
}

/** Mean per UTC day of hourly readings, for days with enough of them. */
export function observedDailyMeans(points: HourlyPoint[]): Map<string, number> {
  const days = new Map<string, { sum: number; count: number }>();
  for (const point of points) {
    const day = utcDay(point.t);
    const held = days.get(day) ?? { sum: 0, count: 0 };
    held.sum += point.v;
    held.count += 1;
    days.set(day, held);
  }
  const means = new Map<string, number>();
  for (const [day, held] of days) if (held.count >= MIN_HOURS) means.set(day, held.sum / held.count);
  return means;
}

/**
 * Mean per UTC day of a forecast, read at every hour between its points.
 *
 * The forecast is hourly for two days and three- or six-hourly after, so each
 * hour is interpolated rather than each point counted once. A day the forecast
 * does not cover for `MIN_HOURS` hours has no mean: the day it was issued on is
 * only kept by an issue from its first hours.
 */
export function forecastDailyMeans(points: HourlyPoint[]): Map<string, number> {
  const means = new Map<string, number>();
  if (points.length < 2) return means;
  const days = new Map<string, { sum: number; count: number }>();
  let index = 0;
  const first = Math.ceil(points[0].t / HOUR_MS) * HOUR_MS;
  for (let at = first; at <= points[points.length - 1].t; at += HOUR_MS) {
    while (index + 1 < points.length && points[index + 1].t < at) index += 1;
    const left = points[index];
    const right = points[index + 1] ?? left;
    if (right.t - left.t > FORECAST_MAX_STEP_MS) continue;
    const speed = right.t === left.t ? left.v : left.v + (right.v - left.v) * ((at - left.t) / (right.t - left.t));
    const day = utcDay(at);
    const held = days.get(day) ?? { sum: 0, count: 0 };
    held.sum += speed;
    held.count += 1;
    days.set(day, held);
  }
  for (const [day, held] of days) if (held.count >= MIN_HOURS) means.set(day, held.sum / held.count);
  return means;
}

/** The zone's mean per day over the stations that have it, where enough do. */
export function zoneDailyMeans(perStation: Map<string, number>[], stationCount: number): { day: string; mean_speed_m_s: number; count: number }[] {
  const days = new Map<string, { sum: number; count: number }>();
  for (const station of perStation) {
    for (const [day, mean] of station) {
      const held = days.get(day) ?? { sum: 0, count: 0 };
      held.sum += mean;
      held.count += 1;
      days.set(day, held);
    }
  }
  return [...days]
    .filter(([, held]) => held.count >= Math.ceil(stationCount * MIN_STATION_SHARE))
    .map(([day, held]) => ({ day, mean_speed_m_s: Math.round(held.sum / held.count * 1000) / 1000, count: held.count }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

async function fetchJson(url: string, fetchImpl: typeof fetch): Promise<unknown | null> {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS), headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/** When each zone's observations were last asked for, so an SMHI outage is not retried every quarter. */
const observedAttempts = new Map<string, number>();

/**
 * Bring the zone's observed days up to yesterday.
 *
 * One missing day is read from the last 24 hours, which is a small response;
 * anything more, or a day that small response cannot complete, is read from
 * SMHI's last four months.
 */
async function syncObserved(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  zone: string,
  stations: WindStation[],
  held: WindDay[],
  now: Date,
  fetchImpl: typeof fetch,
): Promise<WindDay[]> {
  const yesterday = utcDay(now.getTime() - DAY_MS);
  const newest = held.at(-1)?.day;
  if (newest !== undefined && newest >= yesterday) return held;
  const attempted = observedAttempts.get(zone);
  if (attempted !== undefined && now.getTime() - attempted < OBSERVED_RETRY_MS) return held;
  observedAttempts.set(zone, now.getTime());

  const read = async (period: "latest-day" | "latest-months") => {
    const bodies = await Promise.all(stations.map((station) => fetchJson(`${OBSERVATIONS}/${station.id}/period/${period}/data.json`, fetchImpl)));
    return zoneDailyMeans(bodies.map((body) => observedDailyMeans(parseObservedWind(body))), stations.length)
      // Today is never complete.
      .filter((entry) => entry.day <= yesterday);
  };
  const oneDayBehind = newest !== undefined && newest === utcDay(now.getTime() - 2 * DAY_MS);
  let fresh = oneDayBehind ? await read("latest-day") : [];
  if (!fresh.some((entry) => entry.day === yesterday)) fresh = await read("latest-months");
  if (fresh.length === 0) return held;

  const { error } = await supabase.from("energy_market_wind_observed").upsert(
    fresh.map((entry) => ({ zone, day: entry.day, mean_speed_m_s: entry.mean_speed_m_s, station_count: entry.count, updated_at: now.toISOString() })),
    { onConflict: "zone,day" },
  );
  if (error) console.error("[MARKET-WIND] observed days not stored", error);
  const merged = new Map(held.map((entry) => [entry.day, entry.mean_speed_m_s]));
  for (const entry of fresh) merged.set(entry.day, entry.mean_speed_m_s);
  const from = utcDay(now.getTime() - OBSERVED_DAYS * DAY_MS);
  return [...merged].filter(([day]) => day >= from).map(([day, mean_speed_m_s]) => ({ day, mean_speed_m_s })).sort((a, b) => a.day.localeCompare(b.day));
}

interface ForecastRow {
  day: string;
  mean_speed_m_s: number;
  issued_on: string;
  issued_at: string;
}

/** The latest forecast for today and after, asking SMHI when the stored one is stale. */
async function syncForecast(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  zone: string,
  stations: WindStation[],
  held: ForecastRow[],
  now: Date,
  fetchImpl: typeof fetch,
): Promise<WindDay[]> {
  const today = utcDay(now.getTime());
  // The newest issue of each day wins; rows arrive newest issue first.
  const latest = new Map<string, number>();
  for (const row of held) if (row.day >= today && !latest.has(row.day)) latest.set(row.day, Number(row.mean_speed_m_s));
  const newestIssue = held.reduce((newest, row) => Math.max(newest, Date.parse(row.issued_at)), 0);
  if (now.getTime() - newestIssue >= FORECAST_TTL_MS) {
    const bodies = await Promise.all(stations.map((station) =>
      fetchJson(`${FORECAST}/lon/${station.longitude.toFixed(4)}/lat/${station.latitude.toFixed(4)}/data.json`, fetchImpl)
    ));
    const fresh = zoneDailyMeans(bodies.map((body) => forecastDailyMeans(parseForecastWind(body))), stations.length)
      .filter((entry) => entry.day >= today);
    if (fresh.length > 0) {
      const { error } = await supabase.from("energy_market_wind_forecast").upsert(
        fresh.map((entry) => ({
          zone, issued_on: today, day: entry.day, mean_speed_m_s: entry.mean_speed_m_s, point_count: entry.count, issued_at: now.toISOString(),
        })),
        { onConflict: "zone,issued_on,day" },
      );
      if (error) console.error("[MARKET-WIND] forecast days not stored", error);
      for (const entry of fresh) latest.set(entry.day, entry.mean_speed_m_s);
    }
  }
  return [...latest].map(([day, mean_speed_m_s]) => ({ day, mean_speed_m_s })).sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * What a forecast speed has to be multiplied by to read like an observed one.
 *
 * The forecast is the model's wind over a 2.5 km square and the observation is
 * one mast, and the planner fits prices to the masts. Where the two differ on
 * average, a forecast taken as it stands would read every day ahead as windier
 * or calmer than the days the fit was made on. The ratio is taken over the
 * recent days that were both forecast and then observed, and is 1 until there
 * are enough of them.
 */
export function forecastCalibration(observed: readonly WindDay[], forecasts: readonly { day: string; mean_speed_m_s: number | string; issued_on: string }[]): number {
  const measured = new Map(observed.map((entry) => [entry.day, entry.mean_speed_m_s]));
  // The last issue for each day, which is the one a plan would have read.
  const issued = new Map<string, { on: string; speed: number }>();
  for (const row of forecasts) {
    const held = issued.get(row.day);
    if (!held || row.issued_on > held.on) issued.set(row.day, { on: row.issued_on, speed: Number(row.mean_speed_m_s) });
  }
  let observedSum = 0, forecastSum = 0, days = 0;
  for (const [day, forecast] of issued) {
    const speed = measured.get(day);
    if (speed === undefined || !(forecast.speed > 0)) continue;
    observedSum += speed;
    forecastSum += forecast.speed;
    days += 1;
  }
  if (days < CALIBRATION_MIN_DAYS || !(forecastSum > 0)) return 1;
  return Math.min(1.4, Math.max(0.6, observedSum / forecastSum));
}

/**
 * The zone's daily wind: observed for the last weeks, forecast from today on.
 * Null for a zone without stations or when nothing could be read.
 */
export async function zoneWindDays(options: {
  // deno-lint-ignore no-explicit-any
  supabase: any;
  zone: string;
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<WindDay[] | null> {
  const { supabase, zone, now = new Date(), fetchImpl = fetch } = options;
  const stations = ZONE_STATIONS[zone];
  if (!stations) return null;
  try {
    const from = utcDay(now.getTime() - OBSERVED_DAYS * DAY_MS);
    const [observedRead, forecastRead] = await Promise.all([
      supabase.from("energy_market_wind_observed").select("day, mean_speed_m_s").eq("zone", zone).gte("day", from).order("day"),
      supabase.from("energy_market_wind_forecast").select("day, mean_speed_m_s, issued_on, issued_at").eq("zone", zone)
        .gte("issued_on", utcDay(now.getTime() - CALIBRATION_DAYS * DAY_MS)).order("issued_at", { ascending: false }),
    ]);
    if (observedRead.error || forecastRead.error) {
      console.error("[MARKET-WIND] stored wind not read", observedRead.error ?? forecastRead.error);
      return null;
    }
    const stored = (observedRead.data ?? []).map((row: { day: string; mean_speed_m_s: number | string }) => ({ day: row.day, mean_speed_m_s: Number(row.mean_speed_m_s) }));
    const [observed, forecast] = await Promise.all([
      syncObserved(supabase, zone, stations, stored, now, fetchImpl),
      syncForecast(supabase, zone, stations, forecastRead.data ?? [], now, fetchImpl),
    ]);
    const scale = forecastCalibration(observed, forecastRead.data ?? []);
    // What was measured outranks what was forecast for the same day.
    const days = new Map(forecast.map((entry) => [entry.day, Math.round(entry.mean_speed_m_s * scale * 1000) / 1000]));
    for (const entry of observed) days.set(entry.day, entry.mean_speed_m_s);
    if (days.size === 0) return null;
    return [...days].map(([day, mean_speed_m_s]) => ({ day, mean_speed_m_s })).sort((a, b) => a.day.localeCompare(b.day));
  } catch (error) {
    console.error("[MARKET-WIND] lookup failed", error);
    return null;
  }
}

/** The snapshot with the server's wind outlook for its price area, or unchanged without one. */
export async function withWindOutlook<
  S extends {
    sources: { import_price?: { location?: { market_area?: string } } | null };
    wind_outlook?: unknown;
  },
>(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  snapshot: S,
  options: { now?: Date; fetchImpl?: typeof fetch } = {},
): Promise<S> {
  // Wind is the server's to provide; whatever a snapshot arrives with is dropped.
  const { wind_outlook: _ignored, ...without } = snapshot;
  const zone = snapshot.sources.import_price?.location?.market_area?.trim().toUpperCase();
  if (!zone) return without as S;
  const days = await zoneWindDays({ supabase, zone, ...options });
  if (!days) return without as S;
  return { ...without, wind_outlook: { provider: "smhi", zone, days } } as S;
}
