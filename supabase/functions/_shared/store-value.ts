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

/** Validate concavity and ordering; a bad curve must never reach the solver. */
export function validateCurve(curve: UtilityCurve): CurveRejection | null {
  const points = curve.points;
  if (points.length === 0) {
    return { reason: "no_points", detail: "a curve needs at least one segment" };
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
        detail:
          `marginal value rises from ${points[index - 1].sek_per_unit} to ${
            points[index].sek_per_unit
          }`,
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
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const next = points[index];
    if (at <= next.at) {
      const span = next.at - previous.at;
      if (span <= 0) return next.sek_per_unit;
      const ratio = (at - previous.at) / span;
      return previous.sek_per_unit +
        (next.sek_per_unit - previous.sek_per_unit) * ratio;
    }
  }
  return 0;
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
  // Rectangle below the first breakpoint, then trapezoids between them, because
  // the marginal value is now a sloped line rather than a flat step.
  let total = 0;
  const first = points[0];
  const flatTo = Math.min(at, first.at);
  if (flatTo > 0) total += flatTo * first.sek_per_unit;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const next = points[index];
    if (at <= previous.at) break;
    const upper = Math.min(at, next.at);
    const span = upper - previous.at;
    if (span <= 0) continue;
    const valueAtUpper = marginalValue(curve, upper);
    total += span * (previous.sek_per_unit + valueAtUpper) / 2;
  }
  return total;
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
  /** Shadow import prices for the remaining horizon, cheapest first is fine. */
  futureImportSekPerKwh: number[];
  /** Forecast surplus PV, in kWh, over the same remaining horizon. */
  futureSurplusKwh: number;
  /** Usable capacity between min and max SOC, kWh. */
  usableKwh: number;
  /** Round-trip efficiency, charge × discharge. */
  roundTrip: number;
  /** Wear cost per kWh of throughput, SEK. */
  degradationSekPerKwh: number;
  /** Expected residual load to be covered before the next surplus, kWh. */
  expectedDrawKwh: number;
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
 * The shape is two segments and a tail. Energy up to the expected overnight
 * draw is worth the *expensive* end of the coming prices, because that is what
 * it displaces. Energy beyond that is worth progressively less, and energy the
 * sun will replace tomorrow anyway is worth nothing at all — which is precisely
 * when exporting into a high price is correct.
 */
export function batteryValueCurve(
  input: StoredEnergyValueInput,
): UtilityCurve {
  const {
    futureImportSekPerKwh,
    futureSurplusKwh,
    usableKwh,
    roundTrip,
    degradationSekPerKwh,
    expectedDrawKwh,
  } = input;
  if (usableKwh <= 0 || futureImportSekPerKwh.length === 0) {
    return { unit: "kwh", points: [] };
  }
  const efficiency = Math.max(0.05, roundTrip);
  const sorted = [...futureImportSekPerKwh].sort((a, b) => b - a);
  const dear = sorted[0];
  const median = sorted[Math.floor(sorted.length / 2)];
  const cheapest = sorted[sorted.length - 1];

  // The energy that covers the draw before the next surplus arrives. This
  // segment survives however sunny tomorrow is, and an earlier version of this
  // function got that wrong: it subtracted forecast surplus from the *whole*
  // pack first, so a sunny forecast collapsed the entire curve to zero and the
  // battery refused to charge at all. Tomorrow's sun cannot power tonight, so
  // the charge that displaces tonight's import is worth the import it displaces
  // no matter what the forecast says.
  const coveringKwh = Math.max(0, Math.min(expectedDrawKwh, usableKwh));

  const points: { at: number; sek_per_unit: number }[] = [];
  if (coveringKwh > 0) {
    // Displacing the dearest import ahead, less the wear of the cycle.
    points.push({
      at: coveringKwh,
      sek_per_unit: Math.max(0, dear / efficiency - degradationSekPerKwh),
    });
  }
  if (usableKwh > coveringKwh) {
    // Everything above the covering band. If the forecast says the sun will
    // refill this room anyway, holding it displaces nothing and it is worth the
    // cheapest price ahead at most — often nothing, which is exactly when
    // exporting into a spike is right.
    const remainingKwh = usableKwh - coveringKwh;
    const refilledBySun = futureSurplusKwh >= remainingKwh;
    const level = (refilledBySun ? cheapest : median) / efficiency;
    const top = Math.max(
      0,
      Math.min(
        level - degradationSekPerKwh,
        points[0]?.sek_per_unit ?? Number.POSITIVE_INFINITY,
      ),
    );
    // A short transition, then flat.
    //
    // Marginal value is interpolated between breakpoints, which is right for a
    // household's own preference — warmth and range decline smoothly. The
    // battery's curve is derived rather than stated, and its two regimes are
    // genuinely separate: energy below the expected draw displaces tonight's
    // import, energy above it is refilled by tomorrow's sun. Sloping straight
    // between them would price the kWh just above the covering band as though
    // it were half of tonight's, and the battery would hold charge it should
    // have sold.
    const transition = Math.min(
      usableKwh,
      coveringKwh + Math.max(0.01, usableKwh * 0.1),
    );
    if (transition > coveringKwh) {
      points.push({ at: transition, sek_per_unit: top });
    }
    if (usableKwh > transition) {
      points.push({ at: usableKwh, sek_per_unit: top });
    }
  }
  return { unit: "kwh", points };
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
