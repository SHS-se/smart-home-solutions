import { assert, assertEquals } from 'jsr:@std/assert@1';
import { alignedDomains } from './chart-axes.ts';

/** Where zero sits, as a fraction of the plot measured from the bottom. */
const zeroFraction = ([min, max]: [number, number]) => (0 - min) / (max - min);

Deno.test('both axes put zero at the same height', () => {
  // Grid export is negative, so the power axis reaches below zero. If the price
  // axis stayed at [0, max] its zero would sit on the floor while the power
  // zero floated above it, and reading a price against a flow would be wrong by
  // that offset everywhere on the chart.
  const domains = alignedDomains([
    { price: 3.2, power: 5_200 },
    { price: 0, power: -4_000 },
  ]);
  assert(
    Math.abs(zeroFraction(domains.price) - zeroFraction(domains.power)) < 1e-9,
    `price zero at ${zeroFraction(domains.price)}, power zero at ${zeroFraction(domains.power)}`,
  );
});

Deno.test('a day that never exports keeps both axes on the floor', () => {
  const domains = alignedDomains([{ price: 2.5, power: 4_000 }]);
  assertEquals(domains.price[0], 0);
  assertEquals(domains.power[0], 0);
});

Deno.test('the domains still cover the data they were built from', () => {
  const domains = alignedDomains([
    { price: 3.8, power: 6_000 },
    { price: 0, power: -9_000 },
  ]);
  assert(domains.power[0] <= -9_000 && domains.power[1] >= 6_000);
  assert(domains.price[1] >= 3.8);
});

Deno.test('an empty window does not produce a degenerate axis', () => {
  // Every domain must still be an interval: a zero-width axis makes recharts
  // draw nothing at all rather than an empty chart.
  const domains = alignedDomains([]);
  assert(domains.price[1] > domains.price[0]);
  assert(domains.power[1] > domains.power[0]);
});
