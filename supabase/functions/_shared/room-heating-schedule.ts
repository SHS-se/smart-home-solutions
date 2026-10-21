/** Finite native thermostat targets and whole-quarter relays, comfort before cost. */
import { type RoomTransition, stepRoom } from "./planner/thermal-model.ts";
import { heatingMask, projectThermostatQuarter, thermostatTargets,
  type RoomThermostat, type ThermostatQuarter, type ThermostatRoomState } from "./planner/thermostat.ts";

export interface RoomQuarter extends ThermostatQuarter {
  transition: RoomTransition;
  required_c: number;
  maximum_c: number;
  maximum_w: number;
  relay_w: number[];
  fixed_relays: (boolean | null)[];
  /** Native applied targets; the original retained command stays with its caller. */
  fixed_targets_c: (number | null)[];
  import_sek_per_kwh: number;
  export_sek_per_kwh: number;
  surplus_w: number;
}
export interface RoomHeatingPlan {
  power_w: number[];
  thermostat_w: number[][];
  targets_c: number[][];
  relays_on: boolean[][];
  temperature_c: number[];
  shortfall_c: number[];
}

export const MAX_ROOM_RELAYS = 4;
const SHORTFALL_SEK_PER_C = 10_000, OVERSHOOT_SEK_PER_C = 1_000;
const DELIVERED_POINTS = 7, MARGIN_C = 2;
interface Grid { low: number; step_c: number; temperatures: number; delivered_step: number; points: number; masks: number }
interface Choice { score: number; watts: number; targets: number[]; relays: boolean[]; state: ThermostatRoomState; thermostat_w: number[] }

function future(table: Float64Array | undefined, grid: Grid, state: ThermostatRoomState): number {
  if (!table) return 0;
  const tp = Math.min(Math.max((state.temperature_c - grid.low) / grid.step_c, 0), grid.temperatures - 1);
  const ti = Math.min(Math.floor(tp), grid.temperatures - 2), tf = tp - ti;
  const dp = grid.points > 1 ? Math.min(Math.max(state.delivered_w / grid.delivered_step, 0), grid.points - 1) : 0;
  const di = Math.min(Math.floor(dp), Math.max(0, grid.points - 2)), df = dp - di;
  const at = (t: number, d: number) => table[(t * grid.points + Math.min(d, grid.points - 1)) * grid.masks + state.heating_mask];
  const bottom = at(ti, di) * (1 - df) + at(ti, di + 1) * df;
  const top = at(ti + 1, di) * (1 - df) + at(ti + 1, di + 1) * df;
  return bottom * (1 - tf) + top * tf;
}
function combinations<T>(options: T[][]): T[][] {
  return options.reduce<T[][]>((rows, values) => rows.flatMap(row => values.map(value => [...row, value])), [[]]);
}

