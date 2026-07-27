import type { EnergyBillingMonth } from './energy-billing-series';

export const SWEDISH_RESIDENTIAL_CONSUMPTION_SHARES = [
  0.125,
  0.11,
  0.1,
  0.075,
  0.06,
  0.05,
  0.045,
  0.05,
  0.065,
  0.085,
  0.105,
  0.13,
] as const;

export const SWEDISH_RESIDENTIAL_EXPORT_SHARES = [
  0.005,
  0.015,
  0.055,
  0.105,
  0.15,
  0.16,
  0.155,
  0.13,
  0.105,
  0.07,
  0.035,
  0.015,
] as const;

export const CENTRAL_SWEDEN_NORMAL_YEAR = [
  { month: 1, days: 31, temperatureC: -3.1 },
  { month: 2, days: 28, temperatureC: -2.8 },
  { month: 3, days: 31, temperatureC: 1 },
  { month: 4, days: 30, temperatureC: 5.7 },
  { month: 5, days: 31, temperatureC: 11.2 },
  { month: 6, days: 30, temperatureC: 15 },
  { month: 7, days: 31, temperatureC: 17.1 },
  { month: 8, days: 31, temperatureC: 15.9 },
  { month: 9, days: 30, temperatureC: 11.6 },
  { month: 10, days: 31, temperatureC: 6.4 },
  { month: 11, days: 30, temperatureC: 1.8 },
  { month: 12, days: 31, temperatureC: -1.6 },
] as const;

export interface AnnualizedMetric {
  value: number | null;
  estimated: boolean;
  observedMonths: number;
  completeMonths: number;
  seasonalCoverage: number;
}

export interface AnnualEnergyHistoryEstimate {
  consumptionKwh: AnnualizedMetric;
  exportedKwh: AnnualizedMetric;
  gridCostSek: AnnualizedMetric;
  electricityCostSek: AnnualizedMetric;
  totalCostSek: AnnualizedMetric;
  costPerKwh: AnnualizedMetric;
  windowStart: string | null;
  windowEnd: string | null;
}

interface AnnualizeOptions {
  value: (month: EnergyBillingMonth) => number | null;
  coverageDays: (month: EnergyBillingMonth) => number;
  shares: readonly number[];
}

const UNIFORM_MONTH_SHARES = Array.from({ length: 12 }, () => 1 / 12);
const GRID_COST_SHARES = SWEDISH_RESIDENTIAL_CONSUMPTION_SHARES.map(
  (share, index) => (share + UNIFORM_MONTH_SHARES[index]) / 2,
);
const ELECTRICITY_COST_SHARES = SWEDISH_RESIDENTIAL_CONSUMPTION_SHARES.map(
  (share, index) => share * 0.8 + UNIFORM_MONTH_SHARES[index] * 0.2,
);

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function annualize(
  months: EnergyBillingMonth[],
  options: AnnualizeOptions,
): AnnualizedMetric {
  const observations = months.flatMap((month) => {
    const value = options.value(month);
    const coverageDays = Math.min(
      Math.max(options.coverageDays(month), 0),
      month.daysInMonth,
    );
    if (value === null || coverageDays === 0) return [];
    const coverageFraction = coverageDays / month.daysInMonth;
    return [{
      month,
      value,
      coverageFraction,
      share: options.shares[month.month - 1],
    }];
  });
  const completeMonths = observations.filter(
    ({ coverageFraction }) => coverageFraction >= 1,
  ).length;
  const completeAnnualWindow = months.length === 12
    && observations.length === 12
    && completeMonths === 12;

  if (observations.length === 0) {
    return {
      value: null,
      estimated: true,
      observedMonths: 0,
      completeMonths: 0,
      seasonalCoverage: 0,
    };
  }

  if (completeAnnualWindow) {
    return {
      value: round(observations.reduce((sum, observation) => sum + observation.value, 0)),
      estimated: false,
      observedMonths: 12,
      completeMonths: 12,
      seasonalCoverage: 1,
    };
  }

  const seasonalCoverage = observations.reduce(
    (sum, observation) => sum + observation.share * observation.coverageFraction,
    0,
  );
  const fullMonthTotal = observations.reduce(
    (sum, observation) => sum + observation.value / observation.coverageFraction,
    0,
  );
  const observedSeasonalShares = observations.reduce(
    (sum, observation) => sum + observation.share,
    0,
  );

  return {
    value: observedSeasonalShares > 0
      ? round(fullMonthTotal / observedSeasonalShares)
      : null,
    estimated: true,
    observedMonths: observations.length,
    completeMonths,
    seasonalCoverage: round(seasonalCoverage, 4),
  };
}

