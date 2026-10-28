import type { NativeCommand } from './ready-problem.ts';

/** Forced purchases/sales commit the native allocation; automatic modes keep their ceilings. */
export function allocatedBatteryCommand(
  command: NativeCommand,
  quarter: { charge_w: number; discharge_w: number },
): NativeCommand {
  if (command.battery !== 'grid_charge' && command.battery !== 'export') return command;
  return { ...command,
    battery: quarter.charge_w === 0 && quarter.discharge_w === 0 ? 'idle' : command.battery,
    // Native scoring already quantized the feasible request. Saturation can
    // leave a fractional physical flow; it is not another command to floor.
    charge_limit_w: command.battery === 'grid_charge' ? command.charge_limit_w : 0,
    discharge_limit_w: command.battery === 'export' ? command.discharge_limit_w : 0 };
}
