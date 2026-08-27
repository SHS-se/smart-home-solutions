import { assert, assertEquals } from 'jsr:@std/assert@1';
import {
  linearScale,
  midpointLinePath,
  niceTicks,
  placeBandLabels,
  spansOf,
  stackBands,
  stepAreaPath,
  stepBandPath,
  stepLinePath,
} from './plan-chart-geometry.ts';

const x = linearScale([0, 4], [0, 400]);
const y = linearScale([0, 10], [100, 0]);

Deno.test('a scale maps its domain onto its range', () => {
  assertEquals(x(0), 0);
  assertEquals(x(4), 400);
  assertEquals(y(10), 0, 'the range is inverted, as screen coordinates are');
});

Deno.test('a flat domain draws a line rather than dividing by zero', () => {
  const flat = linearScale([5, 5], [0, 100]);
  assert(Number.isFinite(flat(5)), `got ${flat(5)}`);
});

Deno.test('a quarter is drawn as a band, not a point', () => {
  // The value holds from the start of the quarter to the start of the next
  // one, so the first quarter has to reach x(1) even though there is no
  // second data point yet. Drawn as points, every series would end a quarter
  // early and the day would look fifteen minutes shorter than it was.
  const path = stepLinePath([5], x, y);
  assertEquals(path, 'M0,50L100,50');
});

Deno.test('a gap in the data draws as a gap', () => {
  // Unpriced quarters are real: prices only accumulate forward from the day
  // the integration started sending them. Bridging the hole would invent a
  // price that was never quoted.
  const path = stepLinePath([5, null, 5], x, y);
  assertEquals(path.split('M').length - 1, 2, `expected two sub-paths, got ${path}`);
});

Deno.test('an area closes down to its baseline', () => {
  const path = stepAreaPath([5], x, y, 0);
  assert(path.endsWith('Z'), `unclosed: ${path}`);
  assert(path.includes(`,${y(0)}`), `never reaches the baseline: ${path}`);
});

Deno.test('stacked bands run each series on top of the last', () => {
  const bands = stackBands([[1, 1], [2, 2], [3, 3]]);
  assertEquals(bands[0], [[0, 1], [0, 1]]);
  assertEquals(bands[1], [[1, 3], [1, 3]]);
  assertEquals(bands[2], [[3, 6], [3, 6]]);
});

Deno.test('a stacked band is closed, so it can be filled', () => {
  const path = stepBandPath([[0, 1], [1, 3]], x, y);
  assert(path.startsWith('M'), path);
  assert(path.endsWith('Z'), path);
});

Deno.test('state of charge is drawn through quarter midpoints', () => {
  // The one quantity here that is a level moving through the quarter rather
  // than a rate held across it, so it is the one series not drawn stepped.
  const path = midpointLinePath([10], x, y);
  assertEquals(path, `M${x(0.5)},0`);
});

Deno.test('ticks are numbers a person recognises', () => {
  assertEquals(niceTicks(0, 4.6, 4), [0, 1, 2, 3, 4]);
  assertEquals(niceTicks(-2.7, 5.1, 4), [-2, 0, 2, 4]);
});

Deno.test('a tick is never labelled minus zero', () => {
  // -0 renders as "-0", which reads as a bug rather than as zero.
  for (const tick of niceTicks(-3, 9, 4)) {
    assert(!Object.is(tick, -0), 'negative zero reached the axis');
  }
});

Deno.test('zero is a real tick whenever the domain spans it', () => {
  const ticks = niceTicks(-4_000, 5_200, 4);
  assert(ticks.some(tick => tick === 0), `no zero in ${JSON.stringify(ticks)}`);
});

Deno.test('equal neighbours collapse into one span', () => {
  // Twenty meters over thirty-six hours is nearly three thousand cells, and
  // most of them are the same shade of nothing beside an identical neighbour.
  assertEquals(spansOf([0, 0, 3, 3, 3, 1]), [
    { from: 0, to: 2, value: 0 },
    { from: 2, to: 5, value: 3 },
    { from: 5, to: 6, value: 1 },
  ]);
});

Deno.test('spans cover every index exactly once', () => {
  const values = [1, 1, 2, 3, 3, 3, 0, 0, 5];
  const spans = spansOf(values);
  assertEquals(spans[0].from, 0);
  assertEquals(spans[spans.length - 1].to, values.length);
  for (let i = 1; i < spans.length; i += 1) assertEquals(spans[i].from, spans[i - 1].to);
});

const bandOf = (values: number[]): Array<[number, number]> =>
  values.map(value => [0, value] as [number, number]);

Deno.test('a band too thin to hold its name does not get one', () => {
  const thin = bandOf([0.2, 0.2, 0.2]);
  assertEquals(placeBandLabels([thin], ['Pool pump'], x, y).length, 0);
});

Deno.test('a band thick enough is labelled at its widest point', () => {
  const band = bandOf([1, 9, 1]);
  const [placement] = placeBandLabels([band], ['Pool heater'], x, y);
  assertEquals(placement.band, 0);
  // Quarter 1 is the thickest, so the label sits over its middle.
  assertEquals(placement.x, (x(1) + x(2)) / 2);
});

Deno.test('overlapping labels are dropped, thickest kept', () => {
  // Stacked bands are separated vertically by their own thickness, so labels
  // collide only when two bands peak at different times but similar heights —
  // which is exactly what a long meter name turns into an overlap.
  const thick: Array<[number, number]> = [[0, 5], [0, 1], [0, 1], [0, 1]];
  const thin: Array<[number, number]> = [[5, 6], [1, 5], [1, 5], [1, 5]];
  const name = 'Tesla Model Y Charge';
  const placed = placeBandLabels([thick, thin], [name, name], x, y, { minThickness: 18 });
  assertEquals(placed.length, 1);
  assertEquals(placed[0].band, 0, 'the thicker band should keep its label');
});

Deno.test('labels far apart both survive', () => {
  const left = bandOf([9, 1, 1, 1]);
  const right = bandOf([1, 1, 1, 9]);
  const placed = placeBandLabels([left, right], ['A', 'B'], x, y);
  assertEquals(placed.length, 2);
});

Deno.test('a label never hangs off the end of the plot', () => {
  const atEdge = bandOf([9, 1, 1, 1]);
  const [placement] = placeBandLabels([atEdge], ['A very long meter name'], x, y);
  assert(placement.x - placement.width / 2 >= x(0) - 0.001, 'ran off the left');
  assert(placement.x + placement.width / 2 <= x(4) + 0.001, 'ran off the right');
});

Deno.test('placements come back in band order', () => {
  const placed = placeBandLabels(
    [bandOf([1, 1, 1, 9]), bandOf([9, 1, 1, 1])],
    ['B', 'A'],
    x, y,
  );
  assertEquals(placed.map(placement => placement.band), [0, 1]);
});
