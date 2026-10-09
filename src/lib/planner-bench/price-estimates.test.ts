import { assertAlmostEquals, assertEquals } from '@std/assert';
import {
  actualsByDay, chartDays, DAY_QUARTERS, priceEstimates, summariseEstimates, type ActualDayRow, type EstimateDayRow,
} from './price-estimates.ts';

const HOME = 'home';
const flat = (value: number | null, from = 0, to = DAY_QUARTERS) =>
  Array.from({ length: DAY_QUARTERS }, (_, i) => i >= from && i < to ? value : null);
const estimate = (issued_on: string, target_day: string, quarters: (number | null)[], basis = 'wind'): EstimateDayRow => ({
  home_id: HOME, home_name: 'Home', issued_on, issued_at: `${issued_on}T10:00:00Z`, target_day, basis, timezone: 'Europe/Stockholm', quarters,
});
const actual = (day: string, quarters: (number | null)[]): ActualDayRow => ({ home_id: HOME, day, quarters });

Deno.test('a day\'s level error is the gap between its means and its quarter error the mean gap per quarter', () => {
  // Estimated flat at 2; the day was 1 for its first half and 2 for its second.
  const real = Array.from({ length: DAY_QUARTERS }, (_, i) => i < 48 ? 1 : 2);
  const [made] = priceEstimates({ estimates: [estimate('2026-10-01', '2026-10-03', flat(2))], actuals: [actual('2026-10-03', real)] });
  const [day] = made.days;
  assertEquals([made.issuedOn, day.day, day.leadDays, day.quarters], ['2026-10-01', '2026-10-03', 2, 96]);
  assertEquals([day.believed, day.was], [2, 1.5]);
  assertAlmostEquals(day.levelError!, 0.5);
  assertAlmostEquals(day.quarterError!, 0.5);
  // Too high in one half and as far too low in the other: the level is right, the quarters are not.
  const [shape] = priceEstimates({ estimates: [estimate('2026-10-01', '2026-10-03', flat(1.5))], actuals: [actual('2026-10-03', real)] });
  assertAlmostEquals(shape.days[0].levelError!, 0);
  assertAlmostEquals(shape.days[0].quarterError!, 0.5);
});

Deno.test('a day waits until every estimated quarter is published, and only those quarters are compared', () => {
  const partly = flat(1, 0, 40);
  const waiting = priceEstimates({ estimates: [estimate('2026-10-01', '2026-10-02', flat(2))], actuals: [actual('2026-10-02', partly)] })[0].days[0];
  assertEquals([waiting.was, waiting.levelError, waiting.quarterError], [null, null, null]);
  assertEquals(priceEstimates({ estimates: [estimate('2026-10-01', '2026-10-02', flat(2))], actuals: [] })[0].days[0].was, null);
  // The plan's last day is estimated in part: the real mean is taken over the same quarters.
  const real = Array.from({ length: DAY_QUARTERS }, (_, i) => i < 24 ? 1 : 9);
  const last = priceEstimates({ estimates: [estimate('2026-10-01', '2026-10-04', flat(2, 0, 24))], actuals: [actual('2026-10-04', real)] })[0].days[0];
  assertEquals([last.quarters, last.was, last.levelError], [24, 1, 1]);
  // A row without a single estimated quarter is no estimate.
  assertEquals(priceEstimates({ estimates: [estimate('2026-10-01', '2026-10-02', flat(null))], actuals: [] }), []);
});

Deno.test('estimates group by the day they were made and summarise by days ahead and basis', () => {
  const data = {
    estimates: [
      estimate('2026-10-02', '2026-10-04', flat(2.1)), estimate('2026-10-01', '2026-10-03', flat(1.2)),
      estimate('2026-10-01', '2026-10-02', flat(1), 'recent_norm'), estimate('2026-10-03', '2026-10-05', flat(1.5)),
      estimate('2026-10-02', '2026-10-05', flat(9, 0, 24)),
    ],
    actuals: [actual('2026-10-02', flat(2)), actual('2026-10-03', flat(1.6)), actual('2026-10-04', flat(1.9)), actual('2026-10-05', flat(5, 0, 24))],
  };
  const made = priceEstimates(data);
  assertEquals(made.map(e => [e.issuedOn, e.days.map(d => d.day)]), [
    ['2026-10-01', ['2026-10-02', '2026-10-03']], ['2026-10-02', ['2026-10-04', '2026-10-05']], ['2026-10-03', ['2026-10-05']],
  ]);
  const summary = summariseEstimates(made);
  // Two days ahead on wind: +0.2 and −0.4. The part-day and the unpublished day are left out.
  assertEquals(summary.map(row => [row.lead, row.basis, row.days]), [[1, 'recent_norm', 1], [2, 'wind', 2]]);
  assertAlmostEquals(summary[1].levelError, 0.3);
  assertAlmostEquals(summary[1].bias, -0.1);
  assertAlmostEquals(summary[1].quarterError, 0.3);
  assertAlmostEquals(summary[0].bias, -1);
});

Deno.test('the chart runs from the day the estimate was made to the last day it estimated', () => {
  const data = {
    estimates: [estimate('2026-10-01', '2026-10-03', flat(2)), estimate('2026-10-01', '2026-10-04', flat(2, 0, 30))],
    actuals: [actual('2026-10-01', flat(1)), actual('2026-10-03', flat(1.5))],
  };
  const days = chartDays(priceEstimates(data)[0], actualsByDay(data.actuals));
  assertEquals(days.map(d => [d.day, d.estimated?.leadDays ?? null, d.actual[0]]), [
    ['2026-10-01', null, 1], ['2026-10-02', null, null], ['2026-10-03', 2, 1.5], ['2026-10-04', 3, null],
  ]);
});
