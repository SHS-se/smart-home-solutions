import { assertAlmostEquals, assertEquals } from '@std/assert';
import { pricePairChartRows, pricePairDays, type PricePairTarget } from './price-pair-comparison.ts';
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
