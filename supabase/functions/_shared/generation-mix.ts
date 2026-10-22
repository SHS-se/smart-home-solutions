/** Pure TEST research: MW forecasts never enter household planning or price policy. */
import type { EntsoeInterval } from "./entsoe-market-data.ts";
import type { MediumRangeWeatherDocument } from "./medium-range-weather.ts";

const HOUR = 3_600_000;
const NEIGHBOURS = 12;
const ZONE = "SE3";
const ALGORITHM = "se3-generation-analog-v1";
const MODELS = ["persistence", "calendar", "weather", "published"] as const;
export type GenerationModel = typeof MODELS[number] | "hydro_state" | "nuclear_delta" | "nuclear_ratio";
export type GenerationPrediction =
  | { status: "predicted"; mw: number; trainingSamples: number; latestTrainingEnd: string | null }
  | { status: "unavailable"; reason: string };
export type GenerationModels = Record<typeof MODELS[number], GenerationPrediction> &
  Partial<Record<"hydro_state" | "nuclear_delta" | "nuclear_ratio", GenerationPrediction>>;
export interface GenerationMixForecast {
  algorithm: typeof ALGORITHM | "se3-generation-analog-v2";
  zone: typeof ZONE;
  origin: string;
  hours: { start: string; byPsr: Record<string, GenerationModels> }[];
  training: Record<string, {
    hours: number; firstStart: string | null; lastEnd: string | null; weatherHours: number;
  }>;
  diagnostics: {
    actuals: { productionIntervals: number; completeHours: number; reason: string | null };
    weather: { status: "available" | "unavailable"; issueTime: string | null; reason: string | null };
    published: { productionIntervals: number; completeHours: number; reason: string | null };
  };
}
export interface GenerationScore {
  algorithm: GenerationMixForecast["algorithm"];
  psrType: string;
  model: GenerationModel;
  lead: "0–24h" | "24–48h" | "48–72h";
  hours: number;
  origins: number;
  targetDays: number;
  maeMw: number;
  biasMw: number;
  /** Each baseline has its own exact candidate/baseline/actual intersection. Negative delta is better. */
  pairedBaseline: Record<"persistence" | "calendar", {
    hours: number; origins: number; targetDays: number;
    baselineMaeMw: number; candidateMaeMw: number; deltaMaeMw: number;
  } | null>;
}
interface HourlyMw { start: number; mw: number }
interface Piece { start: number; end: number; value: number }
type HourlyPanel = Map<string, Map<number, HourlyMw>>;
const localClock = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", weekday: "short", hourCycle: "h23",
});
function local(at: number) {
  const parts = Object.fromEntries(localClock.formatToParts(at).map(part => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: parts.hour,
    dayType: parts.weekday === "Sat" || parts.weekday === "Sun" ? "weekend" : "weekday" };
}
const iso = (at: number) => new Date(at).toISOString();
const unavailable = (reason: string): GenerationPrediction => ({ status: "unavailable", reason });
function predicted(rows: readonly HourlyMw[], weights: readonly number[] = rows.map(() => 1)): GenerationPrediction {
  if (!rows.length) return unavailable("No eligible complete historical production hours.");
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return { status: "predicted", mw: rows.reduce((sum, row, index) => sum + row.mw * weights[index], 0) / total,
    trainingSamples: rows.length, latestTrainingEnd: iso(Math.max(...rows.map(row => row.start + HOUR))) };
}
function production(row: EntsoeInterval): boolean {
  return row.flow === "production" && typeof row.psrType === "string" && /^B\d{2}$/.test(row.psrType) &&
    (row.unit === "MAW" || row.unit === "MW") && Number.isFinite(row.startMs) &&
    Number.isFinite(row.endMs) && row.endMs > row.startMs && Number.isFinite(row.value);
}

/** Union equal overlaps once; a conflicting overlap or any gap invalidates that hour. */
export function hourlyPanel(intervals: readonly EntsoeInterval[], cutoff = Infinity): HourlyPanel {
  const pieces = new Map<string, Map<number, Piece[]>>();
  for (const row of intervals) {
    if (!production(row) || row.endMs > cutoff) continue;
    const type = row.psrType!;
    const byHour = pieces.get(type) ?? new Map<number, Piece[]>();
    pieces.set(type, byHour);
    for (let at = Math.floor(row.startMs / HOUR) * HOUR; at < row.endMs; at += HOUR) {
      if (at + HOUR > cutoff) continue;
      const held = byHour.get(at) ?? [];
      held.push({ start: Math.max(at, row.startMs), end: Math.min(at + HOUR, row.endMs), value: row.value });
      byHour.set(at, held);
    }
  }
  const result: HourlyPanel = new Map();
  for (const [type, byHour] of pieces) {
    const complete = new Map<number, HourlyMw>();
    for (const [start, entries] of byHour) {
      const boundaries = [...new Set([start, start + HOUR, ...entries.flatMap(row => [row.start, row.end])])].sort((a, b) => a - b);
      let integral = 0, valid = true;
      for (let i = 1; i < boundaries.length; i++) {
        const from = boundaries[i - 1], to = boundaries[i];
        const values = new Set(entries.filter(row => row.start <= from && row.end >= to).map(row => row.value));
        if (values.size !== 1) { valid = false; break; }
        integral += values.values().next().value! * (to - from);
      }
      if (valid) complete.set(start, { start, mw: integral / HOUR });
    }
    result.set(type, complete);
  }
  return result;
}

interface WeatherFeatures {
  at(type: string, start: number): number[] | null;
}
/** All ten sites remain separate features. Radiation's label ends its represented hour. */
function weatherFeatures(weather: MediumRangeWeatherDocument | null): WeatherFeatures {
  if (!weather || weather.sites.length !== 10 || new Set(weather.sites.map(site => site.station_id)).size !== 10) {
    return { at: () => null };
  }
  const sites = weather.sites.map(site => ({ site,
    indices: new Map(site.times.map((time, index) => [Date.parse(time), index])) }));
  return { at(type, start) {
    const variables = type === "B16" ? ["shortwave_radiation"] as const
      : type === "B18" || type === "B19" ? ["wind_speed_10m", "wind_speed_120m"] as const : null;
    if (!variables) return null;
    const features: number[] = [];
    for (const { site, indices } of sites) {
      for (const variable of variables) {
        const at = variable === "shortwave_radiation" ? start + HOUR : start;
        const index = indices.get(at);
        const value = index === undefined ? null : site.series[variable][index];
        if (typeof value !== "number" || !Number.isFinite(value)) return null;
        features.push(value);
      }
    }
    return features;
  } };
}
interface AnalogRow extends HourlyMw { features: number[] }
interface WeatherAnalog {
  rows: AnalogRow[];
  scales: number[];
}
function fitWeather(rows: readonly HourlyMw[], features: WeatherFeatures, psrType: string): WeatherAnalog {
  const training = rows.flatMap(row => {
    const values = features.at(psrType, row.start);
    return values ? [{ ...row, features: values }] : [];
  });
  const scales = (training[0]?.features ?? []).map((_, column) => {
    const mean = training.reduce((sum, row) => sum + row.features[column], 0) / training.length;
    return Math.sqrt(training.reduce((sum, row) => sum + (row.features[column] - mean) ** 2, 0) / training.length) || 1;
  });
  return { rows: training, scales };
}
function weatherPrediction(analog: WeatherAnalog, target: number[] | null, supported: boolean): GenerationPrediction {
  if (!supported) return unavailable("Weather candidate is defined only for solar and onshore/offshore wind.");
  if (!target) return unavailable("Target weather requires non-null variables at all ten sites.");
  if (!analog.rows.length) return unavailable("No complete historical MW and ten-site weather pairs.");
  const neighbours = analog.rows.map(row => ({ row, distance: row.features.reduce((sum, value, column) =>
    sum + ((value - target[column]) / analog.scales[column]) ** 2, 0) / target.length }))
    .sort((a, b) => a.distance - b.distance || b.row.start - a.row.start).slice(0, NEIGHBOURS);
  // Strictly positive bounded weights are model policy, not a prediction clipping rule.
  return predicted(neighbours.map(value => value.row), neighbours.map(value => 1 / (1 + value.distance)));
}

/** Observed production types only. Each candidate is independent; missing inputs never substitute another model. */
export function forecastGenerationMix(input: {
  origin: string;
  actuals: EntsoeInterval[];
  weather: MediumRangeWeatherDocument | null;
  published: EntsoeInterval[];
}): GenerationMixForecast {
  const origin = Date.parse(input.origin);
  if (!Number.isFinite(origin)) throw new Error("Generation forecast origin must be a valid timestamp.");
  const history = hourlyPanel(input.actuals, origin);
  const published = hourlyPanel(input.published);
  const types = [...new Set(input.actuals.filter(row => production(row) && row.endMs <= origin).map(row => row.psrType!))].sort();
  const features = weatherFeatures(input.weather);
  const rowsByType = new Map(types.map(type => [type, [...(history.get(type)?.values() ?? [])].sort((a, b) => a.start - b.start)]));
  const analogByType = new Map(types.map(type => [type, fitWeather(rowsByType.get(type)!, features, type)]));
  const training = Object.fromEntries(types.map(type => {
    const rows = rowsByType.get(type)!;
    return [type, { hours: rows.length, firstStart: rows[0] ? iso(rows[0].start) : null,
      lastEnd: rows.at(-1) ? iso(rows.at(-1)!.start + HOUR) : null, weatherHours: analogByType.get(type)!.rows.length }];
  }));
  const clocks = new Map<number, ReturnType<typeof local>>();
  const clockAt = (start: number) => {
    if (!clocks.has(start)) clocks.set(start, local(start));
    return clocks.get(start)!;
  };
  const calendarByType = new Map(types.map(type => {
    const groups = new Map<string, HourlyMw[]>();
    for (const row of rowsByType.get(type)!) {
      const clock = clockAt(row.start), key = `${clock.hour}:${clock.dayType}`;
      groups.set(key, [...(groups.get(key) ?? []), row].slice(-NEIGHBOURS));
    }
    return [type, groups];
  }));
  const first = Math.ceil(origin / HOUR) * HOUR;
  const hours = Array.from({ length: 72 }, (_, index) => {
    const start = first + index * HOUR, clock = clockAt(start);
    return { start: iso(start), byPsr: Object.fromEntries(types.map(type => {
      const rows = rowsByType.get(type)!;
      const calendar = calendarByType.get(type)!.get(`${clock.hour}:${clock.dayType}`) ?? [];
      const value = published.get(type)?.get(start);
      const models: GenerationModels = {
        persistence: predicted(rows.slice(-1)),
        calendar: predicted(calendar),
        weather: weatherPrediction(analogByType.get(type)!, features.at(type, start), type === "B16" || type === "B18" || type === "B19"),
        published: value ? { status: "predicted", mw: value.mw, trainingSamples: 0, latestTrainingEnd: null }
          : unavailable("No complete published production MW hour for this target and PSR type."),
      };
      return [type, models];
    })) };
  });
  const actualCount = input.actuals.filter(row => production(row) && row.endMs <= origin).length;
  const actualHours = [...history.values()].reduce((sum, rows) => sum + rows.size, 0);
  const publishedCount = input.published.filter(production).length;
  const publishedHours = [...published.values()].reduce((sum, rows) => sum + rows.size, 0);
  const weatherAvailable = input.weather !== null && input.weather.sites.length === 10 &&
    new Set(input.weather.sites.map(site => site.station_id)).size === 10;
  return { algorithm: ALGORITHM, zone: ZONE, origin: iso(origin), hours, training, diagnostics: {
    actuals: { productionIntervals: actualCount, completeHours: actualHours,
      reason: actualHours ? null : "No complete production MW history acquired for this origin." },
    weather: { status: weatherAvailable ? "available" : "unavailable", issueTime: input.weather?.issue_time ?? null,
      reason: weatherAvailable ? null : "No ten-site weather document; per-hour missing values remain explicit." },
    published: { productionIntervals: publishedCount, completeHours: publishedHours,
      reason: publishedHours ? null : "No complete published production MW hours." },
  } };
}

/** Scores use complete later-observed production hours; model coverage remains explicit and may differ. */
export function scoreGenerationRuns(runs: readonly GenerationMixForecast[], actuals: readonly EntsoeInterval[]): GenerationScore[] {
  const panel = hourlyPanel(actuals);
  const targetDays = new Map<number, string>();
  interface PairedAccumulator { baselineAbsolute: number; candidateAbsolute: number; count: number;
    origins: Set<string>; days: Set<string> }
  const groups = new Map<string, { algorithm: GenerationMixForecast["algorithm"]; psrType: string; model: GenerationModel; lead: GenerationScore["lead"];
    absolute: number; signed: number; count: number; origins: Set<string>; days: Set<string>;
    paired: Partial<Record<"persistence" | "calendar", PairedAccumulator>> }>();
  // A repeated read of the same origin is not an independent forecast sample.
  const unique = new Map(runs.map(run => [`${run.algorithm}:${run.zone}:${run.origin}`, run]));
  for (const run of unique.values()) {
    const first = Math.ceil(Date.parse(run.origin) / HOUR) * HOUR;
    for (const hour of run.hours) {
      const at = Date.parse(hour.start), band = Math.floor((at - first) / (24 * HOUR));
      if (band < 0 || band > 2) continue;
      if (!targetDays.has(at)) targetDays.set(at, local(at).day);
      const lead = (["0–24h", "24–48h", "48–72h"] as const)[band];
      for (const [psrType, predictions] of Object.entries(hour.byPsr)) {
        const actual = panel.get(psrType)?.get(at);
        if (!actual) continue;
        for (const model of [...MODELS, "hydro_state", "nuclear_delta", "nuclear_ratio"] as const) {
          const prediction = predictions[model];
          if (!prediction || prediction.status !== "predicted") continue;
          const key = `${run.algorithm}:${psrType}:${model}:${lead}`;
          const group = groups.get(key) ?? { algorithm: run.algorithm, psrType, model, lead, absolute: 0, signed: 0, count: 0,
            origins: new Set<string>(), days: new Set<string>(), paired: {} };
          const error = prediction.mw - actual.mw;
          group.absolute += Math.abs(error); group.signed += error; group.count++;
          group.origins.add(run.origin); group.days.add(targetDays.get(at)!); groups.set(key, group);
          for (const baseline of ["persistence", "calendar"] as const) {
            const reference = predictions[baseline];
            if (reference.status !== "predicted") continue;
            const paired = group.paired[baseline] ?? { baselineAbsolute: 0, candidateAbsolute: 0, count: 0,
              origins: new Set<string>(), days: new Set<string>() };
            paired.baselineAbsolute += Math.abs(reference.mw - actual.mw);
            paired.candidateAbsolute += Math.abs(error); paired.count++;
            paired.origins.add(run.origin); paired.days.add(targetDays.get(at)!);
            group.paired[baseline] = paired;
          }
        }
      }
    }
  }
  return [...groups.values()].map(group => ({ algorithm: group.algorithm, psrType: group.psrType, model: group.model, lead: group.lead,
    hours: group.count, origins: group.origins.size, targetDays: group.days.size,
    maeMw: group.absolute / group.count, biasMw: group.signed / group.count,
    pairedBaseline: Object.fromEntries((["persistence", "calendar"] as const).map(baseline => {
      const pair = group.paired[baseline];
      return [baseline, pair ? { hours: pair.count, origins: pair.origins.size, targetDays: pair.days.size,
        baselineMaeMw: pair.baselineAbsolute / pair.count, candidateMaeMw: pair.candidateAbsolute / pair.count,
        deltaMaeMw: (pair.candidateAbsolute - pair.baselineAbsolute) / pair.count } : null];
    })) as GenerationScore["pairedBaseline"] }))
    .sort((a, b) => a.algorithm.localeCompare(b.algorithm) || a.psrType.localeCompare(b.psrType) || a.model.localeCompare(b.model) || a.lead.localeCompare(b.lead));
}

export { local as generationLocalTime };
