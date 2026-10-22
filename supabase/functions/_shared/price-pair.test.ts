import { assertAlmostEquals, assertEquals, assertNotEquals, assertThrows } from '@std/assert';
import { buildPricePair, PRICE_PAIR_ALGORITHM, PRICE_PAIR_GENERATION_MODELS, type PricePairInput } from './price-pair.ts';
import { fitRidge, predictRidge, ridge } from './ridge.ts';
import { generationLocalTime, type GenerationMixForecast, type GenerationModels, type GenerationPrediction } from './generation-mix.ts';
import type { EntsoeInterval } from './entsoe-market-data.ts';

const HOUR = 3_600_000, QUARTER = 900_000, DAY = 86_400_000;
const ORIGIN = '2026-10-22T12:00:00.000Z';
const PSRS = PRICE_PAIR_GENERATION_MODELS.map(row => row.psrType);
const mw = (at: number, index: number) => 100 + index * 40 + 30 * Math.sin(at / HOUR / (index + 2));
const prediction = (value: number): GenerationPrediction => ({ status: 'predicted', mw: value, trainingSamples: 1, latestTrainingEnd: ORIGIN });
function fixture(origin = ORIGIN): PricePairInput {
  const at = Date.parse(origin), first = Math.ceil(at / HOUR) * HOUR;
  const generation: GenerationMixForecast = {
    algorithm: 'se3-generation-analog-v2', zone: 'SE3', origin,
    hours: Array.from({ length: 72 }, (_, i) => ({ start: new Date(first + i * HOUR).toISOString(),
      byPsr: Object.fromEntries(PSRS.map((psr, index) => {
        const value = mw(first + i * HOUR, index);
        const models: GenerationModels = { persistence: prediction(1e6), calendar: prediction(value), weather: prediction(value),
          published: { status: 'unavailable', reason: 'No published comparator.' }, hydro_state: prediction(value),
          nuclear_delta: prediction(1e6), nuclear_ratio: prediction(value) };
        return [psr, models];
      })) })), training: {}, diagnostics: {
      actuals: { productionIntervals: 0, completeHours: 0, reason: null },
      weather: { status: 'available', issueTime: null, reason: null },
      published: { productionIntervals: 0, completeHours: 0, reason: null },
    },
  };
  const actualIntervals: EntsoeInterval[] = Array.from({ length: 14 * 24 }, (_, hour) => PSRS.map((psrType, index) => {
    const startMs = first - (14 * 24 - hour) * HOUR;
    return { startMs, endMs: startMs + HOUR, value: mw(startMs, index), psrType,
      unit: 'MAW', resolution: 'PT60M', businessType: 'A01', seriesId: psrType, flow: 'production' as const };
  })).flat();
  const prices = Array.from({ length: 39 * 96 }, (_, index) => {
    const time = first - 35 * DAY + index * QUARTER;
    return { start_ts: new Date(time).toISOString(), import_price_sek_per_kwh:
      0.2 + PSRS.reduce((sum, _, i) => sum + mw(Math.floor(time / HOUR) * HOUR, i) * (i + 1) / 1000, 0) + Math.sin(time / HOUR / 5) * 0.2 };
  });
  return { knownAt: origin, prices, generation, actualIntervals };
}

Deno.test('shared ridge freezes train-only scaling and fixed-penalty coefficients, including one-row and collinear cohorts', () => {
  const fit = fitRidge([[0], [1]], [2, 4]);
  assertEquals(fit.means, [0.5]); assertEquals(fit.scales, [0.5]); assertEquals(fit.lambda, 1);
  assertAlmostEquals(predictRidge(fit, [2]), 5);
  assertAlmostEquals(ridge([[0], [1]], [2, 4], [2]), 5);
  assertEquals(predictRidge(fitRidge([[99, 7]], [-4]), [1e6, -1e6]), -4);
  assertAlmostEquals(predictRidge(fitRidge([[1, 1], [2, 2]], [1, 2]), [3, 3]), 2.7);
  assertThrows(() => fitRidge([], []));
  assertThrows(() => fitRidge([[1], [2, 3]], [1, 2]));
  assertThrows(() => predictRidge(fit, [Number.NaN]));
  assertThrows(() => fitRidge([[Number.MAX_VALUE], [Number.MAX_VALUE]], [1, 2]), Error, 'not numerically finite');
  assertThrows(() => predictRidge({ lambda: 1, means: [0], scales: [1], coefficients: [Number.MAX_VALUE, Number.MAX_VALUE] }, [2]), Error, 'not numerically finite');
});

