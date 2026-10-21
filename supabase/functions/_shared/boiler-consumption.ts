/** A run keeps permission until its live heater power falls strictly below
 * this (user requirement, 21 October 2026). Matches the HA controller. */
export const FINISH_HEATING_W = 50;

/** An electrical daily requirement, not an assertion about tank temperature.
 * Permission starts a run. Once started, the same completion rule as the
 * controller lets it finish. A fractional last quarter represents fewer
 * seconds at running power, never a reduced heater setting. */
export function projectBoilerDay(input: {
  required_wh: number;
  running_w: readonly number[];
  hours: readonly number[];
  permitted: readonly boolean[];
  committed_w?: readonly (number | undefined)[];
}) {
  const fixedWh = input.hours.reduce((sum, h, i) => sum + (input.committed_w?.[i] ?? 0) * h, 0);
  let remaining = Math.max(0, input.required_wh - fixedWh), running = false;
  const remaining_wh: number[] = [];
  const expected_w = input.hours.map((hours, i) => {
    const fixed = input.committed_w?.[i];
    const watts = fixed ?? (hours > 0 && (input.permitted[i] || running)
      ? Math.min(input.running_w[i], remaining / hours) : 0);
    if (fixed === undefined) remaining = Math.max(0, remaining - watts * hours);
    running = watts >= FINISH_HEATING_W && remaining > 1e-6;
    remaining_wh.push(remaining);
    return watts;
  });
  return { expected_w, remaining_wh, unserved_wh: remaining };
}
