import { assertEquals } from 'jsr:@std/assert@1';
import { validInputAccuracy } from './input-accuracy.ts';

Deno.test('input accuracy is a bounded share per known check and anything else is dropped', () => {
  const check = {key: 'sensors', percentage: 98, grade: 'green', healthy: 63, expected: 64, issues: ['sensor.kitchen_heater_power']};
  const prices = {key: 'prices', percentage: 100, grade: 'green', healthy: 56, expected: 56, issues: [],
    published_until: '2026-10-18T21:45:00+00:00', first_missing: null};
  const value = {version: 1, observed_at: '2026-10-18T08:00:00+00:00', percentage: 99, grade: 'green', checks: [prices, check]};
  assertEquals(validInputAccuracy(value), true);
  assertEquals(validInputAccuracy({...value, percentage: null, grade: null, checks: []}), true);
  for (const bad of [{...value, version: 2}, {...value, percentage: 101}, {...value, checks: [check, check]},
    {...value, checks: [{...check, key: 'forecast'}]}, {...value, checks: [{...check, healthy: 65}]},
    {...value, checks: [{...check, issues: Array(11).fill('sensor.x')}]}, {...value, observed_at: 'yesterday'}, null])
    assertEquals(validInputAccuracy(bad), false);
});
