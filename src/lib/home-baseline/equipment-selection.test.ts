import { assertEquals, assertThrows } from '@std/assert';
import { readEquipmentSelection, writeEquipmentSelection } from './equipment-selection.ts';
import type { EquipmentTrial } from './equipment.ts';

Deno.test('selected equipment sizes survive reload, stay scoped to one home/customer and reset explicitly', () => {
  const entries = new Map<string, string>();
  const storage = { getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); }, removeItem: (key: string) => { entries.delete(key); } };
  const ref = { customerId: 'synthetic-customer', homeId: 'synthetic-home' };
  const trial: EquipmentTrial = { solar: { current: { arrayKwp: 5, inverterKw: 4 }, proposed: { arrayKwp: 8, inverterKw: 6 } }, batteryKwh: 20 };
  assertEquals(readEquipmentSelection(storage, ref), null);
  writeEquipmentSelection(storage, ref, trial);
  assertEquals(readEquipmentSelection(storage, ref), trial);
  assertEquals(readEquipmentSelection(storage, { ...ref, homeId: 'other-home' }), null);
  assertEquals(readEquipmentSelection(storage, { ...ref, customerId: 'other-customer' }), null);
  assertEquals(JSON.parse([...entries.values()][0]), trial);
  assertThrows(() => writeEquipmentSelection(storage, ref, { ...trial, batteryKwh: -1 }));
  writeEquipmentSelection(storage, ref, null);
  assertEquals(readEquipmentSelection(storage, ref), null);
  assertEquals(entries.size, 0);
});
