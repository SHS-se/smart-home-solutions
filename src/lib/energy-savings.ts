import type { EnergyBillingMonth } from './energy-billing-series';
import type { MonthlyEnergyFlow } from './energy-usage-series';

/**
 * What solar and battery are worth in money.
 *
 * Two things are saved. Energy the home used but never bought, valued at the
 * price that kWh would have been bought for, and what the grid paid for the
 * surplus that went the other way.
 *
 * The price of an avoided kWh is deliberately *not* the all-in cost per kWh.
 * The fixed grid fee, the electricity subscription and the peak-demand charge
 * are owed whatever the panels do, so pricing self-consumption at the average
 * cost per kWh would credit the installation with money it never saved. Only
 * the charges that fall when a kWh is not imported are counted: spot energy,
 * supplier markups, grid transfer, energy tax, and the VAT that rides on them.
 *
 * Every figure is measured. A month with no whole-home reading contributes no
 * avoided purchase rather than a guess, and the totals say how much was
 * measured so a short window is never mistaken for a year.
 */

export interface MonthlyEnergySaving {
  monthKey: string;
  /** Variable cost of one imported kWh, or null when a side of the bill is missing. */
  avoidedRateSekPerKwh: number | null;
  /** Energy the home used without buying it, over the days both series cover. */
  selfConsumedKwh: number | null;
  /** Days where grid import and whole-home load were both measured. */
  measuredDays: number;
  daysInMonth: number;
  /** What the self-consumed kWh would have cost at this month's variable price. */
  avoidedImportSek: number | null;
  /** Export credits net of export fees. Negative if the fees were larger. */
  exportIncomeSek: number | null;
  exportedKwh: number | null;
  savingSek: number | null;
  /** The bill as invoiced or calculated. */
  billedCostSek: number | null;
}

export interface EnergySavingsSummary {
  months: MonthlyEnergySaving[];
  avoidedImportSek: number | null;
  exportIncomeSek: number | null;
  savingSek: number | null;
  selfConsumedKwh: number | null;
  exportedKwh: number | null;
  /** Billed cost of the months that contributed a saving. */
  billedCostSek: number | null;
  /** What those months would have cost with nothing behind the meter. */
  costWithoutSelfSupplySek: number | null;
  /** Saving as a share of that counterfactual cost. */
  savedShare: number | null;
  averageAvoidedRateSekPerKwh: number | null;
  measuredDays: number;
  /** Months where self-consumption could be measured and priced. */
  measuredMonths: number;
  /** Months with a bill but no whole-home reading to value against it. */
  unmeasuredMonths: number;
  firstMeasuredMonth: string | null;
  lastMeasuredMonth: string | null;
}

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/** Scale a partly covered month up to a whole one so the two halves compare. */
function coverageScale(coverageDays: number, daysInMonth: number): number | null {
  if (coverageDays <= 0 || daysInMonth <= 0) return null;
  return daysInMonth / Math.min(coverageDays, daysInMonth);
}

/**
 * Split VAT the way it was charged: proportionally across what it was charged
 * on. Swedish VAT is a flat rate on every line, so the ex-VAT share of the
 * variable charges is exactly their share of the VAT.
 */
function vatOnVariable(
  variableExVat: number,
  fixedExVat: number,
  vatSek: number,
): number {
  const base = variableExVat + fixedExVat;
  if (vatSek === 0 || base <= 0) return 0;
  return vatSek * (variableExVat / base);
}

/**
 * Cost of one more imported kWh, counting only charges that follow the kWh.
 *
 * Null whenever the month cannot answer it honestly: either half of the bill
 * missing, or no metered import to divide by. Amounts that already include VAT
 * — everything Home Assistant calculates — carry a zero VAT line and pass
 * through untouched.
 */
export function variableImportPriceSekPerKwh(
  month: EnergyBillingMonth,
): number | null {
  const gridScale = coverageScale(month.gridCoverageDays, month.daysInMonth);
  const electricityScale = coverageScale(
    month.electricityCoverageDays,
    month.daysInMonth,
  );
  const consumptionScale = month.consumptionSource === 'grid'
    ? gridScale
    : electricityScale;
  if (
    gridScale === null
    || electricityScale === null
    || consumptionScale === null
    || month.consumptionKwh === null
    || month.consumptionKwh <= 0
  ) {
    return null;
  }

  const gridVariableExVat = month.gridTransferSek + month.energyTaxSek;
  const gridFixedExVat = month.gridFixedSek + month.gridPeakSek;
  const electricityVariableExVat = month.electricityEnergySek
    + (month.electricityFeesSek - month.electricityFixedSek - month.electricityVatSek);
  const variableCostSek = (
    gridVariableExVat
    + vatOnVariable(gridVariableExVat, gridFixedExVat, month.gridVatSek)
  ) * gridScale + (
    electricityVariableExVat
    + vatOnVariable(electricityVariableExVat, month.electricityFixedSek, month.electricityVatSek)
  ) * electricityScale;
  if (variableCostSek <= 0) return null;

  return round(variableCostSek / (month.consumptionKwh * consumptionScale), 4);
}

