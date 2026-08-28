// Concave utility over stored state, and the marginal value that follows.
//
// ENERGY_OPTIMISATION_ARCHITECTURE.md §8.2–§8.4. This is the module that makes
// the objective well-posed: cost minimisation alone is degenerate, because the
// cheapest possible month is achieved by turning everything off. Pricing the
// service alongside the energy is what removes that, and it is also what
// removes every operating knob — the end-of-solar SOC target, the export floor
// price, the reserve SOC and the static priority stack are all proxies for the
// comparison this module performs directly.
//
// Two properties carry the whole design.
//
// **Concavity.** The first kWh into an empty store is worth far more than the
// last kWh into a nearly full one. That is what makes "marginal value" a
// meaningful quantity, and it is exactly representable as piecewise-linear
// segments — so the resulting problem stays linear and the sophistication costs
// nothing in solve time.
//
// **Comparability.** Every curve is denominated in SEK per unit of physical
// state, so a pool degree and a vehicle kilometre and a stored kWh can be
// ranked against each other and against the price of buying the energy. There
// is no priority ordering anywhere; priority is an *output*, obtained by
// sorting marginal values (§8.9).

/**
 * One concave utility curve, given as breakpoints over a physical state.
 *
 * Points must be sorted by `at` and have non-increasing `sek_per_unit`, which
 * is concavity stated as data. A rising marginal value would mean "the fuller
 * it is, the more another unit is worth", which no store in a house behaves
 * like and which would let a solver justify filling something without limit.
 */
export interface UtilityCurve {
  /** What the curve is over: "kwh", "celsius", "km". Carried for display. */
  unit: string;
  points: { at: number; sek_per_unit: number }[];
}

export interface CurveRejection {
  reason:
    | "no_points"
    | "unsorted"
    | "negative_value"
    | "not_concave"
    | "not_finite";
  detail: string;
}

const finite = (value: number) => Number.isFinite(value);

interface CompiledCurve {
  /** Total utility at each corresponding curve breakpoint. */
  utilityAtPoint: number[];
}

// Curves are immutable planning inputs. Dispatch asks for their value many
// thousands of times, so compile the integral once instead of rescanning every
// preceding segment for every candidate. A WeakMap keeps the cache scoped to
// the curve's lifetime and cannot retain completed plans.
const compiledCurves = new WeakMap<UtilityCurve, CompiledCurve>();

const compileCurve = (curve: UtilityCurve): CompiledCurve => {
  const cached = compiledCurves.get(curve);
  if (cached) return cached;
  const utilityAtPoint: number[] = [];
  const points = curve.points;
  if (points.length > 0) {
    utilityAtPoint[0] = Math.max(0, points[0].at) * points[0].sek_per_unit;
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1];
      const next = points[index];
      utilityAtPoint[index] = utilityAtPoint[index - 1] +
        (next.at - previous.at) *
          (previous.sek_per_unit + next.sek_per_unit) / 2;
    }
  }
  const compiled = { utilityAtPoint };
  compiledCurves.set(curve, compiled);
  return compiled;
};

/** Index of the first breakpoint at or above `at`, or points.length. */
const breakpointAtOrAbove = (
  points: UtilityCurve["points"],
  at: number,
): number => {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (points[middle].at < at) low = middle + 1;
    else high = middle;
  }
  return low;
};

/** Validate concavity and ordering; a bad curve must never reach the solver. */
export function validateCurve(curve: UtilityCurve): CurveRejection | null {
  const points = curve.points;
  if (points.length === 0) {
    return {
      reason: "no_points",
      detail: "a curve needs at least one segment",
    };
  }
  for (const point of points) {
    if (!finite(point.at) || !finite(point.sek_per_unit)) {
      return { reason: "not_finite", detail: `${point.at}` };
    }
    if (point.sek_per_unit < 0) {
      return {
        reason: "negative_value",
        detail: `${point.sek_per_unit} at ${point.at}`,
      };
    }
  }
  for (let index = 1; index < points.length; index += 1) {
    if (points[index].at <= points[index - 1].at) {
      return {
        reason: "unsorted",
        detail: `${points[index - 1].at} then ${points[index].at}`,
      };
    }
    if (points[index].sek_per_unit > points[index - 1].sek_per_unit + 1e-12) {
      return {
        reason: "not_concave",
        detail: `marginal value rises from ${
          points[index - 1].sek_per_unit
        } to ${points[index].sek_per_unit}`,
      };
    }
  }
  return null;
}

