import runtime from '../../../supabase/functions/_shared/planner-wasm/runtime-config.json' with { type: 'json' };
import artifact from '../../../supabase/functions/_shared/planner-wasm/artifact.json' with { type: 'json' };
import { resolveRulePolicy } from '../../../supabase/functions/_shared/planner-wasm/rule-policy.ts';
import { builderRecipe, type NativeCommand, type ReadyProblem } from '../../../supabase/functions/_shared/planner-wasm/ready-problem.ts';
import { problemEndCredit } from '../../../supabase/functions/_shared/planner-wasm/end-credit.ts';
import { allocatedBatteryCommand } from '../../../supabase/functions/_shared/planner-wasm/battery-command.ts';
import type { createWasmPlanner, NativeQuarter } from '../../../supabase/functions/_shared/planner-wasm/core.ts';
import { localDay } from '../../../supabase/functions/_shared/planner-wasm/calendar.ts';
import { recordedTrips, withdrawTrip } from './trip-ledger.ts';
import { electricityLedger } from './controller.ts';
import { projectionSeries, type BaselineInput } from './model.ts';
import { finalSimulationState, simulationProblem } from './simulation-state.ts';
import { quarterPool } from './pool-carry.ts';

export type ReplayEngine = Pick<ReturnType<typeof createWasmPlanner>, 'solve' | 'project'>;
export const REPLAY_PROTOCOL = 'continuous-stores-72h-refined-battery-v6';
export const REPLAY_ENGINE = `${runtime.recipe.version}:${runtime.policy_manifest.version}:${artifact.wasm_sha256}`;

/** Current optimizer, isolated from live planning/dispatch. Trips are external physical withdrawals. */
export function replayScheduler(input: BaselineInput, engine: ReplayEngine) {
  const source = simulationProblem(input, 'scheduler'), { comfort, policy, criteria } = input.settings;
  if (!policy || criteria === undefined || (source.pool_store && !comfort?.pool) || (source.car && !comfort?.ev)) throw new Error('Current scheduler settings unavailable');
  if (policy.battery_target_is_hard) throw new Error('Unsupported configured hard battery target in rules planner');
  const approved = resolveRulePolicy(criteria);
  const problem: ReadyProblem = { ...source, ...approved, work_grant: runtime.recipe.work_grant, recipe: builderRecipe(runtime.recipe),
    ev_battery_supply_allowed: false, pool_stop_c: source.pool_store ? input.settings.pool_model?.hardware?.stop_c ?? null : null,
    targets: { ...source.targets, pool_c: source.pool_store ? comfort!.pool!.target_c : null, ev_km: source.car ? comfort!.ev!.target_km : null, ev_limit_kwh: source.car ? input.settings.ev_battery!.charge_limit_soc * source.car.capacity_kwh : null },
    limits: { ...source.limits, battery_export_enabled: !!source.battery && policy.battery_export_enabled,
      battery_export_reserve_kwh: source.battery ? policy.battery_export_reserve_soc * source.battery.capacity_kwh : 0,
      battery_export_min_price: policy.battery_export_min_price_sek_per_kwh } };
  let state = { ...problem.initial }, selected: NativeCommand[] = [], plannedAt = -1, day = '', solves = 0;
  const commands: NativeCommand[] = [], quarters: NativeQuarter[] = [];
  const forecastSlots = [...problem.slots, ...input.planningTail.slots];
  const trips = recordedTrips([...input.evDemandKwh, ...input.planningTail.evDemandKwh], forecastSlots.length);
  for (let i = 0; i < problem.slots.length; i++) {
    const at = new Date(Date.parse(input.start) + i * 900_000).toISOString(), currentDay = localDay(at, input.timeZone);
    if (problem.car) state = { ...state, ev_kwh: withdrawTrip(state.ev_kwh!, input.evDemandKwh[i], 'SHS Energy Scheduler', at) };
    // Replan when an available car has withdrawals the selected plan could not
    // simulate. A daily solve after the last withdrawal already knows its depleted
    // state and future availability, so its eventual return needs no extra solve.
    const staleEv = plannedAt >= 0 && problem.slots[i].ev_available && i >= trips.next[plannedAt];
    if (plannedAt < 0 || currentDay !== day || staleEv) {
      const horizon: ReadyProblem = { ...problem, initial: state,
        slots: forecastSlots.slice(i, i + 288).map((s, n) => ({ ...s, ev_available: s.ev_available && i + n < trips.next[i], start_seconds: n * 900 })),
        accepted: null, locked_through_seconds: 0 };
      // Historical replay alone uses observed trip withdrawals to stop car
      // availability at the next trip, retaining 72h for pool/battery.
      // After homecoming, replan from the depleted state with the prior committed hour.
      if (plannedAt >= 0 && horizon.slots.length >= 4 && i - plannedAt + 4 <= selected.length) {
        horizon.accepted = selected.slice(i - plannedAt, i - plannedAt + 4);
        horizon.locked_through_seconds = 3600;
      }
      horizon.end_credit = problemEndCredit(horizon);
      const outcome = engine.solve(horizon).outcome; solves++;
      if (outcome.kind === 'failed') throw new Error(`Historical scheduler at ${at}: ${outcome.issue}`);
      selected = outcome.selection.commands.map((command, n) => allocatedBatteryCommand(command, outcome.selection.quarters[n]));
      plannedAt = i; day = currentDay;
    }
    const command = selected[i - plannedAt];
    const quarter: ReadyProblem = { ...problem, initial: state, accepted: null, locked_through_seconds: 0,
      slots: [{ ...problem.slots[i], start_seconds: 0 }] };
    const outcome = engine.project(quarter, [command]).outcome;
    if (outcome.kind === 'failed') throw new Error(`Historical scheduler execution at ${at}: ${outcome.issue}`);
    const q = outcome.quarters[0]; commands.push(command); quarters.push(q);
    state = { battery_kwh: q.battery_kwh, ev_kwh: q.ev_kwh, pool_c: q.pool_c, pool_pending_heat_kwh: q.pool_pending_heat_kwh, pool_source_depletion_kwh: q.pool_source_depletion_kwh, heater_state: q.heater_state as ReadyProblem['initial']['heater_state'] };
  }
  const series = projectionSeries(input, problem, quarters), ledger = electricityLedger(quarters, problem);
  return { series, commands, ledger, states: quarters.map(finalSimulationState), poolStates: quarters.map(quarterPool), solves, engine: REPLAY_ENGINE, protocol: REPLAY_PROTOCOL };
}
export type SchedulerReplay = ReturnType<typeof replayScheduler>;
