// Energiprestanda (primärenergital) from daily category readings, following
// Boverket's measurement-based method (BEN, BFS 2016:12) in simplified form:
//
// 1. Sum the included posts over a rolling 12-month window: heating, hot
//    water, comfort cooling, property energy. Excluded loads (household, EV,
//    pool water heating) are kept visible but never counted.
// 2. Normalize hot water by REPLACING the measured value with the småhus
//    standard 20 kWh × Atemp (BEN 2 kap; resistive production efficiency 1.0).
// 3. Degree-day-correct heating: measured HDD in the window vs the dataset's
//    normal-year HDD (average of all complete calendar years available).
//    Skipped (factor 1) when weather coverage is insufficient.
// 4. EP = (heating_corrected + hot_water_std + cooling + property) × 1.8 / Atemp
//    (1.8 = viktningsfaktor for electricity, BBR — assumes all-electric).
//
// Energy classes relative to the new-build requirement (90 kWh/m²·år for
// småhus): A ≤50%, B ≤75%, C ≤100%, D ≤135%, E ≤180%, F ≤235%, G above.

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

export const ELECTRICITY_WEIGHTING_FACTOR = 1.8;
export const HOT_WATER_STANDARD_KWH_PER_M2 = 20; // småhus, BEN
export const NEW_BUILD_REQUIREMENT_KWH_M2 = 90; // småhus ≥ 90 m², BBR
export const HDD_BASE_TEMPERATURE_C = 17;
export const ROLLING_WINDOW_DAYS = 365;
export const MIN_COVERAGE_DAYS = 30;
const MIN_WEATHER_COVERAGE_RATIO = 0.9;

export interface DailyCategoryReading {
  reading_date: string; // ISO yyyy-mm-dd
  category: string;
  kwh: number;
}

export interface DailyTemperature {
  observed_on: string; // ISO yyyy-mm-dd
  temperature_c: number;
}

export interface EnergyClassBand {
  label: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
  /** Upper EP bound (exclusive for the next class), null for G. */
  maxEp: number | null;
}

export const ENERGY_CLASS_BANDS: EnergyClassBand[] = [
  { label: 'A', maxEp: NEW_BUILD_REQUIREMENT_KWH_M2 * 0.5 },
  { label: 'B', maxEp: NEW_BUILD_REQUIREMENT_KWH_M2 * 0.75 },
  { label: 'C', maxEp: NEW_BUILD_REQUIREMENT_KWH_M2 * 1.0 },
  { label: 'D', maxEp: NEW_BUILD_REQUIREMENT_KWH_M2 * 1.35 },
  { label: 'E', maxEp: NEW_BUILD_REQUIREMENT_KWH_M2 * 1.8 },
  { label: 'F', maxEp: NEW_BUILD_REQUIREMENT_KWH_M2 * 2.35 },
  { label: 'G', maxEp: null },
];

export function energyClassForEp(ep: number): EnergyClassBand['label'] {
  for (const band of ENERGY_CLASS_BANDS) {
    if (band.maxEp === null || ep <= band.maxEp) return band.label;
  }
  return 'G';
}

