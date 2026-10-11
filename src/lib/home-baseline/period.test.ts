import { assert, assertEquals } from '@std/assert';
import { baselineFixture } from './fixture';
import { historyWindows, latestPeriod, stepPeriod, switchPeriodView, type BaselineAnchor } from './period';

const anchor = (end: string): BaselineAnchor => ({ snapshot: baselineFixture().snapshot, latestEnd: end });

for (const [end, start, quarters] of [
  ['2026-04-01T00:00:00Z', '2026-02-28T23:00:00.000Z', 2972],
  ['2026-11-01T00:00:00Z', '2026-09-30T22:00:00.000Z', 2980],
  ['2028-03-01T00:00:00Z', '2028-01-31T23:00:00.000Z', 2784],
] as const) {
  Deno.test(`home calendar month before ${end} contains ${quarters} contiguous quarters`, () => {
    const a = anchor(end), current = latestPeriod(a, 'month'), previous = stepPeriod(a, current, -1)!;
    assertEquals(previous.start, start);
    assertEquals((Date.parse(previous.end) - Date.parse(previous.start)) / 900_000, quarters);
    assertEquals(previous.end, current.start);
    assertEquals(stepPeriod(a, previous, 1), current);
    const windows = historyWindows(previous);
    assertEquals(windows[0].start, previous.start);
    assertEquals(windows.at(-1)!.end, previous.end);
    assertEquals(windows.reduce((sum, w) => sum + w.count, 0), quarters);
    windows.forEach((w, i) => {
      assert(w.count <= 672);
      assertEquals((Date.parse(w.end) - Date.parse(w.start)) / 900_000, w.count);
      if (i) assertEquals(windows[i - 1].end, w.start);
    });
  });
}

Deno.test('month to date is clipped to recorded end and view switches use the selected period', () => {
  const a = anchor('2026-10-11T08:15:00.000Z');
  const current = latestPeriod(a, 'month');
  assertEquals(current.start, '2026-09-30T22:00:00.000Z');
  assertEquals(current.end, a.latestEnd);
  assertEquals(stepPeriod(a, current, 1), null);
  const frame = switchPeriodView(a, current, 'frame');
  assertEquals(Date.parse(frame.end) - Date.parse(frame.start), 72 * 3_600_000);
  assertEquals(switchPeriodView(a, frame, 'month'), current);
});

Deno.test('recorded end exactly at month boundary selects the completed month', () => {
  const a = anchor('2026-09-30T22:00:00.000Z');
  const month = latestPeriod(a, 'month');
  assertEquals(month.start, '2026-08-31T22:00:00.000Z');
  assertEquals(month.end, a.latestEnd);
  assertEquals(stepPeriod(a, month, 1), null);
});
