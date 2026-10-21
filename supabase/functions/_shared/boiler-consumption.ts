/** A run keeps permission until its live heater power falls strictly below
 * this (user requirement, 21 October 2026). Matches the HA controller. */
export const FINISH_HEATING_W = 50;

/** The tank as a heat deficit: Wh below a satisfied thermostat (user
 * requirement, 21 October 2026; replaces a daily electricity lump). Water use
 * adds to it, measured as what a free thermostat would draw to replace it.
 * Heat only replaces what has been drawn: a permitted quarter heats at running
 * power until the thermostat is satisfied, so the tank is never heated beyond
 * full. Once running, the same completion rule as the controller lets a run
 * finish through a block. Heat a block holds off stays owed. A fractional
 * quarter heats for fewer seconds at running power, never at a reduced
 * setting. Committed watts are kept exactly. */
export function projectBoilerTank(input: {
  draw_w: readonly number[];
  initial_deficit_wh?: number;
  running_w: readonly number[];
  hours: readonly number[];
  permitted: readonly boolean[];
  committed_w?: readonly (number | undefined)[];
}) {
  let deficit = Math.max(0, input.initial_deficit_wh ?? 0), running = false;
  const deficit_wh: number[] = [];
  const expected_w = input.hours.map((hours, i) => {
    deficit += input.draw_w[i] * hours;
    const fixed = input.committed_w?.[i];
    const watts = fixed ?? (hours > 0 && (input.permitted[i] || running)
      ? Math.min(input.running_w[i], deficit / hours) : 0);
    deficit = Math.max(0, deficit - watts * hours);
    running = watts >= FINISH_HEATING_W && deficit > 1e-6;
    deficit_wh.push(deficit);
    return watts;
  });
  return { expected_w, deficit_wh, owed_wh: deficit };
}
