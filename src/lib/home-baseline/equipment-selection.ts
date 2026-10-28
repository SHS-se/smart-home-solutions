import { z } from 'zod';
import type { EquipmentTrial } from './equipment.ts';
import type { HomeRef } from './history.ts';

const number = z.number().finite();
const selection = z.object({
  solar: z.object({
    current: z.object({ arrayKwp: number.positive(), inverterKw: number.positive() }).strict(),
    proposed: z.object({ arrayKwp: number.nonnegative(), inverterKw: number.nonnegative() }).strict(),
  }).strict().nullable(),
  batteryKwh: number.nonnegative().nullable(),
}).strict();
const key = (ref: HomeRef) => `shs-equipment-trial-v1:${ref.customerId}:${ref.homeId}`;

/** Persist selected sizes only, scoped to this customer and home. Results and
 * captured household inputs are always recalculated and never stored here. */
export function readEquipmentSelection(storage: Pick<Storage, 'getItem'>, ref: HomeRef): EquipmentTrial | null {
  const saved = storage.getItem(key(ref));
  return saved === null ? null : selection.parse(JSON.parse(saved)) as EquipmentTrial;
}
export function writeEquipmentSelection(storage: Pick<Storage, 'setItem' | 'removeItem'>, ref: HomeRef, value: EquipmentTrial | null): void {
  if (value === null) storage.removeItem(key(ref));
  else storage.setItem(key(ref), JSON.stringify(selection.parse(value)));
}
