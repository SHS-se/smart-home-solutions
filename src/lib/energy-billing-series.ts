import type {
  EnergyChargeCategory,
  EnergyDocumentKind,
} from './energy-billing-parser';

export interface EnergyBillingLineForSeries {
  category: EnergyChargeCategory;
  amountSek: number;
  quantity?: number | null;
  periodStart: string | null;
  periodEnd: string | null;
}

export interface EnergyBillingDocumentForSeries {
  id: string;
  documentKind: EnergyDocumentKind;
  periodStart: string;
  periodEnd: string;
  consumptionKwh: number | null;
  exportedKwh: number | null;
  peakDemandKw: number | null;
  totalAmountSek: number;
  lineItems: EnergyBillingLineForSeries[];
}

export type CoverageStatus = 'complete' | 'partial' | 'missing';

export interface EnergyBillingMonth {
  monthKey: string;
  year: number;
  month: number;
  daysInMonth: number;
  gridCoverageDays: number;
  electricityCoverageDays: number;
  gridCoverage: CoverageStatus;
  electricityCoverage: CoverageStatus;
  consumptionSource: EnergyDocumentKind | null;
  exportSource: EnergyDocumentKind | null;
  consumptionKwh: number | null;
  exportedKwh: number | null;
  gridConsumptionKwh: number | null;
  electricityConsumptionKwh: number | null;
  gridCostSek: number | null;
  electricityCostSek: number | null;
  totalCostSek: number | null;
  peakDemandKw: number | null;
  electricityEnergySek: number;
  electricityFeesSek: number;
  gridFixedSek: number;
  gridTransferSek: number;
  gridPeakSek: number;
  gridVatSek: number;
  energyTaxSek: number;
  exportNetSek: number;
}

interface DateInterval {
  start: Date;
  end: Date;
}

