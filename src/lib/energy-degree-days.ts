// Degree days, and the only honest way to ask "how much of the year does this
// measurement window actually tell us about?"
//
// The defect this replaces (ENERGY_OPTIMISATION_ARCHITECTURE.md §1.3.1): the
// energy-performance page annualized heating by multiplying a measurement
// window by 365/n. For a 43-day window ending in mid-August that turned 76 kWh
// of summer heating into a claimed 648 kWh/year, and the house came out class A.
//
// A day count cannot answer the question. Forty-three days in January and
// forty-three days in July carry completely different amounts of information
// about annual heating. Heating degree days can: the fraction of the normal
// year's heating demand that fell inside the window IS the fraction of the
// year's heating the window can speak for.
//
// The resulting correction is also self-limiting in the right direction. As the
// window's degree days approach zero the extrapolation factor diverges, which
// is the maths telling us a summer window carries no information about winter.
// We gate on coverage rather than letting that divergence produce a number.

export interface DailyTemperature {
  observed_on: string; // ISO yyyy-mm-dd
  temperature_c: number;
}

/** Base temperature for heating degree days, °C. Swedish convention. */
export const HDD_BASE_TEMPERATURE_C = 17;

/**
 * Base temperature for cooling degree days, °C. Comfort cooling in a Swedish
 * home rarely runs below this.
 */
export const CDD_BASE_TEMPERATURE_C = 22;

/** Observations needed before a calendar year counts towards the normal year. */
export const COMPLETE_YEAR_MIN_OBSERVATIONS = 360;

export type DegreeDayKind = 'heating' | 'cooling';

function degreeDays(
  temps: readonly DailyTemperature[],
  kind: DegreeDayKind,
): number {
  const base = kind === 'heating' ? HDD_BASE_TEMPERATURE_C : CDD_BASE_TEMPERATURE_C;
  let total = 0;
  for (const { temperature_c } of temps) {
    if (!Number.isFinite(temperature_c)) continue;
    const delta = kind === 'heating' ? base - temperature_c : temperature_c - base;
    if (delta > 0) total += delta;
  }
  return total;
}

export function heatingDegreeDays(temps: readonly DailyTemperature[]): number {
  return degreeDays(temps, 'heating');
}

export function coolingDegreeDays(temps: readonly DailyTemperature[]): number {
  return degreeDays(temps, 'cooling');
}

/**
 * Normal-year degree days: the mean over every complete calendar year in the
 * dataset. Returns null when no complete year exists — we do not fabricate a
 * normal year from a partial one.
 */
export function normalYearDegreeDays(
  temps: readonly DailyTemperature[],
  kind: DegreeDayKind,
): number | null {
  const byYear = new Map<string, DailyTemperature[]>();
  for (const temp of temps) {
    const year = temp.observed_on.slice(0, 4);
    const list = byYear.get(year);
    if (list) list.push(temp);
    else byYear.set(year, [temp]);
  }

  const annual: number[] = [];
  for (const yearTemps of byYear.values()) {
    if (yearTemps.length >= COMPLETE_YEAR_MIN_OBSERVATIONS) {
      annual.push(degreeDays(yearTemps, kind));
    }
  }
  if (annual.length === 0) return null;
  return annual.reduce((sum, value) => sum + value, 0) / annual.length;
}

export interface SeasonalCoverage {
  /**
   * Fraction of the normal year's degree days that fell inside the days we
   * actually measured. 0 means the window carries no information about this
   * season; 1 means it covers a whole normal year's worth.
   */
  fraction: number;
  /** Degree days inside the measured days. */
  windowDegreeDays: number;
  /** Degree days in an average complete year of the dataset. */
  normalYearDegreeDays: number;
  /**
   * Multiply measured energy by this to get a normal-year figure. Null when
   * coverage is too thin for the result to mean anything.
   */
  normalizationFactor: number | null;
}

/**
 * How much of a normal year's heating (or cooling) demand the measured days
 * captured.
 *
 * `measuredDates` is the set of dates we actually have energy readings for —
 * not the calendar span of the window. A window with a three-month gap in it
 * must not be credited with the degree days in that gap.
 */
export function seasonalCoverage(
  measuredDates: ReadonlySet<string>,
  weather: readonly DailyTemperature[],
  kind: DegreeDayKind,
  minimumFractionForNormalization: number,
): SeasonalCoverage | null {
  const normal = normalYearDegreeDays(weather, kind);
  if (normal === null || normal <= 0) return null;

  const measuredTemps = weather.filter((day) => measuredDates.has(day.observed_on));
  const windowDd = degreeDays(measuredTemps, kind);
  const fraction = windowDd / normal;

  return {
    fraction,
    windowDegreeDays: windowDd,
    normalYearDegreeDays: normal,
    normalizationFactor:
      fraction >= minimumFractionForNormalization && windowDd > 0
        ? normal / windowDd
        : null,
  };
}
