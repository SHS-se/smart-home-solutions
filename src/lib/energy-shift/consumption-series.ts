/** A quarter of average watts is that many watt-hours over four. */
const QUARTER_W_TO_KWH = 4_000;

/**
 * Eight is the ceiling on hues a reader can tell apart, so it is the ceiling
 * on individually named bands. Planned meters past it share one band.
 */
export const MAX_SERIES = 8;

export interface ConsumptionCandidate {
  key: string;
  name: string;
  /** Watts per quarter, over the window being drawn. */
  values: number[];
  /** Whether the plan can move this load at all. */
  schedulable: boolean;
  /** Always drawn, first above base load, whatever it used. */
  pinned?: boolean;
  /** A fixed colour, for a band that means one thing in every home. */
  colour?: string;
}

export interface ConsumptionSeries {
  key: string;
  name: string;
  values: number[];
  kwh: number;
  /** Missing device readings contribute zero to consumption statistics. */
  partial: boolean[];
  /**
   * Palette slot, assigned over every schedulable meter the home has rather
   * than over the ones drawn today. A meter that happens not to run keeps its
   * colour, so yesterday's chart and today's agree about what green means.
   */
  slot: number;
  /** Overrides the palette slot. */
  colour?: string;
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
 * Drew anything at all in the window. Every Planned meter that did is its own
 * band: a 300 W floor heater is exactly what someone reading a room's
 * temperature wants to see, however small it is next to the car.
 */
export const earnsOwnBand = (values: readonly number[]): boolean =>
  values.some(watts => Number.isFinite(watts) && watts > 0);

const totalKwh = (values: readonly number[]): number =>
  values.reduce((sum, watts) => sum + (Number.isFinite(watts) ? watts : 0) / QUARTER_W_TO_KWH, 0);

/**
 * Split the window's meters into bands and background.
 *
 * `houseDemandW` is gross household consumption. Subtract all Planned meters,
 * including those grouped for display. Missing device readings contribute zero;
 * inconsistent household/device totals still leave the base unknown.
 */
export const splitConsumption = (
  candidates: readonly ConsumptionCandidate[],
  houseDemandW: readonly (number | null)[],
): ConsumptionSplit => {
  const length = houseDemandW.length;
  candidates = candidates.map(candidate => ({ ...candidate,
    values: Array.from({ length }, (_, i) => Number.isFinite(candidate.values[i]) ? candidate.values[i] : 0),
  }));

  // Slots follow the meter, not its rank, so filtering never repaints the
  // survivors. Sorted by key rather than by energy for the same reason.
  const slotByKey = new Map(
    candidates
      .filter(candidate => candidate.schedulable && !candidate.colour)
      .map(candidate => candidate.key)
      .sort()
      .map((key, index) => [key, index % MAX_SERIES]),
  );

  const eligible = candidates
    .filter(candidate => candidate.schedulable && (candidate.pinned || earnsOwnBand(candidate.values)))
    .map(candidate => ({
      key: candidate.key,
      name: candidate.name,
      values: [...candidate.values],
      kwh: totalKwh(candidate.values),
      partial: candidate.values.map(() => false),
      slot: slotByKey.get(candidate.key) ?? 0,
      ...(candidate.colour ? { colour: candidate.colour } : {}),
      pinned: candidate.pinned ?? false,
    }))
    .sort((left, right) => Number(right.pinned) - Number(left.pinned)
      || right.kwh - left.kwh || left.key.localeCompare(right.key))
    .map(({ pinned: _pinned, ...entry }) => entry);

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