interface MutableMonth extends EnergyBillingMonth {
  gridCoverageIntervals: DateInterval[];
  electricityCoverageIntervals: DateInterval[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function parseDate(value: string): Date {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid energy billing date: ${value}`);
  }
  return date;
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function monthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function nextMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
}

function monthEnd(date: Date): Date {
  return new Date(nextMonth(monthStart(date)).getTime() - DAY_MS);
}

function inclusiveDays(start: Date, end: Date): number {
  return Math.floor((end.getTime() - start.getTime()) / DAY_MS) + 1;
}

function overlap(
  startA: Date,
  endA: Date,
  startB: Date,
  endB: Date,
): DateInterval | null {
  const start = new Date(Math.max(startA.getTime(), startB.getTime()));
  const end = new Date(Math.min(endA.getTime(), endB.getTime()));
  return start <= end ? { start, end } : null;
}

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function coverageStatus(coveredDays: number, daysInMonth: number): CoverageStatus {
  if (coveredDays <= 0) return 'missing';
  if (coveredDays >= daysInMonth) return 'complete';
  return 'partial';
}

function mergedCoverageDays(intervals: DateInterval[]): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: DateInterval[] = [];

  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (!previous || interval.start.getTime() > previous.end.getTime() + DAY_MS) {
      merged.push({ ...interval });
      continue;
    }
    if (interval.end > previous.end) previous.end = interval.end;
  }

  return merged.reduce(
    (total, interval) => total + inclusiveDays(interval.start, interval.end),
    0,
  );
}

function emptyMonth(date: Date): MutableMonth {
  const start = monthStart(date);
  const end = monthEnd(start);
  return {
    monthKey: toIsoDate(start).slice(0, 7),
    year: start.getUTCFullYear(),
    month: start.getUTCMonth() + 1,
    daysInMonth: inclusiveDays(start, end),
    gridCoverageDays: 0,
    electricityCoverageDays: 0,
    gridCoverage: 'missing',
    electricityCoverage: 'missing',
    consumptionSource: null,
    exportSource: null,
    consumptionKwh: null,
    exportedKwh: null,
    gridConsumptionKwh: null,
    electricityConsumptionKwh: null,
    gridCostSek: null,
    electricityCostSek: null,
    totalCostSek: null,
    peakDemandKw: null,
    electricityEnergySek: 0,
    electricityFeesSek: 0,
    gridFixedSek: 0,
    gridTransferSek: 0,
    gridPeakSek: 0,
    gridVatSek: 0,
    energyTaxSek: 0,
    exportNetSek: 0,
    gridCoverageIntervals: [],
    electricityCoverageIntervals: [],
  };
}

function monthAllocations(
  start: Date,
  end: Date,
  monthsByKey: Map<string, MutableMonth>,
): Array<{ month: MutableMonth; overlap: DateInterval; ratio: number }> {
  const totalDays = inclusiveDays(start, end);
  const allocations: Array<{ month: MutableMonth; overlap: DateInterval; ratio: number }> = [];
  for (
    let cursor = monthStart(start);
    cursor <= monthStart(end);
    cursor = nextMonth(cursor)
  ) {
    const key = toIsoDate(cursor).slice(0, 7);
    const month = monthsByKey.get(key);
    if (!month) continue;
    const clipped = overlap(start, end, cursor, monthEnd(cursor));
    if (!clipped) continue;
    allocations.push({
      month,
      overlap: clipped,
      ratio: inclusiveDays(clipped.start, clipped.end) / totalDays,
    });
  }
  return allocations;
}

function addNullable(
  current: number | null,
  value: number,
  decimals = 2,
): number {
  return round((current ?? 0) + value, decimals);
}

function addBreakdown(
  month: MutableMonth,
  documentKind: EnergyDocumentKind,
  category: EnergyChargeCategory,
  amountSek: number,
): void {
  const amount = round(amountSek);
  switch (category) {
    case 'spot_energy':
      month.electricityEnergySek = round(month.electricityEnergySek + amount);
      break;
    case 'variable_fee':
    case 'markup':
    case 'discount':
      month.electricityFeesSek = round(month.electricityFeesSek + amount);
      break;
    case 'vat':
      if (documentKind === 'grid') {
        month.gridVatSek = round(month.gridVatSek + amount);
      } else {
        month.electricityFeesSek = round(month.electricityFeesSek + amount);
      }
      break;
    case 'fixed_fee':
      if (documentKind === 'grid') {
        month.gridFixedSek = round(month.gridFixedSek + amount);
      } else {
        month.electricityFeesSek = round(month.electricityFeesSek + amount);
      }
      break;
    case 'energy_transfer':
      month.gridTransferSek = round(month.gridTransferSek + amount);
      break;
    case 'peak_demand':
      month.gridPeakSek = round(month.gridPeakSek + amount);
      break;
    case 'energy_tax':
      month.energyTaxSek = round(month.energyTaxSek + amount);
      break;
    case 'export_credit':
    case 'export_fee':
      month.exportNetSek = round(month.exportNetSek + amount);
      break;
  }
}

export function buildEnergyBillingSeries(
  documents: EnergyBillingDocumentForSeries[],
): EnergyBillingMonth[] {
  if (documents.length === 0) return [];

  const starts = documents.map((document) => parseDate(document.periodStart));
  const ends = documents.map((document) => parseDate(document.periodEnd));
  const firstMonth = monthStart(new Date(Math.min(...starts.map((date) => date.getTime()))));
  const lastMonth = monthStart(new Date(Math.max(...ends.map((date) => date.getTime()))));
  const months: MutableMonth[] = [];
  const monthsByKey = new Map<string, MutableMonth>();

  for (let cursor = firstMonth; cursor <= lastMonth; cursor = nextMonth(cursor)) {
    const month = emptyMonth(cursor);
    months.push(month);
    monthsByKey.set(month.monthKey, month);
  }

  for (const document of documents) {
    const documentStart = parseDate(document.periodStart);
    const documentEnd = parseDate(document.periodEnd);
    if (documentStart > documentEnd) {
      throw new Error(`Energy billing document ${document.id} has an inverted period`);
    }

    const consumptionLines = document.lineItems.filter((lineItem) => (
      typeof lineItem.quantity === 'number'
      && (
        (document.documentKind === 'grid' && lineItem.category === 'energy_transfer')
        || (document.documentKind === 'electricity' && lineItem.category === 'spot_energy')
      )
    ));
    const lineItemTotal = round(document.lineItems.reduce(
      (total, lineItem) => total + lineItem.amountSek,
      0,
    ));
    const allocateCostFromLines = document.lineItems.length > 0
      && lineItemTotal === round(document.totalAmountSek);
    const allocations = monthAllocations(documentStart, documentEnd, monthsByKey);
    for (const allocation of allocations) {
      const coverageIntervals = document.documentKind === 'grid'
        ? allocation.month.gridCoverageIntervals
        : allocation.month.electricityCoverageIntervals;
      coverageIntervals.push(allocation.overlap);

      if (document.documentKind === 'grid') {
        if (!allocateCostFromLines) {
          allocation.month.gridCostSek = addNullable(
            allocation.month.gridCostSek,
            document.totalAmountSek * allocation.ratio,
          );
        }
        if (document.consumptionKwh !== null && consumptionLines.length === 0) {
          allocation.month.gridConsumptionKwh = addNullable(
            allocation.month.gridConsumptionKwh,
            document.consumptionKwh * allocation.ratio,
            3,
          );
        }
      } else {
        if (!allocateCostFromLines) {
          allocation.month.electricityCostSek = addNullable(
            allocation.month.electricityCostSek,
            document.totalAmountSek * allocation.ratio,
          );
        }
        if (document.consumptionKwh !== null && consumptionLines.length === 0) {
          allocation.month.electricityConsumptionKwh = addNullable(
            allocation.month.electricityConsumptionKwh,
            document.consumptionKwh * allocation.ratio,
            3,
          );
        }
      }

      if (document.peakDemandKw !== null) {
        allocation.month.peakDemandKw = Math.max(
          allocation.month.peakDemandKw ?? Number.NEGATIVE_INFINITY,
          document.peakDemandKw,
        );
      }
    }

    for (const lineItem of consumptionLines) {
      const lineStart = parseDate(lineItem.periodStart ?? document.periodStart);
      const lineEnd = parseDate(lineItem.periodEnd ?? document.periodEnd);
      for (const allocation of monthAllocations(lineStart, lineEnd, monthsByKey)) {
        const value = (lineItem.quantity ?? 0) * allocation.ratio;
        if (document.documentKind === 'grid') {
          allocation.month.gridConsumptionKwh = addNullable(
            allocation.month.gridConsumptionKwh,
            value,
            3,
          );
        } else {
          allocation.month.electricityConsumptionKwh = addNullable(
            allocation.month.electricityConsumptionKwh,
            value,
            3,
          );
        }
      }
    }

    for (const lineItem of document.lineItems) {
      const lineStart = parseDate(lineItem.periodStart ?? document.periodStart);
      const lineEnd = parseDate(lineItem.periodEnd ?? document.periodEnd);
      for (const allocation of monthAllocations(lineStart, lineEnd, monthsByKey)) {
        if (allocateCostFromLines) {
          if (document.documentKind === 'grid') {
            allocation.month.gridCostSek = addNullable(
              allocation.month.gridCostSek,
              lineItem.amountSek * allocation.ratio,
            );
          } else {
            allocation.month.electricityCostSek = addNullable(
              allocation.month.electricityCostSek,
              lineItem.amountSek * allocation.ratio,
            );
          }
        }
        addBreakdown(
          allocation.month,
          document.documentKind,
          lineItem.category,
          lineItem.amountSek * allocation.ratio,
        );
      }
    }
  }

  for (const month of months) {
    month.gridCoverageDays = mergedCoverageDays(month.gridCoverageIntervals);
    month.electricityCoverageDays = mergedCoverageDays(month.electricityCoverageIntervals);
    month.gridCoverage = coverageStatus(month.gridCoverageDays, month.daysInMonth);
    month.electricityCoverage = coverageStatus(
      month.electricityCoverageDays,
      month.daysInMonth,
    );

    if (month.gridCoverageDays > 0 || month.electricityCoverageDays > 0) {
      month.consumptionSource = month.gridCoverageDays >= month.electricityCoverageDays
        && month.gridConsumptionKwh !== null
        ? 'grid'
        : month.electricityConsumptionKwh !== null
          ? 'electricity'
          : month.gridConsumptionKwh !== null
            ? 'grid'
            : null;
      month.consumptionKwh = month.consumptionSource === 'grid'
        ? month.gridConsumptionKwh
        : month.consumptionSource === 'electricity'
          ? month.electricityConsumptionKwh
          : null;
    }

    const gridExport = documents
      .filter((document) => document.documentKind === 'grid' && document.exportedKwh !== null)
      .reduce((total, document) => {
        const allocation = monthAllocations(
          parseDate(document.periodStart),
          parseDate(document.periodEnd),
          monthsByKey,
        ).find((candidate) => candidate.month.monthKey === month.monthKey);
        return total + (allocation ? (document.exportedKwh ?? 0) * allocation.ratio : 0);
      }, 0);
    const electricityExport = documents
      .filter((document) => document.documentKind === 'electricity' && document.exportedKwh !== null)
      .reduce((total, document) => {
        const allocation = monthAllocations(
          parseDate(document.periodStart),
          parseDate(document.periodEnd),
          monthsByKey,
        ).find((candidate) => candidate.month.monthKey === month.monthKey);
        return total + (allocation ? (document.exportedKwh ?? 0) * allocation.ratio : 0);
      }, 0);
    if (gridExport !== 0 || electricityExport !== 0) {
      month.exportSource = month.gridCoverageDays >= month.electricityCoverageDays
        && gridExport !== 0
        ? 'grid'
        : 'electricity';
      month.exportedKwh = month.exportSource === 'grid'
        ? round(gridExport, 3)
        : round(electricityExport || gridExport, 3);
    } else if (month.gridCoverageDays > 0 || month.electricityCoverageDays > 0) {
      month.exportSource = month.gridCoverageDays >= month.electricityCoverageDays
        ? 'grid'
        : 'electricity';
      month.exportedKwh = 0;
    }

    if (month.gridCostSek !== null || month.electricityCostSek !== null) {
      month.totalCostSek = round(
        (month.gridCostSek ?? 0) + (month.electricityCostSek ?? 0),
      );
    }

    delete (month as Partial<MutableMonth>).gridCoverageIntervals;
    delete (month as Partial<MutableMonth>).electricityCoverageIntervals;
  }

  return months;
}
