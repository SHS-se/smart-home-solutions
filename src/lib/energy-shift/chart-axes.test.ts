import { assert, assertEquals } from 'jsr:@std/assert@1';
import { sharedZeroAxes } from './chart-axes.ts';

/** Where zero sits, as a fraction of the plot measured from the bottom. */
const zeroFraction = ([min, max]: [number, number]) => (0 - min) / (max - min);

const evenlySpaced = (ticks: number[]) => {
  const gaps = ticks.slice(1).map((tick, index) => tick - ticks[index]);
  return gaps.every(gap => Math.abs(gap - gaps[0]) < 1e-9);
};

Deno.test('both axes put zero at the same height', () => {
  // Grid export is negative, so the power axis reaches below zero. If the price
  // axis stayed on the floor, reading a price against a flow would be wrong by
  // that offset everywhere on the chart.
  const axes = sharedZeroAxes({ priceMax: 3.2, powerMinW: -4_000, powerMaxW: 5_200 });
  assert(
    Math.abs(zeroFraction(axes.price.domain) - zeroFraction(axes.power.domain)) < 1e-9,
    `price zero at ${zeroFraction(axes.price.domain)}, power at ${zeroFraction(axes.power.domain)}`,
  );
});

Deno.test('zero is an actual gridline on both axes', () => {
  // Not merely inside the domain: a zero that falls between labels is what made
  // the first version unreadable even once the domains lined up.
  const axes = sharedZeroAxes({ priceMax: 2.93, powerMinW: -3_000, powerMaxW: 5_900 });
  assert(axes.price.ticks.some(tick => Math.abs(tick) < 1e-9), 'price axis has no zero tick');
  assert(axes.power.ticks.some(tick => Math.abs(tick) < 1e-9), 'power axis has no zero tick');
});

Deno.test('ticks are evenly spaced on both axes', () => {
  for (const power of [[-4_000, 5_200], [0, 7_800], [-9_000, 3_000]] as const) {
    const axes = sharedZeroAxes({ priceMax: 3.7, powerMinW: power[0], powerMaxW: power[1] });
    assert(evenlySpaced(axes.price.ticks), `price ticks uneven: ${axes.price.ticks}`);
    assert(evenlySpaced(axes.power.ticks), `power ticks uneven: ${axes.power.ticks}`);
  }
});

Deno.test('power gridlines land on whole kilowatts', () => {
  const axes = sharedZeroAxes({ priceMax: 3.7, powerMinW: -4_100, powerMaxW: 7_800 });
  for (const tick of axes.power.ticks) {
    assertEquals(tick % 1_000, 0, `${tick} W is not a whole kilowatt`);
  }
  assertEquals(axes.power.decimals, 0);
});

Deno.test('the domains still cover the data they were built from', () => {
  const axes = sharedZeroAxes({ priceMin: -1.2, priceMax: 3.8, powerMinW: -9_000, powerMaxW: 6_000 });
  assert(axes.power.domain[0] <= -9_000 && axes.power.domain[1] >= 6_000);
  assert(axes.price.domain[0] <= -1.2);
  assert(axes.price.domain[1] >= 3.8);
});

Deno.test('a day that never exports keeps both axes on the floor', () => {
  const axes = sharedZeroAxes({ priceMax: 2.5, powerMinW: 0, powerMaxW: 4_000 });
  assertEquals(axes.price.domain[0], 0);
  assertEquals(axes.power.domain[0], 0);
  assertEquals(axes.price.ticks[0], 0);
});

Deno.test('an empty window does not produce a degenerate axis', () => {
  // A zero-width domain makes recharts draw nothing at all rather than an
  // empty chart.
  const axes = sharedZeroAxes({ priceMax: 0, powerMinW: 0, powerMaxW: 0 });
  assert(axes.price.domain[1] > axes.price.domain[0]);
  assert(axes.power.domain[1] > axes.power.domain[0]);
});

Deno.test('the price axis is not stretched past what the day needed', () => {
  // Sizing the power axis first produced a price axis running to 6 SEK/kWh on a
  // day that never passed 3.3, wasting half the plot and making every price
  // line hug the middle.
  const axes = sharedZeroAxes({ priceMax: 3.3, powerMinW: -4_400, powerMaxW: 5_200 });
  assert(
    axes.price.domain[1] <= 4.001,
    `price axis reached ${axes.price.domain[1]} for a 3.3 maximum`,
  );
  assert(axes.price.domain[1] >= 3.3, 'and must still cover the data');
  assertEquals(axes.price.decimals, 0);
});

Deno.test('money ticks stay recognisable, never thirds of a krona', () => {
  for (const priceMax of [0.9, 2.2, 3.3, 4.8, 7.5]) {
    const axes = sharedZeroAxes({ priceMax, powerMinW: -3_000, powerMaxW: 6_000 });
    const step = axes.price.ticks[1] - axes.price.ticks[0];
    const scaled = step / 10 ** Math.floor(Math.log10(step));
    assert(
      [1, 2, 5, 10].some(nice => Math.abs(scaled - nice) < 1e-9),
      `price step ${step} is not a round money figure`,
    );
  }
});
