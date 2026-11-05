import { assertAlmostEquals, assertEquals } from '@std/assert';
import { poolComfortExposure } from './pool-comfort.ts';

// Independently specified synthetic water segments; no captured household data.
Deno.test('pool comfort preserves the near-target curve and bounds the deep-cold slope', () => {
  const exposure = (deficit: number) => poolComfortExposure(30, 30 - deficit, 30 - deficit, 1);
  assertEquals(exposure(-1), 0);
  assertEquals(exposure(0), 0);
  assertEquals(exposure(1), 1);
  assertEquals(exposure(2), 4);
  assertEquals(exposure(3), 8);
  assertEquals(exposure(10), 36);
  assertAlmostEquals((exposure(2) - exposure(2 - 1e-5)) / 1e-5, 4, 2e-5);
  assertAlmostEquals((exposure(2 + 1e-5) - exposure(2)) / 1e-5, 4, 1e-9);
});

Deno.test('pool comfort integrates crossings of both joins in either direction', () => {
  // Integral of d² on [0,2] plus 4d−4 on [2,3], divided by deficit span 4.
  assertAlmostEquals(poolComfortExposure(30, 31, 27, 1), 13 / 6, 1e-12);
  assertAlmostEquals(poolComfortExposure(30, 27, 31, 1), 13 / 6, 1e-12);
  assertAlmostEquals(poolComfortExposure(30, 29, 27, .1), 5 / 12, 1e-12);
  const whole = poolComfortExposure(30, 31, 27, 1);
  const split = poolComfortExposure(30, 31, 28, .75) + poolComfortExposure(30, 28, 27, .25);
  assertAlmostEquals(whole, split, 1e-12);
});
