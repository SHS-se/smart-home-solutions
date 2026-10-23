import { assertEquals, assertThrows } from '@std/assert';
import { deviceColour, ownerColour, parseDeviceColours } from './device-colours.ts';

const devices = [{ device_key: 'pool', colour: '#c43c54' }, { device_key: 'guest', colour: '#007f86' }];
Deno.test('saved device colours survive order, activity and configuration changes', () => {
  const catalogue = parseDeviceColours(devices);
  assertEquals(deviceColour(catalogue, 'pool'), '#c43c54');
  assertEquals(deviceColour([...catalogue].reverse(), 'pool'), '#c43c54');
  assertEquals(ownerColour(catalogue, ['pool'], '#475569'), '#c43c54');
  assertEquals(ownerColour(catalogue, ['pool', 'guest'], '#475569'), '#475569');
});
Deno.test('missing, malformed and duplicate colour assignments fail at the boundary', () => {
  assertThrows(() => parseDeviceColours([{ device_key: 'pool', colour: '' }]));
  assertThrows(() => parseDeviceColours([...devices, { device_key: 'third', colour: '#c43c54' }]));
  assertThrows(() => parseDeviceColours([...devices, { device_key: 'pool', colour: '#123456' }]));
  assertThrows(() => deviceColour(devices, 'unknown'), Error, 'missing from the catalogue');
});
