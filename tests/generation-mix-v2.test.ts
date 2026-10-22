import { assertAlmostEquals, assertEquals } from '@std/assert';
import { forecastGenerationMix, scoreGenerationRuns } from '../supabase/functions/_shared/generation-mix.ts';
import { forecastGenerationMixV2, type GenerationMixV2Input } from '../supabase/functions/_shared/generation-mix-v2.ts';
import type { HydroWeek } from '../supabase/functions/_shared/reservoir-hydrology.ts';
import type { EntsoeInterval } from '../supabase/functions/_shared/entsoe-market-data.ts';
import type { NuclearOutageNotice } from '../supabase/functions/_shared/nuclear-availability.ts';
const HOUR = 3_600_000;
const origin = '2026-10-16T12:00:00.000Z';
function actual(start: string, value: number, psrType = 'B12'): EntsoeInterval {
  return { startMs: Date.parse(start), endMs: Date.parse(start) + HOUR, value, psrType,
    unit: 'MAW', resolution: 'PT60M', businessType: 'A01', seriesId: 'measured', flow: 'production' };
}
function week(isoWeek: number, end: string, published: string, filling: number): HydroWeek {
  return { isoYear: 2026, isoWeek, version: 'A', weekEnd: end, providerModifiedAt: published,
    se3StoredGwh: filling * 10, se3FillingPercent: filling, swedenInflowGwh: filling * 20,
    swedenInflowMedianPercent: filling + 60, swedenFillingPercent: 70, swedenNormalFillingPercent: 80 };
}
function input(): GenerationMixV2Input {
  return { origin, actuals: [actual('2026-10-02T12:00Z', 100), actual('2026-10-09T12:00Z', 900),
    actual('2026-10-16T11:00Z', 300, 'B14')], weather: null, published: [],
    hydro: { provider: 'energiforetagen', reports: [], weeks: [
      week(39, '2026-09-27T22:00Z', '2026-09-30T11:00Z', 20),
      week(40, '2026-10-04T22:00Z', '2026-10-07T11:00Z', 80),
      week(41, '2026-10-11T22:00Z', '2026-10-14T11:00Z', 80),
    ] }, nuclear: { roster: null, productionOutages: null, generationOutages: null } };
}
Deno.test('v2 preserves every v1 curve and adds a hydro analog using only preceding provider-dated weekly states', () => {
  const inputs = input(), base = forecastGenerationMix(inputs), run = forecastGenerationMixV2(inputs);
  assertEquals(run.algorithm, 'se3-generation-analog-v2');
  for (let index = 0; index < 72; index++) for (const [psr, candidates] of Object.entries(base.hours[index].byPsr)) {
    for (const name of ['persistence', 'calendar', 'weather', 'published'] as const) {
      assertEquals(run.hours[index].byPsr[psr][name], candidates[name]);
    }
  }
  const hydro = run.hours[0].byPsr.B12.hydro_state!;
  assertEquals(hydro.status, 'predicted');
  if (hydro.status !== 'predicted') throw Error(hydro.reason);
  assertEquals(hydro.trainingSamples, 2);
  assertEquals(hydro.mw > 500 && hydro.mw < 900, true);
  assertEquals(run.driverDiagnostics.hydro.latestWeek, '2026-41A');
  // A report revised after the origin cannot influence either training or target state.
  inputs.hydro!.weeks.push(week(42, '2026-10-18T22:00Z', '2026-10-21T11:00Z', 999));
  assertEquals(forecastGenerationMixV2(inputs), run);
  assertEquals(forecastGenerationMix(inputs), base);
});
Deno.test('hydro candidates expose missing publication dates, missing variation and unmatched calendar hours', () => {
  const inputs = input();
  inputs.hydro!.weeks.forEach(week => { week.providerModifiedAt = null; });
  assertEquals(forecastGenerationMixV2(inputs).hours[0].byPsr.B12.hydro_state!.status, 'unavailable');
  inputs.hydro = input().hydro;
  inputs.actuals = [actual('2026-10-09T12:00Z', 100)];
  assertEquals(forecastGenerationMixV2(inputs).hours[0].byPsr.B12.hydro_state!.status, 'unavailable');
  const run = forecastGenerationMixV2(input());
  assertEquals(run.hours[1].byPsr.B12.hydro_state!.status, 'unavailable');
  assertEquals(run.hours[0].byPsr.B14.hydro_state!.status, 'unavailable');
});
Deno.test('nuclear candidates use measured MW and announced hour means, retaining distinct delta and ratio hypotheses', () => {
  const inputs = input();
  const names = ['Forsmark 1', 'Forsmark 2', 'Forsmark 3', 'Ringhals 3', 'Ringhals 4', 'Oskarshamn 3'];
  inputs.nuclear.roster = { units: names.map((name, index) => ({ name, productionId: `unit-${index}`,
    capacities: [{ startMs: Date.parse('2026-01-01T00:00Z'), endMs: Date.parse('2027-01-01T00:00Z'), mw: 100 }] })) };
  inputs.nuclear.generationOutages = { documents: [] };
  const notice: NuclearOutageNotice = { id: 'maintenance', revision: 1, createdAt: '2026-10-15T12:00:00Z', status: null,
    name: 'Forsmark 1', psrType: 'B14', businessType: 'A53',
    documentType: 'A77', productionId: 'unit-0', generationId: null, nominalMw: 100,
    startMs: Date.parse(origin), endMs: Date.parse(origin) + 2 * HOUR,
    periods: [{ startMs: Date.parse(origin), endMs: Date.parse(origin) + 2 * HOUR, availableMw: 0 }] };
  inputs.nuclear.productionOutages = { documents: [notice] };
  const run = forecastGenerationMixV2(inputs), models = run.hours[0].byPsr.B14;
  assertEquals(models.nuclear_delta!.status, 'predicted');
  assertEquals(models.nuclear_ratio!.status, 'predicted');
  if (models.nuclear_delta!.status !== 'predicted' || models.nuclear_ratio!.status !== 'predicted') throw Error('Missing nuclear model');
  assertAlmostEquals(models.nuclear_delta!.mw, 200);
  assertAlmostEquals(models.nuclear_ratio!.mw, 250);
  const before = structuredClone(run);
  inputs.actuals.push(actual('2026-10-16T12:00Z', 999999, 'B14'));
  assertEquals(forecastGenerationMixV2(inputs), before);
  inputs.nuclear.productionOutages = null;
  assertEquals(forecastGenerationMixV2(inputs).hours[0].byPsr.B14.nuclear_ratio!.status, 'unavailable');
});
Deno.test('scores separate algorithm versions and compare added candidates with matched baseline hours', () => {
  const inputs = input(), v1 = forecastGenerationMix(inputs), v2 = forecastGenerationMixV2(inputs);
  const scores = scoreGenerationRuns([v1, v2], [actual(origin, 700)]);
  assertEquals(new Set(scores.map(score => score.algorithm)).size, 2);
  const hydro = scores.find(score => score.model === 'hydro_state')!;
  assertEquals(hydro.algorithm, 'se3-generation-analog-v2');
  assertEquals(hydro.hours, 1);
  assertEquals(hydro.pairedBaseline.calendar!.hours, 1);
});