/**
 * Marginal value of one more unit of state, in SEK per unit.
 *
 * Interpolated between breakpoints rather than held constant across them, so
 * the curve declines continuously and two stores can be ranked against each
 * other at any state. A piecewise-*constant* marginal value — the derivative of
 * piecewise-linear utility — is what an LP formulation needs, but this planner
 * dispatches greedily on marginal value directly, so it is free to use the
 * smoother function and gets finer prioritisation for it. With a step, every
 * temperature between two breakpoints bid identically and a pool at 25.1 °C
 * was indistinguishable from one at 27.9 °C.
 *
 * Above the last breakpoint the value is zero: a store past the top of its
 * curve is full in the only sense that matters. Curves should therefore end at
 * or near zero, or that transition is a cliff rather than a slope.
 */
export function marginalValue(curve: UtilityCurve, at: number): number {
  const points = curve.points;
  if (points.length === 0) return 0;
  // Flat below the first breakpoint: the first unit into an empty store is
  // worth what the curve says, and there is nothing below it to interpolate to.
  if (at <= points[0].at) return points[0].sek_per_unit;
  const index = breakpointAtOrAbove(points, at);
  if (index >= points.length) return 0;
  const previous = points[index - 1];
  const next = points[index];
  const span = next.at - previous.at;
  if (span <= 0) return next.sek_per_unit;
  const ratio = (at - previous.at) / span;
  return previous.sek_per_unit +
    (next.sek_per_unit - previous.sek_per_unit) * ratio;
}

/**
 * Value of the last unit **already held**, which is not the same question.
 *
 * `marginalValue` answers "what is the next unit worth?" and correctly returns
 * zero above the top of the curve: a full store should buy nothing. But asking
 * the same function what a full store's charge is worth to *give up* returns
 * zero too, and a battery that values its charge at nothing will discharge into
 * any positive price — filling from the grid and emptying again in a loop.
 *
 * The sell side must therefore read the segment the last held unit sits in,
 * which is the one ending at or above the current state.
 */
export function marginalValueHeld(curve: UtilityCurve, at: number): number {
  const points = curve.points;
  if (points.length === 0 || at <= 0) return 0;
  const last = points[points.length - 1];
  // Above the domain the buy side is zero, but what is *held* there is still
  // worth the top of the curve. Returning zero made a full battery value its
  // charge at nothing and discharge into any positive price.
  if (at >= last.at) return last.sek_per_unit;
  return marginalValue(curve, at);
}

/** Total utility of holding `at` units, the integral of the marginal value. */
export function totalUtility(curve: UtilityCurve, at: number): number {
  const points = curve.points;
  if (points.length === 0 || at <= 0) return 0;
  const first = points[0];
  if (at <= first.at) return at * first.sek_per_unit;

  const { utilityAtPoint } = compileCurve(curve);
  const index = breakpointAtOrAbove(points, at);
  if (index >= points.length) return utilityAtPoint[points.length - 1];
  const previous = points[index - 1];
  const next = points[index];
  const span = at - previous.at;
  if (span <= 0) return utilityAtPoint[index - 1];
  const valueAtUpper = previous.sek_per_unit +
    (next.sek_per_unit - previous.sek_per_unit) *
      (span / (next.at - previous.at));
  return utilityAtPoint[index - 1] +
    span * (previous.sek_per_unit + valueAtUpper) / 2;
}

/**
 * Value of moving a store from one state to another. Negative when giving up.
 *
 * This is the quantity a dispatch decision is judged on, so it must be the
 * exact difference of the integral rather than the marginal value times the
 * step — otherwise a large move is mispriced by the curvature that motivated
 * having a curve at all.
 */
export function valueOfMove(
  curve: UtilityCurve,
  from: number,
  to: number,
): number {
  return totalUtility(curve, to) - totalUtility(curve, from);
}

// ---------------------------------------------------------------------------
// The battery's curve is derived, never configured
// ---------------------------------------------------------------------------

