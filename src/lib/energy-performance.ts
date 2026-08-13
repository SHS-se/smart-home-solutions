// One energy-performance answer from whatever evidence the home actually has.
//
// REVISED 2026-08-13 — see ENERGY_OPTIMISATION_ARCHITECTURE.md §1.3.2. The
// previous version gave measured per-category data unconditional precedence,
// so 43 days of summer readings overrode a year of grid-import history and
// produced a class A rating from a July heating sample.
//
// The ordering is now evidence-strength, not data-source:
//
//  1. `measured_categories` — Boverket's measurement method (BEN, BFS 2016:12)
//     on daily per-category readings, but only once the measured days cover
//     enough of a normal heating season to speak for the year. Between the
//     minimum and full coverage thresholds the measured figure is blended with
//     the prior in proportion to how much season it covers.
//  2. `estimated_from_grid` — a daily whole-home series from the grid operator
//     with at least 300 days. Household electricity is removed with BEN's
//     30 kWh/m²·år standard rather than metered.
//  3. `modelled_archetype` — no usable measurement. The expected breakdown for
//     this building's age, form and heating system, from published housing
//     stock statistics. This is the normal case for a prospective customer and
//     for any home in its first winter, and it must always be badged as
//     modelled rather than measured.
//
// All three produce a primary-energy number in kWh/m²·år, compared against the
// same BBR 31 småhus requirement and classified on the same A–G scale. Only the
// confidence and the badge differ, and callers must surface both.

import {
  computeEnergiprestanda,
  measuredHeatingWeight,
  DEFAULT_GEOGRAPHIC_ADJUSTMENT_FACTOR,
  ELECTRICITY_WEIGHTING_FACTOR,
  type DailyCategoryReading,
  type DailyTemperature,
  type EnergiprestandaResult,
} from './energiprestanda';
import {
  eventCoverage,
  latestRenovationYear,
  renovationHeatingFactor,
  periodDates,
  type EnergyEvent,
  type EventCoverageWarning,
} from './energy-events';
import {
  archetypePrior,
  type ArchetypePrior,
  type DwellingArchetype,
  type HeatingArchetype,
} from './energy-archetypes';
import {
  buildIndicativeEnergyPerformance,
  classifyEnergyPerformance,
  smallHouseNewBuildRequirement,
  type IndicativeEnergyGrade,
  type IndicativeEnergyPerformance,
} from './indicative-energy-performance';
import type { DailyEnergyReading } from './energy-usage-series';

export type EnergyPerformanceMethod =
  | 'measured_categories'
  | 'estimated_from_grid'
  | 'modelled_archetype';

export type EnergyPerformanceConfidence = 'high' | 'medium' | 'low';

export type EnergyPerformanceBlocker =
  | 'no_data'
  | 'missing_heated_area'
  | 'area_not_supported'
  | 'solar_requires_total_consumption'
  | 'insufficient_data';

/** Days of real whole-home metering before the grid estimate stops being a guess. */
export const ESTIMATE_MEDIUM_CONFIDENCE_DAYS = 300;

export interface EnergyPerformanceHomeFacts {
  yearBuilt?: number | null;
  dwelling?: DwellingArchetype | null;
  heating?: HeatingArchetype | null;
  /** BBR 31 Table 9:2c. Null means "unknown, assume 1.0 and say so". */
  geographicAdjustmentFactor?: number | null;
}

