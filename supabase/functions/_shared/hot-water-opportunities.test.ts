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
/** Heat never runs ahead of the water drawn (flat forecast, one full day per service). */
const heatsOnlyDrawn = (w: { expected_w: number[] }, drawW: number, owedAtStartWh = 0) => {
  let heat = 0;
  w.expected_w.forEach((watts, i) => { heat += watts / 4; assert(heat <= owedAtStartWh + drawW * (i + 1) / 4 + 1e-6, `quarter ${i}`); });
  return heat / 1000;
};
Deno.test('one run a day heats only the water already drawn', () => {
  const p = input();
  p.large_load_w[0] = 3000;
  p.import_price[24] = -10;
  const w = scheduleHotWater(p);
  // Prices rise through the day: the run is early, outside the large load and the 06:00 peak,
  // and heats what the night drew, not the day's 6 kWh. The evening's water stays owed.
  assertEquals(permittedAt(w), [15, 16, 17, 18, 19, 20, 21, 22, 23, 36, 47]);
  assertEquals(w.expected_w.slice(15, 17), [3000, 1250]);
  assertAlmostEquals(heatsOnlyDrawn(w, 250), 3);
  assertEquals(w.shortfall_minutes, { '2026-10-14': 0 });
});
Deno.test('when heat gets cheaper through the day the evening run heats the day', () => {
  const p = input(); p.import_price = p.starts.map((_s, i) => (96 - i) / 100);
  const w = scheduleHotWater(p);
  assertEquals(w.expected_w.slice(87, 90), [3000, 3000, 3000]);
  assert(w.permitted[49], 'the 12-hour rule still permits 12:15');
  assertAlmostEquals(heatsOnlyDrawn(w, 250), 6);
});
Deno.test('thermostat idle changes no permission and does not create tank debt', () => {
  const p = input(); p.services[0].control.expected_power_w_by_slot.fill(0); p.services[0].required_kwh = 0;
  const w = scheduleHotWater(p);
  assertEquals(w.permitted.filter(Boolean).length, 11);
  assertEquals(w.expected_w.reduce((s, w) => s + w, 0), 0);
});
Deno.test("today's requirement beyond the rest of its forecast is heat already owed", () => {
  const p = input('2026-10-14T12:00:00Z', 48);
  p.services[0].required_kwh = 4; // 3 kWh of forecast remains, so 1 kWh is owed now.
  const w = scheduleHotWater(p);
  assertEquals(w.expected_w.slice(0, 2), [3000, 1500]);
  heatsOnlyDrawn(w, 250, 1000);
});
Deno.test('midday replans retain elapsed opportunities without duplicate credit', () => {
  const p = input('2026-10-14T12:00:00Z', 48);
  p.services[0].required_kwh = 1; // Five of today's six kWh have already been delivered.
  p.previous_permissions = Array.from({ length: 8 }, (_, i) => new Date(Date.parse('2026-10-14T00:00:00Z') + i * 900000).toISOString());
  p.previous_permissions.push(p.previous_permissions[0]);
  const w = scheduleHotWater(p);
  // The last 30 quota minutes are a run at 14:45; 12:00 keeps 02:00 within 12 hours.
  assertEquals(permittedAt(w), [0, 11, 12]);
  assertEquals(w.permission_starts.length, 11);
});
Deno.test('several days each heat what they draw, and the tank carries across midnight', () => {
  const p = input('2026-10-14T00:00:00Z', 288);
  p.services = [3, 5, 7].map((kwh, day) => ({ ...p.services[0], id: `day:${day}`, required_kwh: kwh,
    earliest_start: p.starts[day * 96], deadline: new Date(Date.parse(p.starts[day * 96]) + 86400000).toISOString() }));
  const w = scheduleHotWater(p);
  let heat = 0, drawn = 0;
  w.expected_w.forEach((watts, i) => { heat += watts / 4; drawn += [3, 5, 7][Math.floor(i / 96)] * 1000 / 96; assert(heat <= drawn + 1e-6); });
  for (let day = 0; day < 3; day++) assert(w.permitted.slice(day * 96, (day + 1) * 96).filter(Boolean).length >= 10);
  assertEquals(longestGap(w) <= WATER_MAX_GAP_MINUTES, true);
});
Deno.test('a run is not started where it would have to finish through a headroom obstruction', () => {
  const p = input(); p.import_price = p.starts.map(() => 1); p.import_price[40] = .1;
  assertEquals(scheduleHotWater(p).expected_w.slice(40, 42), [3000, 3000]);
  p.available_w[41] = 0;
  const w = scheduleHotWater(p);
  // The run starts earlier so that it finishes inside the cheap quarter, before the obstruction.
  assertEquals(w.expected_w.slice(37, 42), [3000, 3000, 3000, 1250, 0]);
  assert(w.expected_w.every((watts, i) => watts <= p.available_w[i]));
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
    assert(w.permitted.filter(Boolean).length >= 10);
    assertEquals(Object.keys(w.shortfall_minutes).length, 1);
  }
});

/** Today's quota is already met and the thermostat idle, so only the 12-hour rule permits. */
const gapOnly = (start: string, count: number) => {
  const p = input(start, count);
  p.services[0].required_kwh = 0; p.services[0].control.expected_power_w_by_slot.fill(0);
  p.previous_permissions = Array.from({ length: 10 }, (_, i) => new Date(Date.parse('2026-10-14T00:00:00Z') + i * 900000).toISOString());
  return p;
};
Deno.test('no more than 12 hours without a permitted quarter, at the cheapest quarter that closes the gap', () => {
  const p = gapOnly('2026-10-14T06:00:00Z', 72);
  p.import_price[26] = -1; p.import_price[40] = -2;
  const w = scheduleHotWater(p);
  // 16:00 is cheaper, but from there the 02:30 to 16:00 gap would be over 12 hours.
  assertEquals(permittedAt(w), [26]);
  assertEquals(longestGap(w) <= WATER_MAX_GAP_MINUTES, true);
});

Deno.test('a gap over a whole day gets the fewest extra quarters', () => {
  const p = input('2026-10-14T00:00:00Z', 192);
  p.services = [0, 1].map(day => ({ ...p.services[0], id: `day:${day}`, required_kwh: 0,
    control: { ...p.services[0].control, expected_power_w_by_slot: p.starts.map(() => 0) },
    earliest_start: p.starts[day * 96], deadline: new Date(Date.parse(p.starts[day * 96]) + 86400000).toISOString() }));
  p.available_w.fill(0, 96);
  for (const i of [120, 132, ...Array.from({ length: 12 }, (_, j) => 180 + j)]) p.available_w[i] = 10000;
  const w = scheduleHotWater(p);
  // 02:30 to 06:00 the next day takes two: 05:30 (06–09 is busy) and 17:45.
  assertEquals(permittedAt(w).filter(i => i >= 10 && i < 120), [22, 71]);
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
  const p = gapOnly('2026-10-14T06:00:00Z', 72);
  p.services[0].required_kwh = 4.5; p.services[0].control.expected_power_w_by_slot.fill(250);
  p.import_price = p.starts.map((_s, i) => (72 - i) / 100); // The daily run is late; the gap quarter is wanted at 14:30.
  assertEquals(permittedAt(scheduleHotWater(p)).filter(i => i < 60), [34]);
  p.available_w[35] = 1000;
  const w = scheduleHotWater(p);
  assertEquals(permittedAt(w).filter(i => i < 60), [32]);
  assert(w.expected_w[35] <= 1000);
});
