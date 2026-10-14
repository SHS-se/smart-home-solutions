import { assertEquals } from '@std/assert';
import { hotWaterQuarter } from './hot-water-gate.ts';
const slot = (permitted: boolean) => ({ boiler_expected_w: permitted ? 500 : 0, boiler_permitted: permitted,
  device_commands: { tank: { type: 'permit_inhibit' as const, permitted } } });
Deno.test('water chart represents permission rather than promised heating', () => {
  assertEquals(hotWaterQuarter(slot(true), ['tank']), { state: 'allowed', expectedW: 500 });
  assertEquals(hotWaterQuarter(slot(false), ['tank']), { state: 'blocked', expectedW: 0 });
  assertEquals(hotWaterQuarter({ ...slot(false), device_commands: { tank: { type: 'unavailable', reason: 'Monitoring' } } }, ['tank']).state, 'uncontrolled');
});