export interface ResolvedEnergyPerformance {
  method: EnergyPerformanceMethod | null;
  confidence: EnergyPerformanceConfidence | null;
  grade: IndicativeEnergyGrade | null;
  primaryEnergyKwhM2: number | null;
  newBuildRequirementKwhM2: number | null;
  requirementPercent: number | null;
  heatedAreaM2: number | null;
  blocker: EnergyPerformanceBlocker | null;
  measured: EnergiprestandaResult;
  estimated: IndicativeEnergyPerformance;
  /** The archetype prior, always computed when the area is known. */
  prior: ArchetypePrior | null;
  /** Primary energy implied by the prior alone. */
  priorPrimaryEnergyKwhM2: number | null;
  /**
   * Share of the published figure that comes from measurement rather than the
   * prior: 0 = entirely modelled, 1 = entirely measured.
   */
  measuredWeight: number;
  /** True when the number leans on the prior and must be badged as modelled. */
  isModelled: boolean;
  /** True when F_geo was assumed rather than known. */
  geographicFactorAssumed: boolean;
  hasCategoryReadings: boolean;
  /** Most recent recorded envelope renovation, if any. */
  renovationYear: number | null;
  /** Multiplier applied to the prior's heating term for recorded renovations. */
  renovationHeatingFactor: number;
  /** What the customer's recorded events mean for this window. */
  eventWarnings: EventCoverageWarning[];
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

/** Primary energy implied by an archetype prior, with F_geo on the heating term. */
export function priorPrimaryEnergy(
  prior: ArchetypePrior,
  atempM2: number,
  geographicAdjustmentFactor: number,
): number {
  const fGeo = geographicAdjustmentFactor > 0 ? geographicAdjustmentFactor : 1;
  const weighted =
    prior.heatingKwh / fGeo + prior.hotWaterKwh + prior.propertyEnergyKwh;
  return (weighted * ELECTRICITY_WEIGHTING_FACTOR) / atempM2;
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

export function resolveEnergyPerformance(
  categoryReadings: readonly DailyCategoryReading[],
  dailyReadings: DailyEnergyReading[],
  atempM2: number | null,
  weather: readonly DailyTemperature[],
  hasSolar: boolean | null = null,
  homeFacts: EnergyPerformanceHomeFacts = {},
  events: readonly EnergyEvent[] = [],
): ResolvedEnergyPerformance {
  const area = normalizedArea(atempM2);
  const geographicFactorAssumed =
    homeFacts.geographicAdjustmentFactor === null
    || homeFacts.geographicAdjustmentFactor === undefined;
  const fGeo = geographicFactorAssumed
    ? DEFAULT_GEOGRAPHIC_ADJUSTMENT_FACTOR
    : (homeFacts.geographicAdjustmentFactor as number);

  // Days the customer flagged as unrepresentative never enter the evidence.
  const excludedDates = periodDates(events);
  const measured = computeEnergiprestanda(categoryReadings, area, weather, {
    geographicAdjustmentFactor: fGeo,
    excludedDates,
  });
  const estimated = buildIndicativeEnergyPerformance(dailyReadings, area, hasSolar);
  const newBuildRequirementKwhM2 = area === null
    ? null
    : smallHouseNewBuildRequirement(area);

  // A renovated house does not perform like its unimproved cohort. This is the
  // input §1.3.4a recorded as missing, now supplied by a recorded event. It is
  // applied to heat demand rather than by shifting the build year — see
  // renovationHeatingFactor for why the obvious approach is wrong.
  const renovationFactor = renovationHeatingFactor(events);
  const basePrior = area === null
    ? null
    : archetypePrior({
      yearBuilt: homeFacts.yearBuilt ?? null,
      dwelling: homeFacts.dwelling ?? null,
      heating: homeFacts.heating ?? null,
      heatedAreaM2: area,
    });
  const prior = basePrior === null ? null : {
    ...basePrior,
    heatingKwh: basePrior.heatingKwh * renovationFactor,
    buildingEnergyKwh: basePrior.heatingKwh * renovationFactor
      + basePrior.hotWaterKwh + basePrior.propertyEnergyKwh,
    basis: renovationFactor < 1
      ? [
        ...basePrior.basis,
        `Recorded renovation: heating ×${renovationFactor.toFixed(2)} (modelled)`,
      ]
      : basePrior.basis,
  };
  const priorEp = prior !== null && area !== null
    ? priorPrimaryEnergy(prior, area, fGeo)
    : null;

  const base = {
    heatedAreaM2: area,
    newBuildRequirementKwhM2,
    measured,
    estimated,
    prior,
    priorPrimaryEnergyKwhM2: priorEp,
    geographicFactorAssumed,
    hasCategoryReadings: categoryReadings.length > 0,
    renovationYear: latestRenovationYear(events),
    renovationHeatingFactor: renovationFactor,
    eventWarnings: measured.windowStart !== null && measured.windowEnd !== null
      ? eventCoverage(events, measured.windowStart, measured.windowEnd)
      : [],
  };

  const finish = (
    method: EnergyPerformanceMethod,
    confidence: EnergyPerformanceConfidence,
    ep: number,
    measuredWeight: number,
  ): ResolvedEnergyPerformance => {
    const requirementPercent = (ep / (newBuildRequirementKwhM2 as number)) * 100;
    return {
      ...base,
      method,
      confidence,
      grade: classifyEnergyPerformance(requirementPercent),
      primaryEnergyKwhM2: ep,
      requirementPercent,
      measuredWeight,
      isModelled: measuredWeight < 1,
      blocker: null,
    };
  };

  // 1. Measured categories, weighted by how much heating season they cover.
  if (measured.reason === 'ok' && measured.ep !== null && newBuildRequirementKwhM2 !== null) {
    const weight = measuredHeatingWeight(measured);
    if (weight >= 1 || priorEp === null) {
      return finish('measured_categories', 'high', measured.ep, 1);
    }
    const blended = measured.ep * weight + priorEp * (1 - weight);
    return finish('measured_categories', 'medium', blended, weight);
  }

  // 2. Whole-home grid history. Already gated at 300 days upstream, so it
  //    cannot repeat the summer-extrapolation failure.
  if (estimated.grade !== null && estimated.primaryEnergyKwhM2 !== null
    && newBuildRequirementKwhM2 !== null) {
    return finish(
      'estimated_from_grid',
      estimateConfidence(estimated),
      estimated.primaryEnergyKwhM2,
      0,
    );
  }

  // 3. Nothing usable measured. The prior is the answer, badged as modelled.
  if (priorEp !== null && newBuildRequirementKwhM2 !== null) {
    return finish('modelled_archetype', 'low', priorEp, 0);
  }

  return {
    ...base,
    method: null,
    confidence: null,
    grade: null,
    primaryEnergyKwhM2: null,
    requirementPercent: null,
    measuredWeight: 0,
    isModelled: false,
    blocker: blockerFor(
      estimated,
      categoryReadings.length > 0 || dailyReadings.length > 0,
    ),
  };
}
