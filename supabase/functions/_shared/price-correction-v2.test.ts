import { assertAlmostEquals, assertEquals, assertNotEquals, assertThrows } from '@std/assert';
import { buildPriceCorrectionV2 } from './price-correction-v2.ts';
import { correctionInput } from '../../../tests/helpers/price-correction-fixture.ts';
import type { CorrectionSample } from './price-correction.ts';

function sample(day: string, quarter: number, residual: number, features = Array(13).fill(1)): CorrectionSample {
  return { runId: `synthetic-${day}-${quarter}`, origin: '2026-10-20T12:00:00Z',
    start: new Date(Date.parse(`${day}T00:00:00+02:00`) + quarter * 900_000).toISOString(), leadDay: 2,
    baseline: 1, features, actual: 1 + residual, truthSequence: 10 };
}

Deno.test('v2 has one zero-residual date prior: two observed dates retain equal support despite unequal quarter counts', () => {
  const input = correctionInput();
  input.training = [sample('2026-10-22', 0, 2), sample('2026-10-23', 0, 4), sample('2026-10-23', 1, 4)];
  const result = buildPriceCorrectionV2(input);
  assertEquals(result.fit!.training.targetDays, 2);
  assertAlmostEquals(result.fit!.ridge.coefficients[0], (2 + 4) / (2 + 1));
  assertAlmostEquals(result.targets[0].corrected!, 4);
  input.training.push(...Array.from({ length: 20 }, (_, i) => sample('2026-10-23', i + 2, 4)));
  const repeated = buildPriceCorrectionV2(input);
  assertAlmostEquals(repeated.targets[0].corrected!, result.targets[0].corrected!, 1e-12);
});

Deno.test('v2 slope prior uses mean-date loss: an independent two-point solution has slope 1/11', () => {
  const input = correctionInput();
  const left = Array(13).fill(1), right = [...left]; left[0] = 1; right[0] = 3;
  input.training = [sample('2026-10-22', 0, -1, left), sample('2026-10-22', 1, 1, right)];
  input.baseline.slots[0].price = 4;
  const result = buildPriceCorrectionV2(input);
  assertAlmostEquals(result.fit!.ridge.coefficients[1], 1 / 11, 1e-12);
  assertAlmostEquals(result.targets[0].corrected!, 4 + 2 / 11, 1e-12);
  assertEquals(result.fit!.ridge.slopePenaltyPerDay, 10);
  assertEquals(result.fit!.ridge.interceptPriorDays, 1);
});

Deno.test('constant fractional MW columns stay exactly constant under date weights and cannot invent enormous future contributions', () => {
  const input = correctionInput();
  const features = Array(13).fill(1234.5678912345);
  input.training = Array.from({ length: 96 }, (_, i) => sample('2026-10-22', i, -1, features));
  const result = buildPriceCorrectionV2(input);
  assertEquals(result.fit!.ridge.scales, Array(13).fill(1));
  assertEquals(result.fit!.ridge.coefficients.slice(1), Array(13).fill(0));
  assertAlmostEquals(result.targets[0].corrected!, input.baseline.slots[0].price - .5, 1e-12);
});

Deno.test('v2 preserves genuine prices, all DST quarters, missing-feature reasons, and immutable original evidence', () => {
  const input = correctionInput(), before = structuredClone(input);
  const collecting = buildPriceCorrectionV2(input);
  assertEquals(collecting.status, 'unavailable');
  assertEquals(collecting.targets.length, 100);
  assertEquals(input, before);
  input.training = [sample('2026-10-22', 0, -10)];
  const forecast = buildPriceCorrectionV2(input);
  assertEquals(forecast.targets.map(row => row.baseline), input.baseline.slots.map(row => row.price));
  assertAlmostEquals(forecast.targets[0].corrected!, -3); // No clipping or replacement model.
  input.baseline.slots[0].published = true;
  input.load = null;
  const missing = buildPriceCorrectionV2(input);
  assertEquals(missing.targets[0].corrected, null);
  assertEquals(missing.targets[1].features, null);
  assertNotEquals(missing.targets[1].reason, null);
  input.training[0].truthSequence = 21;
  assertThrows(() => buildPriceCorrectionV2(input), Error, 'training example');
});
