import { parseHeaterState, type HeaterState } from '../../../supabase/functions/_shared/planner/device-models.ts';
import type { NativeQuarter } from '../../../supabase/functions/_shared/planner-wasm/core.ts';
import type { ReadyProblem } from '../../../supabase/functions/_shared/planner-wasm/ready-problem.ts';

export interface PoolSeed { month: string; temperatureC: number; hash: string }
export interface PoolState { poolC: number; pendingHeatKwh: number; heaterState: HeaterState }
export interface PoolActors { baseline: PoolState; scheduler: PoolState }
export interface PoolStart { parentHash: string; initial: PoolActors }
export interface PoolCheckpoint extends PoolStart { month: string; start: string; end: string; final: PoolActors; inputHash: string }

export function seedPool(seed: PoolSeed): PoolStart {
  return { parentHash: seed.hash, initial: { baseline: { poolC: seed.temperatureC, pendingHeatKwh: 0, heaterState: { kind: 'off_unobserved' } },
    scheduler: { poolC: seed.temperatureC, pendingHeatKwh: 0, heaterState: { kind: 'off_unobserved' } } } };
}
export function quarterPool(quarter: NativeQuarter): PoolState | null {
  if (quarter.pool_c === null) return null;
  if (quarter.pool_pending_heat_kwh === null || !Number.isFinite(quarter.pool_pending_heat_kwh) || quarter.pool_pending_heat_kwh < 0) throw new Error('Missing pool pending heat continuation');
  return { poolC: quarter.pool_c, pendingHeatKwh: quarter.pool_pending_heat_kwh, heaterState: parseHeaterState(quarter.heater_state) };
}
export function finalPool(states: readonly (PoolState | null)[]): PoolState {
  const state = states.at(-1);
  if (!state) throw new Error('Missing pool continuation at the end of the month');
  return state;
}
export function withPoolState(problem: ReadyProblem, state: PoolState | undefined): ReadyProblem {
  if (!state) return problem;
  if (!problem.pool_store) throw new Error('Pool continuation requires a pool physical model');
  return { ...problem, initial: { ...problem.initial, pool_c: state.poolC, pool_pending_heat_kwh: state.pendingHeatKwh, heater_state: state.heaterState } };
}
