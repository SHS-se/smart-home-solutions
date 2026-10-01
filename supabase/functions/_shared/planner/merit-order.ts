// A store's value curve from one target and the energy on offer.
//
// The owner states where a store should sit: the pool at 30 °C, the car at
// 300 km. What a degree or a kilometre is then worth is not a preference, it
// is arithmetic: what it costs to supply. Every quarter of the horizon offers
// the store some energy, surplus solar at what exporting it would have earned
// and grid import at its price, and each kWh buys more or less of the store
// depending on the quarter (a heat pump's COP follows the air). Sorted
// cheapest first by what a unit of the store costs, those offers are a supply
// stack, a merit order.
//
// To end the horizon at its target the store needs `need` units: what it is
// short of the target now, plus what it loses on the way (`upkeep`). The value
// of a unit at the target is the price of the last unit of that need, the
// clearing price. A store that would end below the target values a unit at
// what the next, dearer offers cost; one that would end above it, at what the
// cheaper ones did; and nothing once it holds more than it needs. A planner
// bidding with this curve buys exactly the cheapest offers that cover the
// need, which is the point.
//
// It prices against quantities, not only prices: a short sunny hour does not
// make every degree cheap, and a cold night makes each of them dearer. What it
// leaves to the dispatch is timing within the horizon: heat bought early has
// partly leaked by the end, and the dispatch already accounts for that.

import type { UtilityCurve } from "./store-value.ts";

/** Energy one quarter can supply to the store, at one price. */
export interface SupplyOffer {
  /** Electricity on offer, kWh. */
  kwh: number;
  sek_per_kwh: number;
  /** Units of the store one kWh buys in that quarter. */
  units_per_kwh: number;
}

export interface MeritOrderInput {
  /** The curve's unit, e.g. "celsius" or "km". */
  unit: string;
  target: number;
  /** The store's state now. */
  state: number;
  /** Units the store loses over the horizon while held at its target. */
  upkeep: number;
  /** Spacing of the curve's points below the target, in store units. */
  step: number;
  /** The lowest state the curve describes; 0 for a store that cannot go below empty. */
  floor?: number;
  offers: readonly SupplyOffer[];
  /** Multiplies every value: 1 unless an administrator has turned the store up or down. */
  scale: number;
}

export interface MeritOrderEvidence {
  method: "merit_order";
  /** Units needed to end the horizon at the target. */
  need: number;
  upkeep: number;
  /** Price of the last unit of that need, SEK per unit, before `scale`. */
  clearing_sek_per_unit: number;
  /** Units the whole horizon could supply. */
  supply: number;
  scale: number;
}

const round = (value: number, digits = 6) => Number(value.toFixed(digits));

export function meritOrderCurve(input: MeritOrderInput): {
  curve: UtilityCurve;
  evidence: MeritOrderEvidence;
  /** kWh of each offer, in the order given, that covering the need takes: what is no longer on offer to the next store. */
  cleared_kwh: number[];
} {
  const stack = input.offers
    .map((offer, index) => ({ offer, index }))
    .filter(({ offer }) => offer.kwh > 0 && offer.units_per_kwh > 0 && Number.isFinite(offer.sek_per_kwh))
    .map(({ offer, index }) => ({
      index, units: offer.kwh * offer.units_per_kwh, units_per_kwh: offer.units_per_kwh,
      sek_per_unit: Math.max(0, offer.sek_per_kwh) / offer.units_per_kwh,
    }))
    .sort((a, b) => a.sek_per_unit - b.sek_per_unit);
  const supply = stack.reduce((sum, offer) => sum + offer.units, 0);

  /** What the last of `units` costs when bought cheapest first; the dearest offer once supply runs out. */
  const priceAt = (units: number): number => {
    if (units <= 0 || stack.length === 0) return 0;
    let cumulative = 0;
    for (const offer of stack) {
      cumulative += offer.units;
      if (cumulative >= units) return offer.sek_per_unit;
    }
    return stack[stack.length - 1].sek_per_unit;
  };

  const need = Math.max(0, input.target - input.state + input.upkeep);
  // At state x the store still needs `need + (target - x)` to end on target.
  const value = (state: number) => input.scale * priceAt(need + input.target - state);
  const step = Math.max(1e-6, input.step);
  const surplusEnd = input.target + need;
  const ats = [
    ...[8, 4, 2, 1].map(multiple => input.target - multiple * step),
    input.target,
    ...(need > 0 ? [input.target + need / 2, surplusEnd - Math.min(step, need) / 100] : []),
  ];
  const points = ats.filter(at => at >= (input.floor ?? Number.NEGATIVE_INFINITY))
    .map(at => ({ at: round(at), sek_per_unit: round(value(at)) }));
  // Past what it needs, more is worth nothing.
  points.push({ at: round(Math.max(surplusEnd, input.target + step / 100)), sek_per_unit: 0 });

  // Strictly rising states and never-rising values, whatever the offers were.
  const curve: UtilityCurve["points"] = [];
  for (const point of points) {
    const last = curve[curve.length - 1];
    if (last && point.at <= last.at) continue;
    curve.push({ at: point.at, sek_per_unit: last ? Math.min(last.sek_per_unit, point.sek_per_unit) : point.sek_per_unit });
  }
  const cleared = new Array(input.offers.length).fill(0);
  let left = need;
  for (const offer of stack) {
    if (left <= 0) break;
    const units = Math.min(offer.units, left);
    cleared[offer.index] = units / offer.units_per_kwh;
    left -= units;
  }
  return {
    cleared_kwh: cleared,
    curve: { unit: input.unit, points: curve },
    evidence: {
      method: "merit_order", need: round(need, 3), upkeep: round(input.upkeep, 3),
      clearing_sek_per_unit: round(priceAt(need)), supply: round(supply, 3), scale: input.scale,
    },
  };
}

/** One quarter's energy for a store drawing up to `max_w`: surplus solar first, then the grid. */
export function quarterOffers(quarter: {
  hours: number;
  /** Solar left after the fixed load, W. */
  surplus_w: number;
  import_sek_per_kwh: number;
  export_sek_per_kwh: number;
  max_w: number;
  units_per_kwh: number;
}): SupplyOffer[] {
  const surplusW = Math.max(0, Math.min(quarter.surplus_w, quarter.max_w));
  const importW = Math.max(0, quarter.max_w - surplusW);
  return [
    // Using surplus costs what exporting it would have earned.
    { kwh: surplusW * quarter.hours / 1_000, sek_per_kwh: Math.min(quarter.export_sek_per_kwh, quarter.import_sek_per_kwh), units_per_kwh: quarter.units_per_kwh },
    { kwh: importW * quarter.hours / 1_000, sek_per_kwh: quarter.import_sek_per_kwh, units_per_kwh: quarter.units_per_kwh },
  ];
}
