import { marginalValue, totalUtility, type UtilityCurve } from "./store-value.ts";

export interface ServiceValueModel {
  curve: UtilityCurve;
  usage_weight: readonly number[];
  terminal_weight?: number;
}

/** Exact account shared by scalar and whole-run schedule selection. */
export function serviceValue(
  model: ServiceValueModel, state: readonly number[], from = 0, to = state.length - 1,
): number {
  if (to !== state.length - 1 && !(from < to)) return 0;
  // Every term uses the same initial utility. Evaluate it once, preserving
  // the exact subtraction, multiplication and accumulation order of each term.
  const initial = totalUtility(model.curve, state[0]);
  let value = to === state.length - 1
    ? (model.terminal_weight ?? 0) * (totalUtility(model.curve, state[to]) - initial) : 0;
  for (let index = from; index < to; index++) {
    value += (model.usage_weight[index] ?? 0) * (totalUtility(model.curve, state[index]) - initial);
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
