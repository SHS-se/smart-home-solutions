import { buildPriceOutlook, localSlot, type StoredPriceRow, type WindDay } from "./planner/energy-price-shape.ts";
import { forecastCalibration } from "./market-wind.ts";
import { priceCoverageByBucket } from "./planner/price-coverage.ts";

export interface WindIssue extends WindDay { issued_on: string; issued_at: string }
export interface MarketInterval { startMs: number; endMs: number; value: number }
export interface MarketSeries { signal: string; evidence: "retrospective"; intervals: MarketInterval[] }
export interface ResearchBundle {
  prices: StoredPriceRow[];
  observedWind: WindDay[];
  windForecasts: WindIssue[];
  market: MarketSeries[];
}
export interface Metrics {
  quarters: number;
  origins: number;
  targetDays: number;
  mae: number;
  bias: number;
  /** Absolute error of the mean on each origin/target day's scored quarters. */
  dailyMeanMae: number;
}
export interface ModelResult {
  id: string;
  label: string;
  status: "available" | "unavailable";
  reason?: string;
  metrics: Metrics | null;
  byHorizon: Record<string, Metrics>;
}
export interface OriginResult {
  origin: string;
  publishedUntil: string;
  quarters: number;
  pairedQuarters: number;
  windAvailable: boolean;
  windModelUsed: boolean;
  calibrationScale: number;
  latestWindIssue: string | null;
  metrics: Record<string, Metrics>;
  pairedMetrics: Record<string, Metrics>;
  windBetter: boolean | null;
}
interface DailyFactorResult {
  id: string;
  factors: string[];
  status: "available" | "unavailable";
  reason?: string;
  days: number;
  targetDays: string[];
  mae: number | null;
  bias: number | null;
  baselineMae: number | null;
  daily: { day: string; actual: number; prediction: number; baselinePrediction: number;
    absoluteError: number; baselineAbsoluteError: number }[];
}
export interface ComparisonReport {
  assumptions: string[];
  models: ModelResult[];
  origins: OriginResult[];
  paired: {
    origins: number; quarters: number; windWins: number; noWindWins: number; ties: number;
    models: ModelResult[];
  };
  retrospective: { status: "available" | "unavailable"; reason?: string; models: DailyFactorResult[] };
}

const DAY = 86_400_000, HOUR = 3_600_000, QUARTER = 900_000;
const TZ = "Europe/Stockholm";
const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10);
const dayStart = (day: string) => Date.parse(`${day}T00:00:00Z`);
const localDay = (at: number) => localSlot(at, TZ).dayKey;
interface Sample { origin: number; target: number; prediction: number; actual: number }

function metrics(samples: readonly Sample[]): Metrics | null {
  if (!samples.length) return null;
  const days = new Map<string, { sum: number; count: number }>();
  let sum = 0, absolute = 0;
  for (const sample of samples) {
    const error = sample.prediction - sample.actual;
    sum += error;
    absolute += Math.abs(error);
    const key = `${sample.origin}:${localDay(sample.target)}`;
    const day = days.get(key) ?? { sum: 0, count: 0 };
    day.sum += error;
    day.count++;
    days.set(key, day);
  }
  return {
    quarters: samples.length,
    origins: new Set(samples.map(sample => sample.origin)).size,
    targetDays: new Set(samples.map(sample => localDay(sample.target))).size,
    mae: absolute / samples.length,
    bias: sum / samples.length,
    dailyMeanMae: [...days.values()].reduce((sum, day) => sum + Math.abs(day.sum / day.count), 0) / days.size,
  };
}

function modelResult(id: string, label: string, samples: readonly Sample[], reason: string): ModelResult {
  const byHorizon: Record<string, Metrics> = {};
  for (const lead of [2, 3]) {
    const subset = samples.filter(sample =>
      (dayStart(localDay(sample.target)) - dayStart(localDay(sample.origin))) / DAY === lead);
    const result = metrics(subset);
    if (result) byHorizon[`D+${lead}`] = result;
  }
  return { id, label, status: samples.length ? "available" : "unavailable",
    ...(!samples.length ? { reason } : {}), metrics: metrics(samples), byHorizon };
}

/** Assumed published window at the fixed 20:00 UTC origin, not a saved publication vintage. */
function publishedEnd(origin: number): number {
  const tomorrow = utcDay(dayStart(localDay(origin)) + DAY);
  let end = origin;
  while (localDay(end) <= tomorrow) end += QUARTER;
  return end;
}

