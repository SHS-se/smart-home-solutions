import { assertAlmostEquals, assertEquals, assertThrows } from '@std/assert';
import { compareFrozenPriceCorrections } from '../scripts/price-correction-replay.ts';
import { buildPriceCorrection } from '../supabase/functions/_shared/price-correction.ts';
import { correctionInput } from './helpers/price-correction-fixture.ts';
Deno.test('frozen replay scores identical prospective quarters and separates candidate-selection evidence from prospective results', () => {
  const context = correctionInput();
  context.training = [{ runId: 'prior-synthetic', origin: '2026-10-21T12:00Z', start: '2026-10-22T12:00Z',
    leadDay: 2, baseline: 1, actual: 2, truthSequence: 10, features: Array(13).fill(1) }];
  const forecast = buildPriceCorrection(context), runs = [{ id: 'synthetic', context, forecast }];
  const outcomes = forecast.targets.slice(0, 2).map(target => ({ pair_id: 'synthetic', start_ts: target.start,
    target_day: '2026-10-25', lead_day: 2, reduced: target.baseline, full: target.corrected!, actual: target.baseline + .5 }));
  const report = compareFrozenPriceCorrections(runs, outcomes);
  assertEquals(report.prospective, false); assertEquals(report.replayed, 1);
  assertEquals(report.all.wind.quarters, 2); assertEquals(report.all.v2.quarters, 2);
  assertAlmostEquals(report.all.wind.mae, .5); assertAlmostEquals(report.all.v2.mae, 0);
  assertEquals(report.all.v2.cheapQuarterRegret['8'], null);
  const changed = structuredClone(runs); changed[0].forecast.targets[0].corrected = 99;
  assertThrows(() => compareFrozenPriceCorrections(changed, outcomes), Error, 'replay differs');
  assertThrows(() => compareFrozenPriceCorrections(runs, []), Error, 'No common scored');
});
