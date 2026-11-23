import type { PlannedSlot } from './contracts';

export type ChartInstructionSlot = Pick<PlannedSlot, 'start' | 'device_loads_w'> &
  Partial<Pick<PlannedSlot, 'device_commands' | 'pool_permitted'>>;

/** Pool heating has a dedicated enable instruction instead of a meter command. */
export function hasDeviceInstruction(
  slot: ChartInstructionSlot | undefined,
  key: string,
  poolHeaterKeys: ReadonlySet<string>,
): boolean {
  const command = slot?.device_commands?.[key];
  return Boolean(command && command.type !== 'unavailable') ||
    poolHeaterKeys.has(key) && typeof slot?.pool_permitted === 'boolean';
}