function windAtOrigin(bundle: ResearchBundle, origin: number) {
  const today = utcDay(origin);
  const observed = bundle.observedWind.filter(row =>
    dayStart(row.day) + DAY <= origin && row.day >= utcDay(origin - 45 * DAY));
  const eligible = bundle.windForecasts.filter(row => Number.isFinite(Date.parse(row.issued_at)) &&
    Date.parse(row.issued_at) <= origin && row.issued_on >= utcDay(origin - 14 * DAY));
  eligible.sort((a, b) => Date.parse(b.issued_at) - Date.parse(a.issued_at));
  const forecast = new Map<string, WindIssue>();
  for (const row of eligible) if (row.day >= today && !forecast.has(row.day)) forecast.set(row.day, row);
  const calibrationScale = forecastCalibration(observed, eligible);
  const days = new Map<string, number>([...forecast.values()].map(row =>
    [row.day, Math.round(row.mean_speed_m_s * calibrationScale * 1000) / 1000]));
  for (const row of observed) days.set(row.day, row.mean_speed_m_s);
  return {
    days: [...days].map(([day, mean_speed_m_s]) => ({ day, mean_speed_m_s })),
    forecastDays: new Set(forecast.keys()), calibrationScale,
    latestIssue: eligible[0]?.issued_at ?? null,
  };
}

