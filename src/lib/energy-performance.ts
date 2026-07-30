// One energy-performance answer from whatever evidence the home actually has.
//
// Two calculations exist, and they need very different amounts of data:
//
//  1. `measured_categories` — Boverket's measurement method (BEN, BFS 2016:12)
//     applied to daily per-category readings from Home Assistant. Heating, hot
//     water, comfort cooling, and property energy are separated at the source,
//     so household electricity, EV charging, and pool heating can be excluded
//     rather than estimated away. This is the accurate path.
//
//  2. `estimated_from_grid` — the fallback for the overwhelming majority of
//     homes, which only have a daily grid-import series from the grid operator
//     (Ellevio and friends) plus the heated areas from the home profile.
//     Household electricity is removed with BEN's 30 kWh/m²·år standard value
//     instead of being metered.
//
// Both produce a primary-energy number in kWh/m²·år, so they are compared with
// the same BBR 31 small-house requirement and classified on the same A–G scale.
// Only the confidence differs, and callers are expected to surface it.

import {
  computeEnergiprestanda,
  type DailyCategoryReading,
  type DailyTemperature,
  type EnergiprestandaResult,
} from './energiprestanda';
import {
  buildIndicativeEnergyPerformance,
  classifyEnergyPerformance,
  smallHouseNewBuildRequirement,
  type IndicativeEnergyGrade,
  type IndicativeEnergyPerformance,
} from './indicative-energy-performance';
import type { DailyEnergyReading } from './energy-usage-series';

export type EnergyPerformanceMethod = 'measured_categories' | 'estimated_from_grid';

export type EnergyPerformanceConfidence = 'high' | 'medium' | 'low';

export type EnergyPerformanceBlocker =
  | 'no_data'
  | 'missing_heated_area'
  | 'area_not_supported'
  | 'solar_requires_total_consumption'
  | 'insufficient_data';

/** Days of category coverage before the measured path is considered solid. */
export const MEASURED_HIGH_CONFIDENCE_DAYS = 330;
/** Days of real whole-home metering before the estimate stops being a guess. */
export const ESTIMATE_MEDIUM_CONFIDENCE_DAYS = 300;

export interface ResolvedEnergyPerformance {
  /** null when neither calculation could produce a grade. */
  method: EnergyPerformanceMethod | null;
  confidence: EnergyPerformanceConfidence | null;
  grade: IndicativeEnergyGrade | null;
  primaryEnergyKwhM2: number | null;
  newBuildRequirementKwhM2: number | null;
  requirementPercent: number | null;
  heatedAreaM2: number | null;
  /** Why no grade is shown; null whenever `grade` is set. */
  blocker: EnergyPerformanceBlocker | null;
  /** Both underlying calculations, so the UI can show method-specific detail. */
  measured: EnergiprestandaResult;
  estimated: IndicativeEnergyPerformance;
  /** True when per-category readings exist at all, however few. */
  hasCategoryReadings: boolean;
}

function normalizedArea(atempM2: number | null): number | null {
  if (
    atempM2 === null
    || !Number.isFinite(atempM2)
    || atempM2 <= 0
    || atempM2 > 10_000
  ) {
    return null;
  }
  return atempM2;
}

function measuredConfidence(measured: EnergiprestandaResult): EnergyPerformanceConfidence {
  return measured.coverageDays >= MEASURED_HIGH_CONFIDENCE_DAYS
    && measured.degreeDayFactor !== null
    ? 'high'
    : 'medium';
}

function estimateConfidence(
  estimated: IndicativeEnergyPerformance,
): EnergyPerformanceConfidence {
  return estimated.profile.actualTotalConsumptionDays >= ESTIMATE_MEDIUM_CONFIDENCE_DAYS
    ? 'medium'
    : 'low';
}

function blockerFor(
  estimated: IndicativeEnergyPerformance,
  hasAnyReadings: boolean,
): EnergyPerformanceBlocker {
  switch (estimated.unavailableReason) {
    case 'missing_heated_area':
      return 'missing_heated_area';
    case 'area_not_supported':
      return 'area_not_supported';
    case 'solar_requires_total_consumption':
      return 'solar_requires_total_consumption';
    default:
      return hasAnyReadings ? 'insufficient_data' : 'no_data';
  }
}

/**
 * Resolve the single energy-performance figure to show, preferring measured
 * per-category data and degrading to the grid-import estimate.
 */
export function resolveEnergyPerformance(
  categoryReadings: readonly DailyCategoryReading[],
  dailyReadings: DailyEnergyReading[],
  atempM2: number | null,
  weather: readonly DailyTemperature[],
  hasSolar: boolean | null = null,
): ResolvedEnergyPerformance {
  const area = normalizedArea(atempM2);
  const measured = computeEnergiprestanda(categoryReadings, area, weather);
  const estimated = buildIndicativeEnergyPerformance(dailyReadings, area, hasSolar);
  const newBuildRequirementKwhM2 = area === null
    ? null
    : smallHouseNewBuildRequirement(area);

  const base = {
    heatedAreaM2: area,
    newBuildRequirementKwhM2,
    measured,
    estimated,
    hasCategoryReadings: categoryReadings.length > 0,
  };

  if (measured.reason === 'ok' && measured.ep !== null && newBuildRequirementKwhM2 !== null) {
    const requirementPercent = (measured.ep / newBuildRequirementKwhM2) * 100;
    return {
      ...base,
      method: 'measured_categories',
      confidence: measuredConfidence(measured),
      grade: classifyEnergyPerformance(requirementPercent),
      primaryEnergyKwhM2: measured.ep,
      requirementPercent,
      blocker: null,
    };
  }

  if (estimated.grade !== null) {
    return {
      ...base,
      method: 'estimated_from_grid',
      confidence: estimateConfidence(estimated),
      grade: estimated.grade,
      primaryEnergyKwhM2: estimated.primaryEnergyKwhM2,
      requirementPercent: estimated.requirementPercent,
      blocker: null,
    };
  }

  return {
    ...base,
    method: null,
    confidence: null,
    grade: null,
    primaryEnergyKwhM2: null,
    requirementPercent: null,
    blocker: blockerFor(
      estimated,
      categoryReadings.length > 0 || dailyReadings.length > 0,
    ),
  };
}
