import type { ReadyProblem } from '../../../supabase/functions/_shared/planner-wasm/ready-problem.ts';
import type { NativeQuarter } from '../../../supabase/functions/_shared/planner-wasm/core.ts';
import { quarterPool, withPoolState, type PoolStart, type PoolState } from './pool-carry.ts';
import type { BaselineInput } from './model.ts';

export interface SimulationSeed { month: string; hash: string }
export interface SimulationState { batteryKwh: number | null; evKwh: number | null; pool: PoolState | null }
export interface SimulationActors { baseline: SimulationState; scheduler: SimulationState }
export interface SimulationStart { parentHash: string; initial: SimulationActors }
export interface SimulationCheckpoint extends SimulationStart { month: string; start: string; end: string; final: SimulationActors; inputHash: string }
export type SimulationBasis = { kind: 'seed'; hash: string; pool: PoolStart | null }
  | { kind: 'continued'; parentHash: string; initial: SimulationActors };

export function simulationStart(problem: ReadyProblem, basis: SimulationBasis): SimulationStart {
  if (basis.kind === 'continued') return { parentHash: basis.parentHash, initial: basis.initial };
  const state = { batteryKwh: problem.initial.battery_kwh, evKwh: problem.initial.ev_kwh };
  const observedPool: PoolState | null = problem.pool_store ? { poolC: problem.initial.pool_c!, pendingHeatKwh: problem.initial.pool_pending_heat_kwh!, sourceDepletionKwh: problem.initial.pool_source_depletion_kwh, heaterState: problem.initial.heater_state! } : null;
  return { parentHash: basis.hash, initial: {
    baseline: { ...state, pool: basis.pool?.initial.baseline ?? observedPool },
    scheduler: { ...state, pool: basis.pool?.initial.scheduler ?? observedPool },
  } };
}

export function withSimulationBasis(input: BaselineInput, basis: SimulationBasis | null): BaselineInput {
  if (!basis) return input;
  const continuation = simulationStart(input.problem, basis);
  const { baseline, scheduler } = continuation.initial;
  const pool = baseline.pool && scheduler.pool ? { parentHash: continuation.parentHash,
    initial: { baseline: baseline.pool, scheduler: scheduler.pool } } : null;
  return { ...input, continuation, pool };
}

export function withSimulationState(problem: ReadyProblem, state: SimulationState | undefined): ReadyProblem {
  if (!state) return problem;
  if (!!problem.battery !== (state.batteryKwh !== null) || !!problem.car !== (state.evKwh !== null)
    || !!problem.pool_store !== (state.pool !== null)) throw new Error('Simulation continuation does not match the configured stores');
  const pooled = withPoolState(problem, state.pool ?? undefined);
  return { ...pooled, initial: { ...pooled.initial, battery_kwh: state.batteryKwh, ev_kwh: state.evKwh } };
}

/** One owner applies the actor's thermal and electrical continuation. */
export function simulationProblem(input: Pick<BaselineInput, 'problem' | 'pool' | 'continuation'>, actor: 'baseline' | 'scheduler'): ReadyProblem {
  return withSimulationState(withPoolState(input.problem, input.pool?.initial[actor]), input.continuation?.initial[actor]);
}

export function finalSimulationState(quarter: NativeQuarter): SimulationState {
  return { batteryKwh: quarter.battery_kwh, evKwh: quarter.ev_kwh, pool: quarterPool(quarter) };
}
