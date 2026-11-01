/** One conservative residual estimator. No live planner or model-selection policy. */
import { generationLocalTime } from './generation-mix.ts';
import { CORRECTION_FEATURE_NAMES, preparePriceCorrection, type CorrectionSample,
  type PriceCorrectionForecast, type PriceCorrectionInput } from './price-correction.ts';
import { solveRidgeSystem } from './ridge.ts';

export const PRICE_CORRECTION_V2_ALGORITHM = 'se3-price-residual-v2';
export interface DateResidualFit {
  slopePenaltyPerDay: 10;
  interceptPriorDays: 1;
  targetDays: number;
  means: number[];
  scales: number[];
  coefficients: number[];
}
export type PriceCorrectionV2Forecast = Omit<PriceCorrectionForecast, 'algorithm' | 'fit'> & {
  algorithm: typeof PRICE_CORRECTION_V2_ALGORITHM;
  fit: { ridge: DateResidualFit; featureNames: string[];
    training: { quarters: number; targetDays: number; examples: { runId: string; start: string; truthSequence: number }[] } } | null;
};

function fitResiduals(cohort: readonly CorrectionSample[]): DateResidualFit {
  const width = CORRECTION_FEATURE_NAMES.length;
  const dates = new Map<string, string>();
  const dayAt = (start: string) => {
    if (!dates.has(start)) dates.set(start, generationLocalTime(Date.parse(start)).day);
    return dates.get(start)!;
  };
  const counts = new Map<string, number>();
  for (const row of cohort) counts.set(dayAt(row.start), (counts.get(dayAt(row.start)) ?? 0) + 1);
  const targetDays = counts.size;
  const weights = cohort.map(row => 1 / counts.get(dayAt(row.start))!);
  const means: number[] = [], scales: number[] = [];
  for (let column = 0; column < width; column++) {
    const anchor = cohort[0].features[column];
    // Center relative to an observed value: constant fractional MW stays exactly
    // constant instead of acquiring a rounding-sized scale and a spurious slope.
    const mean = anchor + cohort.reduce((sum, row, i) => sum + weights[i] * (row.features[column] - anchor), 0) / targetDays;
    const variance = cohort.reduce((sum, row, i) => sum + weights[i] * (row.features[column] - mean) ** 2, 0) / targetDays;
    means.push(mean); scales.push(Math.sqrt(variance) || 1);
  }
  const matrix = Array.from({ length: width + 1 }, () => new Float64Array(width + 2));
  for (let i = 0; i < cohort.length; i++) {
    const row = cohort[i], weight = weights[i], label = row.actual - row.baseline;
    const z = [1, ...row.features.map((value, column) => (value - means[column]) / scales[column])];
    for (let left = 0; left <= width; left++) {
      for (let right = 0; right <= width; right++) matrix[left][right] += weight * z[left] * z[right];
      matrix[left][width + 1] += weight * z[left] * label;
    }
  }
  // Mean-date squared loss + 10 ||slopes||² + (1 / dates) intercept².
  // The intercept is one neutral date, not an unpenalized first-day regime.
  for (let column = 0; column <= width; column++) matrix[column][column] += column === 0 ? 1 : 10 * targetDays;
  const coefficients = solveRidgeSystem(matrix);
  if ([...means, ...scales, ...coefficients].some(value => !Number.isFinite(value))) throw new Error('Non-finite residual fit');
  return { slopePenaltyPerDay: 10, interceptPriorDays: 1, targetDays, means, scales, coefficients };
}

export function buildPriceCorrectionV2(input: PriceCorrectionInput): PriceCorrectionV2Forecast {
  const { cohort, targets: prepared } = preparePriceCorrection(input);
  const ridge = cohort.length ? fitResiduals(cohort) : null;
  const fit = ridge ? { ridge, featureNames: [...CORRECTION_FEATURE_NAMES], training: {
    quarters: cohort.length, targetDays: ridge.targetDays,
    examples: cohort.map(({ runId, start, truthSequence }) => ({ runId, start, truthSequence })),
  } } : null;
  const targets = prepared.map(row => {
    if (!row.features) return row;
    const correction = ridge ? row.features.reduce((sum, value, i) => sum + ridge.coefficients[i + 1] *
      (value - ridge.means[i]) / ridge.scales[i], ridge.coefficients[0]) : null;
    if (correction !== null && !Number.isFinite(correction)) throw new Error('Non-finite price correction');
    return { ...row, corrected: correction === null ? null : row.baseline + correction,
      reason: ridge ? null : 'Collecting prospective residual outcomes.' };
  });
  const paired = targets.some(row => row.corrected !== null);
  return { algorithm: PRICE_CORRECTION_V2_ALGORITHM, status: paired ? 'paired' : 'unavailable',
    reason: paired ? null : fit ? 'No target has complete prospective market inputs.' : 'Collecting prospective residual outcomes.', fit, targets };
}
