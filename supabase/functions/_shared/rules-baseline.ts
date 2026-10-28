import type { createWasmPlanner, NativeQuarter, ProjectionOutcome } from "./planner-wasm/core.ts";
import type { NativeCommand, ReadyProblem } from "./planner-wasm/ready-problem.ts";
import { projectLoadBalancedEv } from "./planner-wasm/load-balanced-ev.ts";
import type { PreparedRulesInput } from "./rules-planner.ts";
import { waterBatteryCommand, waterBatteryCommands } from "./rules-hot-water.ts";
import { applyNativeHolds, nativeOwnerHeld } from "./rules-commitments.ts";
import { batteryAcCeilings } from './planner/battery-conversion.ts';

/** Same scheduled loads, reactive self-consumption and charger load balancing.
 * Carry this comparison's own stores; the selected battery trajectory cannot
 * supply headroom to a different strategy. Booked/retained commands stay exact. */
export function projectRulesBaseline(core: Pick<ReturnType<typeof createWasmPlanner>, "project">,
  input: PreparedRulesInput, selected: NativeCommand[], selectedQuarters: NativeQuarter[]): { commands: NativeCommand[]; outcome: ProjectionOutcome } {
  const p = input.problem;
  const ceilings = p.battery ? batteryAcCeilings(p.battery) : { charge_w: 0, discharge_w: 0 };
  const requested = selected.map((command, i) => applyNativeHolds(p, i, {
    ...command, battery: p.battery ? "self_consumption" as const : "idle" as const,
    charge_limit_w: ceilings.charge_w, discharge_limit_w: ceilings.discharge_w,
  }));
  if (!p.car || !p.charger) {
    const commands = waterBatteryCommands(input, requested, selectedQuarters);
    return { commands, outcome: core.project(p, commands).outcome };
  }
  let initial = p.initial;
  const commands: NativeCommand[] = [];
  for (const [i, slot] of p.slots.entries()) {
    const retained = p.fixed_commands?.[i] ?? (slot.start_seconds < p.locked_through_seconds ? p.accepted?.[i] : null);
    const hours = slot.hours + Math.min(0, slot.start_seconds) / 3600;
    const quarter: ReadyProblem = { ...p, initial, slots: [{ ...slot, start_seconds: 0, hours }],
      accepted: retained ? [retained] : null, released: retained && !p.fixed_commands?.[i] && p.released ? [p.released[i]] : null,
      unavailable: p.unavailable ? [p.unavailable[i]] : null,
      fixed_commands: null, locked_through_seconds: retained ? hours * 3600 : 0 };
    const balanced = projectLoadBalancedEv(core, quarter, requested[i], !nativeOwnerHeld(p, i, "ev"),
      (command, q) => waterBatteryCommand(input, command, q, i));
    if (balanced.outcome.kind === "failed") return { commands, outcome: balanced.outcome };
    const q = balanced.outcome.quarters[0];
    commands.push(balanced.command);
    initial = { battery_kwh: q.battery_kwh, ev_kwh: q.ev_kwh, pool_c: q.pool_c,
      pool_pending_heat_kwh: q.pool_pending_heat_kwh, pool_source_depletion_kwh: q.pool_source_depletion_kwh,
      heater_state: q.heater_state as ReadyProblem["initial"]["heater_state"] };
  }
  // Certify the complete command vector under the original problem, including
  // absolute-time commitments and the original equipment/permission limits.
  return { commands, outcome: core.project(p, commands).outcome };
}
