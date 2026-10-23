import { assert, assertEquals } from 'jsr:@std/assert@1';
import {
  earnsOwnBand,
  consumptionGapDescription,
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
  colour: `#${(0x304050 + [...overrides.key].reduce((value, char) => value * 31 + char.charCodeAt(0), 0) % 0xb0b0b0).toString(16).padStart(6, '0')}`,
  values: flat(0),
  schedulable: true,
  ...overrides,
});

Deno.test('any use earns a band, however small', () => {
  // A floor heater at a few hundred watts is what a room's temperature line
  // answers to; folding it away left the room with nothing to point at.
  assert(earnsOwnBand([0, 50, 0]));
  assert(earnsOwnBand([forKwh(0.4)]));
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

Deno.test('unreconciled device totals are gaps rather than clamped base load', () => {
  // Device meters can exceed a reported total by a rounding error, and a
  // negative band would draw below the axis in a panel that has no below.
  const split = splitConsumption([
    candidate({ key: 'boiler', values: flat(2_100, 4) }),
  ], flat(2_000, 4));
  assert(split.baseValues.every(Number.isNaN));
  assertEquals(split.invalidIndices, [0, 1, 2, 3]);
});

Deno.test('an unknown household total cannot be reconstructed from partial meters', () => {
  const split = splitConsumption([
    candidate({ key: 'boiler', values: flat(2_000, 2) }),
    candidate({ key: 'fridge', values: flat(90, 2), schedulable: false }),
  ], [null, null]);
  assert(split.baseValues.every(Number.isNaN));
  assertEquals(split.invalidIndices, [0, 1]);
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

  const colourOf = (split: ReturnType<typeof splitConsumption>, key: string) =>
    split.series.find(entry => entry.key === key)?.colour;
  assertEquals(colourOf(quiet, 'a-boiler'), colourOf(busy, 'a-boiler'));
  assertEquals(colourOf(quiet, 'b-pool'), colourOf(busy, 'b-pool'));
});

Deno.test('a meter that did not run keeps its colour for the day it does', () => {
  const idle = candidate({ key: 'a-boiler', values: flat(0, 6) });
  const pool = candidate({ key: 'b-pool', values: flat(forKwh(0.5), 6) });
  const split = splitConsumption([idle, pool], flat(forKwh(0.5), 6));
  assertEquals(split.series.length, 1, 'the idle meter should not be drawn');
  assertEquals(split.series[0].colour, pool.colour);
});

Deno.test('bands are ordered largest first', () => {
  const split = splitConsumption([
    candidate({ key: 'small', values: flat(forKwh(0.15), 6) }),
    candidate({ key: 'large', values: flat(forKwh(0.9), 6) }),
  ], flat(forKwh(1.1), 6));
  assertEquals(split.series.map(entry => entry.key), ['large', 'small']);
});

Deno.test('every planned device retains its own saved colour beyond the old eight-band limit', () => {
  const many = Array.from({ length: 24 }, (_, index) => candidate({
    key: `meter-${index}`, colour: `#${(0x304050 + index * 173).toString(16)}`,
    values: flat(forKwh(0.5 + index), 6),
  }));
  const split = splitConsumption(many, flat(forKwh(1000), 6));
  assertEquals(split.series.length, many.length);
  assertEquals(new Set(split.series.map(series => series.colour)).size, many.length);
  for (const series of split.series) assertEquals(series.colour, many.find(meter => meter.key === series.key)!.colour);
  assertEquals(split.baseValues[0], forKwh(1000) - many.reduce((sum, c) => sum + c.values[0], 0));
});

Deno.test('an empty window produces an empty stack rather than throwing', () => {
  const split = splitConsumption([], []);
  assertEquals(split.series, []);
  assertEquals(split.baseValues, []);
  assertEquals(split.baseKwh, 0);
});

Deno.test("small Planned consumption is its own band, separate from gross base before solar", () => {
  const split = splitConsumption([candidate({ key: "small", values: [50, 0] }),
    candidate({ key: "monitored", values: [100, 100], schedulable: false })], [1000, 1000]);
  assertEquals(split.baseValues, [950, 1000]);
  assertEquals(split.series.map(s => s.key), ["small"]);
  assertEquals(split.series[0].values, [50, 0]);
});

Deno.test("duplicate meter identities cannot manufacture base consumption", () => {
  const c = candidate({ key: "same", values: [100] });
  const split = splitConsumption([c, c], [500]);
  assertEquals(split.invalidIndices, [0]);
  assert(Number.isNaN(split.baseValues[0]));
});

Deno.test('missing planned meter contributes zero without losing household consumption', () => {
  const split = splitConsumption([
    candidate({ key: 'sensor.pool_pump_energy', name: 'Pool pump', values: [NaN, 0] }),
    candidate({ key: 'heater', values: [0, 0] }),
  ], [2600, 2600]);
  assertEquals(split.invalidIndices, []);
  assertEquals(split.issues, [null, null]);
  assertEquals(split.baseValues, [2600, 2600]);
  assertEquals(split.baseKwh, 1.3);
});

Deno.test('inconsistent consumption is not described as a missing device', () => {
  const split = splitConsumption([candidate({ key: 'pump', values: [3000] })], [2600]);
  assertEquals(split.issues, [{ missingDevices: [] }]);
  assertEquals(consumptionGapDescription(split.issues[0]!, (_sv, en) => en),
    'Household and device readings cannot be reconciled for this quarter.');
});

Deno.test('one missing device leaves other device readings intact, including small loads', () => {
  const split = splitConsumption([
    candidate({ key: 'pump', values: [800, NaN, 800, 800, 800] }),
    candidate({ key: 'heater', values: [1800, 1800, 1800, 1800, 1800] }),
    candidate({ key: 'small-missing', values: [20, NaN, 20, 20, 20] }),
    candidate({ key: 'small-known', values: [50, 50, 50, 50, 50] }),
  ], flat(3000, 5));
  assertEquals(split.series.find(s => s.key === 'heater')!.values, flat(1800, 5));
  assertEquals(split.baseValues[1], 1150);
  assertEquals(split.series.find(s => s.key === 'small-known')!.values[1], 50);
  assertEquals(split.series.find(s => s.key === 'small-missing')!.values[1], 0);
  assert(split.series.every(s => s.key !== '$other_planned'));
  assertEquals(split.invalidIndices, []);
  assertEquals(split.issues, flat(0, 5).map(() => null));
  split.baseValues.forEach((base, i) => assertEquals(base + split.series.reduce((sum, s) => sum + s.values[i], 0), 3000));
});

Deno.test('absent and non-finite device readings are zero while negative readings remain invalid', () => {
  const split = splitConsumption([candidate({ key: 'heater', values: [1800, NaN, Infinity, -10] })], flat(3000, 5));
  assertEquals(split.series[0].values, [1800, 0, 0, -10, 0]);
  assertEquals(split.baseValues.slice(0, 3), [1200, 3000, 3000]);
  assertEquals(split.baseValues[4], 3000);
  assertEquals(split.invalidIndices, [3]);
});
