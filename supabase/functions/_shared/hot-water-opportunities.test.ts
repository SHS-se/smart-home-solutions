import { assertEquals, assertAlmostEquals, assert } from '@std/assert';
import { scheduleHotWater, WATER_MAX_GAP_MINUTES } from './hot-water-opportunities.ts';
const input = (start = '2026-10-14T00:00:00Z', count = 96) => {
  const starts = Array.from({ length: count }, (_, i) => new Date(Date.parse(start) + i * 900000).toISOString());
  return { starts, timezone: 'UTC', hours: starts.map(() => .25),
    services: [{ id: 'water', device: 'boiler' as const, priority: 1, required_kwh: 6, earliest_start: starts[0], deadline: new Date(Date.parse(starts.at(-1)!) + 900000).toISOString(),
      control: { type: 'duty_cycle' as const, rated_power_w: 3000, expected_power_w_by_slot: starts.map(() => 250) } }],
    other_house_w: starts.map(() => 500), import_price: starts.map((_s, i) => i / 100), export_price: starts.map(() => .1),
    solar_w: starts.map(() => 0), large_load_w: starts.map(() => 0), available_w: starts.map(() => 10000), locked: [], previous_permissions: [] as string[] };
};
const permittedAt = (w: { permitted: boolean[] }) => w.permitted.flatMap((p, i) => p ? [i] : []);
/** The longest stretch, in minutes, between the end of one permitted quarter and the start of the next. */
const longestGap = (w: { permitted: boolean[] }, from = 0) => {
  const at = [from - 1, ...permittedAt(w), w.permitted.length];
  return Math.max(...at.slice(1).map((i, j) => (i - at[j] - 1) * 15));
};
Deno.test('ten quarters per day, price ordered without peaks or chosen large loads', () => {
  const p = input();
  p.large_load_w[0] = 3000;
  p.import_price[24] = -10;
  const w = scheduleHotWater(p);
  // Ten quota quarters, then 11:45 so the night is no more than 12 hours unpermitted.
  assertEquals(permittedAt(w), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 47]);
  assert(!w.permitted[0] && !w.permitted[24]);
  assertEquals(w.shortfall_minutes, { '2026-10-14': 0 });
  assertAlmostEquals(w.expected_w.reduce((s, w) => s + w / 4000, 0), 6);
});
Deno.test('thermostat idle changes no permission and does not create tank debt', () => {
  const p = input(); p.services[0].control.expected_power_w_by_slot.fill(0); p.services[0].required_kwh = 0;
  const w = scheduleHotWater(p);
  assertEquals(w.permitted.filter(Boolean).length, 11);
  assertEquals(w.expected_w.reduce((s, w) => s + w, 0), 0);
});
Deno.test('midday replans retain elapsed opportunities without duplicate credit', () => {
  const p = input('2026-10-14T12:00:00Z', 48);
  p.services[0].required_kwh = 1; // Five of today's six kWh have already been delivered.
  p.previous_permissions = Array.from({ length: 8 }, (_, i) => new Date(Date.parse('2026-10-14T00:00:00Z') + i * 900000).toISOString());
  p.previous_permissions.push(p.previous_permissions[0]);
  const w = scheduleHotWater(p);
  assertEquals(w.permitted.filter(Boolean).length, 2);
  assertEquals(w.permission_starts.length, 10);
});

Deno.test('daily requirements produce concentrated measured-power runs, independent of allowance length', () => {
  const p = input('2026-10-14T00:00:00Z', 288);
  p.services = [3, 5, 7].map((kwh, day) => ({ ...p.services[0], id: `day:${day}`, required_kwh: kwh,
    earliest_start: p.starts[day * 96], deadline: new Date(Date.parse(p.starts[day * 96]) + 86400000).toISOString() }));
  const result = scheduleHotWater(p);
  for (let day = 0; day < 3; day++) {
    const watts = result.expected_w.slice(day * 96, (day + 1) * 96);
    assertAlmostEquals(watts.reduce((sum, w) => sum + w / 4000, 0), [3, 5, 7][day]);
    assertEquals(watts.filter(w => w === 3000).length, [4, 6, 9][day]);
    assertEquals(result.permitted.slice(day * 96, (day + 1) * 96).filter(Boolean).length, 11);
  }
});

Deno.test('a run never starts before a headroom obstruction it could not finish through', () => {
  const p = input(); p.available_w[3] = 1000;
  const result = scheduleHotWater(p);
  assertEquals(result.expected_w.slice(0, 4), [0, 0, 0, 0]);
  assertAlmostEquals(result.expected_w.reduce((sum, w) => sum + w / 4000, 0), 6);
});

