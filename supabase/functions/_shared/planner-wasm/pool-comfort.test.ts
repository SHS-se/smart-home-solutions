import { assertAlmostEquals, assertEquals } from '@std/assert';
import { poolComfortExposure } from './pool-comfort.ts';

// Independently specified synthetic water segments; no captured household data.
Deno.test('pool comfort is linear beyond a one-degree free band without steps or a cap', () => {
  const exposure = (deficit: number) => poolComfortExposure(30, 30 - deficit, 30 - deficit, 1);
  for (const deficit of [-1, 0, .5, 1]) assertEquals(exposure(deficit), 0);
  assertAlmostEquals(exposure(1.1), .1, 1e-12);
  assertEquals(exposure(1.5), .5);
  assertEquals(exposure(2), 1);
  assertEquals(exposure(2.5), 1.5);
  assertEquals(exposure(3), 2);
  assertEquals(exposure(10), 9);
  assertAlmostEquals(exposure(1 + 1e-5), 1e-5, 1e-12);
});

Deno.test('pool comfort integrates free-band crossings in either direction and partial intervals', () => {
  // Positive triangle: 2°C maximum excess × half the segment × 1/2.
  assertAlmostEquals(poolComfortExposure(30, 31, 27, 1), .5, 1e-12);
  assertAlmostEquals(poolComfortExposure(30, 27, 31, 1), .5, 1e-12);
  assertAlmostEquals(poolComfortExposure(30, 29, 27, .1), .1, 1e-12);
  const whole = poolComfortExposure(30, 31, 27, 1);
  const split = poolComfortExposure(30, 31, 28, .75) + poolComfortExposure(30, 28, 27, .25);
  assertAlmostEquals(whole, split, 1e-12);
});
