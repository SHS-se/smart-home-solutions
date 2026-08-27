import { assert, assertEquals } from 'jsr:@std/assert@1';
import {
  earnsOwnBand,
  MAX_SERIES,
  splitConsumption,
  type ConsumptionCandidate,
} from './consumption-series.ts';

/** Watts that draw exactly the given energy over one quarter. */
const forKwh = (kwh: number) => kwh * 4_000;

const flat = (watts: number, count = 12) => Array.from({ length: count }, () => watts);

const candidate = (
  overrides: Partial<ConsumptionCandidate> & { key: string },
): ConsumptionCandidate => ({
  name: overrides.key,
  values: flat(0),
  schedulable: true,
  ...overrides,
});

Deno.test('a load held for an hour earns a band', () => {
  const values = [0, ...flat(forKwh(0.1), 4), 0];
  assert(earnsOwnBand(values), 'four consecutive quarters at the threshold should qualify');
});

Deno.test('three quarters is not four', () => {
  assertEquals(earnsOwnBand([0, ...flat(forKwh(0.1), 3), 0]), false);
});

Deno.test('the run has to be consecutive', () => {
  // A pump that ticks on and off all day is background, however many quarters
  // it adds up to; the band would be a comb rather than a shape.
  const stuttering = [forKwh(0.1), 0, forKwh(0.1), 0, forKwh(0.1), 0, forKwh(0.1)];
  assertEquals(earnsOwnBand(stuttering), false);
});

Deno.test('one big quarter earns a band on its own', () => {
  // An oven takes a kilowatt-hour and stops. Requiring an hour of it would
  // hide exactly the loads worth shifting.
  assert(earnsOwnBand([0, forKwh(0.4), 0]));
});

Deno.test('a meter that never ran earns nothing', () => {
  assertEquals(earnsOwnBand(flat(0, 96)), false);
  assertEquals(earnsOwnBand([]), false);
});

Deno.test('non-numeric readings do not qualify a meter', () => {
  assertEquals(earnsOwnBand([Number.NaN, Number.NaN, Number.NaN, Number.NaN]), false);
});

Deno.test('only schedulable meters get a band', () => {
  // A fridge cycling at 90 W passes neither test anyway, but a big unmovable
  // load would — and drawing it implies the plan could do something about it.
  const split = splitConsumption([
    candidate({ key: 'sauna', values: flat(forKwh(0.5), 8), schedulable: false }),
  ], flat(forKwh(0.5), 8));
  assertEquals(split.series.length, 0);
  assertEquals(split.foldedCount, 1);
});

Deno.test('the stack always adds up to house demand', () => {
  // The top of the stack is compared against the flows panel above it, so a
  // disagreement between the plan's base figure and its per-device figures
  // must land in base load rather than in a missing sliver at the top.
  const demand = flat(3_000, 4);
  const split = splitConsumption([
    candidate({ key: 'boiler', values: flat(2_000, 4) }),
  ], demand);
  assertEquals(split.series.length, 1);
  split.baseValues.forEach((base, index) => {
    assertEquals(base + split.series[0].values[index], demand[index]);
  });
});

Deno.test('base load never goes negative', () => {
  // Device meters can exceed a reported total by a rounding error, and a
  // negative band would draw below the axis in a panel that has no below.
  const split = splitConsumption([
    candidate({ key: 'boiler', values: flat(2_100, 4) }),
  ], flat(2_000, 4));
  assert(split.baseValues.every(value => value >= 0), JSON.stringify(split.baseValues));
});

Deno.test('an unknown total falls back to adding up the remainder', () => {
  const split = splitConsumption([
    candidate({ key: 'boiler', values: flat(2_000, 2) }),
    candidate({ key: 'fridge', values: flat(90, 2), schedulable: false }),
  ], [null, null]);
  assertEquals(split.baseValues, [90, 90]);
});

Deno.test('colour follows the meter, not its rank', () => {
  // A reader who learned that the boiler is green must not find it repainted
  // because the pool ran harder today.
  const meters = [
    candidate({ key: 'a-boiler', values: flat(forKwh(0.5), 6) }),
    candidate({ key: 'b-pool', values: flat(forKwh(0.2), 6) }),
  ];
  const quiet = splitConsumption(meters, flat(forKwh(0.7), 6));
  const busy = splitConsumption([
    meters[0],
    { ...meters[1], values: flat(forKwh(2), 6) },
  ], flat(forKwh(2.5), 6));

  const slotOf = (split: ReturnType<typeof splitConsumption>, key: string) =>
    split.series.find(entry => entry.key === key)?.slot;
  assertEquals(slotOf(quiet, 'a-boiler'), slotOf(busy, 'a-boiler'));
  assertEquals(slotOf(quiet, 'b-pool'), slotOf(busy, 'b-pool'));
});

Deno.test('a meter that did not run keeps its colour for the day it does', () => {
  const idle = candidate({ key: 'a-boiler', values: flat(0, 6) });
  const pool = candidate({ key: 'b-pool', values: flat(forKwh(0.5), 6) });
  const split = splitConsumption([idle, pool], flat(forKwh(0.5), 6));
  assertEquals(split.series.length, 1, 'the idle meter should not be drawn');
  assertEquals(split.series[0].slot, 1, 'but it should still hold slot 0');
});

Deno.test('bands are ordered largest first', () => {
  const split = splitConsumption([
    candidate({ key: 'small', values: flat(forKwh(0.15), 6) }),
    candidate({ key: 'large', values: flat(forKwh(0.9), 6) }),
  ], flat(forKwh(1.1), 6));
  assertEquals(split.series.map(entry => entry.key), ['large', 'small']);
});

Deno.test('past the colour ceiling, the smallest meters join base load', () => {
  const many = Array.from({ length: MAX_SERIES + 3 }, (_, index) => candidate({
    key: `meter-${String(index).padStart(2, '0')}`,
    values: flat(forKwh(0.5 + index), 6),
  }));
  const split = splitConsumption(many, flat(forKwh(100), 6));
  assertEquals(split.series.length, MAX_SERIES);
  assertEquals(split.foldedCount, 3);
  assert(
    split.baseValues.every(value => value > 0),
    'the folded meters should still be somewhere',
  );
});

Deno.test('an empty window produces an empty stack rather than throwing', () => {
  const split = splitConsumption([], []);
  assertEquals(split.series, []);
  assertEquals(split.baseValues, []);
  assertEquals(split.baseKwh, 0);
});
