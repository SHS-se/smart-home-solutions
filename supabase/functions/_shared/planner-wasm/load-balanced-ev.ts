import type { createWasmPlanner, NativeQuarter } from "./core.ts";
import type { NativeCommand, ReadyProblem } from "./ready-problem.ts";
import { chargerLevels } from "../planner/device-models.ts";

/** Project supported charger settings, highest first, under the same physics.
 * Only a shared-grid violation permits reducing the requested current. */
export function projectLoadBalancedEv(
  engine: Pick<ReturnType<typeof createWasmPlanner>, "project">,
  problem: ReadyProblem,
  requested: NativeCommand,
  allowReduction = true,
  bound?: (command: NativeCommand, quarter: NativeQuarter) => NativeCommand,
) {
  const lower = allowReduction && problem.charger
    ? [...chargerLevels(problem.charger)].reverse().map(level => level.setting).filter(amps => amps < requested.ev_amps)
    : [];
  let command = requested;
  const project = () => {
    let result = engine.project(problem, [command]).outcome;
    if (result.kind === "projected" && bound) {
      const bounded = bound(command, result.quarters[0]);
      if (bounded !== command) {
        command = bounded;
        result = engine.project(problem, [command]).outcome;
      }
    }
    return result;
  };
  let outcome = project();
  for (const amps of lower) {
    if (outcome.kind !== "failed" || outcome.issue !== "shared_grid_limit") break;
    command = { ...requested, ev_amps: amps };
    outcome = project();
  }
  return { command, outcome };
}