export interface StoredEnergyValueInput {
  /** Shadow import prices of the covering window, in any order. */
  futureImportSekPerKwh: number[];
  /**
   * Stored-energy equivalent of the residual load at each price, kWh. The
   * curve takes the dearest kWh first — the merit order of the imports stored
   * energy displaces.
   */
  futureImportKwh: number[];
  /** Forecast surplus PV, in kWh, over the same remaining horizon. */
  futureSurplusKwh: number;
  /** Usable capacity between min and max SOC, kWh. */
  usableKwh: number;
  /**
   * Discharge efficiency, and deliberately not the round trip.
   *
   * The curve answers one question: what is a kilowatt-hour *in the battery*
   * worth. One stored kWh delivers `dischargeEfficiency` kWh to the house, each
   * displacing an import, so that is the whole conversion — the charge side
   * never enters, because this is not the value of *acquiring* a kWh.
   *
   * It was the round trip, and both efficiencies were then applied a second
   * time by the dispatch, which already converts on the flow: `units_per_kwh`
   * multiplies a charge by `charge_efficiency`, and `state_per_kwh_out` divides
   * a discharge by `discharge_efficiency`. Dividing by the round trip here
   * counted them again and in the wrong direction, inflating a stored kWh by
   * `1 / (charge × discharge²)` — about 17% on a 95/95 pack.
   *
   * The consequence was one-way. Discharging then required the present hour to
   * beat the hour the curve was priced against by that same 17%, and since the
   * curve prices the battery at the *dearest* hours it can cover, no such hour
   * exists by construction: a battery in a no-solar winter horizon charged 15
   * kWh and discharged in none of 288 quarters. Charging was the mirror error,
   * clearing at any price below `P / discharge` where the true break-even is
   * `P × charge × discharge`, so it hoarded at prices that never paid back.
   */
  dischargeEfficiency: number;
  /** Wear cost per kWh of throughput, SEK. */
  degradationSekPerKwh: number;
  /** Expected residual load to be covered before the next surplus, kWh. */
  expectedDrawKwh: number;
  /**
   * Energy the household wants kept back, kWh above the hard floor.
   *
   * `terminal_soc_min` expressed in the curve's own units. Zero leaves the
   * curve exactly as the merit order builds it.
   */
  reserveKwh: number;
  /**
   * The dearest hour anywhere in the horizon, SEK/kWh — what the reserve is
   * priced at, and the reason it needs no number from the customer.
   *
   * A reserve is insurance against the plan being wrong: a spike the forecast
   * did not carry, or a peak event. What it is worth is therefore not what the
   * *expected* path costs — the merit order already prices that — but what the
   * worst hour on the board costs, because that is the thing having nothing
   * left would expose the household to.
   *
   * It is self-limiting in the way a reserve should be. The battery will not go
   * below it for an ordinary dear hour, and it *will* for one at the horizon's
   * worst, which is precisely the event the reserve was being kept for. So it
   * is never a floor the plan cannot cross, and it never has to be, which is
   * what stops it re-becoming the hard target §8.4 deleted.
   */
  worstImportSekPerKwh: number;
}

/**
 * Build the house battery's utility curve from forecasts, not from a target.
 *
 * §8.4: the marginal value of stored energy is the expected cost of replacing
 * it later — the price distribution ahead, grossed up by the round trip,
 * weighted by the chance that free surplus does not arrive first. Every energy
 * setting a customer would otherwise maintain falls out of this one function:
 *
 * - "keep 80% by end of solar" becomes wherever the curve happens to sit;
 * - "export above X SEK" becomes "export when the price beats the curve";
 * - "reserve Y%" becomes the steep first segment, which nothing outbids.
 *
 * The covering band is the merit order of the imports stored energy displaces:
 * the first kWh is worth the dearest hour of the coming night, the last kWh of
 * covering is worth the cheapest of the hours it actually avoids. Pricing the
 * whole band at the peak — the two-level step this replaced — made the battery
 * grid-charge overnight in one burst (every covering kWh looked like the
 * spike) and then refuse the next day's surplus (the pack was already full,
 * and the room above covering was worth nothing). Energy the sun will replace
 * tomorrow anyway is still worth nothing at all, which is when exporting into
 * a high price is correct.
 */
