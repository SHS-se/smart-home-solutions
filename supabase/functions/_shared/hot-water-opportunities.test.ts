import { assertEquals, assertAlmostEquals, assert } from '@std/assert';
import { scheduleHotWater } from './hot-water-opportunities.ts';
const input = (start = '2026-10-14T00:00:00Z', count = 96) => {
  const starts = Array.from({ length: count }, (_, i) => new Date(Date.parse(start) + i * 900000).toISOString());
  return { starts, timezone: 'UTC', hours: starts.map(() => .25),
    services: [{ id: 'water', device: 'boiler' as const, priority: 1, required_kwh: 6, earliest_start: starts[0], deadline: new Date(Date.parse(starts.at(-1)!) + 900000).toISOString(),
      control: { type: 'duty_cycle' as const, rated_power_w: 3000, expected_power_w_by_slot: starts.map(() => 250) } }],
    other_house_w: starts.map(() => 500), import_price: starts.map((_s, i) => i / 100), export_price: starts.map(() => .1),
    solar_w: starts.map(() => 0), large_load_w: starts.map(() => 0), available_w: starts.map(() => 10000), locked: [], previous_permissions: [] };
};
Deno.test('ten quarters per day, price ordered without peaks or chosen large loads', () => {
  const p = input();
  p.large_load_w[0] = 3000;
  p.import_price[24] = -10;
  const w = scheduleHotWater(p);
  assertEquals(w.permitted.filter(Boolean).length, 10);
  assert(!w.permitted[0] && !w.permitted[24]);
  assertEquals(w.shortfall_minutes, { '2026-10-14': 0 });
  assertAlmostEquals(w.expected_w.reduce((s, w) => s + w / 4000, 0), 6);
});
Deno.test('thermostat idle changes no permission and does not create tank debt', () => {
  const p = input(); p.services[0].control.expected_power_w_by_slot.fill(0);
  const w = scheduleHotWater(p);
  assertEquals(w.permitted.filter(Boolean).length, 10);
  assertEquals(w.expected_w.reduce((s, w) => s + w, 0), 0);
});
Deno.test('midday replans retain elapsed opportunities without duplicate credit', () => {
  const p = input('2026-10-14T12:00:00Z', 48);
  p.previous_permissions = Array.from({ length: 8 }, (_, i) => new Date(Date.parse('2026-10-14T00:00:00Z') + i * 900000).toISOString());
  p.previous_permissions.push(p.previous_permissions[0]);
  const w = scheduleHotWater(p);
  assertEquals(w.permitted.filter(Boolean).length, 2);
  assertEquals(w.permission_starts.length, 10);
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
    assertEquals(w.permitted.filter(Boolean).length, 10);
    assertEquals(Object.keys(w.shortfall_minutes).length, 1);
  }
});