/** Pure research: never fetches, persists, chooses a live model, or mutates the bundle. */
export function comparePriceForecasts(bundle: ResearchBundle): ComparisonReport {
  const prices = new Map<number, number>();
  for (const row of bundle.prices) {
    const at = Date.parse(row.start_ts);
    if (Number.isFinite(at) && Number.isFinite(row.import_price_sek_per_kwh)) prices.set(at, row.import_price_sek_per_kwh);
  }
  const timestamps = [...prices.keys()].sort((a, b) => a - b);
  const byLocalQuarter = new Map<string, number>();
  for (const at of timestamps) {
    const slot = localSlot(at, TZ);
    const key = `${slot.dayKey}:${slot.quarter}`;
    if (!byLocalQuarter.has(key)) byLocalQuarter.set(key, at);
  }
  const noWindSamples: Sample[] = [], windSamples: Sample[] = [], naiveSamples: Sample[] = [];
  const pairedNoWind: Sample[] = [], pairedWind: Sample[] = [];
  const origins: OriginResult[] = [];
  const firstOrigin = Math.floor((timestamps[0] ?? 0) / DAY) * DAY + 30 * DAY + 20 * HOUR;
  const last = timestamps.at(-1) ?? -Infinity;
  for (let origin = firstOrigin; origin < last; origin += DAY) {
    const cutoff = publishedEnd(origin);
    if (cutoff > last) continue;
    const history: StoredPriceRow[] = timestamps.filter(at => at < origin)
      .map(at => ({ start_ts: new Date(at).toISOString(), import_price_sek_per_kwh: prices.get(at)! }));
    const slots = Array.from({ length: 72 * 4 }, (_, index) => {
      const at = origin + index * QUARTER;
      return { start: new Date(at).toISOString(), import_price_sek_per_kwh: at < cutoff ? prices.get(at) ?? null : null };
    });
    if (!slots.some(slot => slot.import_price_sek_per_kwh !== null)) continue;
    const wind = windAtOrigin(bundle, origin);
    const plain = buildPriceOutlook(slots, history, { asOf: origin, timeZone: TZ });
    const windy = buildPriceOutlook(slots, history, { asOf: origin, timeZone: TZ, wind: wind.days });
    const localPlain: Sample[] = [], localWind: Sample[] = [], localNaive: Sample[] = [];
    const localPairedPlain: Sample[] = [], localPairedWind: Sample[] = [];
    for (let index = 0; index < slots.length; index++) {
      const target = origin + index * QUARTER;
      const actual = prices.get(target);
      if (target < cutoff || actual === undefined) continue;
      const common = { origin, target, actual };
      const plainSample = { ...common, prediction: plain.shadowImportSekPerKwh[index] };
      localPlain.push(plainSample);
      if (wind.forecastDays.has(utcDay(target))) {
        const windSample = { ...common, prediction: windy.shadowImportSekPerKwh[index] };
        localWind.push(windSample);
        localPairedPlain.push(plainSample);
        localPairedWind.push(windSample);
      }
      // Same local wall-clock quarter one week earlier, including DST changes.
      const wantedDay = utcDay(dayStart(localDay(target)) - 7 * DAY);
      const wantedQuarter = localSlot(target, TZ).quarter;
      const naiveAt = byLocalQuarter.get(`${wantedDay}:${wantedQuarter}`);
      if (naiveAt !== undefined && naiveAt < origin) localNaive.push({ ...common, prediction: prices.get(naiveAt)! });
    }
    noWindSamples.push(...localPlain);
    windSamples.push(...localWind);
    naiveSamples.push(...localNaive);
    pairedNoWind.push(...localPairedPlain);
    pairedWind.push(...localPairedWind);
    const plainMetrics = metrics(localPairedPlain), windMetrics = metrics(localPairedWind);
    const originMetrics: Record<string, Metrics> = {};
    for (const [id, samples] of [["no_wind", localPlain], ["wind", localWind], ["seasonal_naive", localNaive]] as const) {
      const result = metrics(samples);
      if (result) originMetrics[id] = result;
    }
    origins.push({ origin: new Date(origin).toISOString(), publishedUntil: new Date(cutoff).toISOString(),
      quarters: localPlain.length, pairedQuarters: localPairedPlain.length,
      windAvailable: localWind.length > 0, windModelUsed: windy.levelBasis === "wind",
      calibrationScale: wind.calibrationScale, latestWindIssue: wind.latestIssue,
      metrics: originMetrics,
      pairedMetrics: plainMetrics && windMetrics ? { no_wind: plainMetrics, wind: windMetrics } : {},
      windBetter: plainMetrics && windMetrics ? windMetrics.mae < plainMetrics.mae : null });
  }
  const pairedOrigins = origins.filter(origin => origin.pairedQuarters > 0);
  const windWins = pairedOrigins.filter(origin => origin.windBetter === true).length;
  const ties = pairedOrigins.filter(origin => {
    const matching = pairedNoWind.filter(sample => sample.origin === Date.parse(origin.origin));
    const actualWind = pairedWind.filter(sample => sample.origin === Date.parse(origin.origin));
    return metrics(matching)?.mae === metrics(actualWind)?.mae;
  }).length;
  return {
    assumptions: [
      "Origins are daily at 20:00 UTC, after 30 days of archive warm-up, with a 72-hour horizon.",
      "Tomorrow's local-day prices are assumed published by the origin; original price publication vintages are unavailable.",
      "Price history and completed-day wind observations are latest stored values, potentially revised; this is an as-of reconstruction, not a fully vintage-preserved backtest.",
      "Only saved SMHI issues at or before each origin are eligible; completed UTC observations and the live 14-day forecast calibration are reconstructed as of that origin.",
      "SMHI storage retains the latest issue per issued-on/target-day pair. Overwritten earlier intraday vintages cannot be recovered, so as-of filtering can use an older surviving issue instead of the one originally available.",
      "Wind/no-wind paired results use identical unpublished quarters with actual prices and a saved forecast for that target UTC day. Gaps are excluded, never filled.",
      "Daily mean errors describe the scored quarters of each origin/target day; partial days remain partial. Overlapping origins and quarter errors are correlated.",
      "Top-level model samples can differ; use paired.models when assessing the incremental value of wind.",
      "Seasonal naive copies the same local quarter one week earlier; no matching observation means no prediction.",
      "ENTSO-E actual-factor experiments are retrospective/oracle comparisons and cannot demonstrate achievable D+2/D+3 forecast improvement.",
      "ENTSO-E wind factors represent the reported SE3 wind series, not all Swedish or interconnected generation; missing technologies or intervals are not assumed to be zero.",
      "Retrospective ablations and their paired baselines are scored on the intersection of held-out target days across all available factor specifications. Each specification trains only on its own strictly earlier eligible rows.",
      "Exact duplicate ENTSO-E intervals count once. A signal with overlapping non-identical intervals is unavailable because overlapping durations cannot establish coverage.",
    ],
    models: [
      modelResult("no_wind", "Current estimator without wind", noWindSamples, "No scored unpublished price quarters after warm-up."),
      modelResult("wind", "Current estimator with saved, calibrated SMHI wind", windSamples, "No saved as-of wind forecast overlaps scored quarters."),
      modelResult("seasonal_naive", "Same local quarter one week earlier", naiveSamples, "No matching historical local quarters."),
    ],
    origins,
    paired: { origins: pairedOrigins.length, quarters: pairedWind.length, windWins,
      noWindWins: pairedOrigins.length - windWins - ties, ties,
      models: [modelResult("no_wind", "Without wind, shared samples", pairedNoWind, "No paired samples."),
        modelResult("wind", "With wind, shared samples", pairedWind, "No paired samples.")] },
    retrospective: retrospectiveFactors(bundle),
  };
}

