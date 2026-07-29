import type { EnergyReadingKind } from './energy-usage-parser';

export interface DailyEnergyReading {
  readingDate: string;
  consumptionKwh: number;
  readingKind: EnergyReadingKind;
}

export interface SelectedEfficiencyReading {
  readingDate: string;
  consumptionKwh: number;
  readingKind: EnergyReadingKind;
}

export interface MonthlyEnergyFlow {
  monthKey: string;
  gridImportAverageKwh: number | null;
  totalConsumptionAverageKwh: number | null;
  selfSuppliedAverageKwh: number | null;
  gridImportDays: number;
  totalConsumptionDays: number;
  pairedDays: number;
}

export interface RollingAnnualEnergyProfile {
  startDate: string | null;
  endDate: string | null;
  gridImportDays: number;
  efficiencyDays: number;
  actualTotalConsumptionDays: number;
  pairedDays: number;
  annualGridImportKwh: number | null;
  annualWholeHomeKwh: number | null;
  averageSelfSuppliedKwhPerDay: number | null;
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MIN_ANNUAL_COVERAGE_DAYS = 300;

function assertReading(reading: DailyEnergyReading): void {
  if (
    !ISO_DATE_PATTERN.test(reading.readingDate)
    || !Number.isFinite(reading.consumptionKwh)
    || reading.consumptionKwh < 0
    || (reading.readingKind !== 'grid_import' && reading.readingKind !== 'total_consumption')
  ) {
    throw new Error('Energy usage contains an invalid daily reading.');
  }
}

function readingsByDate(readings: DailyEnergyReading[]): Map<string, Map<EnergyReadingKind, number>> {
  const byDate = new Map<string, Map<EnergyReadingKind, number>>();
  for (const reading of readings) {
    assertReading(reading);
    const kinds = byDate.get(reading.readingDate) ?? new Map<EnergyReadingKind, number>();
    if (kinds.has(reading.readingKind)) {
      throw new Error(
        `Energy usage contains more than one ${reading.readingKind} reading on ${reading.readingDate}.`,
      );
    }
    kinds.set(reading.readingKind, reading.consumptionKwh);
    byDate.set(reading.readingDate, kinds);
  }
  return byDate;
}

function firstTotalConsumptionDate(
  byDate: Map<string, Map<EnergyReadingKind, number>>,
): string | null {
  return Array.from(byDate.entries())
    .filter(([, values]) => values.has('total_consumption'))
    .map(([readingDate]) => readingDate)
    .sort()
    .at(0) ?? null;
}

export function selectEfficiencyReadings(
  readings: DailyEnergyReading[],
): SelectedEfficiencyReading[] {
  const byDate = readingsByDate(readings);
  const totalConsumptionStart = firstTotalConsumptionDate(byDate);
  return Array.from(byDate.entries())
    .sort(([dateA], [dateB]) => dateA.localeCompare(dateB))
    .flatMap<SelectedEfficiencyReading>(([readingDate, values]) => {
      const totalConsumption = values.get('total_consumption');
      if (totalConsumption !== undefined) {
        return [{
          readingDate,
          consumptionKwh: totalConsumption,
          readingKind: 'total_consumption' as const,
        }];
      }
      if (totalConsumptionStart !== null && readingDate >= totalConsumptionStart) {
        return [];
      }
      const gridImport = values.get('grid_import');
      return gridImport === undefined ? [] : [{
        readingDate,
        consumptionKwh: gridImport,
        readingKind: 'grid_import' as const,
      }];
    });
}

export function buildMonthlyEnergyFlows(
  readings: DailyEnergyReading[],
): MonthlyEnergyFlow[] {
  const months = Array.from(readingsByDate(readings).entries())
    .reduce<Map<string, {
      gridImportSum: number;
      totalConsumptionSum: number;
      selfSuppliedSum: number;
      gridImportDays: number;
      totalConsumptionDays: number;
      pairedDays: number;
    }>>((months, [readingDate, values]) => {
      const monthKey = readingDate.slice(0, 7);
      const month = months.get(monthKey) ?? {
        gridImportSum: 0,
        totalConsumptionSum: 0,
        selfSuppliedSum: 0,
        gridImportDays: 0,
        totalConsumptionDays: 0,
        pairedDays: 0,
      };
      const gridImport = values.get('grid_import');
      const totalConsumption = values.get('total_consumption');
      if (gridImport !== undefined) {
        month.gridImportSum += gridImport;
        month.gridImportDays += 1;
      }
      if (totalConsumption !== undefined) {
        month.totalConsumptionSum += totalConsumption;
        month.totalConsumptionDays += 1;
      }
      if (gridImport !== undefined && totalConsumption !== undefined) {
        month.selfSuppliedSum += Math.max(0, totalConsumption - gridImport);
        month.pairedDays += 1;
      }
      months.set(monthKey, month);
      return months;
    }, new Map());

  return Array.from(months.entries())
    .sort(([monthA], [monthB]) => monthA.localeCompare(monthB))
    .map(([monthKey, month]) => ({
      monthKey,
      gridImportAverageKwh: month.gridImportDays > 0
        ? month.gridImportSum / month.gridImportDays
        : null,
      totalConsumptionAverageKwh: month.totalConsumptionDays > 0
        ? month.totalConsumptionSum / month.totalConsumptionDays
        : null,
      selfSuppliedAverageKwh: month.pairedDays > 0
        ? month.selfSuppliedSum / month.pairedDays
        : null,
      gridImportDays: month.gridImportDays,
      totalConsumptionDays: month.totalConsumptionDays,
      pairedDays: month.pairedDays,
    }));
}

function subtractUtcDays(date: string, days: number): string {
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  return new Date(timestamp - (days * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10);
}

function annualized(total: number, days: number): number | null {
  return days >= MIN_ANNUAL_COVERAGE_DAYS ? total * (365 / days) : null;
}

export function buildRollingAnnualEnergyProfile(
  readings: DailyEnergyReading[],
): RollingAnnualEnergyProfile {
  const byDate = readingsByDate(readings);
  const totalConsumptionStart = firstTotalConsumptionDate(byDate);
  const endDate = Array.from(byDate.keys()).sort().at(-1) ?? null;
  if (!endDate) {
    return {
      startDate: null,
      endDate: null,
      gridImportDays: 0,
      efficiencyDays: 0,
      actualTotalConsumptionDays: 0,
      pairedDays: 0,
      annualGridImportKwh: null,
      annualWholeHomeKwh: null,
      averageSelfSuppliedKwhPerDay: null,
    };
  }

  const startDate = subtractUtcDays(endDate, 364);
  let gridImportSum = 0;
  let wholeHomeSum = 0;
  let selfSuppliedSum = 0;
  let gridImportDays = 0;
  let efficiencyDays = 0;
  let actualTotalConsumptionDays = 0;
  let pairedDays = 0;

  for (const [readingDate, values] of byDate) {
    if (readingDate < startDate || readingDate > endDate) continue;
    const gridImport = values.get('grid_import');
    const totalConsumption = values.get('total_consumption');
    if (gridImport !== undefined) {
      gridImportSum += gridImport;
      gridImportDays += 1;
    }
    if (totalConsumption !== undefined) {
      wholeHomeSum += totalConsumption;
      actualTotalConsumptionDays += 1;
      efficiencyDays += 1;
    } else if (
      gridImport !== undefined
      && (totalConsumptionStart === null || readingDate < totalConsumptionStart)
    ) {
      wholeHomeSum += gridImport;
      efficiencyDays += 1;
    }
    if (gridImport !== undefined && totalConsumption !== undefined) {
      selfSuppliedSum += Math.max(0, totalConsumption - gridImport);
      pairedDays += 1;
    }
  }

  return {
    startDate,
    endDate,
    gridImportDays,
    efficiencyDays,
    actualTotalConsumptionDays,
    pairedDays,
    annualGridImportKwh: annualized(gridImportSum, gridImportDays),
    annualWholeHomeKwh: annualized(wholeHomeSum, efficiencyDays),
    averageSelfSuppliedKwhPerDay: pairedDays > 0
      ? selfSuppliedSum / pairedDays
      : null,
  };
}