function choose(initial: ThermostatRoomState, q: RoomQuarter, thermostats: readonly RoomThermostat[],
  relayOptions: boolean[][], table: Float64Array | undefined, grid: Grid): Choice {
  const passive = stepRoom(q.transition, initial, 0).temperature_c;
  const full = stepRoom(q.transition, initial, thermostats.reduce((s, t) => s + t.power_w, 0) + q.relay_w.reduce((a, b) => a + b, 0)).temperature_c;
  const targets = combinations(thermostats.map((t, j) => q.fixed_targets_c[j] !== null
    ? [q.fixed_targets_c[j]] : thermostatTargets(t, Math.min(initial.temperature_c, passive), Math.max(initial.temperature_c, full))));
  let best: Choice | undefined;
  // Committed commands remain exact, including when their physical demand
  // exceeds new headroom. A native minimum can also make heat unavoidable.
  // Only additional free demand must fit that headroom.
  const committedRelays = q.relay_w.reduce((s, w, j) => s + (q.fixed_relays[j] === true ? w : 0), 0);
  const committedTargets = thermostats.map((t, j) => q.fixed_targets_c[j] ?? t.minimum_c);
  const hasCommitment = q.fixed_targets_c.some(t => t !== null) || q.fixed_relays.some(on => on !== null);
  const minimumCanHeat = thermostats.some(t => Math.min(initial.temperature_c, passive) + t.sensor_offset_c < t.minimum_c);
  const committed = hasCommitment || minimumCanHeat ? projectThermostatQuarter(q, thermostats, initial, committedTargets, committedRelays)
    : { peak_w: 0, state: { temperature_c: passive } };
  const budget = Math.max(q.maximum_w, committed.peak_w);
  for (const relays of relayOptions) for (const target of targets) {
    const relayW = relays.reduce((s, on, j) => s + (on ? q.relay_w[j] : 0), 0);
    const projection = projectThermostatQuarter(q, thermostats, initial, target, relayW);
    if (projection.peak_w > budget + 1e-6) continue;
    const watts = relayW + projection.thermostat_w.reduce((a, b) => a + b, 0);
    const next = projection.state.temperature_c;
    if (q.transition.carry === 0 && next > Math.max(q.maximum_c, passive, committed.state.temperature_c) + 1e-9) continue;
    const covered = Math.min(watts, Math.max(0, q.surplus_w));
    const energy = q.hours / 1000 * (q.export_sek_per_kwh * covered + q.import_sek_per_kwh * (watts - covered));
    // Native targets may sit above the room ceiling to activate heating. The
    // ceiling applies to the predicted room, never to a different sensor's target.
    const overshoot = Math.max(0, next - Math.max(q.maximum_c, passive));
    const score = energy + SHORTFALL_SEK_PER_C * Math.max(0, q.required_c - next) +
      OVERSHOOT_SEK_PER_C * overshoot + future(table, grid, projection.state);
    if (!best || score < best.score - 1e-9 || Math.abs(score - best.score) <= 1e-9 && watts < best.watts) {
      best = { score, watts, targets: target, relays, state: projection.state, thermostat_w: projection.thermostat_w };
    }
  }
  if (!best) throw new Error("No native room command fits the configured electrical headroom");
  return best;
}

export function planRoomHeating(startC: number, thermostats: readonly RoomThermostat[], quarters: RoomQuarter[], startDeliveredW = 0): RoomHeatingPlan {
  const temperatures = [startC, ...quarters.flatMap(q => [q.required_c, q.maximum_c])];
  const delayed = quarters.some(q => q.transition.carry > 0);
  const top = Math.max(startDeliveredW, thermostats.reduce((s, t) => s + t.power_w, 0) + Math.max(0, ...quarters.map(q => q.relay_w.reduce((a, b) => a + b, 0))));
  const points = delayed && top > 0 ? DELIVERED_POINTS : 1;
  const low = Math.min(...temperatures) - MARGIN_C, stepC = delayed ? .1 : .05;
  const grid: Grid = { low, step_c: stepC, temperatures: Math.max(2, Math.ceil((Math.max(...temperatures) + MARGIN_C - low) / stepC) + 1),
    delivered_step: points > 1 ? top / (points - 1) : 0, points, masks: 2 ** thermostats.length };
  const options = quarters.map(q => combinations(q.relay_w.map((_w, j) => q.fixed_relays[j] === null ? [false, true] : [q.fixed_relays[j]])));
  const values: Float64Array[] = Array(quarters.length + 1);
  for (let i = quarters.length - 1; i >= 0; i--) {
    const table = new Float64Array(grid.temperatures * points * grid.masks);
    for (let t = 0; t < grid.temperatures; t++) for (let d = 0; d < points; d++) for (let mask = 0; mask < grid.masks; mask++) {
      table[(t * points + d) * grid.masks + mask] = choose({ temperature_c: low + t * stepC,
        delivered_w: d * grid.delivered_step, heating_mask: mask }, quarters[i], thermostats, options[i], values[i + 1], grid).score;
    }
    values[i] = table;
  }
  const plan: RoomHeatingPlan = { power_w: [], thermostat_w: [], targets_c: [], relays_on: [], temperature_c: [], shortfall_c: [] };
  let state: ThermostatRoomState = { temperature_c: startC, delivered_w: startDeliveredW, heating_mask: heatingMask(thermostats) };
  quarters.forEach((q, i) => {
    const next = choose(state, q, thermostats, options[i], values[i + 1], grid);
    plan.power_w.push(next.watts); plan.thermostat_w.push(next.thermostat_w); plan.targets_c.push(next.targets);
    plan.relays_on.push(next.relays); plan.temperature_c.push(next.state.temperature_c);
    plan.shortfall_c.push(Math.max(0, q.required_c - next.state.temperature_c));
    state = next.state;
  });
  return plan;
}
