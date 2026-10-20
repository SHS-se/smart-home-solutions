/**
 * Price- and deadline-aware heating for one thermostat room.
 *
 * A backward dynamic programme over room temperature chooses each quarter's
 * heat. Comfort comes first: every °C below a quarter's objective costs far
 * more than any electricity, so an attainable deadline is always met and an
 * unattainable one gets the closest recovery. Among plans that serve comfort
 * equally, the cheapest wins: the room coasts while power is dear and keeps
 * or stores warmth (never above its ceiling) while it is cheap.
 *
 * The cost-to-go is held on a temperature grid and interpolated linearly, so
 * the forward pass runs from the exact measured temperature and every planned
 * temperature is exact first-order physics, not a grid value.
 *
 * Relays (a towel rack on a smart plug) switch for whole quarters only, so each
 * on/off combination is a step of fixed heat with the thermostats' continuous
 * power on top.
 */

/** One quarter's exact transition: next = start·decay + offset + gain·watts. */
export interface RoomQuarter {
  hours: number;
  decay: number;
  offset_c: number;
  gain_c_per_w: number;
  /** Temperature the room should have reached when this quarter ends. */
  required_c: number;
  /** Heating may not lift the room above this; passive warmth may. */
  maximum_c: number;
  /** All heat in the room, relays and thermostats together. */
  maximum_w: number;
  /** Combined thermostat rating: the continuous part of the room's heat. */
  continuous_w: number;
  /** Each relay's heat when on for the whole quarter. */
  relay_w: number[];
  /** A committed quarter keeps its retained thermostat power exactly. */
  fixed_w: number | null;
  /** A committed quarter keeps each relay's retained state; null is free. */
  fixed_relays: (boolean | null)[];
  import_sek_per_kwh: number;
  /** Foregone export: the price of power that solar surplus already covers. */
  export_sek_per_kwh: number;
  surplus_w: number;
}

export interface RoomHeatingPlan {
  /** All heat in the room, relays included. */
  power_w: number[];
  /** Each quarter's relay states, in `relay_w` order. */
  relays_on: boolean[][];
  /** Planned temperature at the end of each quarter. */
  temperature_c: number[];
  shortfall_c: number[];
}

const GRID_C = 0.05;
/** A lexicographic weight, not a price: comfort before cost. */
const SHORTFALL_SEK_PER_C = 10_000;
const MARGIN_C = 2;
/** Relay combinations double per relay; past this a room keeps the old path. */
export const MAX_ROOM_RELAYS = 4;

interface Choice { total: number; watts: number; next: number; relays: boolean[] }

function interpolate(values: Float64Array, low: number, t: number): number {
  const position = (t - low) / GRID_C;
  if (position <= 0) return values[0];
  if (position >= values.length - 1) return values[values.length - 1];
  const index = Math.floor(position);
  const fraction = position - index;
  return values[index] * (1 - fraction) + values[index + 1] * fraction;
}

/** Every relay combination a quarter allows, committed relays held. */
function relayStates(q: RoomQuarter): boolean[][] {
  let states: boolean[][] = [[]];
  q.relay_w.forEach((_w, r) => {
    const fixed = q.fixed_relays[r];
    states = states.flatMap(state => fixed === null || fixed === undefined
      ? [[...state, false], [...state, true]] : [[...state, fixed]]);
  });
  return states;
}

function choose(t: number, q: RoomQuarter, value: Float64Array | null, low: number): Choice {
  const passive = t * q.decay + q.offset_c;
  let best: Choice = { total: Infinity, watts: 0, next: passive, relays: q.relay_w.map(() => false) };
  for (const relays of relayStates(q)) {
    const committed = relays.every((on, r) => q.fixed_relays[r] === on);
    const stepW = relays.reduce((sum, on, r) => sum + (on ? q.relay_w[r] : 0), 0);
    const base = passive + q.gain_c_per_w * stepW;
    // A free relay may not overrun the room's power or lift it past its ceiling.
    if (!committed && (stepW > q.maximum_w + 1e-9 || (stepW > 0 && base > Math.max(passive, q.maximum_c) + 1e-9))) continue;
    const candidates: number[] = [];
    if (q.fixed_w !== null) candidates.push(q.fixed_w);
    else if (q.gain_c_per_w > 0 && q.continuous_w > 0 && q.maximum_w > stepW) {
      const cap = Math.max(0, Math.min(q.continuous_w, q.maximum_w - stepW, (Math.max(base, q.maximum_c) - base) / q.gain_c_per_w));
      const watts = (target: number) => (target - base) / q.gain_c_per_w;
      candidates.push(0, cap);
      // The objective is piecewise linear in power: its kinks are the grid
      // points, the end of free surplus and the comfort objective itself.
      for (const kink of [q.surplus_w - stepW, watts(q.required_c)]) if (kink > 0 && kink < cap) candidates.push(kink);
      const first = Math.ceil((base - low) / GRID_C), last = Math.floor((base + q.gain_c_per_w * cap - low) / GRID_C);
      for (let g = Math.max(0, first); g <= last; g++) {
        const w = watts(low + g * GRID_C);
        if (w > 0 && w < cap) candidates.push(w);
      }
      candidates.sort((a, b) => a - b);
    } else candidates.push(0);
    for (const continuous of candidates) {
      const watts = stepW + continuous;
      const next = passive + q.gain_c_per_w * watts;
      const covered = Math.min(watts, Math.max(0, q.surplus_w));
      const energy = q.hours / 1000 * (q.export_sek_per_kwh * covered + q.import_sek_per_kwh * (watts - covered));
      const total = energy + SHORTFALL_SEK_PER_C * Math.max(0, q.required_c - next) +
        (value ? interpolate(value, low, next) : 0);
      // Ties keep the smaller heat, so equal plans never heat for nothing.
      if (total < best.total - 1e-9 || (Math.abs(total - best.total) <= 1e-9 && watts < best.watts)) {
        best = { total, watts, next, relays };
      }
    }
  }
  return best;
}

export function planRoomHeating(startC: number, quarters: RoomQuarter[]): RoomHeatingPlan {
  const temperatures = [startC, ...quarters.flatMap(q => [q.required_c, q.maximum_c])].filter(Number.isFinite);
  const low = Math.min(...temperatures) - MARGIN_C;
  const size = Math.max(2, Math.ceil((Math.max(...temperatures) - low) / GRID_C) + 1);
  const values: Float64Array[] = Array(quarters.length + 1);
  for (let i = quarters.length - 1; i >= 0; i--) {
    const row = new Float64Array(size);
    for (let g = 0; g < size; g++) row[g] = choose(low + g * GRID_C, quarters[i], values[i + 1] ?? null, low).total;
    values[i] = row;
  }
  const plan: RoomHeatingPlan = { power_w: [], relays_on: [], temperature_c: [], shortfall_c: [] };
  let t = startC;
  quarters.forEach((q, i) => {
    const step = choose(t, q, values[i + 1] ?? null, low);
    plan.power_w.push(step.watts);
    plan.relays_on.push(step.relays);
    plan.temperature_c.push(step.next);
    plan.shortfall_c.push(Math.max(0, q.required_c - step.next));
    t = step.next;
  });
  return plan;
}