export interface EnergiprestandaResult {
  /** null when EP could not be computed (see reason). */
  ep: number | null;
  energyClass: EnergyClassBand['label'] | null;
  reason: 'ok' | 'no_readings' | 'insufficient_coverage' | 'missing_atemp';
  windowStart: string | null;
  windowEnd: string | null;
  /** Distinct dates in the window with at least one included-category reading. */
  coverageDays: number;
  /** Measured kWh per category in the window (not annualized). */
  measuredKwh: Record<string, number>;
  /** Included posts annualized to 365 days. */
  annualizedIncludedKwh: {
    heating: number;
    hot_water: number;
    cooling: number;
    property_energy: number;
  } | null;
  /** Heating after degree-day correction. */
  correctedHeatingKwh: number | null;
  degreeDayFactor: number | null;
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

/** Heating degree days over daily mean temperatures (base 17 °C). */
export function heatingDegreeDays(temps: readonly DailyTemperature[]): number {
  let hdd = 0;
  for (const { temperature_c } of temps) {
    if (Number.isFinite(temperature_c) && temperature_c < HDD_BASE_TEMPERATURE_C) {
      hdd += HDD_BASE_TEMPERATURE_C - temperature_c;
    }
  }
  return hdd;
}

/**
 * Normal-year HDD: average annual HDD across all complete calendar years in
 * the dataset (≥ 360 observations). Returns null when no complete year exists.
 */
export function normalYearHdd(temps: readonly DailyTemperature[]): number | null {
  const byYear = new Map<string, DailyTemperature[]>();
  for (const temp of temps) {
    const year = temp.observed_on.slice(0, 4);
    const list = byYear.get(year);
    if (list) list.push(temp);
    else byYear.set(year, [temp]);
  }
  const annualHdds: number[] = [];
  for (const yearTemps of byYear.values()) {
    if (yearTemps.length >= 360) annualHdds.push(heatingDegreeDays(yearTemps));
  }
  if (annualHdds.length === 0) return null;
  return annualHdds.reduce((sum, v) => sum + v, 0) / annualHdds.length;
}

export function computeEnergiprestanda(
  readings: readonly DailyCategoryReading[],
  atempM2: number | null,
  weather: readonly DailyTemperature[],
): EnergiprestandaResult {
  const empty: EnergiprestandaResult = {
    ep: null,
    energyClass: null,
    reason: 'no_readings',
    windowStart: null,
    windowEnd: null,
    coverageDays: 0,
    measuredKwh: {},
    annualizedIncludedKwh: null,
    correctedHeatingKwh: null,
    degreeDayFactor: null,
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
  const includedDates = new Set<string>();
  const includedSet = new Set<string>(EP_INCLUDED_CATEGORIES);
  for (const reading of readings) {
    if (reading.reading_date < windowStart || reading.reading_date > windowEnd) {
      continue;
    }
    if (!Number.isFinite(reading.kwh) || reading.kwh < 0) continue;
    measuredKwh[reading.category] =
      (measuredKwh[reading.category] ?? 0) + reading.kwh;
    if (includedSet.has(reading.category)) {
      includedDates.add(reading.reading_date);
    }
  }

  const coverageDays = includedDates.size;
  const base: EnergiprestandaResult = {
    ...empty,
    windowStart,
    windowEnd,
    coverageDays,
    measuredKwh,
  };
  if (coverageDays < MIN_COVERAGE_DAYS) {
    return { ...base, reason: 'insufficient_coverage' };
  }

  const annualize = ROLLING_WINDOW_DAYS / coverageDays;
  const annualized = {
    heating: (measuredKwh.heating ?? 0) * annualize,
    hot_water: (measuredKwh.hot_water ?? 0) * annualize,
    cooling: (measuredKwh.cooling ?? 0) * annualize,
    property_energy: (measuredKwh.property_energy ?? 0) * annualize,
  };

  // Degree-day correction, only with solid weather coverage of the window.
  let degreeDayFactor: number | null = null;
  const windowTemps = weather.filter(
    (w) => w.observed_on >= windowStart && w.observed_on <= windowEnd,
  );
  const normalHdd = normalYearHdd(weather);
  if (
    normalHdd !== null &&
    windowTemps.length >= ROLLING_WINDOW_DAYS * MIN_WEATHER_COVERAGE_RATIO
  ) {
    const windowHdd =
      heatingDegreeDays(windowTemps) * (ROLLING_WINDOW_DAYS / windowTemps.length);
    if (windowHdd > 0) degreeDayFactor = normalHdd / windowHdd;
  }
  const correctedHeating = annualized.heating * (degreeDayFactor ?? 1);

  if (atempM2 === null || !Number.isFinite(atempM2) || atempM2 <= 0) {
    return {
      ...base,
      reason: 'missing_atemp',
      annualizedIncludedKwh: annualized,
      correctedHeatingKwh: correctedHeating,
      degreeDayFactor,
    };
  }

  const standardHotWater = HOT_WATER_STANDARD_KWH_PER_M2 * atempM2;
  const normalizedAnnual =
    correctedHeating +
    standardHotWater +
    annualized.cooling +
    annualized.property_energy;
  const ep = (normalizedAnnual * ELECTRICITY_WEIGHTING_FACTOR) / atempM2;

  return {
    ...base,
    reason: 'ok',
    annualizedIncludedKwh: annualized,
    correctedHeatingKwh: correctedHeating,
    degreeDayFactor,
    standardHotWaterKwh: standardHotWater,
    normalizedAnnualKwh: normalizedAnnual,
    ep,
    energyClass: energyClassForEp(ep),
  };
}
