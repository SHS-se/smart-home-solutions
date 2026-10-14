// Whether the plan lets the water heater run in a quarter, and why not.
//
// The plan does not publish an on/off schedule for hot water. Each quarter is
// one of: blocked outright (an expensive quarter), a live load gate that Home
// Assistant applies to the measured house demand, or no instruction at all.
// The gate's thresholds are gross household watts, the same quantity as the
// top of the consumption stack, so the chart can draw them against it.
import type { PlannedSlot } from './contracts';

export type HotWaterState =
  /** Permitted, or gated with the forecast load expected to stay under the limit. */
  | 'allowed'
  /** Gated, and the forecast load is expected to cross the limit. */
  | 'load_gate'
  /** The plan inhibits the heater regardless of load. */
  | 'blocked'
  /** Outside every hot-water window: the plan sends no instruction. */
  | 'uncontrolled';

export interface HotWaterQuarter {
  state: HotWaterState;
  /** The planned water heating, in watts. */
  expectedW: number;
  /** The heater may start while the house draws no more than this. */
  allowBelowW: number | null;
  /** A running heater is stopped once the house draws more than this. */
  inhibitAboveW: number | null;
  /** Heating the tank is owed at the end of the quarter, kWh; known only where a referee carried the plan out. */
  owedKwh?: number;
}

/**
 * A quarter as the planner bench's referee carried it out: what the plan told
 * the heater, and whether the gate let it run on the house's simulated draw.
 */
export function refereedHotWaterQuarter(water: {
  command: readonly ('free' | 'inhibit' | 'gate')[]; permitted: readonly number[];
  allowBelowW: readonly (number | null)[]; inhibitAboveW: readonly (number | null)[]; owedKwh: readonly number[];
}, i: number, expectedW: number): HotWaterQuarter {
  const command = water.command[i];
  return {
    state: command === 'free' ? 'uncontrolled' : command === 'inhibit' ? 'blocked' : water.permitted[i] ? 'allowed' : 'load_gate',
    expectedW, allowBelowW: water.allowBelowW[i], inhibitAboveW: water.inhibitAboveW[i], owedKwh: water.owedKwh[i],
  };
}

export function hotWaterQuarter(
  slot: Pick<PlannedSlot, 'boiler_expected_w' | 'boiler_permitted' | 'device_commands'>,
  hotWaterKeys: readonly string[],
): HotWaterQuarter {
  const expectedW = slot.boiler_expected_w;
  const commands = hotWaterKeys.flatMap(key => slot.device_commands?.[key] ?? []);
  const gate = commands.find(command => command.type === 'house_demand_permission');
  if (gate?.type === 'house_demand_permission') {
    return {
      state: gate.expected_permitted ? 'allowed' : 'load_gate', expectedW,
      allowBelowW: gate.allow_below_w, inhibitAboveW: gate.inhibit_above_w,
    };
  }
  const permits = commands.flatMap(command => command.type === 'permit_inhibit' ? [command.permitted] : []);
  // A plan without per-device commands still carries the aggregate decision.
  const permitted = permits.length ? permits.every(Boolean) : commands.length ? null : slot.boiler_permitted;
  return {
    state: permitted === null ? 'uncontrolled' : permitted ? 'allowed' : 'blocked',
    expectedW, allowBelowW: null, inhibitAboveW: null,
  };
}
