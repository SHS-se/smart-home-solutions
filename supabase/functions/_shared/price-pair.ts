/** Frozen research ablation: the only arm difference is the six prospective generation features. */
import { generationLocalTime, hourlyPanel, type GenerationMixForecast, type GenerationModel } from './generation-mix.ts';
import type { EntsoeInterval } from './entsoe-market-data.ts';
import { fitRidge, predictRidge, type RidgeFit } from './ridge.ts';

export const PRICE_PAIR_ALGORITHM = 'se3-price-mix-pair-v1';
const QUARTER = 900_000, HOUR = 3_600_000, DAY = 86_400_000;
export const PRICE_PAIR_GENERATION_MODELS = [
  { psrType: 'B04', model: 'calendar' }, { psrType: 'B12', model: 'hydro_state' },
  { psrType: 'B14', model: 'nuclear_ratio' }, { psrType: 'B16', model: 'weather' },
  { psrType: 'B19', model: 'weather' }, { psrType: 'B20', model: 'calendar' },
] as const satisfies readonly { psrType: string; model: GenerationModel }[];
const REDUCED_FEATURES = ['local_quarter_sin_1', 'local_quarter_cos_1', 'local_quarter_sin_2', 'local_quarter_cos_2',
  'weekend', 'price_utc_lag_168h', 'price_local_day_mean_d4', 'price_local_day_mean_d7'];
export interface PricePairInput {
  knownAt: string;
  prices: { start_ts: string; import_price_sek_per_kwh: number }[];
  generation: GenerationMixForecast;
  actualIntervals: EntsoeInterval[];
}
interface PricePairFit {
  algorithm: typeof PRICE_PAIR_ALGORITHM;
  knownAt: string;
  generationOrigin: string;
  trainingCutoff: string;
  training: { quarters: number; targets: string[]; firstStart: string; lastEnd: string };
  featureNames: { reduced: string[]; full: string[] };
  generationModels: typeof PRICE_PAIR_GENERATION_MODELS;
  reduced: RidgeFit;
  full: RidgeFit;
}
export interface PricePairForecast {
  status: 'paired' | 'unavailable';
  reason?: string;
  fit: PricePairFit | null;
  targets: { start: string; reduced: number | null; full: number | null; reason: string | null }[];
}
function calendarDay(day: string, change: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + change * DAY).toISOString().slice(0, 10);
}
function midnight(day: string): number {
  const nominal = Date.parse(`${day}T00:00:00Z`);
  for (const offset of [1, 2]) {
    const candidate = nominal - offset * HOUR, clock = generationLocalTime(candidate);
    if (clock.day === day && clock.hour === '00') return candidate;
  }
  throw new Error('Unsupported Stockholm local-day boundary.');
}

