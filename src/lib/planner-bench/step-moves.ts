// Moves of power between quarters for a device that runs only at its levels.
//
// The audit (opportunities.ts) tries the same energy at another time. For a
// device with levels (a charger in whole amps) an alternative is only worth
// trying if every quarter it touches still sits on a level, and it moves
// exactly as much as it takes, so the store ends where the plan ended it.

import type { Level, Levels } from '../../../supabase/functions/_shared/planner/device-models';

export interface StepMove {
  /** The series with the move made. */
  values: number[];
  /** Quarters that gave power up, and quarters that took it. */
  fromQ: number[];
  toQ: number[];
  /** Power moved, summed over the quarters it left, W. */
  moved_w: number;
}

/** A power within this of a level is on it. */
const ON_LEVEL_W = 1;

/**
 * Every total the quarters can change by, each with the change per quarter that
 * makes it: lowering (`sign` −1) or raising (+1) each quarter from the level it
 * is on to another. A quarter that is not on a level is left alone. Earlier
 * quarters and larger changes are tried first, and the first way found to a
 * total is kept.
 */
function reachable(values: readonly number[], quarters: readonly number[], levels: Levels<Level>, sign: 1 | -1): Map<number, number[]> {
  let totals = new Map<number, number[]>([[0, []]]);
  for (const q of quarters) {
    const at = levels.findIndex(level => Math.abs(level.draw_w - values[q]) <= ON_LEVEL_W);
    const others = at < 0 ? [] : sign < 0 ? levels.slice(0, at).reverse() : levels.slice(at + 1).reverse();
    const changes = [...others.map(level => Math.abs(level.draw_w - levels[at].draw_w)), 0];
    const next = new Map<number, number[]>();
    for (const [total, made] of totals) {
      for (const change of changes) {
        const sum = Math.round((total + change) * 1_000) / 1_000;
        if (!next.has(sum)) next.set(sum, [...made, change]);
      }
    }
    totals = next;
  }
  return totals;
}

/**
 * Take power from the `from` quarters and give the same power to the `to`
 * quarters, every quarter touched ending on a level: the largest such move of
 * no more than `wantW`, or null when there is none. List the quarters in the
 * order they should be used.
 */
export function stepMove(values: readonly number[], from: readonly number[], to: readonly number[], levels: Levels<Level>, wantW: number): StepMove | null {
  const lowered = reachable(values, from, levels, -1), raised = reachable(values, to, levels, 1);
  let moved = 0;
  for (const total of lowered.keys()) if (total > moved && total <= wantW + 1e-6 && raised.has(total)) moved = total;
  if (moved <= 0) return null;
  const out = [...values];
  const down = lowered.get(moved)!, up = raised.get(moved)!;
  from.forEach((q, i) => { out[q] -= down[i]; });
  to.forEach((q, i) => { out[q] += up[i]; });
  return { values: out, fromQ: from.filter((_, i) => down[i] > 0).sort((a, b) => a - b), toQ: to.filter((_, i) => up[i] > 0).sort((a, b) => a - b), moved_w: moved };
}
