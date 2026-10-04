import { assertEquals } from '@std/assert';
import { chargerLevels } from '../../../supabase/functions/_shared/planner/device-models.ts';
import { stepMove } from './step-moves.ts';

const levels = chargerLevels({ voltage_v: 230, phase_count: 3, min_current_a: 5, max_current_a: 16, current_step_a: 1 });
const A = 690;

Deno.test('charge moves between quarters in whole amps, the same out as in', () => {
  // Two quarters at 7 A; all of it may go to two idle quarters.
  const all = stepMove([7 * A, 7 * A, 0, 0], [0, 1], [2, 3], levels, 14 * A)!;
  assertEquals([all.moved_w, all.values.reduce((a, b) => a + b, 0)], [14 * A, 14 * A]);
  assertEquals([all.values.slice(0, 2), all.fromQ, all.toQ.length > 0], [[0, 0], [0, 1], true]);
  // Half of it: a quarter cannot be left at 2 A, so one whole quarter moves and the other stays.
  const half = stepMove([7 * A, 7 * A, 0, 0], [0, 1], [2, 3], levels, 7 * A)!;
  assertEquals([half.values, half.moved_w, half.fromQ, half.toQ], [[0, 7 * A, 7 * A, 0], 7 * A, [0], [2]]);
  // Into a quarter already charging, one amp at a time is a step.
  const top = stepMove([7 * A, 12 * A], [0], [1], levels, 2 * A)!;
  assertEquals([top.values, top.moved_w], [[5 * A, 14 * A], 2 * A]);
  // The quarters are used in the order given: the first listed gives up most.
  const ordered = stepMove([9 * A, 9 * A, 0], [1, 0], [2], levels, 9 * A)!;
  assertEquals(ordered.values, [9 * A, 0, 9 * A]);
});

Deno.test('a move that would leave a quarter between two steps is not made', () => {
  // Less than 5 A cannot start an idle quarter, and 7 A cannot shed 4 A and stay on.
  assertEquals(stepMove([7 * A, 0], [0], [1], levels, 4 * A), null);
  // The receiving quarter is already flat out.
  assertEquals(stepMove([7 * A, 16 * A], [0], [1], levels, 7 * A), null);
  // A quarter that is not on a step to begin with is left alone.
  assertEquals(stepMove([5000, 0], [0], [1], levels, 5000), null);
  assertEquals(stepMove([7 * A, 0], [0], [1], levels, 0), null);
});
