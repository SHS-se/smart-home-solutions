import { assertEquals } from '@std/assert';
import { curvePlotPoints } from './curve-plot.ts';
import type { UsedCurve } from './types.ts';

Deno.test('a reported target cutoff is drawn as a jump, with zero utility beyond it', () => {
  const curve: UsedCurve = { store: 'ev', unit: 'km', points: [
    { at: 200, sek_per_unit: .4 }, { at: 300, sek_per_unit: .4 }],
    initial_state: 150, max_state: 380, units_per_kwh: 6, reference_sek_per_kwh: .8, mode: 'comfort target' };
  assertEquals(curvePlotPoints(curve), [
    { at: 150, sek_per_unit: .4 }, { at: 200, sek_per_unit: .4 },
    { at: 300, sek_per_unit: .4 }, { at: 300, sek_per_unit: 0 }, { at: 380, sek_per_unit: 0 }]);
  assertEquals(curve.points.length, 2);
  assertEquals(curvePlotPoints({ ...curve, max_state: 300, initial_state: 320 }).at(-1),
    { at: 320, sek_per_unit: 0 });
});
