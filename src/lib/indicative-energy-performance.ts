import {
  buildRollingAnnualEnergyProfile,
  type DailyEnergyReading,
  type RollingAnnualEnergyProfile,
} from './energy-usage-series';

export type IndicativeEnergyGrade = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
export type EnergyPerformanceUnavailableReason =
  | 'missing_heated_area'
  | 'area_not_supported'
  | 'insufficient_daily_data'
  | 'solar_requires_total_consumption';

export interface IndicativeEnergyPerformance {
  grade: IndicativeEnergyGrade | null;
  unavailableReason: EnergyPerformanceUnavailableReason | null;
  profile: RollingAnnualEnergyProfile;
  heatedAreaM2: number | null;
  newBuildRequirementKwhM2: number | null;
  primaryEnergyKwhM2: number | null;
  requirementPercent: number | null;
  estimatedHouseholdElectricityKwh: number | null;
  estimatedBuildingEnergyNeedKwh: number | null;
  estimatedDeliveredBuildingElectricityKwh: number | null;
}

export const BOVERKET_ELECTRICITY_PRIMARY_ENERGY_FACTOR = 1.8;
export const STOCKHOLM_GEOGRAPHIC_ADJUSTMENT_FACTOR = 1;
export const NORMAL_HOUSEHOLD_ELECTRICITY_KWH_M2 = 30;

export function classifyEnergyPerformance(
  requirementPercent: number,
): IndicativeEnergyGrade {
  if (!Number.isFinite(requirementPercent) || requirementPercent < 0) {
    throw new Error('Energy-performance percentage must be a non-negative number.');
  }
  if (requirementPercent <= 50) return 'A';
  if (requirementPercent <= 75) return 'B';
  if (requirementPercent <= 100) return 'C';
  if (requirementPercent <= 135) return 'D';
  if (requirementPercent <= 180) return 'E';
  if (requirementPercent <= 235) return 'F';
  return 'G';
}

export function smallHouseNewBuildRequirement(heatedAreaM2: number): number | null {
  if (!Number.isFinite(heatedAreaM2) || heatedAreaM2 <= 50) return null;
  if (heatedAreaM2 > 130) return 90;
  if (heatedAreaM2 > 90) return 95;
  return 100;
}

export function buildIndicativeEnergyPerformance(
  readings: DailyEnergyReading[],
  heatedAreaM2: number | null,
  hasSolar: boolean | null = null,
): IndicativeEnergyPerformance {
  const profile = buildRollingAnnualEnergyProfile(readings);
  const emptyResult = (
    unavailableReason: EnergyPerformanceUnavailableReason,
    normalizedArea: number | null,
    requirement: number | null,
  ): IndicativeEnergyPerformance => ({
    grade: null,
    unavailableReason,
    profile,
    heatedAreaM2: normalizedArea,
    newBuildRequirementKwhM2: requirement,
    primaryEnergyKwhM2: null,
    requirementPercent: null,
    estimatedHouseholdElectricityKwh: null,
    estimatedBuildingEnergyNeedKwh: null,
    estimatedDeliveredBuildingElectricityKwh: null,
  });

  if (
    heatedAreaM2 === null
    || !Number.isFinite(heatedAreaM2)
    || heatedAreaM2 <= 0
    || heatedAreaM2 > 10_000
  ) {
    return emptyResult('missing_heated_area', null, null);
  }

  const newBuildRequirementKwhM2 = smallHouseNewBuildRequirement(heatedAreaM2);
  if (newBuildRequirementKwhM2 === null) {
    return emptyResult('area_not_supported', heatedAreaM2, null);
  }

  if (
    profile.annualGridImportKwh === null
    || profile.annualWholeHomeKwh === null
  ) {
    return emptyResult(
      'insufficient_daily_data',
      heatedAreaM2,
      newBuildRequirementKwhM2,
    );
  }

  if (hasSolar === true && profile.actualTotalConsumptionDays < 30) {
    return emptyResult(
      'solar_requires_total_consumption',
      heatedAreaM2,
      newBuildRequirementKwhM2,
    );
  }

  const estimatedHouseholdElectricityKwh =
    NORMAL_HOUSEHOLD_ELECTRICITY_KWH_M2 * heatedAreaM2;
  const estimatedBuildingEnergyNeedKwh = Math.max(
    0,
    profile.annualWholeHomeKwh - estimatedHouseholdElectricityKwh,
  );
  const estimatedBuildingShare = profile.annualWholeHomeKwh > 0
    ? estimatedBuildingEnergyNeedKwh / profile.annualWholeHomeKwh
    : 0;
  const estimatedDeliveredBuildingElectricityKwh = Math.min(
    estimatedBuildingEnergyNeedKwh,
    profile.annualGridImportKwh * estimatedBuildingShare,
  );
  const primaryEnergyKwhM2 = (
    estimatedDeliveredBuildingElectricityKwh
    * BOVERKET_ELECTRICITY_PRIMARY_ENERGY_FACTOR
  ) / (heatedAreaM2 * STOCKHOLM_GEOGRAPHIC_ADJUSTMENT_FACTOR);
  const requirementPercent = (
    primaryEnergyKwhM2 / newBuildRequirementKwhM2
  ) * 100;

  return {
    grade: classifyEnergyPerformance(requirementPercent),
    unavailableReason: null,
    profile,
    heatedAreaM2,
    newBuildRequirementKwhM2,
    primaryEnergyKwhM2,
    requirementPercent,
    estimatedHouseholdElectricityKwh,
    estimatedBuildingEnergyNeedKwh,
    estimatedDeliveredBuildingElectricityKwh,
  };
}
