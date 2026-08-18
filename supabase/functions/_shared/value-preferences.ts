// Utility curves stated as three numbers a household actually has opinions
// about, instead of as marginal value per physical unit.
//
// ENERGY_OPTIMISATION_ARCHITECTURE.md §8.10 requires the curves to be supplied
// once and then left alone, which makes them worthless if nobody can state one.
// And nobody can: the shipped pool curve values a degree at 80 SEK falling to
// zero, and the only way to know whether 80 is sane is to already know that a
// 55 m³ pool takes about 14 kWh per degree. That is not a preference anyone
// holds; it is arithmetic wearing a preference's clothes.
//
// What a household does hold is three thresholds, in the unit it thinks in:
//
//   - **urgent_below** — under this I really want it dealt with, buy the energy
//   - **comfortable**  — this is where I would like it to sit
//   - **indifferent_above** — past this, do not bother on my account
//
// The levels are then arithmetic rather than taste, anchored to what the energy
// to move one unit actually costs. That is the whole trick: the customer states
// *where* the thresholds are and the physics states *what they are worth*, so a
// pool degree and a kilometre of range come out on the same footing without
// anyone converting anything by hand.

import type { UtilityCurve } from "./store-value.ts";

export interface StorePreference {
  /** Below this, the household wants the service enough to buy energy for it. */
  urgent_below: number;
  /** Where they would like the store to sit. */
  comfortable: number;
  /** Above this the service is worth nothing more to them. */
  indifferent_above: number;
}

export interface PreferenceScale {
  /**
   * Physical units one kWh of electricity buys in this store.
   *
   * Where the physics enters: a heat pump's COP over the pool's thermal mass,
   * or a vehicle's charging efficiency over its kWh/km. It is the reason the
   * same three thresholds mean different money on different equipment.
   */
  units_per_kwh: number;
  /**
   * The energy price the levels are anchored to, SEK per kWh.
   *
   * The home's own typical all-in import price. Callers should pass a measured
   * figure; `DEFAULT_REFERENCE_SEK_PER_KWH` exists only so a home with no price
   * history is still plannable, and is a fallback rather than a claim.
   */
  reference_sek_per_kwh: number;
}

/**
 * A placeholder Swedish all-in import price, used only where none is known.
 *
 * Deliberately not presented as measured (§1.3.1). The shape of the resulting
 * curve is unaffected by it — only the absolute level is, and the level only
 * matters relative to the prices the planner compares it against, which move
 * with it.
 */
export const DEFAULT_REFERENCE_SEK_PER_KWH = 2;

/**
 * How much more an urgently wanted unit is worth than an ordinary one.
 *
 * Three, so that the steep segment clears the dearest hour a household would
 * ever face rather than merely the average one. Below the urgent threshold the
 * planner will buy from the grid at almost any price, which is the intended
 * reading of "I really want this dealt with".
 */
const URGENT_MULTIPLE = 3;

/**
 * Turn three thresholds into the concave curve the planner consumes.
 *
 * The comfortable level is pinned at exactly what the energy costs, and that
 * single choice does most of the work: at the comfortable point the store will
 * take surplus and cheap grid but decline an expensive hour, which is what
 * "where I would like it to sit" means operationally. Above it the value falls
 * to zero at the indifference threshold, so a store past its band stops bidding
 * without needing a rule that says so.
 */
export function curveFromPreference(
  preference: StorePreference,
  unit: string,
  scale: PreferenceScale,
): UtilityCurve {
  const unitsPerKwh = Math.max(1e-9, scale.units_per_kwh);
  const reference = Math.max(0, scale.reference_sek_per_kwh);
  // SEK of electricity to move this store one physical unit. Every level below
  // is a multiple of it, which is what keeps a degree and a kilometre
  // comparable without anyone doing the conversion by hand.
  const costPerUnit = reference / unitsPerKwh;
  return {
    unit,
    points: [
      {
        at: round(preference.urgent_below),
        sek_per_unit: round(URGENT_MULTIPLE * costPerUnit),
      },
      {
        at: round(preference.comfortable),
        sek_per_unit: round(costPerUnit),
      },
      // Ends at zero rather than at a positive value, so the top of the curve
      // is a slope rather than a cliff: `marginalValue` interpolates, and a
      // curve stopping above zero drops straight to nothing at its last point.
      { at: round(preference.indifferent_above), sek_per_unit: 0 },
    ],
  };
}

/**
 * Read three thresholds back out of a curve this module generated.
 *
 * Exact, because the thresholds *are* its breakpoints: nothing is inverted and
 * no scale is needed, so opening the editor and saving without touching
 * anything cannot drift.
 *
 * Null for any other shape, and deliberately so. An earlier version guessed at
 * hand-written curves by taking the most valuable interior breakpoint, which
 * reads the pool default correctly and the vehicle default wrongly: the
 * vehicle's second point exists to end the range-anxiety ramp, not to mark the
 * band the household wants, so the editor would have opened claiming they
 * wanted 120 km when the curve means 400. A caller with no preference to read
 * should fall back to a stated default rather than to an inference.
 */
export function preferenceFromCurve(
  curve: UtilityCurve,
): StorePreference | null {
  const points = curve.points;
  if (points.length !== 3) return null;
  return {
    urgent_below: points[0].at,
    comfortable: points[1].at,
    indifferent_above: points[2].at,
  };
}

/**
 * The pool thresholds the shipped default curve was written to express.
 *
 * Stated rather than inferred, for the reason above. The numbers are the
 * shipped curve's own breakpoints, so a home that has never opened the editor
 * and one that opens and saves it unchanged behave the same way.
 */
export const DEFAULT_POOL_PREFERENCE: StorePreference = {
  urgent_below: 25,
  comfortable: 28,
  indifferent_above: 31,
};

/**
 * Vehicle thresholds scaled to the range this customer actually asked for.
 *
 * An absolute kilometre figure means nothing across vehicles, so the charge
 * limit is the statement of how much range is wanted and the other two
 * thresholds are read off it: anxiety below a third of it, indifference a
 * little beyond. Stating it over range rather than state of charge is what
 * makes winter automatic (§8.3) — the same limit buys fewer kilometres when
 * consumption rises, so the car lands further up the steep part with no
 * seasonal parameter anywhere.
 */
export function vehiclePreference(targetRangeKm: number): StorePreference {
  const target = Math.max(20, targetRangeKm);
  return {
    urgent_below: Math.round(target * 0.3),
    comfortable: Math.round(target),
    indifferent_above: Math.round(target * 1.3),
  };
}

/**
 * Reject thresholds that do not describe a store, before they reach a curve.
 *
 * Strictly increasing, because the three numbers are the breakpoints: equal or
 * reversed values produce a curve `validateCurve` would refuse, and a customer
 * should be told which of their own numbers is wrong rather than shown a
 * concavity error about a curve they never saw.
 */
export function validatePreference(
  preference: StorePreference,
): string | null {
  const values = [
    preference.urgent_below,
    preference.comfortable,
    preference.indifferent_above,
  ];
  if (values.some((value) => !Number.isFinite(value))) {
    return "every threshold must be a number";
  }
  if (!(preference.urgent_below < preference.comfortable)) {
    return "the urgent threshold must be below the comfortable one";
  }
  if (!(preference.comfortable < preference.indifferent_above)) {
    return "the comfortable threshold must be below the indifference one";
  }
  return null;
}

const round = (value: number) => Math.round(value * 1e6) / 1e6;
