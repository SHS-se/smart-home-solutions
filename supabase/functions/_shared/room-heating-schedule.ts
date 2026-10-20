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
 *
 * A room whose heat arrives through a delay (a floor slab) has a second state:
 * the heat already on its way. Its programme runs over both, on a coarser grid
 * of delivered heat. Heat put into the floor now warms the room for hours, so
 * its ceiling cannot be a cap on this quarter's power: every quarter planned
 * above the ceiling costs a penalty below a comfort shortfall but above any
 * price, and the programme sees the overshoot that parked heat would cause.
 * A room without a delay keeps its exact one-dimensional programme.
 */

/**
 * One quarter's exact transition:
 *   next = start·decay + offset + delivered_gain·delivered + gain·watts
 *   next delivered = carry·delivered + (1 − carry)·watts
 */
export interface RoomQuarter {
  hours: number;
  decay: number;
  offset_c: number;
  gain_c_per_w: number;
  /** Zero, with `carry`, for a room whose heat arrives at once. */
  delivered_gain_c_per_w?: number;
  carry?: number;
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

/**
 * A delayed room's grid. Two dimensions cost the product of both, so each is
 * coarser than the one-dimensional programme's; the forward pass still runs
 * exact physics from the measured state.
 */
const DELAYED_GRID_C = 0.1;
const DELIVERED_POINTS = 7;
/** Below comfort, above any electricity: a delayed room planned over its ceiling. */
const OVERSHOOT_SEK_PER_C = 1_000;

interface DelayedChoice extends Choice { delivered: number }

function interpolate2(values: Float64Array, low: number, t: number, step: number, points: number, d: number): number {
  const rows = values.length / points;
  let position = (t - low) / DELAYED_GRID_C;
  position = Math.min(Math.max(position, 0), rows - 1);
  const ti = Math.min(Math.floor(position), rows - 2), tf = position - ti;
  let dp = step > 0 ? d / step : 0;
  dp = Math.min(Math.max(dp, 0), points - 1);
  const di = Math.min(Math.floor(dp), Math.max(0, points - 2)), df = points > 1 ? dp - di : 0;
  const at = (r: number, c: number) => values[r * points + Math.min(c, points - 1)];
  const lowRow = at(ti, di) * (1 - df) + at(ti, di + 1) * df;
  const highRow = at(ti + 1, di) * (1 - df) + at(ti + 1, di + 1) * df;
  return lowRow * (1 - tf) + highRow * tf;
}

interface RelayOption { relays: boolean[]; stepW: number }

/** A quarter's allowed relay combinations, built once rather than per grid state. */
function relayOptions(q: RoomQuarter): RelayOption[] {
  return relayStates(q).flatMap(relays => {
    const committed = relays.every((on, r) => q.fixed_relays[r] === on);
    const stepW = relays.reduce((sum, on, r) => sum + (on ? q.relay_w[r] : 0), 0);
    return !committed && stepW > q.maximum_w + 1e-9 ? [] : [{ relays, stepW }];
  });
}

function chooseDelayed(t: number, d: number, q: RoomQuarter, options: RelayOption[], value: Float64Array | null,
  low: number, step: number, points: number): DelayedChoice {
  const carry = q.carry ?? 0;
  const passive = t * q.decay + q.offset_c + (q.delivered_gain_c_per_w ?? 0) * d;
  let best: DelayedChoice = { total: Infinity, watts: 0, next: passive, delivered: carry * d, relays: options[0]?.relays ?? [] };
  for (const { relays, stepW } of options) {
    const candidates: number[] = [];
    if (q.fixed_w !== null) candidates.push(q.fixed_w);
    else if (q.continuous_w > 0 && q.maximum_w > stepW) {
      const cap = Math.max(0, Math.min(q.continuous_w, q.maximum_w - stepW));
      candidates.push(0, cap, cap / 4, cap / 2, 3 * cap / 4);
      const toRequired = q.gain_c_per_w > 0 ? (q.required_c - passive - q.gain_c_per_w * stepW) / q.gain_c_per_w : -1;
      for (const kink of [q.surplus_w - stepW, toRequired]) if (kink > 0 && kink < cap) candidates.push(kink);
      candidates.sort((a, b) => a - b);
    } else candidates.push(0);
    for (const continuous of candidates) {
      const watts = stepW + continuous;
      const next = passive + q.gain_c_per_w * watts;
      const delivered = carry * d + (1 - carry) * watts;
      const covered = Math.min(watts, Math.max(0, q.surplus_w));
      const energy = q.hours / 1000 * (q.export_sek_per_kwh * covered + q.import_sek_per_kwh * (watts - covered));
      const total = energy + SHORTFALL_SEK_PER_C * Math.max(0, q.required_c - next) +
        OVERSHOOT_SEK_PER_C * Math.max(0, next - q.maximum_c) +
        (value ? interpolate2(value, low, next, step, points, delivered) : 0);
      if (total < best.total - 1e-9 || (Math.abs(total - best.total) <= 1e-9 && watts < best.watts)) {
        best = { total, watts, next, delivered, relays };
      }
    }
  }
  return best;
}

function planDelayedRoom(startC: number, startDeliveredW: number, quarters: RoomQuarter[],
  low: number, high: number): RoomHeatingPlan {
  const size = Math.max(2, Math.ceil((high - low) / DELAYED_GRID_C) + 1);
  const top = Math.max(startDeliveredW, ...quarters.map(q => q.continuous_w + q.relay_w.reduce((a, w) => a + w, 0)));
  const points = top > 0 ? DELIVERED_POINTS : 1, step = top > 0 ? top / (points - 1) : 0;
  const values: Float64Array[] = Array(quarters.length + 1);
  const options = quarters.map(relayOptions);
  for (let i = quarters.length - 1; i >= 0; i--) {
    const table = new Float64Array(size * points);
    for (let g = 0; g < size; g++) for (let p = 0; p < points; p++) {
      table[g * points + p] = chooseDelayed(low + g * DELAYED_GRID_C, p * step, quarters[i], options[i], values[i + 1] ?? null,
        low, step, points).total;
    }
    values[i] = table;
  }
  const plan: RoomHeatingPlan = { power_w: [], relays_on: [], temperature_c: [], shortfall_c: [] };
  let t = startC, d = startDeliveredW;
  quarters.forEach((q, i) => {
    const choice = chooseDelayed(t, d, q, options[i], values[i + 1] ?? null, low, step, points);
    plan.power_w.push(choice.watts);
    plan.relays_on.push(choice.relays);
    plan.temperature_c.push(choice.next);
    plan.shortfall_c.push(Math.max(0, q.required_c - choice.next));
    t = choice.next; d = choice.delivered;
  });
  return plan;
}

export function planRoomHeating(startC: number, quarters: RoomQuarter[], startDeliveredW = 0): RoomHeatingPlan {
  const temperatures = [startC, ...quarters.flatMap(q => [q.required_c, q.maximum_c])].filter(Number.isFinite);
  const low = Math.min(...temperatures) - MARGIN_C;
  const size = Math.max(2, Math.ceil((Math.max(...temperatures) - low) / GRID_C) + 1);
  if (quarters.some(q => (q.carry ?? 0) > 0 || (q.delivered_gain_c_per_w ?? 0) > 0)) {
    return planDelayedRoom(startC, Math.max(0, startDeliveredW), quarters, low, Math.max(...temperatures));
  }
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
