// Energiprestanda (primärenergital) from daily category readings, following
// Boverket's measurement-based method (BEN, BFS 2016:12) in simplified form.
//
// REWRITTEN 2026-08-13 — see ENERGY_OPTIMISATION_ARCHITECTURE.md §1.3.1 for the
// defect analysis this replaces. In short: the previous version annualized
// heating by multiplying the measurement window by 365/n. A 43-day summer
// window produced a claimed 648 kWh/year of heating for a 424 m² house and a
// class A rating. Two large errors were partly cancelling — heating understated
// ~20-30×, hot water overstated ~4× by BEN's area-proportional standard — which
// is why the output looked plausible.
//
// The method now:
//
// 1. Sum the included posts over a rolling 12-month window: heating, hot water,
//    comfort cooling, property energy. Excluded loads (household, EV, pool
//    water heating) stay visible but are never counted.
// 2. Normalize each post on the basis appropriate to it, rather than one naive
//    linear scale for all of them:
//      - heating: heating degree days, gated on seasonal coverage
//      - cooling: cooling degree days, gated on seasonal coverage
//      - property energy: linear on measured days (genuinely non-seasonal)
//      - hot water: REPLACED by the småhus standard 20 kWh × Atemp (BEN 2 kap)
// 3. Divide the heating term by the BBR geographic adjustment factor so the
//    same building scores the same anywhere in Sweden (BBR 31, BFS 2024:14).
// 4. EP = (heating/F_geo + hot_water_std + cooling + property) × 1.8 / Atemp
//    (1.8 = viktningsfaktor for electricity, BBR — assumes all-electric).
//
// When seasonal coverage is too thin to normalize heating, this returns a
// reason instead of a number. Producing a confident class from a summer window
// is the specific failure being designed out; callers fall back to the
// archetype prior (`energy-archetypes.ts`) and must badge it as modelled.

import {
  coolingDegreeDays,
  heatingDegreeDays,
  normalYearDegreeDays,
  seasonalCoverage,
  type DailyTemperature,
  type SeasonalCoverage,
} from './energy-degree-days';

export type { DailyTemperature };
export { heatingDegreeDays, coolingDegreeDays };

export const EP_INCLUDED_CATEGORIES = [
  'heating',
  'hot_water',
  'cooling',
  'property_energy',
] as const;

export const EP_EXCLUDED_CATEGORIES = [
  'household',
  'ev_charging',
  'pool_heating',
] as const;

/**
 * Weighting factor (viktningsfaktor) for electricity in the primary-energy
 * number. 1.8 under BBR 29 (BFS 2020:4) onwards.
 */
export const ELECTRICITY_WEIGHTING_FACTOR = 1.8;

/**
 * The factor that applied before BBR 29 took effect on **2020-09-01**.
 *
 * Certificates issued before that date used 1.6, so the same building, with
 * the same measured energy, scores 12.5% higher today for a purely regulatory
 * reason. Verified against energideklaration 1110952 (issued 2020-08-27):
 * 19,567 kWh × 1.6 = 31,307 kWh primary energy, exactly as printed.
 *
 * Any comparison with an older declaration must restate it, or a house appears
 * to have got worse when nothing about it changed.
 */
export const ELECTRICITY_WEIGHTING_FACTOR_BEFORE_BBR29 = 1.6;
export const BBR29_EFFECTIVE_FROM = '2020-09-01';

/**
 * Restate a primary-energy number issued under an older weighting factor onto
 * today's, so old and new figures can be compared honestly.
 */
export function restatePrimaryEnergy(ep: number, issuedOn: string): number {
  if (issuedOn >= BBR29_EFFECTIVE_FROM) return ep;
  return (ep / ELECTRICITY_WEIGHTING_FACTOR_BEFORE_BBR29) * ELECTRICITY_WEIGHTING_FACTOR;
}
export const HOT_WATER_STANDARD_KWH_PER_M2 = 20; // småhus, BEN
export const NEW_BUILD_REQUIREMENT_KWH_M2 = 90; // småhus > 130 m², BBR
export const ROLLING_WINDOW_DAYS = 365;

/**
 * Fraction of a normal year's heating degree days the measured days must cover
 * before heating may be extrapolated at all.
 *
 * This replaces `MIN_COVERAGE_DAYS = 30`. Thirty days is not a threshold — it
 * is thirty days of whatever season happened to be running. Below this
 * fraction we decline to state a class rather than extrapolate winter from
 * summer.
 */
export const MIN_HEATING_COVERAGE_FRACTION = 0.6;

/** Coverage at which the measured heating figure stands on its own. */
export const FULL_HEATING_COVERAGE_FRACTION = 0.9;

/** Cooling is a much smaller post; a looser gate is proportionate. */
export const MIN_COOLING_COVERAGE_FRACTION = 0.5;

/** Measured days required before even the non-seasonal posts are scaled. */
export const MIN_MEASURED_DAYS = 30;

/**
 * Boverket geographic adjustment factor (BBR 31 Table 9:2c), applied to the
 * heating term. The per-municipality table is not reproduced in this codebase;
 * 1.0 is correct for Stockholm County and wrong further north, so callers that
 * do not know it must surface the assumption.
 */
