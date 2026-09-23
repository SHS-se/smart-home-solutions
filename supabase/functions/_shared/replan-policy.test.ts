import { assertEquals } from 'jsr:@std/assert@1';
import { mixedModeSnapshot } from '../../../scripts/generate-ha-plan-fixture.ts';
import { generateOptimisationPlan } from './energy-optimisation.ts';
import { hasNewPublishedPrices, deviationRecommendations, recoveredMeasurementRecommendations } from './replan-policy.ts';
import { isolateMeasurements } from './measurement-isolation.ts';

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

Deno.test('a device left out for its readings recommends a replan once they are valid again', () => {
  const broken = mixedModeSnapshot();
  broken.pool = { ...broken.pool!, water_temperature_c: 500 };
  const plan = generateOptimisationPlan(broken, new Date(broken.captured_at));
  assertEquals(plan.capabilities.pool, false);
  // Still impossible: nothing to recommend, and no deviation warning either.
  assertEquals(recoveredMeasurementRecommendations(plan, isolateMeasurements(broken)), []);
  const later = structuredClone(broken);
  later.captured_at = new Date(Date.parse(broken.captured_at) + 900_000).toISOString();
  later.pool!.water_temperature_c = 26.4;
  assertEquals(recoveredMeasurementRecommendations(plan, isolateMeasurements(later)), [{
    key: 'measurement_recovered_pool',
    reason: "The pool's readings are valid again, but the current plan leaves it out. Replan to include it.",
    occurred_at: later.captured_at,
  }]);
  // A plan that already includes the device has nothing to recover.
  const whole = generateOptimisationPlan(mixedModeSnapshot(), new Date(later.captured_at));
  assertEquals(recoveredMeasurementRecommendations(whole, isolateMeasurements(later)), []);
});

Deno.test('an impossible pack reading raises no stored-energy warning', () => {
  const s = mixedModeSnapshot(), plan = generateOptimisationPlan(s, new Date(s.captured_at));
  const impossible = structuredClone(s);
  impossible.battery!.soc = 1.4;
  const now = new Date(s.captured_at);
  assertEquals(deviationRecommendations(plan, [], impossible, now).map(r => r.key), ['battery_energy']);
  assertEquals(deviationRecommendations(plan, [], isolateMeasurements(impossible), now), []);
});
