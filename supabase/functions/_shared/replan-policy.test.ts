import { assertEquals } from 'jsr:@std/assert@1';
import { mixedModeSnapshot } from '../../../scripts/generate-ha-plan-fixture.ts';
import { generateOptimisationPlan } from './energy-optimisation.ts';
import { hasNewPublishedPrices, deviationRecommendations } from './replan-policy.ts';

Deno.test('quarter exchange and changed measurements preserve plan until a price publication', () => {
  const before = mixedModeSnapshot(), next = structuredClone(before);
  next.slots.shift(); next.battery.soc -= .1;
  assertEquals(hasNewPublishedPrices(before, next), false);
  next.slots[0].import_price_sek_per_kwh! += .1;
  assertEquals(hasNewPublishedPrices(before, next), true);
  const later = structuredClone(before);
  const last = later.slots.filter(s => s.import_price_sek_per_kwh !== null).at(-1)!;
  const index = later.slots.indexOf(last) + 1;
  if (later.slots[index]) {
    later.slots[index].import_price_sek_per_kwh = 2;
    later.slots[index].export_price_sek_per_kwh = 1;
  } else later.slots.push({...last, start: new Date(Date.parse(last.start) + 900000).toISOString()});
  assertEquals(hasNewPublishedPrices(before, later), true);
  const missing = structuredClone(before);
  missing.slots.forEach(s => {s.import_price_sek_per_kwh = null; s.export_price_sek_per_kwh = null;});
  assertEquals(hasNewPublishedPrices(before, missing), false);
});

Deno.test('recommendations use four complete contiguous quarters and rolling signed energy difference', () => {
  const s = mixedModeSnapshot(), plan = generateOptimisationPlan(s, new Date(s.captured_at));
  const slots = plan.plans.priority.slots.slice(1, 5);
  slots.forEach(s => s.load_w = 4000); // one kWh in each quarter
  const now = new Date(Date.parse(slots[3].start) + 900000);
  const actual = slots.map(s => ({start_ts: s.start, total_load_kwh: 3}));
  const keys = (rows = actual) => deviationRecommendations(plan, rows, null, now).map(r => r.key);
  assertEquals(keys(), ['household_relative', 'household_energy']);
  assertEquals(keys(actual.slice(1)), []);
  actual.forEach(r => r.total_load_kwh = 2.5); // exactly six is not more than six
  assertEquals(keys(), ['household_relative']);
  actual[0].total_load_kwh = 1;
  assertEquals(keys(), []);
});

Deno.test('pack warning compares energy at the captured time, independent of mode', () => {
  const s = mixedModeSnapshot(), plan = generateOptimisationPlan(s, new Date(s.captured_at));
  const index = 4;
  s.captured_at = plan.plans.priority.slots[index].start;
  s.battery.soc = plan.plans.priority.slots[index - 1].battery_soc - 4.1 / s.battery.capacity_kwh;
  assertEquals(deviationRecommendations(plan, [], s, new Date(s.captured_at)).map(r => r.key), ['battery_energy']);
});
