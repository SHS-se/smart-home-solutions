import { assertAlmostEquals, assertEquals } from '@std/assert';
import { pricePairChartRows, pricePairDays, weatherPriceCriterion, type PricePairTarget } from './price-pair-comparison.ts';
const target = (start: string, actual: number | null, day = '2026-10-24'): PricePairTarget => ({
  start, target_day: day, lead_day: 2, reduced: 2, full: 1.5, actual, truth_sequence: actual === null ? null : 1,
});
Deno.test('day errors use identical published quarters and keep pending prices out, including negative and zero prices', () => {
  const result = pricePairDays([target('2026-10-24T00:00Z', null), target('2026-10-24T00:15Z', 0), target('2026-10-24T00:30Z', -1)]);
  assertEquals(result[0].eligible, 3); assertEquals(result[0].scored, 2);
  assertAlmostEquals(result[0].reducedMae!, 2.5); assertAlmostEquals(result[0].fullMae!, 2);
  assertEquals(pricePairDays([target('2026-10-24T00:00Z', null)])[0].fullMae, null);
});
Deno.test('day coverage uses the 100-quarter autumn day and 92-quarter spring day', () => {
  const result = pricePairDays([target('2026-10-25T00:00Z', null, '2026-10-25'), target('2026-03-29T00:00Z', null, '2026-03-29')]);
  assertEquals(result.map(row => [row.day, row.expected]), [['2026-03-29', 92], ['2026-10-25', 100]]);
});
Deno.test('chart preserves UTC ordering and a real gap instead of joining missing eligible quarters', () => {
  const result = pricePairChartRows([target('2026-10-25T01:00Z', 0), target('2026-10-25T00:30Z', null)]);
  assertEquals(result.length, 3);
  assertEquals(result[1], { at: Date.parse('2026-10-25T00:45Z'), reduced: null, full: null, actual: null });
  assertEquals(result[2].actual, 0);
  assertEquals(pricePairChartRows([]), []);
});

Deno.test('the weather criterion needs every rule: a large average gain on few winning days does not pass', () => {
  const score = (lead: number, wins: number, full: number, covered = 768) => ({ lead_day: lead, scored_quarters: covered, origin_count: 8, target_day_count: 8,
    reduced_mae: 1, full_mae: full, reduced_bias: 0, full_bias: 0, mae_improvement: 1 - full, reduced_daily_mean_mae: 1, full_daily_mean_mae: full,
    complete_day_origins: 8, scored_day_origins: 8, day_wins: wins, baseline_quarters: 768 });
  const days = (full: (day: number) => number) => [2, 3].flatMap(lead => Array.from({ length: 8 }, (_, day) => ({ target_day: `2026-03-${String(day + 10).padStart(2, '0')}`,
    lead_day: lead, scored_quarters: 96, origin_count: 1, reduced_mae: 1, full_mae: full(day) })));
  const met = weatherPriceCriterion([score(2, 7, 0.8), score(3, 6, 0.7)], days(() => 0.75))!;
  assertEquals(met.map(rule => [rule.key, rule.met]), [['mae', true], ['days', true], ['interval', true], ['coverage', true]]);
  // One very good day carries the average: the interval of resampled days reaches zero and too few days win.
  const lucky = weatherPriceCriterion([score(2, 1, 0.8), score(3, 1, 0.8)], days(day => day === 0 ? 0.01 : 1.05))!;
  assertEquals(lucky.map(rule => rule.met), [true, false, false, true]);
  assertEquals(weatherPriceCriterion([score(2, 7, 0.97), score(3, 7, 0.7, 700)], days(() => 0.8))!.map(rule => rule.met), [false, true, true, false]);
  // Scores without day counts (the retired studies) have no criterion.
  assertEquals(weatherPriceCriterion([{ ...score(2, 7, 0.8), day_wins: undefined }, score(3, 7, 0.8)], []), null);
});