function retrospectiveFactors(bundle: ResearchBundle): ComparisonReport["retrospective"] {
  const prices = priceCoverageByBucket(bundle.prices, QUARTER, at => utcDay(at));
  const levels = new Map([...prices].filter(([, value]) => value.coveredMs >= 20 * HOUR)
    .map(([day, value]) => [day, value.mean]));
  const factors = new Map<string, Map<string, number>>();
  const invalid = new Map<string, string>();
  const intervalsBySignal = new Map<string, MarketInterval[]>();
  for (const series of bundle.market) {
    if (series.evidence !== "retrospective") continue;
    intervalsBySignal.set(series.signal, [...(intervalsBySignal.get(series.signal) ?? []), ...series.intervals]);
  }
  for (const [signal, intervals] of intervalsBySignal) {
    const days = new Map<string, { sum: number; duration: number }>();
    const unique = new Map(intervals.filter(row => Number.isFinite(row.startMs) &&
      Number.isFinite(row.endMs) && Number.isFinite(row.value) && row.endMs > row.startMs)
      .map(row => [`${row.startMs}:${row.endMs}`, row]));
    const ordered = [...unique.values()].sort((left, right) => left.startMs - right.startMs);
    if (ordered.some((row, index) => index > 0 && row.startMs < ordered[index - 1].endMs)) {
      invalid.set(signal, `Overlapping non-identical intervals in ${signal}; coverage is unavailable.`);
      continue;
    }
    for (const row of ordered) {
      for (let at = row.startMs; at < row.endMs;) {
        const end = Math.min(row.endMs, dayStart(utcDay(at)) + DAY);
        const held = days.get(utcDay(at)) ?? { sum: 0, duration: 0 };
        held.sum += row.value * (end - at);
        held.duration += end - at;
        days.set(utcDay(at), held);
        at = end;
      }
    }
    factors.set(signal, new Map([...days].filter(([, day]) => day.duration >= 20 * HOUR)
      .map(([key, day]) => [key, day.sum / day.duration])));
  }
  const specifications = [
    { id: "calendar_lags_load", factors: ["load_actual"] },
    { id: "calendar_lags_wind", factors: ["wind_actual"] },
    { id: "calendar_lags_load_solar", factors: ["load_actual", "solar_actual"] },
    { id: "calendar_lags_wind_load_solar", factors: ["wind_actual", "load_actual", "solar_actual"] },
    { id: "calendar_lags_wind_load_solar_nuclear", factors: ["wind_actual", "load_actual", "solar_actual", "nuclear_actual"] },
    { id: "calendar_lags_wind_load_solar_hydro", factors: ["wind_actual", "load_actual", "solar_actual", "hydro_actual"] },
    { id: "calendar_lags_wind_load_solar_hydro_nuclear", factors: ["wind_actual", "load_actual", "solar_actual", "hydro_actual", "nuclear_actual"] },
    { id: "calendar_lags_generation_mix", factors: ["wind_actual", "solar_actual", "hydro_actual", "nuclear_actual", "gas_actual", "other_actual"] },
    { id: "calendar_lags_load_generation_mix", factors: ["load_actual", "wind_actual", "solar_actual", "hydro_actual", "nuclear_actual", "gas_actual", "other_actual"] },
    { id: "calendar_lags_load_generation_mix_without_nuclear", factors: ["load_actual", "wind_actual", "solar_actual", "hydro_actual", "gas_actual", "other_actual"] },
    { id: "calendar_lags_load_generation_mix_without_hydro", factors: ["load_actual", "wind_actual", "solar_actual", "nuclear_actual", "gas_actual", "other_actual"] },
  ];
  type FactorSpecification = typeof specifications[number];
  interface FactorPrediction { day: string; actual: number; baseline: number; estimated: number }
  const unavailable = (specification: FactorSpecification, reason: string): DailyFactorResult => ({ ...specification,
    status: "unavailable", reason, days: 0, targetDays: [], mae: null, bias: null, baselineMae: null, daily: [] });
  const experiments = specifications.map(specification => {
    const missing = specification.factors.filter(name => !factors.get(name)?.size);
    if (missing.length) return { specification, predictions: [] as FactorPrediction[], reason:
      missing.map(name => invalid.get(name) ?? `No usable retrospective daily series: ${name}.`).join(" ") };
    const rows = [...levels].sort(([left], [right]) => left.localeCompare(right)).flatMap(([day, price]) => {
      const previous = levels.get(utcDay(dayStart(day) - DAY));
      const weekAgo = levels.get(utcDay(dayStart(day) - 7 * DAY));
      const values = specification.factors.map(name => factors.get(name)?.get(day));
      if (previous === undefined || weekAgo === undefined || values.some(value => value === undefined)) return [];
      const weekday = new Date(dayStart(day)).getUTCDay();
      return [{ day, price, baseline: [weekday === 0 || weekday === 6 ? 1 : 0, previous, weekAgo], values: values as number[] }];
    });
    const predictions: FactorPrediction[] = [];
    for (let index = 14; index < rows.length; index++) {
      const train = rows.slice(Math.max(0, index - 60), index);
      const target = rows[index];
      const baseline = ridge(train.map(row => row.baseline), train.map(row => row.price), target.baseline);
      const estimated = ridge(train.map(row => [...row.baseline, ...row.values]), train.map(row => row.price), [...target.baseline, ...target.values]);
      predictions.push({ day: target.day, actual: target.price, baseline, estimated });
    }
    return { specification, predictions, reason: "Fewer than 15 common daily rows with calendar, lag prices and all requested factors." };
  });
  const availableExperiments = experiments.filter(experiment => experiment.predictions.length > 0);
  let sharedDays = new Set(availableExperiments[0]?.predictions.map(prediction => prediction.day) ?? []);
  for (const experiment of availableExperiments.slice(1)) {
    const heldOutDays = new Set(experiment.predictions.map(prediction => prediction.day));
    sharedDays = new Set([...sharedDays].filter(day => heldOutDays.has(day)));
  }
  const models: DailyFactorResult[] = experiments.map(experiment => {
    if (!experiment.predictions.length) return unavailable(experiment.specification, experiment.reason);
    const scored = experiment.predictions.filter(prediction => sharedDays.has(prediction.day));
    if (!scored.length) return unavailable(experiment.specification, "No common held-out target days across available factor specifications.");
    const absolute = scored.reduce((sum, row) => sum + Math.abs(row.estimated - row.actual), 0);
    const bias = scored.reduce((sum, row) => sum + row.estimated - row.actual, 0);
    const baselineAbsolute = scored.reduce((sum, row) => sum + Math.abs(row.baseline - row.actual), 0);
    return { ...experiment.specification, status: "available", days: scored.length,
      targetDays: scored.map(row => row.day), mae: absolute / scored.length, bias: bias / scored.length,
      baselineMae: baselineAbsolute / scored.length,
      daily: scored.map(row => ({ day: row.day, actual: row.actual, prediction: row.estimated,
        baselinePrediction: row.baseline, absoluteError: Math.abs(row.estimated - row.actual),
        baselineAbsoluteError: Math.abs(row.baseline - row.actual) })) };
  });
  const available = models.some(model => model.status === "available");
  return { status: available ? "available" : "unavailable",
    ...(!available ? { reason: "No factor experiment has sufficient usable ENTSO-E evidence; unavailable factors are never replaced by zero." } : {}), models };
}