export function batteryValueCurve(
  input: StoredEnergyValueInput,
): UtilityCurve {
  const {
    futureImportSekPerKwh,
    futureImportKwh,
    futureSurplusKwh,
    usableKwh,
    dischargeEfficiency,
    degradationSekPerKwh,
    expectedDrawKwh,
    reserveKwh,
    worstImportSekPerKwh,
  } = input;
  if (usableKwh <= 0 || futureImportSekPerKwh.length === 0) {
    return { unit: "kwh", points: [] };
  }
  if (futureImportKwh.length !== futureImportSekPerKwh.length) {
    throw new Error(
      "futureImportKwh must have one residual-load value per import price",
    );
  }
  if (
    futureImportSekPerKwh.some((value) => !Number.isFinite(value)) ||
    futureImportKwh.some((value) => !Number.isFinite(value) || value < 0)
  ) {
    throw new Error(
      "future import prices and residual-load values must be finite",
    );
  }
  const weightedDrawKwh = futureImportKwh.reduce(
    (total, value) => total + value,
    0,
  );
  if (Math.abs(weightedDrawKwh - expectedDrawKwh) > 1e-6) {
    throw new Error(
      "futureImportKwh must sum to expectedDrawKwh",
    );
  }
  const efficiency = Math.min(1, Math.max(0.05, dischargeEfficiency));
  const sorted = [...futureImportSekPerKwh].sort((a, b) => b - a);
  const median = sorted[Math.floor(sorted.length / 2)];
  const cheapest = sorted[sorted.length - 1];
  const netValue = (sek: number) =>
    Math.max(0, sek * efficiency - degradationSekPerKwh);

  // The energy that covers the draw before the next surplus arrives. This
  // segment survives however sunny tomorrow is, and an earlier version of this
  // function got that wrong: it subtracted forecast surplus from the *whole*
  // pack first, so a sunny forecast collapsed the entire curve to zero and the
  // battery refused to charge at all. Tomorrow's sun cannot power tonight, so
  // the charge that displaces tonight's import is worth the import it displaces
  // no matter what the forecast says.
  const coveringKwh = Math.max(0, Math.min(expectedDrawKwh, usableKwh));

  const points: { at: number; sek_per_unit: number }[] = [];

  // The reserve sits under the merit order rather than beside it: the same
  // kilowatt-hours serve both, and what the reserve changes is only what the
  // bottom of the pack is worth. Appending it first means the merit order takes
  // over above it — `appendBand` drops any band that would land below a
  // breakpoint already placed — so a covering window dearer than the worst hour
  // cannot happen and a cheaper one simply starts higher up the pack.
  const reserve = Math.max(0, Math.min(reserveKwh, usableKwh));
  if (reserve > 0 && Number.isFinite(worstImportSekPerKwh)) {
    appendBand(points, reserve, netValue(worstImportSekPerKwh));
  }

  const slices = futureImportSekPerKwh
    .map((sek, index) => ({
      sek,
      kwh: futureImportKwh[index],
    }))
    .filter((slice) => slice.kwh > 0 && Number.isFinite(slice.sek))
    .sort((a, b) => b.sek - a.sek || b.kwh - a.kwh);

  if (coveringKwh > 0 && slices.length > 0) {
    let filled = 0;
    for (const slice of slices) {
      if (filled >= coveringKwh - 1e-12) break;
      const take = Math.min(slice.kwh, coveringKwh - filled);
      if (take <= 1e-12) continue;
      filled += take;
      appendBand(points, filled, netValue(slice.sek));
    }
  }

  const filledTo = points.length > 0 ? points[points.length - 1].at : 0;
  if (usableKwh > filledTo + 1e-12) {
    // Everything above the covering band. If the forecast says the sun will
    // refill this room anyway, holding it displaces nothing and it is worth the
    // cheapest price ahead at most — often nothing, which is exactly when
    // exporting into a spike is right.
    const remainingKwh = usableKwh - filledTo;
    const refilledBySun = futureSurplusKwh >= remainingKwh;
    const level = (refilledBySun ? cheapest : median) * efficiency;
    // Cap at the *last* covering value, not the first: remaining used to be
    // compared to the dearest hour, which with a two-level step was the only
    // covering value. Under merit order that would let remaining rise above
    // the cheap end of covering and break concavity.
    const lastCovering = points[points.length - 1]?.sek_per_unit ??
      Number.POSITIVE_INFINITY;
    const top = Math.max(
      0,
      Math.min(level - degradationSekPerKwh, lastCovering),
    );
    appendBand(points, usableKwh, top);
  }
  return { unit: "kwh", points };
}

