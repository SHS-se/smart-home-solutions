import type { EnergyBillingMonth } from './energy-billing-series';
import { variableImportPriceComponentsSekPerKwh } from './energy-savings';

/**
 * A consumption-independent view of the prices paid for imported energy.
 * Each index starts at 100 in its first complete, priceable month.
 */
export interface EnergyPriceInflationPoint {
  monthKey: string;
  gridSekPerKwh: number | null;
  electricitySekPerKwh: number | null;
  gridIndex: number | null;
  electricityIndex: number | null;
}

export interface EnergyPriceInflationSourceSummary {
  baselineMonth: string | null;
  latestMonth: string | null;
  baselineSekPerKwh: number | null;
  latestSekPerKwh: number | null;
  changeRatio: number | null;
  months: number;
}

export interface EnergyPriceInflation {
  points: EnergyPriceInflationPoint[];
  grid: EnergyPriceInflationSourceSummary;
  electricity: EnergyPriceInflationSourceSummary;
}

interface RawPricePoint {
  monthKey: string;
  gridSekPerKwh: number | null;
  electricitySekPerKwh: number | null;
}

function round(value: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function summariseSource(
  points: readonly RawPricePoint[],
  key: 'gridSekPerKwh' | 'electricitySekPerKwh',
): EnergyPriceInflationSourceSummary {
  const priced = points.filter(
    (point): point is RawPricePoint & Record<typeof key, number> => (
      point[key] !== null && Number.isFinite(point[key])
    ),
  );
  const baseline = priced.find((point) => point[key] > 0) ?? null;
  const latest = priced.at(-1) ?? null;
  if (!baseline || !latest) {
    return {
      baselineMonth: null,
      latestMonth: null,
      baselineSekPerKwh: null,
      latestSekPerKwh: null,
      changeRatio: null,
      months: priced.length,
    };
  }

  return {
    baselineMonth: baseline.monthKey,
    latestMonth: latest.monthKey,
    baselineSekPerKwh: baseline[key],
    latestSekPerKwh: latest[key],
    changeRatio: round((latest[key] / baseline[key]) - 1),
    months: priced.length,
  };
}

export function buildEnergyPriceInflation(
  months: readonly EnergyBillingMonth[],
): EnergyPriceInflation {
  const rawPoints = [...months]
    .sort((a, b) => a.monthKey.localeCompare(b.monthKey))
    .map((month): RawPricePoint => {
      const prices = variableImportPriceComponentsSekPerKwh(month);
      return {
        monthKey: month.monthKey,
        gridSekPerKwh: month.gridCoverage === 'complete'
          ? prices.gridSekPerKwh
          : null,
        electricitySekPerKwh: month.electricityCoverage === 'complete'
          ? prices.electricitySekPerKwh
          : null,
      };
    });
  const grid = summariseSource(rawPoints, 'gridSekPerKwh');
  const electricity = summariseSource(rawPoints, 'electricitySekPerKwh');

  const points = rawPoints
    .map((point): EnergyPriceInflationPoint => ({
      ...point,
      gridIndex: point.gridSekPerKwh !== null && grid.baselineSekPerKwh !== null
        ? round((point.gridSekPerKwh / grid.baselineSekPerKwh) * 100, 2)
        : null,
      electricityIndex: point.electricitySekPerKwh !== null
        && electricity.baselineSekPerKwh !== null
        ? round((point.electricitySekPerKwh / electricity.baselineSekPerKwh) * 100, 2)
        : null,
    }))
    .filter((point) => point.gridIndex !== null || point.electricityIndex !== null);

  return { points, grid, electricity };
}
