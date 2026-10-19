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
  maximum_w: number;
  /** A committed quarter keeps its retained power exactly. */
  fixed_w: number | null;
  import_sek_per_kwh: number;
  /** Foregone export: the price of power that solar surplus already covers. */
  export_sek_per_kwh: number;
  surplus_w: number;
}

export interface RoomHeatingPlan {
  power_w: number[];
  /** Planned temperature at the end of each quarter. */
  temperature_c: number[];
  shortfall_c: number[];
}

const GRID_C = 0.05;
/** A lexicographic weight, not a price: comfort before cost. */
const SHORTFALL_SEK_PER_C = 10_000;
const MARGIN_C = 2;

interface Choice { total: number; watts: number; next: number }

function interpolate(values: Float64Array, low: number, t: number): number {
  const position = (t - low) / GRID_C;
  if (position <= 0) return values[0];
  if (position >= values.length - 1) return values[values.length - 1];
  const index = Math.floor(position);
  const fraction = position - index;
  return values[index] * (1 - fraction) + values[index + 1] * fraction;
}

function choose(t: number, q: RoomQuarter, value: Float64Array | null, low: number): Choice {
  const passive = t * q.decay + q.offset_c;
  const candidates: number[] = [];
  if (q.fixed_w !== null) candidates.push(q.fixed_w);
  else if (q.gain_c_per_w > 0 && q.maximum_w > 0) {
    const cap = Math.max(0, Math.min(q.maximum_w, (Math.max(passive, q.maximum_c) - passive) / q.gain_c_per_w));
    const watts = (target: number) => (target - passive) / q.gain_c_per_w;
    candidates.push(0, cap);
    // The objective is piecewise linear in power: its kinks are the grid
    // points, the end of free surplus and the comfort objective itself.
    for (const kink of [q.surplus_w, watts(q.required_c)]) if (kink > 0 && kink < cap) candidates.push(kink);
    const first = Math.ceil((passive - low) / GRID_C), last = Math.floor((passive + q.gain_c_per_w * cap - low) / GRID_C);
    for (let g = Math.max(0, first); g <= last; g++) {
      const w = watts(low + g * GRID_C);
      if (w > 0 && w < cap) candidates.push(w);
    }
    candidates.sort((a, b) => a - b);
  } else candidates.push(0);
  let best: Choice = { total: Infinity, watts: 0, next: passive };
  for (const watts of candidates) {
    const next = passive + q.gain_c_per_w * watts;
    const covered = Math.min(watts, Math.max(0, q.surplus_w));
    const energy = q.hours / 1000 * (q.export_sek_per_kwh * covered + q.import_sek_per_kwh * (watts - covered));
    const total = energy + SHORTFALL_SEK_PER_C * Math.max(0, q.required_c - next) +
      (value ? interpolate(value, low, next) : 0);
    // Ties keep the smaller heat, so equal plans never heat for nothing.
    if (total < best.total - 1e-9) best = { total, watts, next };
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
  const plan: RoomHeatingPlan = { power_w: [], temperature_c: [], shortfall_c: [] };
  let t = startC;
  quarters.forEach((q, i) => {
    const step = choose(t, q, values[i + 1] ?? null, low);
    plan.power_w.push(step.watts);
    plan.temperature_c.push(step.next);
    plan.shortfall_c.push(Math.max(0, q.required_c - step.next));
    t = step.next;
  });
  return plan;
}