/**
 * Append a concave band: a short drop to `value`, then flat through `at`.
 *
 * Marginal value is interpolated between breakpoints, which is right for a
 * household's own preference — warmth and range decline smoothly. The
 * battery's curve is derived rather than stated, and neighbouring prices in
 * the merit order are genuinely separate hours: sloping across a whole cheap
 * band would price kWh that only displace that band as though they were still
 * part of the spike, which is the two-level step in miniature. A short
 * transition keeps the interpolation honest without a true discontinuity.
 */
function appendBand(
  points: { at: number; sek_per_unit: number }[],
  at: number,
  value: number,
): void {
  if (at <= 0 || !Number.isFinite(at) || !Number.isFinite(value)) return;
  const sek = Math.max(0, value);
  if (points.length === 0) {
    points.push({ at, sek_per_unit: sek });
    return;
  }
  const previous = points[points.length - 1];
  if (at <= previous.at + 1e-12) return;
  if (sek >= previous.sek_per_unit - 1e-12) {
    previous.at = at;
    return;
  }
  const span = at - previous.at;
  const transitionAt = previous.at + Math.min(0.01, span);
  if (transitionAt > previous.at + 1e-12) {
    points.push({ at: transitionAt, sek_per_unit: sek });
  }
  if (at > transitionAt + 1e-12) {
    points.push({ at, sek_per_unit: sek });
  }
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

export interface StoreState {
  key: string;
  curve: UtilityCurve;
  /** Current physical state, in the curve's own units. */
  at: number;
  /** Physical units gained per kWh of electricity delivered now. */
  unitsPerKwh: number;
}

export interface RankedStore {
  key: string;
  /** SEK per kWh of electricity, which is directly comparable to price. */
  sekPerKwh: number;
}

/**
 * Rank stores by what a kWh of electricity is worth to each, right now.
 *
 * This replaces the priority stack outright (§8.9). A fixed order cannot
 * express a reversal, and reversals are the normal case: the car outranks the
 * pool at 30% state of charge and stops outranking it near full. Converting
 * each store's marginal utility into SEK per kWh of *electricity* is what makes
 * them comparable — it is where the pool heat pump's COP and the vehicle's
 * kWh/km enter, so a warm spring afternoon genuinely does raise the pool's
 * standing against the car.
 */
export function rankStores(stores: StoreState[]): RankedStore[] {
  return stores
    .map((store) => ({
      key: store.key,
      sekPerKwh: marginalValue(store.curve, store.at) * store.unitsPerKwh,
    }))
    .sort((a, b) => b.sekPerKwh - a.sekPerKwh || a.key.localeCompare(b.key));
}

/**
 * Should this store take a kWh at this price?
 *
 * The entire buying rule, and the whole of §8.12's heuristic 6: buy when the
 * price is below the marginal utility of a sink. Nothing else is consulted —
 * not the season, not the time of day, not a priority table.
 */
export function worthBuying(
  store: StoreState,
  priceSekPerKwh: number,
): boolean {
  return marginalValue(store.curve, store.at) * store.unitsPerKwh >
    priceSekPerKwh;
}

/**
 * Should stored energy be exported at this price rather than kept?
 *
 * Replaces `battery_export_min_price_sek_per_kwh`. A fixed floor cannot know
 * that the same 2 SEK spike is a good trade before a sunny day and a poor one
 * before a dark week; this comparison does, because the curve was built from
 * the forecast.
 */
export function worthExporting(
  store: StoreState,
  exportPriceSekPerKwh: number,
): boolean {
  return exportPriceSekPerKwh >
    marginalValue(store.curve, store.at) * store.unitsPerKwh;
}
