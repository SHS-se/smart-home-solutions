import type {
  CoverageStatus,
  EnergyBillingMonth,
} from './energy-billing-series';
import { normalizeHomeProfileDate } from './home-profile-values';

export interface EnergyCoverageIssue {
  monthKey: string;
  gridCoverage: CoverageStatus;
  electricityCoverage: CoverageStatus;
}

function nextMonthKey(monthKey: string): string {
  const [year, month] = monthKey.split('-').map(Number);
  return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 7);
}

function effectiveMoveInMonthCoverage(
  coverageDays: number,
  originalStatus: CoverageStatus,
  expectedDays: number,
): CoverageStatus {
  return coverageDays >= expectedDays ? 'complete' : originalStatus;
}

export function getEnergyCoverageIssues(
  series: EnergyBillingMonth[],
  moveInDate: string | null,
): EnergyCoverageIssue[] {
  if (series.length === 0) return [];

  const normalizedMoveInDate = normalizeHomeProfileDate(moveInDate);
  if (!normalizedMoveInDate) {
    return series
      .filter((month) => (
        month.gridCoverage !== 'complete'
        || month.electricityCoverage !== 'complete'
      ))
      .map((month) => ({
        monthKey: month.monthKey,
        gridCoverage: month.gridCoverage,
        electricityCoverage: month.electricityCoverage,
      }));
  }

  const moveInMonthKey = normalizedMoveInDate.slice(0, 7);
  const firstRelevantMonth = series.find((month) => month.monthKey >= moveInMonthKey);
  if (!firstRelevantMonth) return [];

  const issues: EnergyCoverageIssue[] = [];
  for (
    let monthKey = moveInMonthKey;
    monthKey < firstRelevantMonth.monthKey;
    monthKey = nextMonthKey(monthKey)
  ) {
    issues.push({
      monthKey,
      gridCoverage: 'missing',
      electricityCoverage: 'missing',
    });
  }

  const moveInDay = Number(normalizedMoveInDate.slice(8, 10));
  for (const month of series) {
    if (month.monthKey < moveInMonthKey) continue;

    const expectedDays = month.monthKey === moveInMonthKey
      ? month.daysInMonth - moveInDay + 1
      : month.daysInMonth;
    const gridCoverage = month.monthKey === moveInMonthKey
      ? effectiveMoveInMonthCoverage(
          month.gridCoverageDays,
          month.gridCoverage,
          expectedDays,
        )
      : month.gridCoverage;
    const electricityCoverage = month.monthKey === moveInMonthKey
      ? effectiveMoveInMonthCoverage(
          month.electricityCoverageDays,
          month.electricityCoverage,
          expectedDays,
        )
      : month.electricityCoverage;

    if (gridCoverage !== 'complete' || electricityCoverage !== 'complete') {
      issues.push({
        monthKey: month.monthKey,
        gridCoverage,
        electricityCoverage,
      });
    }
  }

  return issues;
}
