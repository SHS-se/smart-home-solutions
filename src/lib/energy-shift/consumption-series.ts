// Which meters earn a band of their own in the consumption stack.
//
// A house reports whatever Home Assistant reports — nineteen meters here,
// including a fridge, a TV socket and a bulb group. Drawing all of them stacked
// was the original chart's worst fault: eight distinguishable hues is the
// ceiling, so the palette was cycled and three meters shared every colour.
//
// Bucketing them by category is not the answer either. The planner dispatches
// individual devices, so a chart that draws "Kitchen & cold" describes
// something no schedule can act on. The answer is to draw fewer meters, not
// coarser ones: a meter earns its own band when it is something the plan can
// *move*, and when it moved enough to be worth looking at. Everything else
// joins base load, where it is honest about being background.

/** A quarter of average watts is that many watt-hours over four. */
const QUARTER_W_TO_KWH = 4_000;

/** Sustained: this much in a quarter, for this many quarters running. */
export const SUSTAINED_KWH = 0.1;
export const SUSTAINED_QUARTERS = 4;
/** Or a single quarter this large, for loads that run in one short burst. */
export const SPIKE_KWH = 0.4;

/**
 * Eight is the ceiling on hues a reader can tell apart, so it is the ceiling
 * on bands. A ninth qualifying meter joins base load rather than taking a
 * ninth colour that nobody could name.
 */
export const MAX_SERIES = 8;

export interface ConsumptionCandidate {
  key: string;
  name: string;
  /** Watts per quarter, over the window being drawn. */
  values: number[];
  /** Whether the plan can move this load at all. */
  schedulable: boolean;
}

export interface ConsumptionSeries {
  key: string;
  name: string;
  values: number[];
  kwh: number;
  /**
   * Palette slot, assigned over every schedulable meter the home has rather
   * than over the ones drawn today. A meter that happens not to run keeps its
   * colour, so yesterday's chart and today's agree about what green means.
   */
  slot: number;
}

export interface ConsumptionSplit {
  /** Drawn bands, largest first. */
  series: ConsumptionSeries[];
  /** Base load plus every meter that did not earn a band. */
  baseValues: number[];
  baseKwh: number;
  /** How many meters ended up in base load, for the caption to admit to. */
  foldedCount: number;
}

/**
 * Ran long enough, or hard enough, to be worth a band.
 *
 * Two tests rather than one because the two shapes of load that matter look
 * nothing alike: a pool pump holds a modest draw for hours, an oven takes a
 * kilowatt-hour in one quarter and stops.
 */
export const earnsOwnBand = (values: readonly number[]): boolean => {
  let run = 0;
  for (const watts of values) {
    const kwh = (Number.isFinite(watts) ? watts : 0) / QUARTER_W_TO_KWH;
    if (kwh >= SPIKE_KWH) return true;
    run = kwh >= SUSTAINED_KWH ? run + 1 : 0;
    if (run >= SUSTAINED_QUARTERS) return true;
  }
  return false;
};

const totalKwh = (values: readonly number[]): number =>
  values.reduce((sum, watts) => sum + (Number.isFinite(watts) ? watts : 0) / QUARTER_W_TO_KWH, 0);

/**
 * Split the window's meters into bands and background.
 *
 * `houseDemandW` is the authority on the total: the folded band is whatever is
 * left of it once the drawn bands are taken out, so the top of the stack is
 * always the demand the flows panel has to match. Deriving it by addition
 * instead would let a disagreement between the plan's base figure and its
 * per-device figures show up as a stack that quietly missed the total.
 */
export const splitConsumption = (
  candidates: readonly ConsumptionCandidate[],
  houseDemandW: readonly (number | null)[],
): ConsumptionSplit => {
  const length = houseDemandW.length;

  // Slots follow the meter, not its rank, so filtering never repaints the
  // survivors. Sorted by key rather than by energy for the same reason.
  const slotByKey = new Map(
    candidates
      .filter(candidate => candidate.schedulable)
      .map(candidate => candidate.key)
      .sort()
      .map((key, index) => [key, index % MAX_SERIES]),
  );

  const eligible = candidates
    .filter(candidate => candidate.schedulable && earnsOwnBand(candidate.values))
    .map(candidate => ({
      key: candidate.key,
      name: candidate.name,
      values: candidate.values,
      kwh: totalKwh(candidate.values),
      slot: slotByKey.get(candidate.key) ?? 0,
    }))
    .sort((left, right) => right.kwh - left.kwh || left.key.localeCompare(right.key));

  const series = eligible.slice(0, MAX_SERIES);
  const drawn = new Set(series.map(entry => entry.key));

  const baseValues = Array.from({ length }, (_, index) => {
    const demand = houseDemandW[index];
    const drawnW = series.reduce((sum, entry) => sum + (entry.values[index] ?? 0), 0);
    if (demand !== null && Number.isFinite(demand)) return Math.max(0, demand - drawnW);
    // No measured total: fall back to adding up what is left.
    return candidates.reduce(
      (sum, candidate) => drawn.has(candidate.key) ? sum : sum + (candidate.values[index] ?? 0),
      0,
    );
  });

  return {
    series,
    baseValues,
    baseKwh: totalKwh(baseValues),
    foldedCount: candidates.length - series.length,
  };
};
