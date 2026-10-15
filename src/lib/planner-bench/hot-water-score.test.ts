import { assertEquals } from '@std/assert';
import { HOUSEHOLD } from './household.ts';
import { referee } from './referee.ts';
import { scoreQuarters } from './score.ts';
import { TARGETS, plan, quarters, world } from './world.fixture.ts';

/** Only permissions are known: the thermostat and electrical demand are unknown. */
function permissions(start: string, allowance: (day: number) => number) {
  const c = world();
  c.start = start;
  const hot_water = quarters(i => i % 96 < allowance(Math.floor(i / 96))
    ? { kind: 'permit' as const } : { kind: 'inhibit' as const });
  return referee(c, HOUSEHOLD, TARGETS, { ...plan(), hot_water }).series;
}

Deno.test('ten permissions per sample day incur no water penalty regardless of inferred heating debt or thermostat idling', () => {
  const s = permissions('2026-10-05T10:15:00Z', () => 10);
  s.hotWater!.owedKwh = quarters(() => 100);
  assertEquals(s.hotWater!.demandKnown, false);
  assertEquals(scoreQuarters(s).counts.water_opportunities, undefined);
  assertEquals(s.hotWaterW.every(w => w === 0), true);
});

Deno.test('sample-day permission shortfall counts only missing quarters, without borrowing extra permissions from another day', () => {
  const s = permissions('2026-10-05T10:15:00Z', day => day === 0 ? 8 : 12);
  const score = scoreQuarters(s);
  assertEquals(score.counts.water_opportunities, 2);
  const charged = score.quarters.flatMap((q, i) => q.fired.includes('water_opportunities') ? [i] : []);
  assertEquals(charged, [95]); // End of the first 24 hours from the sample start.
  assertEquals(score.quarters[95].deductions.water_opportunities, -2);
  assertEquals(scoreQuarters(s, { water_opportunities: { points: -2 } }).quarters[95].deductions.water_opportunities, -4);
  assertEquals(scoreQuarters(s, { water_opportunities: { enabled: false } }).counts.water_opportunities, undefined);
  assertEquals(scoreQuarters(s, { water_opportunities: { threshold: 8 } }).counts.water_opportunities, undefined);
});

Deno.test('finish-heating overrides do not replace the plan’s daily permission requirement', () => {
  const s = permissions('2026-10-05T10:15:00Z', () => 8);
  s.hotWater!.permitted.fill(1);
  assertEquals(scoreQuarters(s).counts.water_opportunities, 6); // Three sample days, two missing each.
  s.hotWater!.command.fill('free');
  assertEquals(scoreQuarters(s).counts.water_opportunities, undefined);
});

Deno.test('midday starts and daylight-saving changes still assess exactly three 24-hour periods', () => {
  for (const start of ['2026-10-05T10:15:00Z', '2026-03-28T23:00:00Z', '2026-10-24T22:00:00Z']) {
    const s = permissions(start, () => 10);
    assertEquals(scoreQuarters(s).counts.water_opportunities, undefined);
    const blocked = permissions(start, () => 0);
    const scored = scoreQuarters(blocked);
    assertEquals(scored.counts.water_opportunities, 30);
    assertEquals(scored.quarters.flatMap((q, i) => q.fired.includes('water_opportunities') ? [i] : []), [95, 191, 287]);
  }
});
