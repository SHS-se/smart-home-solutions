import { assert, assertEquals } from 'jsr:@std/assert@1';
import { comparePreference, solveWith } from './curve-preview.ts';
import { curveFromPreference } from '../../../supabase/functions/_shared/value-preferences.ts';
import { WATER_KWH_PER_M3_K } from '../../../supabase/functions/_shared/store-models.ts';
import { DEFAULT_VALUE_CURVES } from '../../../supabase/functions/_shared/value-curves.ts';
import { CAPTURED_AT, snapshot } from './optimisation-snapshot.fixture.ts';

const poolScale = {
  units_per_kwh: 4.6 / (55 * WATER_KWH_PER_M3_K),
  reference_sek_per_kwh: 2.2,
};

const poolCurve = (comfortable: number) =>
  curveFromPreference(
    { urgent_below: 25, comfortable, indifferent_above: comfortable + 2 },
    'celsius',
    poolScale,
  );

Deno.test('a preview runs the planner rather than a second model of it', () => {
  const outcome = solveWith(snapshot(), { pool: DEFAULT_VALUE_CURVES.pool });
  assert(typeof outcome !== 'string', `solve failed: ${outcome}`);
  assert(outcome.stores.length > 0, 'the preview must report the stores');
  const pool = outcome.stores.find(store => store.key === 'pool');
  assert(pool !== undefined, 'a home with a pool must report one');
  assertEquals(pool.unit, 'celsius');
});

Deno.test('wanting the pool warmer buys more heating, and the delta says so', () => {
  // The whole point of the preview: the household moves one number and reads a
  // consequence in hours, kWh and kronor rather than in SEK per degree.
  const comparison = comparePreference(
    snapshot(),
    { pool: poolCurve(28) },
    { pool: poolCurve(30) },
  );
  assert(typeof comparison !== 'string', `preview failed: ${comparison}`);
  const pool = comparison.stores.find(store => store.key === 'pool')!;
  assert(
    pool.runHoursAfter > pool.runHoursBefore,
    `a warmer target must run the heater longer: ${pool.runHoursBefore} -> ${pool.runHoursAfter}`,
  );
  assert(
    pool.kwhAfter > pool.kwhBefore,
    `and take more energy: ${pool.kwhBefore} -> ${pool.kwhAfter}`,
  );
  assert(
    pool.endStateAfter !== null && pool.endStateBefore !== null &&
      pool.endStateAfter > pool.endStateBefore,
    'and leave the pool warmer at the end of the horizon',
  );
});

Deno.test('the energy has to come from somewhere, and the preview shows where', () => {
  // Heating more either imports more or exports less. A preview that showed
  // the service change without its cost would be the half-objective §8.1 warns
  // about, dressed as a feature.
  const comparison = comparePreference(
    snapshot(),
    { pool: poolCurve(28) },
    { pool: poolCurve(30) },
  );
  assert(typeof comparison !== 'string');
  assert(
    comparison.importDeltaKwh > 0 || comparison.exportDeltaKwh < 0,
    'more heating must show up as more import or less export',
  );
});

Deno.test('an unchanged curve previews as no change at all', () => {
  const curves = { pool: poolCurve(28) };
  const comparison = comparePreference(snapshot(), curves, curves);
  assert(typeof comparison !== 'string');
  assertEquals(comparison.costDeltaSek, 0);
  assertEquals(comparison.importDeltaKwh, 0);
  for (const store of comparison.stores) {
    assertEquals(store.runHoursAfter, store.runHoursBefore);
  }
});

Deno.test('a snapshot the planner refuses explains itself instead of throwing', () => {
  const broken = { ...snapshot(), slots: [] };
  const outcome = solveWith(broken, {});
  assertEquals(typeof outcome, 'string');
});
