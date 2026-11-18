import { heatingCurveAt, MAX_POINTS, WEATHER_HEATING_METHOD, type HeatingDrawBand, type WeatherHeatingProfile } from "../planner/weather-heating.ts";
import { heatingBand } from "../planner/heating-bands.ts";
import { addPairedLoss, pairedImprovement, type PairedDay } from "./heating-comparison.ts";

const BAND_C = 3;
const DAY_MS = 86_400_000;

export interface HeatingDay {
  day: string;
  outdoor_c: number;
  watts: number;
  hours: number;
}
function median(values: number[]): number {
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}
const validDay = (row: HeatingDay) => Number.isFinite(row.outdoor_c) &&
  Number.isFinite(row.watts) && row.watts > 0 && Number.isFinite(row.hours) && row.hours > 0;

function heatingPoint(band: readonly HeatingDay[]) {
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
  const bands = new Map<number, HeatingDay[]>();
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
  const active = profile.points as HeatingDrawBand[];
  const byBand = new Map<number, HeatingDay[]>();
  for (const row of observations) {
    if (!validDay(row) || row.day >= completedDay) continue;
    const key = heatingBand(row.outdoor_c);
    const days = byBand.get(key) ?? [];
    days.push(row);
    byBand.set(key, days);
  }
  const next = [...byBand.entries()].map(([band, raw]) => {
    const rows = raw.sort((a, b) => a.day.localeCompare(b.day));
    return { band, rows, latest: rows.at(-1)!.day, previousAttempt: state.attempted[band] ?? "" };
  }).filter(entry => entry.latest > entry.previousAttempt)
    .sort((a, b) => a.previousAttempt.localeCompare(b.previousAttempt) || b.latest.localeCompare(a.latest))[0];
  if (!next) return profile;
  const { band, rows, latest } = next;
  const attempted = { ...state.attempted, [band]: latest };
  const incumbent = active.find(point => point.band_c === band);
  const pending = state.candidates.find(point => point.band_c === band);
  const others = state.candidates.filter(point => point !== pending);
  if (pending) {
    const losses = new Map<number, PairedDay>();
    for (const row of rows) {
      if (row.day < pending.training_to.slice(0, 10) ||
        row.outdoor_c < pending.min_c || row.outdoor_c > pending.max_c) continue;
      const existing = incumbent && row.outdoor_c >= incumbent.min_c && row.outdoor_c <= incumbent.max_c ? incumbent.watts
        : profile.reference && heatingCurveAt(profile.reference.points, row.outdoor_c)?.watts;
      if (existing != null) addPairedLoss(losses, Date.parse(row.day),
        (row.watts - pending.watts) ** 2, (row.watts - existing) ** 2);
    }
    const result = pairedImprovement(losses);
    const points = result === "better" ? [...active.filter(point => point !== incumbent), pending]
      .sort((a, b) => a.band_c - b.band_c) : active;
    return { ...profile, points, versioned: { attempted, candidates: result === "undecided" ? state.candidates : others } };
  }
  const days = [...new Set(rows.map(row => row.day))];
  const firstDay = days[incumbent ? Math.floor(days.length / 2) : 0];
  const training = rows.filter(row => row.day >= firstDay);
  const point = heatingPoint(training);
  if (point.days < 2 || (incumbent && (point.min_c > incumbent.min_c || point.max_c < incumbent.max_c))) {
    return { ...profile, versioned: { ...state, attempted } };
  }
  const revision: HeatingDrawBand = { ...point, revision: crypto.randomUUID(), band_c: band,
    observed_min_c: point.min_c, observed_max_c: point.max_c, training_from: new Date(firstDay).toISOString(),
    training_to: new Date(Date.parse(latest) + DAY_MS).toISOString() };
  const overlapsReference = profile.reference && point.max_c >= profile.reference.points[0].min_c &&
    point.min_c <= profile.reference.points.at(-1)!.max_c;
  return incumbent || overlapsReference ? { ...profile, versioned: { attempted, candidates: [...others, revision] } }
    : { ...profile, points: [...active, revision].sort((a, b) => a.band_c - b.band_c), versioned: { ...state, attempted } };
}
