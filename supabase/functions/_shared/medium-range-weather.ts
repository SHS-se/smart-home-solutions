/** Native seven-day weather evidence for TEST price research; never generation MW. */
import { ZONE_STATIONS } from "./market-wind.ts";

export const MEDIUM_RANGE_VARIABLES = ["wind_speed_10m", "wind_speed_120m", "temperature_2m", "shortwave_radiation"] as const;
type Variable = typeof MEDIUM_RANGE_VARIABLES[number];
type VariableValues<T> = Record<Variable, T>;
const MODEL = "ecmwf_ifs025";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SEMANTICS: VariableValues<{ unit: string; time: "instant" | "preceding_hour_mean" }> = {
  wind_speed_10m: { unit: "m/s", time: "instant" },
  wind_speed_120m: { unit: "m/s", time: "instant" },
  temperature_2m: { unit: "°C", time: "instant" },
  shortwave_radiation: { unit: "W/m²", time: "preceding_hour_mean" },
};
export interface MediumRangeWeatherDocument {
  provider: "open_meteo";
  model: typeof MODEL;
  issue_time: null;
  attribution: string;
  semantics: typeof SEMANTICS;
  sites: {
    station_id: string;
    requested: { latitude: number; longitude: number };
    grid: { latitude: number; longitude: number; elevation_m: number | null };
    times: string[];
    series: VariableValues<(number | null)[]>;
  }[];
  coverage: {
    day: string;
    lead_days: 2 | 3;
    expected_samples: number;
    sites: { station_id: string; non_null_samples: VariableValues<number> }[];
  }[];
}

/** Fixed model, sites and native units make successive vintages comparable. */
export function mediumRangeWeatherRequest(pastDays: 0 | 28 = 0) {
  const sites = ZONE_STATIONS.SE3.map(({ id, latitude, longitude }) => ({ station_id: id, latitude, longitude }));
  const record = {
    provider: "open_meteo" as const, model: MODEL as typeof MODEL, forecast_days: 7 as const, past_days: pastDays,
    timezone: "UTC" as const, wind_speed_unit: "ms" as const,
    variables: [...MEDIUM_RANGE_VARIABLES], sites,
  };
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: sites.map(site => site.latitude).join(","),
    longitude: sites.map(site => site.longitude).join(","),
    models: record.model, forecast_days: String(record.forecast_days),
    timezone: record.timezone, wind_speed_unit: record.wind_speed_unit,
    hourly: record.variables.join(","),
  }).toString();
  if (pastDays !== 0) url.searchParams.set("past_days", String(pastDays));
  return { url, record };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid weather object");
  return value as Record<string, unknown>;
}
function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function nativeHour(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:00(?::00(?:\.000)?)?Z?$/.test(value)) {
    throw new Error("Weather time must be an aligned UTC hour");
  }
  const parsed = Date.parse(value.endsWith("Z") ? value : `${value}Z`);
  if (!Number.isFinite(parsed)) throw new Error("Invalid weather time");
  const canonical = new Date(parsed).toISOString();
  if (canonical.slice(0, 13) !== value.slice(0, 13)) throw new Error("Invalid weather calendar date");
  return canonical;
}
const stockholmDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit",
});
function localDay(timestamp: number): string {
  const parts = stockholmDay.formatToParts(timestamp);
  const part = (name: string) => parts.find(value => value.type === name)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
function variableValues<T>(create: (variable: Variable) => T): VariableValues<T> {
  return Object.fromEntries(MEDIUM_RANGE_VARIABLES.map(variable => [variable, create(variable)])) as VariableValues<T>;
}

/** Parse the documented multi-coordinate response in request order. Grid positions are separate provenance. */
export function parseMediumRangeWeather(body: unknown, requestedAt: string): MediumRangeWeatherDocument {
  const requestedMs = Date.parse(requestedAt);
  if (!Number.isFinite(requestedMs)) throw new Error("Invalid weather acquisition time");
  const requestedSites = mediumRangeWeatherRequest().record.sites;
  if (!Array.isArray(body) || body.length !== requestedSites.length) throw new Error("Weather batch does not match requested sites");
  const sites: MediumRangeWeatherDocument["sites"] = body.map((value, index) => {
    const entry = object(value), hourly = object(entry.hourly), units = object(entry.hourly_units);
    if (entry.utc_offset_seconds !== 0 || !["GMT", "UTC"].includes(String(entry.timezone)) || units.time !== "iso8601") {
      throw new Error("Weather response must use UTC ISO times");
    }
    if (!finite(entry.latitude) || entry.latitude < -90 || entry.latitude > 90 ||
      !finite(entry.longitude) || entry.longitude < -180 || entry.longitude > 180 ||
      !(entry.elevation === null || finite(entry.elevation))) throw new Error("Invalid weather grid coordinates");
    if (!Array.isArray(hourly.time)) throw new Error("Missing weather times");
    const times = hourly.time.map(nativeHour);
    for (let i = 1; i < times.length; i++) {
      if (times[i] <= times[i - 1]) throw new Error("Weather times must be ascending and unique");
    }
    const series = variableValues(variable => {
      if (units[variable] !== SEMANTICS[variable].unit) throw new Error(`Unexpected weather units: ${variable}`);
      const values = hourly[variable];
      if (!Array.isArray(values) || values.length !== times.length || !values.every(cell => cell === null || finite(cell))) {
        throw new Error(`Invalid weather values: ${variable}`);
      }
      return [...values] as (number | null)[];
    });
    const requested = requestedSites[index];
    return { station_id: requested.station_id,
      requested: { latitude: requested.latitude, longitude: requested.longitude },
      grid: { latitude: entry.latitude, longitude: entry.longitude, elevation_m: entry.elevation }, times, series };
  });
  const baseDay = Date.parse(`${localDay(requestedMs)}T00:00:00.000Z`);
  const coverage = ([2, 3] as const).map(lead_days => {
    const nominal = baseDay + lead_days * DAY;
    const day = new Date(nominal).toISOString().slice(0, 10);
    // Enumerate native UTC hours around the local date; DST dates contain 23 or 25.
    let expected_samples = 0;
    for (let timestamp = nominal - DAY; timestamp < nominal + 2 * DAY; timestamp += HOUR) {
      if (localDay(timestamp) === day) expected_samples++;
    }
    return { day, lead_days, expected_samples, sites: sites.map(site => ({
      station_id: site.station_id,
      non_null_samples: variableValues(variable => site.times.reduce((count, time, index) => {
        // Radiation timestamp ends the preceding hourly interval. Midnight belongs to yesterday.
        const representedTime = Date.parse(time) - (SEMANTICS[variable].time === "preceding_hour_mean" ? 1 : 0);
        return count + (site.series[variable][index] !== null && localDay(representedTime) === day ? 1 : 0);
      }, 0)),
    })) };
  });
  return { provider: "open_meteo", model: MODEL, issue_time: null,
    attribution: "Weather data: Open-Meteo (https://open-meteo.com/), ECMWF IFS (https://www.ecmwf.int/).",
    semantics: structuredClone(SEMANTICS), sites, coverage };
}