Deno.test('price pair freezes one historical cohort, fit metadata and the fixed six generation candidates', () => {
  const input = fixture(), before = structuredClone(input), result = buildPricePair(input);
  assertEquals(result.status, 'paired');
  if (!result.fit) throw new Error('Expected fitted pair.');
  assertEquals(result.targets.length, 288);
  assertEquals(result.targets[0].start, ORIGIN);
  assertEquals(result.targets.at(-1)!.start, '2026-10-25T11:45:00.000Z');
  assertEquals(result.targets.every(row => row.reduced !== null && row.full !== null && row.reason === null), true);
  assertEquals(result.fit.algorithm, PRICE_PAIR_ALGORITHM);
  assertEquals(result.fit.training.quarters, 14 * 96);
  assertEquals(result.fit.training.lastEnd, ORIGIN);
  assertEquals(result.fit.featureNames.reduced.length, 8);
  assertEquals(result.fit.featureNames.full.length, 14);
  assertEquals(result.fit.generationModels, PRICE_PAIR_GENERATION_MODELS);
  assertEquals(result.fit.reduced.means.length, 8);
  assertEquals(result.fit.full.means.slice(0, 8), result.fit.reduced.means);
  assertEquals(input, before);
  assertEquals(buildPricePair(input), result);
});

Deno.test('future price labels and future actual production never affect either fit or prediction', () => {
  const input = fixture(), expected = buildPricePair(input), origin = Date.parse(ORIGIN);
  input.prices = input.prices.map(row => Date.parse(row.start_ts) >= origin ? { ...row, import_price_sek_per_kwh: 1e6 } : row);
  input.actualIntervals.push(...PSRS.map((psrType, index) => ({ ...input.actualIntervals[index], startMs: origin, endMs: origin + HOUR, value: 1e9, psrType })));
  assertEquals(buildPricePair(input), expected);
});

Deno.test('actual training cutoff respects the earlier mix origin even when price reservation is later', () => {
  const input = fixture();
  input.knownAt = '2026-10-23T12:00:00.000Z';
  const expected = buildPricePair(input), at = Date.parse(ORIGIN);
  input.actualIntervals.push(...PSRS.map((psrType, index) => ({ ...input.actualIntervals[index], startMs: at, endMs: at + HOUR, value: 1e6, psrType })));
  assertEquals(buildPricePair(input), expected);
  assertEquals(expected.fit?.trainingCutoff, ORIGIN);
  input.knownAt = '2026-10-21T12:00:00.000Z';
  const earlier = buildPricePair(input);
  assertEquals(earlier.fit?.training.lastEnd, input.knownAt);
});

Deno.test('missing historical generation removes the same four quarter labels from both arms rather than supplying zero', () => {
  const input = fixture(), complete = buildPricePair(input);
  const first = input.actualIntervals[0].startMs;
  input.actualIntervals = input.actualIntervals.filter(row => row.psrType !== 'B20' || row.startMs !== first);
  const missing = buildPricePair(input);
  assertEquals(missing.fit!.training.quarters, complete.fit!.training.quarters - 4);
  assertEquals(missing.fit!.training.targets.some(start => Date.parse(start) >= first && Date.parse(start) < first + HOUR), false);
  assertEquals(missing.fit!.full.means.slice(0, 8), missing.fit!.reduced.means);
  input.actualIntervals = input.actualIntervals.filter(row => row.psrType !== 'B20');
  const unavailable = buildPricePair(input);
  assertEquals(unavailable.status, 'unavailable'); assertEquals(unavailable.fit, null);
  assertEquals(unavailable.targets.every(row => row.reduced === null && row.full === null), true);
});

