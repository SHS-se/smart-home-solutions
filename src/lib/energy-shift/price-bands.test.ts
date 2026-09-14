import { assert, assertEquals } from 'jsr:@std/assert@1';
import { PRICE_RAMP_STEPS, priceBands, priceGradientStops } from './price-bands.ts';

const spread = [0.4, 0.8, 1.2, 1.6, 2.0, 2.4, 2.8];

Deno.test('seven equal bands cover 0–5 SEK/kWh with clamped endpoint colours', () => {
  const bands = priceBands(spread)!;
  assertEquals(bands.min, 0);
  assertEquals(bands.max, 5);
  for (let index = 0; index < PRICE_RAMP_STEPS; index++) {
    assertEquals(bands.step((index + 0.5) * 5 / PRICE_RAMP_STEPS), index + 1);
  }
  for (let index = 1; index < PRICE_RAMP_STEPS; index++) {
    const boundary = index * 5 / PRICE_RAMP_STEPS;
    assertEquals(bands.step(boundary - 0.000001), index);
    assertEquals(bands.step(boundary + 0.000001), index + 1);
  }
  assertEquals(bands.step(0), 1);
  assertEquals(bands.step(-1), 1);
  assertEquals(bands.step(5), PRICE_RAMP_STEPS);
  assertEquals(bands.step(10), PRICE_RAMP_STEPS);
});

Deno.test('the same price keeps its colour across windows and on flat-price days', () => {
  const windows = [[1.2, 1.3, 1.4], [0, 1.3, 10], [1.3, 1.3], [1.3, 1.3001]];
  for (const prices of windows) {
    const bands = priceBands(prices)!;
    assertEquals(bands.step(1.3), 2);
    assertEquals(bands.min, 0);
    assertEquals(bands.max, 5);
  }
  assertEquals(priceBands([5, 5])!.step(5), PRICE_RAMP_STEPS);
});

Deno.test('no finite prices means nothing to colour', () => {
  assertEquals(priceBands([]), null);
  assertEquals(priceBands([null, null]), null);
  assertEquals(priceBands([Number.NaN, Infinity]), null);
});

Deno.test('unpriced quarters do not change the fixed scale', () => {
  const bands = priceBands([null, 1.0, null, 3.0])!;
  assertEquals(bands.min, 0);
  assertEquals(bands.max, 5);
  assertEquals(bands.step(1), 2);
});

Deno.test('every step is inside the ramp, including outside the window', () => {
  const bands = priceBands(spread)!;
  for (const price of [-5, 0, 1.37, 99, Number.NaN]) {
    const step = bands.step(price);
    assert(
      step >= 1 && step <= PRICE_RAMP_STEPS && Number.isInteger(step),
      `${price} produced step ${step}`,
    );
  }
});

Deno.test('gradient stops step at quarter edges rather than blending', () => {
  // Two stops per colour change, so one quarter's colour never smears into
  // the next — the line has to look as stepped as the data is.
  const prices = [0.4, 2.8];
  const bands = priceBands(prices)!;
  const stops = priceGradientStops(prices, bands);
  assertEquals(stops.length, 4);
  assertEquals(stops[0].offset, '0.000%');
  assertEquals(stops[1].offset, '50.000%');
  assertEquals(stops[2].offset, '50.000%');
  assertEquals(stops[3].offset, '100.000%');
  assert(stops[0].step !== stops[3].step, 'both ends came out the same colour');
});

Deno.test('a run of one colour costs two stops, not two per quarter', () => {
  const prices = [1, 1, 1, 1];
  const bands = priceBands([...prices, 5])!;
  assertEquals(priceGradientStops(prices, bands).length, 2);
});

Deno.test('stops span the whole width', () => {
  const bands = priceBands(spread)!;
  const stops = priceGradientStops(spread, bands);
  assertEquals(stops[0].offset, '0.000%');
  assertEquals(stops[stops.length - 1].offset, '100.000%');
});