/** Fits on one strict common historical cohort; missing targets remain explicit instead of substituting a model. */
export function buildPricePair(input: PricePairInput): PricePairForecast {
  const knownAt = Date.parse(input.knownAt), generationOrigin = Date.parse(input.generation.origin);
  const targets = input.generation.hours.flatMap(hour => Array.from({ length: 4 }, (_, index) => ({
    start: new Date(Date.parse(hour.start) + index * QUARTER).toISOString(),
    reduced: null as number | null, full: null as number | null, reason: null as string | null,
  })));
  function unavailable(reason: string): PricePairForecast {
    return { status: 'unavailable', reason, fit: null, targets: targets.map(target => ({ ...target, reason })) };
  }
  if (!Number.isFinite(knownAt) || !Number.isFinite(generationOrigin)) return unavailable('Invalid frozen knowledge or generation origin.');
  const cutoff = Math.min(knownAt, generationOrigin);
  const prices = new Map<number, number | null>();
  for (const row of input.prices) {
    const at = Date.parse(row.start_ts), value = row.import_price_sek_per_kwh;
    if (!Number.isFinite(at) || at % QUARTER || !Number.isFinite(value)) return unavailable('Published price input is not a finite aligned UTC quarter.');
    prices.set(at, !prices.has(at) || prices.get(at) === value ? value : null);
  }
  const clocks = new Map<number, ReturnType<typeof generationLocalTime>>();
  const clockAt = (at: number) => {
    if (!clocks.has(at)) clocks.set(at, generationLocalTime(at));
    return clocks.get(at)!;
  };
  const dailyMeans = new Map<string, number | null>();
  function completeDay(day: string): number | null {
    if (!dailyMeans.has(day)) {
      const start = midnight(day), end = midnight(calendarDay(day, 1));
      let sum = 0, count = 0, complete = true;
      for (let at = start; at < end; at += QUARTER) {
        const value = prices.get(at);
        if (value === undefined || value === null) { complete = false; break; }
        sum += value; count++;
      }
      dailyMeans.set(day, complete && count ? sum / count : null);
    }
    return dailyMeans.get(day)!;
  }
  function reducedFeatures(at: number): number[] | null {
    const clock = clockAt(at), lag = prices.get(at - 168 * HOUR);
    const d4 = completeDay(calendarDay(clock.day, -4)), d7 = completeDay(calendarDay(clock.day, -7));
    if (lag === null || lag === undefined || d4 === null || d7 === null) return null;
    const quarter = Number(clock.hour) * 4 + new Date(at).getUTCMinutes() / 15;
    const phase = 2 * Math.PI * quarter / 96;
    return [Math.sin(phase), Math.cos(phase), Math.sin(2 * phase), Math.cos(2 * phase), clock.dayType === 'weekend' ? 1 : 0, lag, d4, d7];
  }
  const actuals = hourlyPanel(input.actualIntervals, cutoff);
  const training = [...prices].sort(([a], [b]) => a - b).flatMap(([at, label]) => {
    if (label === null || at + QUARTER > cutoff) return [];
    const reduced = reducedFeatures(at);
    if (!reduced) return [];
    const hour = Math.floor(at / HOUR) * HOUR;
    const generation = PRICE_PAIR_GENERATION_MODELS.map(({ psrType }) => actuals.get(psrType)?.get(hour)?.mw);
    if (generation.some(value => value === undefined)) return [];
    return [{ at, label, reduced, full: [...reduced, ...generation as number[]] }];
  });
  if (!training.length) return unavailable('No shared historical quarters with complete prices, lag days and all six production types.');
  const labels = training.map(row => row.label);
  const reducedFit = fitRidge(training.map(row => row.reduced), labels), fullFit = fitRidge(training.map(row => row.full), labels);
  const forecastHours = new Map(input.generation.hours.map(hour => [Date.parse(hour.start), hour]));
  for (const target of targets) {
    const at = Date.parse(target.start), reduced = reducedFeatures(at);
    if (!reduced) { target.reason = 'Missing exact UTC weekly price lag or complete Stockholm D-4/D-7 price day.'; continue; }
    target.reduced = predictRidge(reducedFit, reduced);
    const hour = forecastHours.get(Math.floor(at / HOUR) * HOUR);
    const mix = PRICE_PAIR_GENERATION_MODELS.map(({ psrType, model }) => {
      const prediction = hour?.byPsr[psrType]?.[model];
      return prediction?.status === 'predicted' && Number.isFinite(prediction.mw) ? prediction.mw : null;
    });
    const missing = PRICE_PAIR_GENERATION_MODELS.filter((_, index) => mix[index] === null);
    if (missing.length) {
      target.reason = `Missing prospective generation MW: ${missing.map(row => `${row.psrType}/${row.model}`).join(', ')}.`;
      continue;
    }
    target.full = predictRidge(fullFit, [...reduced, ...mix as number[]]);
  }
  const fit: PricePairFit = { algorithm: PRICE_PAIR_ALGORITHM, knownAt: new Date(knownAt).toISOString(),
    generationOrigin: new Date(generationOrigin).toISOString(), trainingCutoff: new Date(cutoff).toISOString(),
    training: { quarters: training.length, targets: training.map(row => new Date(row.at).toISOString()),
      firstStart: new Date(training[0].at).toISOString(), lastEnd: new Date(training.at(-1)!.at + QUARTER).toISOString() },
    featureNames: { reduced: [...REDUCED_FEATURES], full: [...REDUCED_FEATURES, ...PRICE_PAIR_GENERATION_MODELS.map(row => `${row.psrType}_mw`)] },
    generationModels: PRICE_PAIR_GENERATION_MODELS, reduced: reducedFit, full: fullFit };
  return targets.some(target => target.reduced !== null && target.full !== null)
    ? { status: 'paired', fit, targets }
    : { status: 'unavailable', reason: 'No target has both forecasts; missing inputs remain explicit.', fit, targets };
}
