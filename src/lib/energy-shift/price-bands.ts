// Turning a price into a colour.
//
// The buy price is drawn as a line coloured along its length by how dear that
// quarter is, so a reader can see "expensive evening, cheap night" without
// reading the axis at all. Two decisions live here rather than in the chart:
//
// 1. The scale is *relative to the window on screen*. A day that never leaves
//    1.20–1.40 SEK/kWh still gets the full ramp, because the question the
//    colour answers is "cheap or dear compared with the rest of what I can
//    see", not "cheap or dear compared with last winter".
//
// 2. The ramp is diverging blue↔red with a neutral middle, not Tibber's
//    green→yellow→red. A three-hue rainbow has no meaningful midpoint — there
//    is nothing yellow *means* — and green versus red is precisely the pair a
//    red-green reader cannot separate, which here would be the pair carrying
//    the whole message.

/** Odd, so the ramp has a true middle step that reads as "ordinary". */
export const PRICE_RAMP_STEPS = 7;

export interface PriceBands {
  min: number;
  max: number;
  /** Top of the cheapest quarter of the window. */
  cheapAt: number;
  /** Bottom of the dearest quarter of the window. */
  dearAt: number;
  /** A ramp step, 1 (cheapest) to PRICE_RAMP_STEPS (dearest). */
  step: (price: number) => number;
}

/**
 * Null when there is nothing to colour: no prices at all, or a window whose
 * price never moves, where a ramp would invent a distinction that is not there.
 */
export const priceBands = (
  prices: readonly (number | null)[],
): PriceBands | null => {
  const known = prices.filter(
    (price): price is number => price !== null && Number.isFinite(price),
  );
  if (known.length === 0) return null;

  const min = Math.min(...known);
  const max = Math.max(...known);
  // A tenth of an öre across a whole window is a flat price with float noise on
  // it, and colouring that noise would read as a real swing.
  if (max - min < 0.001) return null;

  const sorted = [...known].sort((left, right) => left - right);
  const at = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];

  const span = max - min;
  return {
    min,
    max,
    cheapAt: at(0.25),
    dearAt: at(0.75),
    step: (price: number) => {
      if (!Number.isFinite(price)) return Math.ceil(PRICE_RAMP_STEPS / 2);
      const share = (price - min) / span;
      return Math.min(
        PRICE_RAMP_STEPS,
        Math.max(1, Math.ceil(share * PRICE_RAMP_STEPS)),
      );
    },
  };
};

/**
 * Stops for a horizontal gradient whose colour changes only at quarter edges.
 *
 * Two stops per quarter, at its start and its end, so the ramp steps exactly
 * where the price steps instead of smearing one quarter's colour into the next.
 */
export const priceGradientStops = (
  prices: readonly (number | null)[],
  bands: PriceBands,
): Array<{ offset: string; step: number }> => {
  const count = prices.length;
  if (count === 0) return [];
  const stops: Array<{ offset: string; step: number }> = [];
  prices.forEach((price, index) => {
    const step = price === null ? Math.ceil(PRICE_RAMP_STEPS / 2) : bands.step(price);
    // Runs of one colour need only their outer two stops.
    const previous = stops[stops.length - 1];
    if (previous && previous.step === step) stops.pop();
    else stops.push({ offset: `${((index / count) * 100).toFixed(3)}%`, step });
    stops.push({ offset: `${(((index + 1) / count) * 100).toFixed(3)}%`, step });
  });
  return stops;
};
