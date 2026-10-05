import { marginalValue, valueOfMove, type UtilityCurve } from "./store-value.ts";

export interface ServiceValueModel {
  curve: UtilityCurve;
  usage_weight: readonly number[];
  terminal_weight?: number;
}

/** Exact account shared by scalar and whole-run schedule selection. */
export function serviceValue(
  model: ServiceValueModel, state: readonly number[], from = 0, to = state.length - 1,
): number {
  const initial = state[0];
  let value = to === state.length - 1
    ? (model.terminal_weight ?? 0) * valueOfMove(model.curve, initial, state[to]) : 0;
  for (let index = from; index < to; index++) {
    value += (model.usage_weight[index] ?? 0) * valueOfMove(model.curve, initial, state[index]);
  }
  return value;
}

/** Reverse derivative of that account, in SEK per unit added before drift. */
export function marginalServiceValues(
  model: ServiceValueModel, state: readonly number[],
  stateToNext: readonly number[], inputToNext: readonly number[],
): number[] {
  const count = state.length - 1;
  const values = new Array<number>(count);
  let next = (model.terminal_weight ?? 0) * marginalValue(model.curve, state[count]);
  for (let index = count - 1; index >= 0; index--) {
    values[index] = inputToNext[index] * next;
    next = (model.usage_weight[index] ?? 0) * marginalValue(model.curve, state[index]) +
      stateToNext[index] * next;
  }
  return values;
}
