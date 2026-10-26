/** Prospective residual study. No executable planner imports this module. */
import { PRICE_PAIR_GENERATION_MODELS, priceGenerationFeatures } from './price-pair.ts';
import { generationLocalTime, type GenerationMixForecast } from './generation-mix.ts';
import type { EntsoeInterval } from './entsoe-market-data.ts';
import { fitRidge, predictRidge, type RidgeFit } from './ridge.ts';

export const PRICE_CORRECTION_ALGORITHM = 'se3-price-residual-v1';
export interface CorrectionBaseline {
  id: string;
  generatedAt: string;
  slots: { start: string; price: number; published: boolean }[];
}
export interface CorrectionSample {
  runId: string; origin: string; start: string; leadDay: number;
  baseline: number; features: number[]; actual: number; truthSequence: number;
}
export interface PriceCorrectionInput {
  knownAt: string;
  truthCutoff: number;
  baseline: CorrectionBaseline;
  generationRunId: string | null;
  generation: GenerationMixForecast | null;
  load: { id: string; intervals: EntsoeInterval[] } | null;
  training: CorrectionSample[];
}
export interface CorrectionTarget {
  start: string; baseline: number; features: number[] | null;
  corrected: number | null; reason: string | null;
}
export interface PriceCorrectionForecast {
  algorithm: typeof PRICE_CORRECTION_ALGORITHM;
  status: 'paired' | 'unavailable'; reason: string | null;
  fit: { ridge: RidgeFit; featureNames: string[];
    training: { quarters: number; targetDays: number; examples: { runId: string; start: string; truthSequence: number }[] } } | null;
  targets: CorrectionTarget[];
}
export const CORRECTION_FEATURE_NAMES = ['baseline_import_price', 'local_hour_sin', 'local_hour_cos',
  'weekend', 'lead_hours', ...PRICE_PAIR_GENERATION_MODELS.map(row => `${row.psrType}_forecast_mw`),
  'week_ahead_load_min_mw', 'week_ahead_load_max_mw'];

/** Native daily demand extrema remain two features, never a fabricated hourly mean. */
function demandRange(intervals: readonly EntsoeInterval[], at: number): number[] | null {
  return ['A60', 'A61'].reduce<number[] | null>((values, businessType) => {
    const rows = intervals.filter(row => row.businessType === businessType && row.resolution === 'P1D' &&
      row.unit === 'MAW' && row.startMs <= at && row.endMs >= at + 900_000);
    const distinct = new Set(rows.map(row => row.value));
    return values && distinct.size === 1 && Number.isFinite(rows[0].value) ? [...values, rows[0].value] : null;
  }, []);
}

/** Only labels already frozen below this run's truth cutoff can train it. */
export function buildPriceCorrection(input: PriceCorrectionInput): PriceCorrectionForecast {
  const origin = Date.parse(input.knownAt);
  if (!Number.isFinite(origin) || !Number.isSafeInteger(input.truthCutoff) || input.truthCutoff < 0) {
    throw new Error('Invalid correction knowledge boundary');
  }
  const hours = new Map(input.generation?.hours.map(hour => [Date.parse(hour.start), hour]) ?? []);
  const training = new Map<string, CorrectionSample>();
  for (const row of input.training) {
    if (row.truthSequence > input.truthCutoff || Date.parse(row.origin) >= origin ||
      !Number.isFinite(row.actual) || !Number.isFinite(row.baseline) ||
      row.features.length !== CORRECTION_FEATURE_NAMES.length || row.features.some(value => !Number.isFinite(value))) {
      throw new Error('Invalid frozen correction training example');
    }
    // One example per delivered quarter and local lead. Repeated refreshes cannot multiply its training weight.
    const key = `${row.start}/${row.leadDay}`, prior = training.get(key);
    if (!prior || Date.parse(row.origin) > Date.parse(prior.origin) ||
      row.origin === prior.origin && row.runId > prior.runId) training.set(key, row);
  }
  const cohort = [...training.values()].sort((a, b) => a.start.localeCompare(b.start) || a.leadDay - b.leadDay);
  const fit = cohort.length ? {
    ridge: fitRidge(cohort.map(row => row.features), cohort.map(row => row.actual - row.baseline)),
    featureNames: [...CORRECTION_FEATURE_NAMES],
    training: { quarters: cohort.length,
      targetDays: new Set(cohort.map(row => generationLocalTime(Date.parse(row.start)).day)).size,
      examples: cohort.map(({ runId, start, truthSequence }) => ({ runId, start, truthSequence })) },
  } : null;
  const targets = input.baseline.slots.map((slot): CorrectionTarget => {
    const at = Date.parse(slot.start);
    if (!Number.isFinite(at) || at % 900_000 || !Number.isFinite(slot.price)) throw new Error('Invalid frozen baseline quarter');
    const unavailable = (reason: string): CorrectionTarget => ({ start: slot.start, baseline: slot.price, features: null, corrected: null, reason });
    if (slot.published) return unavailable('Already published in the household forecast.');
    const hour = hours.get(Math.floor(at / 3_600_000) * 3_600_000);
    const mix = priceGenerationFeatures(hour);
    if (mix.some(value => value === null)) return unavailable('Missing prospective generation mix.');
    const range = input.load && demandRange(input.load.intervals, at);
    if (!range) return unavailable('Missing native week-ahead load minimum or maximum.');
    const clock = generationLocalTime(at), phase = 2 * Math.PI * (Number(clock.hour) + new Date(at).getUTCMinutes() / 60) / 24;
    const features = [slot.price, Math.sin(phase), Math.cos(phase), clock.dayType === 'weekend' ? 1 : 0,
      (at - origin) / 3_600_000, ...mix as number[], ...range];
    return { start: slot.start, baseline: slot.price, features,
      corrected: fit ? slot.price + predictRidge(fit.ridge, features) : null,
      reason: fit ? null : 'Collecting prospective residual outcomes.' };
  });
  const paired = targets.some(row => row.corrected !== null);
  return { algorithm: PRICE_CORRECTION_ALGORITHM, status: paired ? 'paired' : 'unavailable',
    reason: paired ? null : fit ? 'No target has complete prospective market inputs.' : 'Collecting prospective residual outcomes.', fit, targets };
}
