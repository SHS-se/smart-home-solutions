import { parseHeaterState, type HeaterState } from '../../../supabase/functions/_shared/planner/device-models.ts';
import type { PoolResponseState } from '../../../supabase/functions/_shared/planner/pool-response.ts';
import type { NativeQuarter } from '../../../supabase/functions/_shared/planner-wasm/core.ts';
import type { ReadyProblem } from '../../../supabase/functions/_shared/planner-wasm/ready-problem.ts';

export interface PoolSeed { month: string; temperatureC: number; hash: string }
export interface PoolState { poolC: number; pendingHeatKwh: number; sourceDepletionKwh: number | null; heaterState: HeaterState }
export interface PoolActors { baseline: PoolState; scheduler: PoolState }
export interface PoolStart { parentHash: string; initial: PoolActors }
export interface PoolCheckpoint extends PoolStart { month: string; start: string; end: string; final: PoolActors; inputHash: string }

export function seedPool(seed: PoolSeed, response: PoolResponseState | null = null): PoolStart {
  return { parentHash: seed.hash, initial: { baseline: { poolC: seed.temperatureC, pendingHeatKwh: response?.pending_heat_kwh ?? 0, sourceDepletionKwh: response?.source_depletion_kwh ?? null, heaterState: { kind: 'off_unobserved' } },
    scheduler: { poolC: seed.temperatureC, pendingHeatKwh: response?.pending_heat_kwh ?? 0, sourceDepletionKwh: response?.source_depletion_kwh ?? null, heaterState: { kind: 'off_unobserved' } } } };
}
export function quarterPool(quarter: NativeQuarter): PoolState | null {
  if (quarter.pool_c === null) return null;
  if (quarter.pool_pending_heat_kwh === null || !Number.isFinite(quarter.pool_pending_heat_kwh) || quarter.pool_pending_heat_kwh < 0) throw new Error('Missing pool pending heat continuation');
  return { poolC: quarter.pool_c, pendingHeatKwh: quarter.pool_pending_heat_kwh, sourceDepletionKwh: quarter.pool_source_depletion_kwh, heaterState: parseHeaterState(quarter.heater_state) };
}
export function finalPool(states: readonly (PoolState | null)[]): PoolState {
  const state = states.at(-1);
  if (!state) throw new Error('Missing pool continuation at the end of the month');
  return state;
}
export function withPoolState(problem: ReadyProblem, state: PoolState | undefined): ReadyProblem {
  if (!state) return problem;
  if (!problem.pool_store) throw new Error('Pool continuation requires a pool physical model');
  if (problem.heater?.source && (state.sourceDepletionKwh === null || !Number.isFinite(state.sourceDepletionKwh) || state.sourceDepletionKwh < 0)) throw new Error('Pool continuation needs measured initial source depletion');
  return { ...problem, initial: { ...problem.initial, pool_c: state.poolC, pool_pending_heat_kwh: state.pendingHeatKwh, pool_source_depletion_kwh: problem.heater?.source ? state.sourceDepletionKwh : null, heater_state: state.heaterState } };
}
