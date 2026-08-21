// Axis domains for charts that draw prices and power on one plot.

export interface Axis {
  domain: [number, number];
  ticks: number[];
  /** Decimals the labels need, given the step that was chosen. */
  decimals: number;
}

/**
 * Step sizes that read as round numbers rather than as arithmetic.
 *
 * Restricted to values a person recognises at a glance — a gridline every 3 kW
 * is legible, one every 2.4 kW is not — and never below `floor`, so an axis
 * cannot end up labelled in fifths of a kilowatt.
 */
const MONEY_STEPS = [1, 2, 5, 10];
const POWER_STEPS = [1, 2, 3, 4, 5, 6, 8, 10];

function niceStep(raw: number, floor: number, multiples: number[]): number {
  if (!Number.isFinite(raw) || raw <= 0) return floor;
  const exponent = Math.floor(Math.log10(Math.max(raw, floor)));
  for (const scale of [10 ** exponent, 10 ** (exponent + 1)]) {
    for (const multiple of multiples) {
      const step = multiple * scale;
      if (step >= raw && step >= floor) return step;
    }
  }
  return Math.max(floor, raw);
}

const decimalsFor = (step: number) =>
  step >= 1 ? 0 : step >= 0.1 ? 1 : 2;

/**
 * Two axes that agree about where zero is, with regular round-numbered ticks.
 *
 * Grid export is drawn negative — energy leaving the house — so the power axis
 * has to reach below zero. Left to itself the price axis would put its zero on
 * the floor while the power zero floated above it, and every read across the
 * chart would be wrong by that gap.
 *
 * Both axes are therefore divided into the *same* number of steps above and
 * below zero. That makes zero a real gridline on both rather than a value that
 * happens to fall between labels, which is what made the earlier version hard
 * to read even once the domains matched.
 */
export function sharedZeroAxes(input: {
  /** Lowest displayed price; all-in prices can occasionally be negative. */
  priceMin?: number;
  priceMax: number;
  /** Watts; negative for energy leaving the house. */
  powerMinW: number;
  powerMaxW: number;
  /** Roughly how many gridlines to aim for above zero. */
  divisionsAbove?: number;
}): { price: Axis; power: Axis } {
  const target = input.divisionsAbove ?? 4;
  const powerMaxKw = Math.max(0, input.powerMaxW) / 1_000;
  const powerMinKw = Math.min(0, input.powerMinW) / 1_000;
  const priceMin = Math.min(0, input.priceMin ?? 0);
  const priceMax = Math.max(0, input.priceMax);

  // The price axis leads, because it is the one whose numbers a reader is
  // trying to recognise: a step of 1 SEK/kWh is legible and a step of 1.6 is
  // not. Sizing the power axis first produced a price axis running to 6 on a
  // day that never passed 3.3, wasting half the plot.
  const priceStep = niceStep(priceMax / target, 0.25, MONEY_STEPS);
  const above = Math.max(1, Math.ceil(priceMax / priceStep));

  // Whole kilowatts, with enough headroom for `above` of them to cover the day.
  const powerStep = niceStep(powerMaxKw / above, 1, POWER_STEPS);
  // One shared count below zero keeps both axes aligned while still covering
  // an unusual negative market price as well as negative export power.
  const below = Math.max(
    0,
    Math.ceil(-powerMinKw / powerStep),
    Math.ceil(-priceMin / priceStep),
  );

  const axis = (step: number, scale: number): Axis => ({
    domain: [-below * step * scale, above * step * scale],
    ticks: Array.from(
      { length: above + below + 1 },
      (_value, index) => (index - below) * step * scale,
    ),
    decimals: decimalsFor(step),
  });

  return {
    price: axis(priceStep, 1),
    // Back to watts, which is what the series are drawn in.
    power: axis(powerStep, 1_000),
  };
}
