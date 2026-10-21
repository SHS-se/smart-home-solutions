import { assertAlmostEquals, assertEquals } from '@std/assert';
import { projectBoilerTank } from './boiler-consumption.ts';

const quarters = (n: number) => ({ running_w: Array(n).fill(3000), hours: Array(n).fill(.25) });

Deno.test('heat only replaces water already drawn: the tank is never heated beyond full', () => {
  const run = projectBoilerTank({ ...quarters(4), draw_w: [1000, 1000, 1000, 1000], permitted: [true, false, false, false] });
  assertEquals(run.expected_w, [1000, 0, 0, 0]);
  assertEquals(run.deficit_wh, [0, 250, 500, 750]);
  assertEquals(run.owed_wh, 750);
});

Deno.test('a block leaves heat owed and the next permission heats it at running power', () => {
  const run = projectBoilerTank({ ...quarters(8), draw_w: Array(8).fill(1000), permitted: [false, false, false, false, false, false, true, false] });
  assertEquals(run.expected_w, [0, 0, 0, 0, 0, 0, 3000, 3000]);
  assertEquals(run.owed_wh, 500);
});

Deno.test('a free thermostat heats each draw as it happens, carrying what exceeds running power', () => {
  const run = projectBoilerTank({ ...quarters(4), draw_w: [0, 500, 4000, 0], permitted: [true, true, true, true] });
  assertEquals(run.expected_w, [0, 500, 3000, 1000]);
  assertEquals(run.owed_wh, 0);
});

Deno.test('a run finishes across inhibition and its final quarter integrates actual runtime', () => {
  const run = projectBoilerTank({ draw_w: [0, 0, 0], initial_deficit_wh: 1000, running_w: [3060, 3060, 3060],
    hours: [.25, .25, .25], permitted: [true, false, false] });
  assertEquals(run.expected_w, [3060, 940, 0]);
  assertEquals(run.owed_wh, 0);
});

Deno.test('a partial current quarter heats for its remaining seconds', () => {
  const run = projectBoilerTank({ draw_w: [0, 0, 0], initial_deficit_wh: 1000, running_w: [3000, 3000, 3000],
    hours: [.1, .25, .25], permitted: [true, true, true] });
  assertAlmostEquals(run.expected_w[0], 3000);
  assertAlmostEquals(run.expected_w[1], 2800);
  assertEquals(run.expected_w[2], 0);
});

Deno.test('committed watts are kept exactly and still empty the deficit', () => {
  const run = projectBoilerTank({ ...quarters(3), draw_w: [0, 0, 0], initial_deficit_wh: 1500,
    permitted: [true, false, false], committed_w: [3000, undefined, undefined] });
  assertEquals(run.expected_w, [3000, 3000, 0]);
});

Deno.test('a run drawing 50 W or more keeps finishing; below 50 W it has finished', () => {
  for (const [watts, next] of [[60, 3000], [50, 3000], [49, 0]]) {
    const run = projectBoilerTank({ ...quarters(3), draw_w: [0, 0, 0], initial_deficit_wh: 1000,
      permitted: [true, false, false], committed_w: [watts, undefined, undefined] });
    assertEquals(run.expected_w[1], next);
  }
});