Deno.test('unused permission opportunities may be scattered after the heating run completes', () => {
  const p = input(); p.services[0].required_kwh = 3;
  p.available_w.fill(0);
  for (const i of [0, 1, 2, 3, 8, 9, 10, 11, 12, 13]) p.available_w[i] = 10000;
  const result = scheduleHotWater(p);
  assertEquals(result.expected_w.slice(0, 4), [3000, 3000, 3000, 3000]);
  assertEquals(result.expected_w.slice(4).every(w => w === 0), true);
  assertEquals(result.permitted.filter(Boolean).length, 10);
  assertEquals(result.shortfall_minutes['2026-10-14'], 0);
});
Deno.test('equipment headroom shortfall is explicit, not fabricated permission', () => {
  const p = input(); p.available_w.fill(2000);
  const w = scheduleHotWater(p);
  assertEquals(w.permitted.filter(Boolean).length, 0);
  assertEquals(w.shortfall_minutes['2026-10-14'], 150);
});
Deno.test('DST local days still get 150 permission minutes', () => {
  for (const [start, count] of [['2026-03-28T23:00:00Z', 92], ['2026-10-24T22:00:00Z', 100]] as const) {
    const p = { ...input(start, count), timezone: 'Europe/Stockholm' };
    const w = scheduleHotWater(p);
    assertEquals(w.permitted.filter(Boolean).length, 11);
    assertEquals(Object.keys(w.shortfall_minutes).length, 1);
  }
});

Deno.test('no more than 12 hours without a permitted quarter, at the cheapest quarter that closes the gap', () => {
  const p = input(); p.services[0].required_kwh = 7.5; // The run fills the quota: 00:00 to 02:30.
  p.import_price[50] = -1; p.import_price[60] = -2;
  const w = scheduleHotWater(p);
  // 15:00 is cheaper, but from there the 02:30 to 15:00 gap would be over 12 hours.
  assertEquals(permittedAt(w), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 50]);
  assertEquals(longestGap(w) <= WATER_MAX_GAP_MINUTES, true);
});

Deno.test('a gap over a whole day gets the fewest extra quarters', () => {
  const p = input('2026-10-14T00:00:00Z', 192);
  p.services = [7.5, 0].map((kwh, day) => ({ ...p.services[0], id: `day:${day}`, required_kwh: kwh,
    earliest_start: p.starts[day * 96], deadline: new Date(Date.parse(p.starts[day * 96]) + 86400000).toISOString() }));
  p.available_w.fill(0, 96);
  for (const i of [120, 132, ...Array.from({ length: 12 }, (_, j) => 180 + j)]) p.available_w[i] = 10000;
  const w = scheduleHotWater(p);
  // 02:30 to 21:00 the next day takes three: 09:00 (06–09 is busy), 21:00 (18–21 is busy) and 09:00.
  assertEquals(permittedAt(w).filter(i => i >= 10 && i < 180), [36, 84, 132]);
  assertEquals(longestGap(w) <= WATER_MAX_GAP_MINUTES, true);
});

Deno.test('the gap is counted from the latest permission before midnight', () => {
  const p = input('2026-10-14T06:00:00Z', 72);
  p.import_price = p.starts.map((_s, i) => (72 - i) / 100); // The daily run lands in the evening.
  p.previous_permissions = ['2026-10-13T21:45:00Z', '2026-10-13T22:00:00Z', '2026-10-13T08:00:00Z'];
  const w = scheduleHotWater(p);
  const extra = permittedAt(w).filter(i => p.starts[i] < '2026-10-14T18:00:00Z');
  assertEquals(extra.length, 1);
  assert(p.starts[extra[0]] <= '2026-10-14T10:15:00Z', p.starts[extra[0]]);
  // Yesterday's last 12 hours and the latest permission stay in the ledger; older ones go.
  assert(w.permission_starts.includes('2026-10-13T22:00:00Z') && w.permission_starts.includes('2026-10-13T21:45:00Z'));
  assert(!w.permission_starts.includes('2026-10-13T08:00:00Z'));
});

Deno.test('an overdue gap is closed at the first eligible quarter', () => {
  const p = input('2026-10-14T06:00:00Z', 72);
  p.import_price = p.starts.map((_s, i) => (72 - i) / 100);
  p.previous_permissions = ['2026-10-13T12:00:00Z'];
  p.available_w[0] = 1000;
  const w = scheduleHotWater(p);
  assert(!w.permitted[0] && w.permitted[1]);
  assert(w.permission_starts.includes('2026-10-13T12:00:00Z'));
});

Deno.test('a gap quarter is skipped where the run it starts could not finish within headroom', () => {
  const p = input();
  p.import_price = p.starts.map((_s, i) => (96 - i) / 100); // Daily run late; the gap quarter is wanted at 12:00.
  p.available_w[50] = 1000;
  const w = scheduleHotWater(p);
  const extra = permittedAt(w).filter(i => i < 80);
  assertEquals(extra, [42]);
  assertEquals(w.expected_w[50], 0);
});
