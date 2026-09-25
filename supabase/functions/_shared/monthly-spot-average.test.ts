import { assertAlmostEquals, assertThrows } from '@std/assert';
import { monthlySpotAverage } from './monthly-spot-average.ts';
Deno.test('market average weights time, including mixed hour and quarter intervals', () => {
  assertAlmostEquals(monthlySpotAverage([
    { SEK_per_kWh: 1, time_start: '2026-01-01T00:00:00Z', time_end: '2026-01-01T01:00:00Z' },
    { SEK_per_kWh: -1, time_start: '2026-01-01T01:00:00Z', time_end: '2026-01-01T01:15:00Z' },
  ]), 0.6);
});
Deno.test('market average refuses gaps, overlaps and invalid values', () => {
  const row = { SEK_per_kWh: 1, time_start: '2026-01-01T00:00:00Z', time_end: '2026-01-01T01:00:00Z' };
  assertThrows(() => monthlySpotAverage([]));
  assertThrows(() => monthlySpotAverage([row, row]));
  assertThrows(() => monthlySpotAverage([{ ...row, SEK_per_kWh: NaN }]));
  assertThrows(() => monthlySpotAverage([row, { ...row, time_start: '2026-01-01T02:00:00Z', time_end: '2026-01-01T03:00:00Z' }]));
});
