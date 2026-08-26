import { assert, assertEquals } from 'jsr:@std/assert@1';
import { PRICE_RAMP_STEPS, priceBands, priceGradientStops } from './price-bands.ts';

const spread = [0.4, 0.8, 1.2, 1.6, 2.0, 2.4, 2.8];

Deno.test('the cheapest quarter gets the first step and the dearest the last', () => {
  const bands = priceBands(spread)!;
  assertEquals(bands.step(0.4), 1);
  assertEquals(bands.step(2.8), PRICE_RAMP_STEPS);
});

Deno.test('the ramp is relative to the window on screen', () => {
  // A day that never leaves 1.20–1.40 still uses the whole ramp: the question
  // the colour answers is "cheap or dear compared with the rest of what I can
  // see", not "cheap or dear compared with last winter".
  const flatish = priceBands([1.2, 1.25, 1.3, 1.35, 1.4])!;
  assertEquals(flatish.step(1.2), 1);
  assertEquals(flatish.step(1.4), PRICE_RAMP_STEPS);
});

Deno.test('a price that never moves gets no ramp at all', () => {
  // Colouring float noise on a fixed-price contract would read as a real swing.
  assertEquals(priceBands([1.5, 1.5, 1.5]), null);
  assertEquals(priceBands([1.5, 1.5001]), null);
});

Deno.test('no prices means nothing to colour', () => {
  assertEquals(priceBands([]), null);
  assertEquals(priceBands([null, null]), null);
});

Deno.test('unpriced quarters do not drag the ends of the ramp', () => {
  const bands = priceBands([null, 1.0, null, 3.0])!;
  assertEquals(bands.min, 1.0);
  assertEquals(bands.max, 3.0);
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

Deno.test('the quartile rules sit inside the range and in order', () => {
  const bands = priceBands(spread)!;
  assert(bands.min <= bands.cheapAt, 'cheap rule below the range');
  assert(bands.cheapAt <= bands.dearAt, 'quartiles out of order');
  assert(bands.dearAt <= bands.max, 'dear rule above the range');
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
