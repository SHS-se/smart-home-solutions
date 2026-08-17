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
 * Below the first breakpoint the first segment's value applies, and above the
 * last it is zero — a store past the top of its curve is full in the only sense
 * that matters, and further energy into it is worth nothing. That is how "the
 * top fifth of the battery is not worth buying from the grid" and "10–12 kWh
 * carries a summer night" arrive without either being configured.
 */
export function marginalValue(curve: UtilityCurve, at: number): number {
  const points = curve.points;
  if (points.length === 0) return 0;
  if (at < points[0].at) return points[0].sek_per_unit;
  for (let index = 0; index < points.length; index += 1) {
    if (at < points[index].at) return points[index].sek_per_unit;
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
  for (const point of points) {
    if (at <= point.at) return point.sek_per_unit;
  }
  return points[points.length - 1].sek_per_unit;
}

/** Total utility of holding `at` units, the integral of the marginal value. */
export function totalUtility(curve: UtilityCurve, at: number): number {
  const points = curve.points;
  if (points.length === 0 || at <= 0) return 0;
  let total = 0;
  let previous = 0;
  for (const point of points) {
    const upper = Math.min(at, point.at);
    if (upper > previous) total += (upper - previous) * point.sek_per_unit;
    previous = Math.max(previous, point.at);
    if (at <= point.at) break;
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

  // How much of the store the sun is expected to replace for free. That energy
  // is worth nothing to hold, because holding it displaces nothing — it simply
  // occupies room that tomorrow's surplus would have filled.
  const replacedKwh = Math.max(0, Math.min(usableKwh, futureSurplusKwh));
  const scarceKwh = Math.max(0, Math.min(usableKwh - replacedKwh, usableKwh));
  const coveringKwh = Math.max(0, Math.min(expectedDrawKwh, scarceKwh));

  const points: { at: number; sek_per_unit: number }[] = [];
  if (coveringKwh > 0) {
    // Displacing the dearest import ahead, less the wear of the cycle.
    points.push({
      at: coveringKwh,
      sek_per_unit: Math.max(0, dear / efficiency - degradationSekPerKwh),
    });
  }
  if (scarceKwh > coveringKwh) {
    points.push({
      at: scarceKwh,
      sek_per_unit: Math.max(
        0,
        Math.min(
          median / efficiency,
          points[0]?.sek_per_unit ?? median / efficiency,
        ) - degradationSekPerKwh,
      ),
    });
  }
  if (usableKwh > scarceKwh) {
    // Energy the forecast says will be free tomorrow. Worth the cheapest price
    // ahead at most, and often nothing.
    points.push({
      at: usableKwh,
      sek_per_unit: Math.max(
        0,
        Math.min(
          cheapest / efficiency - degradationSekPerKwh,
          points[points.length - 1]?.sek_per_unit ?? 0,
        ),
      ),
    });
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