export const DEFAULT_GEOGRAPHIC_ADJUSTMENT_FACTOR = 1.0;

export interface DailyCategoryReading {
  reading_date: string; // ISO yyyy-mm-dd
  category: string;
  kwh: number;
}

export interface EnergyClassBand {
  label: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
  /** Upper bound as a share of the new-build requirement; null for G. */
  maxRequirementPercent: number | null;
}

/**
 * Class boundaries as a share of the *building's own* new-build requirement.
 * Previously these were absolute numbers against a flat 90 kWh/m², which
 * disagreed with the requirement actually used for classification below 130 m².
 * Expressing them as percentages removes the second, divergent source of truth.
 */
export const ENERGY_CLASS_BANDS: EnergyClassBand[] = [
  { label: 'A', maxRequirementPercent: 50 },
  { label: 'B', maxRequirementPercent: 75 },
  { label: 'C', maxRequirementPercent: 100 },
  { label: 'D', maxRequirementPercent: 135 },
  { label: 'E', maxRequirementPercent: 180 },
  { label: 'F', maxRequirementPercent: 235 },
  { label: 'G', maxRequirementPercent: null },
];

export type EnergiprestandaReason =
  | 'ok'
  | 'no_readings'
  | 'insufficient_measured_days'
  | 'insufficient_heating_season'
  | 'no_normal_year_weather'
  | 'missing_atemp';

export interface EnergiprestandaResult {
  /** null when EP could not be computed; `reason` says why. */
  ep: number | null;
  reason: EnergiprestandaReason;
  windowStart: string | null;
  windowEnd: string | null;
  /** Distinct dates with at least one included-category reading. */
  coverageDays: number;
  /** Per-category distinct measured dates — the honest denominator. */
  coverageDaysByCategory: Record<string, number>;
  /** Measured kWh per category in the window (not normalized). */
  measuredKwh: Record<string, number>;
  /** Included posts after normalization to a normal year. */
  annualizedIncludedKwh: {
    heating: number;
    hot_water: number;
    cooling: number;
    property_energy: number;
  } | null;
  /** Heating after degree-day normalization and F_geo. */
  correctedHeatingKwh: number | null;
  /** Degree-day normalization factor actually applied to heating. */
  degreeDayFactor: number | null;
  /** Days dropped because the customer flagged them as unrepresentative. */
  excludedDayCount: number;
  heatingCoverage: SeasonalCoverage | null;
  coolingCoverage: SeasonalCoverage | null;
  geographicAdjustmentFactor: number;
  /** The standard hot-water value that replaced the measured one. */
  standardHotWaterKwh: number | null;
  /** Total weighted, normalized annual energy (kWh) the EP is based on. */
  normalizedAnnualKwh: number | null;
}

