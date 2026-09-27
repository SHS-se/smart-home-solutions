/** A quarter of average watts is that many watt-hours over four. */
const QUARTER_W_TO_KWH = 4_000;

/** Sustained: this much in a quarter, for this many quarters running. */
export const SUSTAINED_KWH = 0.1;
export const SUSTAINED_QUARTERS = 4;
/** Or a single quarter this large, for loads that run in one short burst. */
export const SPIKE_KWH = 0.4;

/**
 * Eight is the ceiling on hues a reader can tell apart, so it is the ceiling
 * on individually named bands. Remaining Planned meters share one band.
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
  /** A grouped value contains only the available device readings. */
  partial: boolean[];
  /**
   * Palette slot, assigned over every schedulable meter the home has rather
   * than over the ones drawn today. A meter that happens not to run keeps its
   * colour, so yesterday's chart and today's agree about what green means.
   */
  slot: number;
}

export interface ConsumptionIssue {
  missingDevices: string[];
}

export const consumptionGapDescription = (
  issue: ConsumptionIssue,
  t: (sv: string, en: string) => string,
): string => issue.missingDevices.length
  ? t(`Mätvärden saknas för: ${issue.missingDevices.join(', ')}. Baslasten kan inte beräknas.`,
      `Missing readings for: ${issue.missingDevices.join(', ')}. Base load cannot be calculated.`)
  : t('Husets och enheternas mätvärden kan inte stämmas av för denna kvart.',
      'Household and device readings cannot be reconciled for this quarter.');

export interface ConsumptionSplit {
  /** Drawn bands, largest first. */
  series: ConsumptionSeries[];
  /** Gross house consumption minus every Planned meter, before solar. */
  baseValues: number[];
  baseKwh: number;
  /** Monitoring meters, already included in gross base consumption. */
  foldedCount: number;
  invalidIndices: number[];
  issues: (ConsumptionIssue | null)[];
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
 * `houseDemandW` is gross household consumption. Subtract all Planned meters,
 * including those grouped for display. Inconsistent or missing measurements
 * leave the base unknown; each available device keeps its own reading.
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
      values: [...candidate.values],
      kwh: totalKwh(candidate.values),
      partial: candidate.values.map(() => false),
      slot: slotByKey.get(candidate.key) ?? 0,
    }))
    .sort((left, right) => right.kwh - left.kwh || left.key.localeCompare(right.key));

  const series = eligible.slice(0, MAX_SERIES);
  const drawn = new Set(series.map(entry => entry.key));
  const grouped = candidates.filter(c => c.schedulable && !drawn.has(c.key));
  if (grouped.some(c => c.values.some(w => w > 0))) {
    const readings = Array.from({ length }, (_, i) => grouped.map(c => c.values[i]).filter(Number.isFinite));
    const values = readings.map(known => known.length ? known.reduce((sum, w) => sum + w, 0) : NaN);
    const partial = readings.map(known => known.length < grouped.length);
    series.push({ key: "$other_planned", name: "Other planned devices", values,
      kwh: totalKwh(values), partial, slot: MAX_SERIES });
  }
  const planned = candidates.filter(c => c.schedulable);
  const invalidIndices: number[] = [];
  const issues: (ConsumptionIssue | null)[] = Array(length).fill(null);
  const duplicate = new Set(candidates.map(c => c.key)).size !== candidates.length;
  const baseValues = Array.from({ length }, (_, index) => {
    const demand = houseDemandW[index];
    const values = planned.map(c => c.values[index]);
    const plannedW = values.reduce((sum, watts) => sum + watts, 0);
    if (duplicate || demand === null || !Number.isFinite(demand) || demand < 0 ||
        values.some(w => !Number.isFinite(w) || w < 0) || plannedW > demand) {
      invalidIndices.push(index);
      issues[index] = { missingDevices: planned
        .filter(c => !Number.isFinite(c.values[index]))
        .map(c => c.name) };
      // Only the remainder is unknown. Keep every available device reading.
      return NaN;
    }
    return demand - plannedW;
  });

  return {
    series,
    baseValues,
    baseKwh: invalidIndices.length ? NaN : totalKwh(baseValues),
    foldedCount: candidates.filter(c => !c.schedulable).length,
    invalidIndices,
    issues,
  };
};