function combineCostMetrics(
  grid: AnnualizedMetric,
  electricity: AnnualizedMetric,
): AnnualizedMetric {
  const values = [grid.value, electricity.value].filter(
    (value): value is number => value !== null,
  );
  return {
    value: values.length === 0 ? null : round(values.reduce((sum, value) => sum + value, 0)),
    estimated: grid.estimated || electricity.estimated
      || grid.value === null
      || electricity.value === null,
    observedMonths: Math.min(grid.observedMonths, electricity.observedMonths),
    completeMonths: Math.min(grid.completeMonths, electricity.completeMonths),
    seasonalCoverage: Math.min(grid.seasonalCoverage, electricity.seasonalCoverage),
  };
}

export function estimateAnnualEnergyHistory(
  series: EnergyBillingMonth[],
): AnnualEnergyHistoryEstimate {
  const months = series.slice(-12);
  const consumptionKwh = annualize(months, {
    value: (month) => month.consumptionKwh,
    coverageDays: (month) => month.consumptionSource === 'grid'
      ? month.gridCoverageDays
      : month.electricityCoverageDays,
    shares: SWEDISH_RESIDENTIAL_CONSUMPTION_SHARES,
  });
  const exportedKwh = annualize(months, {
    value: (month) => month.exportedKwh,
    coverageDays: (month) => month.exportSource === 'grid'
      ? month.gridCoverageDays
      : month.electricityCoverageDays,
    shares: SWEDISH_RESIDENTIAL_EXPORT_SHARES,
  });
  const gridCostSek = annualize(months, {
    value: (month) => month.gridCostSek,
    coverageDays: (month) => month.gridCoverageDays,
    shares: GRID_COST_SHARES,
  });
  const electricityCostSek = annualize(months, {
    value: (month) => month.electricityCostSek,
    coverageDays: (month) => month.electricityCoverageDays,
    shares: ELECTRICITY_COST_SHARES,
  });
  const totalCostSek = combineCostMetrics(gridCostSek, electricityCostSek);
  const costPerKwhValue = totalCostSek.value !== null
    && consumptionKwh.value !== null
    && consumptionKwh.value > 0
    ? round(totalCostSek.value / consumptionKwh.value, 3)
    : null;
  const costPerKwh: AnnualizedMetric = {
    value: costPerKwhValue,
    estimated: totalCostSek.estimated || consumptionKwh.estimated,
    observedMonths: Math.min(
      totalCostSek.observedMonths,
      consumptionKwh.observedMonths,
    ),
    completeMonths: Math.min(
      totalCostSek.completeMonths,
      consumptionKwh.completeMonths,
    ),
    seasonalCoverage: Math.min(
      totalCostSek.seasonalCoverage,
      consumptionKwh.seasonalCoverage,
    ),
  };

  return {
    consumptionKwh,
    exportedKwh,
    gridCostSek,
    electricityCostSek,
    totalCostSek,
    costPerKwh,
    windowStart: months.at(0)?.monthKey ?? null,
    windowEnd: months.at(-1)?.monthKey ?? null,
  };
}

interface TemperatureSweepPoint {
  tempC: number;
  dailyKwh: number;
  peakW?: number;
}

export interface NormalYearEstimate {
  annualKwh: number;
  annualPeakWMonths: number;
  monthly: Array<{
    month: number;
    temperatureC: number;
    energyKwh: number;
    peakW: number;
  }>;
}

function interpolateSweepValue(
  sweep: TemperatureSweepPoint[],
  temperatureC: number,
  key: 'dailyKwh' | 'peakW',
): number {
  const points = sweep
    .filter((point) => typeof point[key] === 'number')
    .sort((a, b) => a.tempC - b.tempC);
  if (points.length === 0) return 0;
  const lower = [...points].reverse().find((point) => point.tempC <= temperatureC)
    ?? points[0];
  const upper = points.find((point) => point.tempC >= temperatureC)
    ?? points.at(-1)!;
  const lowerValue = Number(lower[key]);
  const upperValue = Number(upper[key]);
  if (lower.tempC === upper.tempC) return lowerValue;
  const ratio = (temperatureC - lower.tempC) / (upper.tempC - lower.tempC);
  return lowerValue + (upperValue - lowerValue) * ratio;
}

export function estimateNormalYearFromTemperatureSweep(
  sweep: TemperatureSweepPoint[],
): NormalYearEstimate {
  const monthly = CENTRAL_SWEDEN_NORMAL_YEAR.map((month) => ({
    month: month.month,
    temperatureC: month.temperatureC,
    energyKwh: interpolateSweepValue(sweep, month.temperatureC, 'dailyKwh') * month.days,
    peakW: interpolateSweepValue(sweep, month.temperatureC, 'peakW'),
  }));

  return {
    annualKwh: round(
      monthly.reduce((sum, month) => sum + month.energyKwh, 0),
      0,
    ),
    annualPeakWMonths: round(
      monthly.reduce((sum, month) => sum + month.peakW, 0),
      0,
    ),
    monthly: monthly.map((month) => ({
      ...month,
      energyKwh: round(month.energyKwh),
      peakW: round(month.peakW, 0),
    })),
  };
}