function isoDaysAgo(endIso: string, days: number): string {
  const end = new Date(`${endIso}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() - days);
  return end.toISOString().slice(0, 10);
}

export interface EnergiprestandaOptions {
  geographicAdjustmentFactor?: number;
  /**
   * Days the customer has told us are unrepresentative — a holiday, guests, a
   * broken heat pump. Excluded from both the energy and the degree days, so the
   * ratio stays honest: dropping a fortnight's kWh while keeping its cold days
   * would make the house look worse, not neutral.
   */
  excludedDates?: ReadonlySet<string>;
}

export function computeEnergiprestanda(
  readings: readonly DailyCategoryReading[],
  atempM2: number | null,
  weather: readonly DailyTemperature[],
  options: EnergiprestandaOptions = {},
): EnergiprestandaResult {
  const fGeo = options.geographicAdjustmentFactor ?? DEFAULT_GEOGRAPHIC_ADJUSTMENT_FACTOR;
  const excludedDates = options.excludedDates ?? new Set<string>();

  const empty: EnergiprestandaResult = {
    ep: null,
    reason: 'no_readings',
    windowStart: null,
    windowEnd: null,
    coverageDays: 0,
    coverageDaysByCategory: {},
    excludedDayCount: 0,
    measuredKwh: {},
    annualizedIncludedKwh: null,
    correctedHeatingKwh: null,
    degreeDayFactor: null,
    heatingCoverage: null,
    coolingCoverage: null,
    geographicAdjustmentFactor: fGeo,
    standardHotWaterKwh: null,
    normalizedAnnualKwh: null,
  };
  if (readings.length === 0) return empty;

  const windowEnd = readings.reduce(
    (max, r) => (r.reading_date > max ? r.reading_date : max),
    readings[0].reading_date,
  );
  const windowStart = isoDaysAgo(windowEnd, ROLLING_WINDOW_DAYS - 1);

  const measuredKwh: Record<string, number> = {};
  const datesByCategory = new Map<string, Set<string>>();
  const includedDates = new Set<string>();
  const includedSet = new Set<string>(EP_INCLUDED_CATEGORIES);

  for (const reading of readings) {
    if (reading.reading_date < windowStart || reading.reading_date > windowEnd) continue;
    if (!Number.isFinite(reading.kwh) || reading.kwh < 0) continue;
    if (excludedDates.has(reading.reading_date)) continue;

    measuredKwh[reading.category] = (measuredKwh[reading.category] ?? 0) + reading.kwh;

    let dates = datesByCategory.get(reading.category);
    if (!dates) {
      dates = new Set<string>();
      datesByCategory.set(reading.category, dates);
    }
    dates.add(reading.reading_date);

    if (includedSet.has(reading.category)) includedDates.add(reading.reading_date);
  }

  const coverageDaysByCategory: Record<string, number> = {};
  for (const [category, dates] of datesByCategory) {
    coverageDaysByCategory[category] = dates.size;
  }

  const base: EnergiprestandaResult = {
    ...empty,
    windowStart,
    windowEnd,
    coverageDays: includedDates.size,
    coverageDaysByCategory,
    excludedDayCount: [...excludedDates]
      .filter(date => date >= windowStart && date <= windowEnd).length,
    measuredKwh,
  };

  if (includedDates.size < MIN_MEASURED_DAYS) {
    return { ...base, reason: 'insufficient_measured_days' };
  }

  // A normal year is required before any degree-day statement can be made.
  if (normalYearDegreeDays(weather, 'heating') === null) {
    return { ...base, reason: 'no_normal_year_weather' };
  }

  const heatingDates = datesByCategory.get('heating') ?? new Set<string>();
  const coolingDates = datesByCategory.get('cooling') ?? new Set<string>();

  const heatingCoverage = seasonalCoverage(
    heatingDates,
    weather,
    'heating',
    MIN_HEATING_COVERAGE_FRACTION,
  );
  const coolingCoverage = seasonalCoverage(
    coolingDates,
    weather,
    'cooling',
    MIN_COOLING_COVERAGE_FRACTION,
  );

  const withCoverage: EnergiprestandaResult = { ...base, heatingCoverage, coolingCoverage };

  // This is the gate the old code did not have. A summer window cannot say
  // anything about annual heating, and heating decides the class.
  if (heatingCoverage === null || heatingCoverage.normalizationFactor === null) {
    return { ...withCoverage, reason: 'insufficient_heating_season' };
  }

  const heatingFactor = heatingCoverage.normalizationFactor;
  const normalizedHeating = (measuredKwh.heating ?? 0) * heatingFactor;

  // Cooling is normalized on its own season where possible. Where it is not,
  // the measured value is used unscaled: comfort cooling only happens in the
  // warm months, so a window covering summer already holds most of the year's
  // cooling, and inflating it would be the same mistake in miniature.
  const coolingFactor = coolingCoverage?.normalizationFactor ?? 1;
  const normalizedCooling = (measuredKwh.cooling ?? 0) * coolingFactor;

  // Property energy is genuinely non-seasonal, so days are the right basis.
  const propertyDays = coverageDaysByCategory.property_energy ?? 0;
  const normalizedProperty = propertyDays > 0
    ? (measuredKwh.property_energy ?? 0) * (ROLLING_WINDOW_DAYS / propertyDays)
    : 0;

  const annualized = {
    heating: normalizedHeating,
    // Reported for transparency; the standard value replaces it below.
    hot_water: (measuredKwh.hot_water ?? 0)
      * (coverageDaysByCategory.hot_water
        ? ROLLING_WINDOW_DAYS / coverageDaysByCategory.hot_water
        : 0),
    cooling: normalizedCooling,
    property_energy: normalizedProperty,
  };

  const geoAdjustedHeating = normalizedHeating / (fGeo > 0 ? fGeo : 1);

  if (atempM2 === null || !Number.isFinite(atempM2) || atempM2 <= 0) {
    return {
      ...withCoverage,
      reason: 'missing_atemp',
      annualizedIncludedKwh: annualized,
      correctedHeatingKwh: geoAdjustedHeating,
      degreeDayFactor: heatingFactor,
    };
  }

  const standardHotWater = HOT_WATER_STANDARD_KWH_PER_M2 * atempM2;
  const normalizedAnnual =
    geoAdjustedHeating + standardHotWater + normalizedCooling + normalizedProperty;
  const ep = (normalizedAnnual * ELECTRICITY_WEIGHTING_FACTOR) / atempM2;

  return {
    ...withCoverage,
    reason: 'ok',
    annualizedIncludedKwh: annualized,
    correctedHeatingKwh: geoAdjustedHeating,
    degreeDayFactor: heatingFactor,
    standardHotWaterKwh: standardHotWater,
    normalizedAnnualKwh: normalizedAnnual,
    ep,
  };
}

/**
 * How far the measured heating season goes towards standing on its own, 0..1.
 * Used to weight measured evidence against the archetype prior.
 */
export function measuredHeatingWeight(result: EnergiprestandaResult): number {
  const fraction = result.heatingCoverage?.fraction ?? 0;
  if (fraction <= MIN_HEATING_COVERAGE_FRACTION) return 0;
  if (fraction >= FULL_HEATING_COVERAGE_FRACTION) return 1;
  return (
    (fraction - MIN_HEATING_COVERAGE_FRACTION)
    / (FULL_HEATING_COVERAGE_FRACTION - MIN_HEATING_COVERAGE_FRACTION)
  );
}