/** Standardize from training rows only; fixed ridge=1, unpenalized intercept. */
function ridge(inputs: number[][], prices: number[], target: number[]): number {
  const width = target.length;
  const means = target.map((_, column) => inputs.reduce((sum, row) => sum + row[column], 0) / inputs.length);
  const scales = means.map((mean, column) => Math.sqrt(inputs.reduce((sum, row) => sum + (row[column] - mean) ** 2, 0) / inputs.length) || 1);
  const transform = (row: number[]) => [1, ...row.map((value, column) => (value - means[column]) / scales[column])];
  const x = inputs.map(transform);
  const matrix = Array.from({ length: width + 1 }, (_, left) =>
    Array.from({ length: width + 2 }, (_, right) => right > width
      ? x.reduce((sum, row, index) => sum + row[left] * prices[index], 0)
      : x.reduce((sum, row) => sum + row[left] * row[right], 0) + (left === right && left > 0 ? 1 : 0)));
  for (let column = 0; column <= width; column++) {
    const pivot = matrix[column][column];
    for (let right = column; right <= width + 1; right++) matrix[column][right] /= pivot;
    for (let row = 0; row <= width; row++) {
      if (row === column) continue;
      const factor = matrix[row][column];
      for (let right = column; right <= width + 1; right++) matrix[row][right] -= factor * matrix[column][right];
    }
  }
  return transform(target).reduce((sum, value, column) => sum + value * matrix[column][width + 1], 0);
}
