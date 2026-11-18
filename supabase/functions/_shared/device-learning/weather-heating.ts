import { MAX_POINTS, WEATHER_HEATING_METHOD, type HeatingDrawBand, type WeatherHeatingProfile } from "../planner/weather-heating.ts";
import { heatingBand, publishHeatingBand } from "../planner/heating-bands.ts";

const BAND_C = 3;
const DAY_MS = 86_400_000;
export const WEATHER_HEATING_BAND_IMPLEMENTATION = "weather_heating_empirical_bands_v2";

export interface HeatingDay {
  day: string;
  outdoor_c: number;
  watts: number | null;
  hours: number;
  evidence_updated_at?: string;
}
function median(values: number[]): number {
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}
type MeasuredHeatingDay = HeatingDay & { watts: number };
const validDay = (row: HeatingDay): row is MeasuredHeatingDay => Number.isFinite(row.outdoor_c) &&
  typeof row.watts === "number" && Number.isFinite(row.watts) && row.watts > 0 && Number.isFinite(row.hours) && row.hours > 0;

function heatingPoint(band: readonly MeasuredHeatingDay[]) {
  const days = new Map<string, { wh: number; hours: number }>();
  let hours = 0, outdoorHours = 0, min = Infinity, max = -Infinity;
  for (const row of band) {
    const day = days.get(row.day) ?? { wh: 0, hours: 0 };
    day.wh += row.watts * row.hours;
    day.hours += row.hours;
    days.set(row.day, day);
    hours += row.hours;
    outdoorHours += row.outdoor_c * row.hours;
    min = Math.min(min, row.outdoor_c);
    max = Math.max(max, row.outdoor_c);
  }
  const dailyWatts = [...days.values()].map(day => day.wh / day.hours);
  const watts = median(dailyWatts);
  return { outdoor_c: outdoorHours / hours, min_c: min, max_c: max, watts,
    spread_w: median(dailyWatts.map(value => Math.abs(value - watts))), hours, days: days.size };
}

/** Typical draw across days, so one long heating run cannot dominate a band. */
export function fitWeatherHeating(binding: string, observations: readonly HeatingDay[]): WeatherHeatingProfile {
  const valid = observations.filter(validDay);
  const coldest = valid.reduce((min, row) => Math.min(min, row.outdoor_c), Infinity);
  const warmest = valid.reduce((max, row) => Math.max(max, row.outdoor_c), -Infinity);
  const first = Math.floor(coldest / BAND_C) * BAND_C;
  const width = Math.max(BAND_C, (warmest - first) / MAX_POINTS);
  const bands = new Map<number, MeasuredHeatingDay[]>();
  for (const row of valid) {
    const index = Math.min(MAX_POINTS - 1, Math.floor((row.outdoor_c - first) / width));
    const band = bands.get(index) ?? [];
    band.push(row);
    bands.set(index, band);
  }
  const points = [...bands].sort(([a], [b]) => a - b).map(([, band]) => heatingPoint(band));
  return { method: WEATHER_HEATING_METHOD, binding, points };
}

export function advanceWeatherHeatingBands(
  binding: string, previous: WeatherHeatingProfile | null, observations: readonly HeatingDay[],
  completedDay: string,
): WeatherHeatingProfile {
  const profile: WeatherHeatingProfile = previous?.versioned ? previous : { method: WEATHER_HEATING_METHOD, binding,
    points: [], versioned: { candidates: [], attempted: {} },
    ...(previous ? { reference: { revision: crypto.randomUUID(), points: previous.points } } : {}) };
  const state = profile.versioned!;
  // An implementation change reconsiders every observed band without removing
  // any accepted fit. Input expiry alone never advances a material revision.
  const revisions = state.implementation === WEATHER_HEATING_BAND_IMPLEMENTATION ? state.evidence_updated_at ?? {} : {};
  const active = profile.points as HeatingDrawBand[];
  const byBand = new Map<number, { rows: MeasuredHeatingDay[]; updatedAt: string }>();
  for (const row of observations) {
    if (!Number.isFinite(row.outdoor_c) || !Number.isFinite(Date.parse(row.day)) || row.day >= completedDay) continue;
    if (!row.evidence_updated_at || !Number.isFinite(Date.parse(row.evidence_updated_at))) {
      throw new Error("Banded electrical evidence requires its material update timestamp");
    }
    const key = heatingBand(row.outdoor_c);
    const evidence = byBand.get(key) ?? { rows: [], updatedAt: row.evidence_updated_at };
    if (validDay(row)) evidence.rows.push(row);
    if (Date.parse(row.evidence_updated_at) > Date.parse(evidence.updatedAt)) evidence.updatedAt = row.evidence_updated_at;
    byBand.set(key, evidence);
  }
  const pending = [...byBand.entries()].filter(([band, evidence]) =>
    Date.parse(evidence.updatedAt) > Date.parse(revisions[band] ?? "1970-01-01"))
    .sort(([a, evidenceA], [b, evidenceB]) => Number(revisions[a] !== undefined) - Number(revisions[b] !== undefined) ||
      Date.parse(revisions[a] ?? "1970-01-01") - Date.parse(revisions[b] ?? "1970-01-01") ||
      Date.parse(evidenceB.updatedAt) - Date.parse(evidenceA.updatedAt) || a - b);
  const versioned = { ...state, candidates: [], implementation: WEATHER_HEATING_BAND_IMPLEMENTATION,
    evidence_updated_at: revisions, pending_bands: pending.length };
  if (!pending.length) return { ...profile, versioned };
  const [band, evidence] = pending[0];
  const rows = evidence.rows.sort((a, b) => a.day.localeCompare(b.day));
  const latest = rows.at(-1)?.day;
  const attempted = { ...state.attempted, ...(latest ? { [band]: latest } : {}) };
  const updated = { ...versioned, attempted, evidence_updated_at: { ...revisions, [band]: evidence.updatedAt },
    pending_bands: pending.length - 1 };
  // A withdrawn/missing input is not zero draw. Keep the published response
  // when the measured running evidence cannot identify a replacement.
  if (new Set(rows.map(row => row.day)).size < 2) return { ...profile, versioned: updated };
  const point = heatingPoint(rows);
  const revision: HeatingDrawBand = { ...point, revision: crypto.randomUUID(), band_c: band,
    observed_min_c: point.min_c, observed_max_c: point.max_c, training_from: new Date(rows[0].day).toISOString(),
    training_to: new Date(Date.parse(latest!) + DAY_MS).toISOString() };
  return { ...profile, points: publishHeatingBand(active, revision), versioned: updated };
}
