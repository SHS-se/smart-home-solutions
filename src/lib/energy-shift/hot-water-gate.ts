/** Planned permission, distinct from actual thermostat demand or a finishing run. */
import type { PlannedSlot } from './contracts';
export type HotWaterState = 'allowed' | 'blocked' | 'uncontrolled';
export interface HotWaterQuarter { state: HotWaterState; expectedW: number; owedKwh?: number }
export function refereedHotWaterQuarter(water: {
  command: readonly ('free' | 'inhibit' | 'permit')[]; owedKwh: readonly number[];
}, i: number, expectedW: number): HotWaterQuarter {
  return { state: water.command[i] === 'free' ? 'uncontrolled' : water.command[i] === 'permit' ? 'allowed' : 'blocked',
    expectedW, owedKwh: water.owedKwh[i] };
}
export function hotWaterQuarter(slot: Pick<PlannedSlot, 'boiler_expected_w' | 'boiler_permitted' | 'device_commands'>, hotWaterKeys: readonly string[]): HotWaterQuarter {
  const commands = hotWaterKeys.flatMap(key => slot.device_commands?.[key] ?? []);
  const permits = commands.flatMap(command => command.type === 'permit_inhibit' ? [command.permitted] : []);
  const permitted = permits.length ? permits.every(Boolean) : commands.length ? null : slot.boiler_permitted;
  return { state: permitted === null ? 'uncontrolled' : permitted ? 'allowed' : 'blocked', expectedW: slot.boiler_expected_w };
}
