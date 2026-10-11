import { assert, assertEquals, assertThrows } from '@std/assert';
import { energyChartTicks } from './energy-chart-axis';
import { homeHourMinute } from './home-time';

const rows = (start: string, count: number) => Array.from({ length: count }, (_, i) => ({ startMs: Date.parse(start) + i * 900_000 }));

Deno.test('72-hour chart retains six-hour ticks in the home timezone', () => {
  const data = rows('2026-10-07T22:00:00Z', 288);
  const { hourTicks, dayTicks } = energyChartTicks(data, 'Europe/Stockholm');
  assertEquals(hourTicks.map(tick => tick.index), Array.from({ length: 12 }, (_, i) => i * 24));
  assertEquals(dayTicks.map(tick => tick.index), [96, 192]);
});

Deno.test('calendar month axis spaces local dates across DST and respects label configuration', () => {
  // October in Stockholm includes the autumn clock change: 31 days plus an hour.
  const data = rows('2026-09-30T22:00:00Z', 2980);
  for (const limit of [8, 16]) {
    const { hourTicks, dayTicks } = energyChartTicks(data, 'Europe/Stockholm', limit);
    assertEquals(hourTicks, []);
    assert(dayTicks.length <= limit);
    assert(dayTicks.at(-1)!.index > 27 * 96);
    dayTicks.forEach(tick => assertEquals(homeHourMinute(tick.date, 'Europe/Stockholm'), { hour: 0, minute: 0 }));
  }
  assertEquals(energyChartTicks([], 'Europe/Stockholm'), { hourTicks: [], dayTicks: [] });
  assertThrows(() => energyChartTicks(data, 'Europe/Stockholm', 0));
});
