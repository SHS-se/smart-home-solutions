import { assertAlmostEquals, assertEquals } from '@std/assert';
import { projectBoilerDay } from './boiler-consumption.ts';

Deno.test('3, 5 and 7 kWh take 60, 100 and 140 minutes at measured 3 kW', () => {
  for (const [kwh, minutes] of [[3, 60], [5, 100], [7, 140]]) {
    const run = projectBoilerDay({ required_wh: kwh * 1000, running_w: Array(96).fill(3000),
      hours: Array(96).fill(.25), permitted: Array.from({ length: 96 }, (_, i) => i < 10) });
    assertAlmostEquals(run.expected_w.reduce((s, w) => s + w / 4000, 0), kwh);
    assertAlmostEquals(run.expected_w.reduce((s, w) => s + w / 3000 * 15, 0), minutes);
    assertEquals(run.expected_w.filter(w => w > 0 && w < 3000).length, kwh === 3 ? 0 : 1);
    assertEquals(run.unserved_wh, 0);
  }
});

Deno.test('a run finishes across inhibition and its final quarter integrates actual runtime', () => {
  const run = projectBoilerDay({ required_wh: 1000, running_w: [3060, 3060, 3060],
    hours: [.25, .25, .25], permitted: [true, false, false] });
  assertEquals(run.expected_w, [3060, 940, 0]);
  assertEquals(run.unserved_wh, 0);
});

Deno.test('partial current hours and fixed future energy are counted exactly once', () => {
  const run = projectBoilerDay({ required_wh: 1500, running_w: [3000, 3000, 3000],
    hours: [.1, .25, .25], permitted: [true, true, true], committed_w: [560, undefined, 1000] });
  assertEquals(run.expected_w[0], 560);
  assertEquals(run.expected_w[2], 1000);
  assertEquals(run.expected_w[1], 3000);
  assertAlmostEquals(run.unserved_wh, 444);
});

Deno.test('a locked heating prefix seeds completion into the following blocked quarter', () => {
  const run = projectBoilerDay({ required_wh: 1500, running_w: [3000, 3000, 3000],
    hours: [.25, .25, .25], permitted: [true, false, false], committed_w: [3000, undefined, undefined] });
  assertEquals(run.expected_w, [3000, 3000, 0]);
  assertEquals(run.unserved_wh, 0);
});

Deno.test('a run drawing 50 W or more keeps finishing; below 50 W it has finished', () => {
  for (const [watts, next] of [[60, 3000], [50, 3000], [49, 0]]) {
    const run = projectBoilerDay({ required_wh: 1000, running_w: [3000, 3000, 3000],
      hours: [.25, .25, .25], permitted: [true, false, false], committed_w: [watts, undefined, undefined] });
    assertEquals(run.expected_w[1], next);
  }
});