Deno.test('missing prospective nuclear candidate preserves independent reduced predictions and has no substitute', () => {
  const input = fixture(), expected = buildPricePair(input);
  input.generation.hours[0].byPsr.B14.nuclear_ratio = { status: 'unavailable', reason: 'No roster.' };
  const result = buildPricePair(input);
  assertEquals(result.fit, expected.fit);
  assertEquals(result.targets.map(row => row.reduced), expected.targets.map(row => row.reduced));
  assertEquals(result.targets.slice(0, 4).every(row => row.full === null && row.reason!.includes('B14/nuclear_ratio')), true);
  assertEquals(result.targets.slice(4), expected.targets.slice(4));
});

Deno.test('target MW changes affect only the full prediction; unused candidate models cannot alter either arm', () => {
  const input = fixture(), expected = buildPricePair(input);
  input.generation.hours[0].byPsr.B19.weather = prediction(3000);
  input.generation.hours[0].byPsr.B14.nuclear_delta = prediction(-1e8);
  const result = buildPricePair(input);
  assertEquals(result.fit, expected.fit);
  assertEquals(result.targets.map(row => row.reduced), expected.targets.map(row => row.reduced));
  assertNotEquals(result.targets[0].full, expected.targets[0].full);
  input.generation.hours[0].byPsr.B19.weather = prediction(mw(Date.parse(ORIGIN), 4));
  assertEquals(buildPricePair(input), expected);
});

Deno.test('fall DST local-day means require all 100 quarters including the final repeated-day hour', () => {
  const input = fixture('2026-10-29T12:00:00.000Z');
  assertEquals(buildPricePair(input).targets[0].reduced !== null, true);
  input.prices = input.prices.filter(row => row.start_ts !== '2026-10-25T22:45:00.000Z');
  const result = buildPricePair(input);
  assertEquals(result.targets[0].reduced, null);
  assertEquals(result.targets[0].full, null);
});

Deno.test('spring DST complete-day means use exactly 92 quarters and do not require next-day prices', () => {
  const input = fixture('2026-03-31T12:00:00.000Z');
  input.prices = input.prices.filter(row => row.start_ts !== '2026-03-29T22:00:00.000Z'); // March30 local midnight, outside March29.
  const result = buildPricePair(input);
  const target = result.targets.find(row => row.start === '2026-04-02T12:00:00.000Z')!; // D-4 is March29.
  assertEquals(target.reduced !== null && target.full !== null, true);
});

Deno.test('weekly lag uses exact UTC 168 hours while calendar and daily means use Stockholm time', () => {
  const input = fixture('2026-10-29T12:00:00.000Z'), result = buildPricePair(input);
  const target = Date.parse(result.targets[0].start), clock = generationLocalTime(target);
  const map = new Map(input.prices.map(row => [Date.parse(row.start_ts), row.import_price_sek_per_kwh]));
  const mean = (day: string) => {
    const values = input.prices.filter(row => generationLocalTime(Date.parse(row.start_ts)).day === day).map(row => row.import_price_sek_per_kwh);
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  };
  const phase = 2 * Math.PI * Number(clock.hour) / 24;
  const values = [Math.sin(phase), Math.cos(phase), Math.sin(phase * 2), Math.cos(phase * 2), 0,
    map.get(target - 168 * HOUR)!, mean('2026-10-25'), mean('2026-10-22')];
  assertAlmostEquals(result.targets[0].reduced!, predictRidge(result.fit!.reduced, values));
  const wrongWallClock = [...values]; wrongWallClock[5] = map.get(target - 169 * HOUR)!;
  assertNotEquals(result.targets[0].reduced, predictRidge(result.fit!.reduced, wrongWallClock));
});

Deno.test('a single common label is a valid regularized experiment, and negative prices are not clipped', () => {
  const input = fixture();
  const at = Date.parse(ORIGIN) - HOUR;
  input.actualIntervals = input.actualIntervals.filter(row => row.startMs === at);
  input.prices = input.prices.filter(row => Date.parse(row.start_ts) < at || row.start_ts === new Date(at).toISOString());
  input.prices.find(row => row.start_ts === new Date(at).toISOString())!.import_price_sek_per_kwh = -3;
  const result = buildPricePair(input);
  assertEquals(result.fit!.training.quarters, 1);
  assertEquals(result.targets[0].reduced, -3);
  assertEquals(result.targets[0].full, -3);
});