/**
 * Value each month's behind-the-meter supply and export.
 *
 * `months` is the billing series for the window on screen; `flows` the daily
 * usage rolled up per month. A month present in one and not the other simply
 * contributes what it knows.
 */
export function buildMonthlyEnergySavings(
  months: readonly EnergyBillingMonth[],
  flows: readonly MonthlyEnergyFlow[],
): MonthlyEnergySaving[] {
  const flowByMonth = new Map(flows.map((flow) => [flow.monthKey, flow]));

  return months.map((month) => {
    const flow = flowByMonth.get(month.monthKey);
    const measuredDays = flow?.pairedDays ?? 0;
    const selfConsumedKwh = flow && flow.selfSuppliedAverageKwh !== null && measuredDays > 0
      ? round(flow.selfSuppliedAverageKwh * measuredDays, 3)
      : null;
    const avoidedRateSekPerKwh = variableImportPriceSekPerKwh(month);
    const avoidedImportSek = selfConsumedKwh !== null && avoidedRateSekPerKwh !== null
      ? round(selfConsumedKwh * avoidedRateSekPerKwh)
      : null;
    // Export credits are carried as negative cost, which is how they reduce a
    // bill. Turned around here, because a saving reads as a positive number.
    const billed = month.gridCoverageDays > 0 || month.electricityCoverageDays > 0;
    const exportIncomeSek = billed ? round(-month.exportNetSek) : null;
    const savingSek = avoidedImportSek === null && exportIncomeSek === null
      ? null
      : round((avoidedImportSek ?? 0) + (exportIncomeSek ?? 0));

    return {
      monthKey: month.monthKey,
      avoidedRateSekPerKwh,
      selfConsumedKwh,
      measuredDays,
      daysInMonth: month.daysInMonth,
      avoidedImportSek,
      exportIncomeSek,
      exportedKwh: month.exportedKwh,
      savingSek,
      billedCostSek: month.totalCostSek,
    };
  });
}

/**
 * Total the months that had something to say.
 *
 * The counterfactual bill and its share are taken over the contributing months
 * only, so a saving measured over four months is never divided by a year of
 * invoices.
 */
export function summariseEnergySavings(
  savings: readonly MonthlyEnergySaving[],
): EnergySavingsSummary {
  const contributing = savings.filter((month) => month.savingSek !== null);
  const measured = savings.filter(
    (month) => month.avoidedImportSek !== null && month.selfConsumedKwh !== null,
  );
  const sum = (
    rows: readonly MonthlyEnergySaving[],
    value: (row: MonthlyEnergySaving) => number | null,
  ): number | null => {
    const values = rows.map(value).filter((entry): entry is number => entry !== null);
    return values.length === 0
      ? null
      : round(values.reduce((total, entry) => total + entry, 0));
  };

  const avoidedImportSek = sum(measured, (month) => month.avoidedImportSek);
  const exportIncomeSek = sum(contributing, (month) => month.exportIncomeSek);
  const savingSek = sum(contributing, (month) => month.savingSek);
  const selfConsumedKwh = measured.length === 0
    ? null
    : round(
      measured.reduce((total, month) => total + (month.selfConsumedKwh ?? 0), 0),
      3,
    );
  const billedCostSek = sum(contributing, (month) => month.billedCostSek);
  const costWithoutSelfSupplySek = billedCostSek === null || savingSek === null
    ? null
    : round(billedCostSek + savingSek);

  return {
    months: [...savings],
    avoidedImportSek,
    exportIncomeSek,
    savingSek,
    selfConsumedKwh,
    exportedKwh: sum(contributing, (month) => month.exportedKwh),
    billedCostSek,
    costWithoutSelfSupplySek,
    savedShare: savingSek === null
      || costWithoutSelfSupplySek === null
      || costWithoutSelfSupplySek <= 0
      ? null
      : round(savingSek / costWithoutSelfSupplySek, 4),
    averageAvoidedRateSekPerKwh: avoidedImportSek === null
      || selfConsumedKwh === null
      || selfConsumedKwh <= 0
      ? null
      : round(avoidedImportSek / selfConsumedKwh, 4),
    measuredDays: measured.reduce((total, month) => total + month.measuredDays, 0),
    measuredMonths: measured.length,
    unmeasuredMonths: savings.filter(
      (month) => month.billedCostSek !== null && month.avoidedImportSek === null,
    ).length,
    firstMeasuredMonth: measured.at(0)?.monthKey ?? null,
    lastMeasuredMonth: measured.at(-1)?.monthKey ?? null,
  };
}
