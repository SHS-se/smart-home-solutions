import { assertEquals } from '@std/assert';
import { localDay } from '../../../supabase/functions/_shared/planner-wasm/calendar.ts';
import { HOUSEHOLD } from './household.ts';
import { referee } from './referee.ts';
import { scoreQuarters } from './score.ts';
import { TARGETS, plan, quarters, world } from './world.fixture.ts';

/** Only permissions are known: the thermostat and electrical demand are unknown. */
function permissions(start: string, allowance: (day: number) => number) {
  const c = world();
  c.start = start;
  const dates: string[] = [];
  const seen = new Map<string, number>();
  const hot_water = quarters(i => {
    const date = localDay(new Date(Date.parse(start) + i * 900_000).toISOString(), c.timezone);
    if (!dates.includes(date)) dates.push(date);
    const slot = seen.get(date) ?? 0;
    seen.set(date, slot + 1);
    return slot < allowance(dates.indexOf(date)) ? { kind: 'permit' as const } : { kind: 'inhibit' as const };
  });
  return referee(c, HOUSEHOLD, TARGETS, { ...plan(), hot_water }).series;
}

Deno.test('ten permissions per local day incur no water penalty regardless of inferred heating debt or thermostat idling', () => {
  const s = permissions('2026-10-05T10:15:00Z', () => 10);
  s.hotWater!.owedKwh = quarters(() => 100);
  assertEquals(s.hotWater!.demandKnown, false);
  assertEquals(scoreQuarters(s).counts.water_opportunities, undefined);
  assertEquals(s.hotWaterW.every(w => w === 0), true);
});

Deno.test('daily permission shortfall counts only missing quarters, without borrowing extra permissions from another day', () => {
  const s = permissions('2026-10-05T10:15:00Z', day => day === 0 ? 8 : 12);
  const score = scoreQuarters(s);
  assertEquals(score.counts.water_opportunities, 2);
  const charged = score.quarters.flatMap((q, i) => q.fired.includes('water_opportunities') ? [i] : []);
  assertEquals(charged, [46]); // Last quarter before Stockholm midnight.
  assertEquals(score.quarters[46].deductions.water_opportunities, -2);
  assertEquals(scoreQuarters(s, { water_opportunities: { points: -2 } }).quarters[46].deductions.water_opportunities, -4);
  assertEquals(scoreQuarters(s, { water_opportunities: { enabled: false } }).counts.water_opportunities, undefined);
  assertEquals(scoreQuarters(s, { water_opportunities: { threshold: 8 } }).counts.water_opportunities, undefined);
});

Deno.test('finish-heating overrides do not replace the plan’s daily permission requirement', () => {
  const s = permissions('2026-10-05T10:15:00Z', () => 8);
  s.hotWater!.permitted.fill(1);
  assertEquals(scoreQuarters(s).counts.water_opportunities, 8); // Four local dates, two missing each.
  s.hotWater!.command.fill('free');
  assertEquals(scoreQuarters(s).counts.water_opportunities, undefined);
});

Deno.test('spring and autumn daylight-saving days use local dates and partial horizon days keep their own quota', () => {
  for (const start of ['2026-03-28T23:00:00Z', '2026-10-24T22:00:00Z']) {
    const s = permissions(start, () => 10);
    const grouped = new Map<string, number[]>();
    s.start.forEach((start, i) => {
      const day = localDay(start, s.hotWater!.timeZone);
      grouped.set(day, [...grouped.get(day) ?? [], i]);
    });
    const days = [...grouped.values()];
    assertEquals(days[0].length, start.includes('03-28') ? 92 : 100);
    // Spring's final partial date contains only four possible quarters.
    assertEquals(scoreQuarters(s).counts.water_opportunities, start.includes('03-28') ? 6 : undefined);
  }
});
