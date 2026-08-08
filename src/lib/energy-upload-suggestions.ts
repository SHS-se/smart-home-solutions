import type { EnergyBillingMonth } from './energy-billing-series';
import { getEnergyCoverageIssues } from './energy-history-coverage';

export type SuggestedUploadKind = 'grid' | 'electricity';

export interface SuggestedUpload {
  monthKey: string;
  kind: SuggestedUploadKind;
  /** Days of the month no document of this kind reaches. */
  missingDays: number;
  /** Roughly what the upload would put a number on, for ranking. */
  unexplainedSek: number | null;
}

/** How many suggestions are worth showing before it stops being a to-do list. */
export const MAX_UPLOAD_SUGGESTIONS = 3;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function monthKeyOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/**
 * Which receipts would actually improve the picture, best first.
 *
 * Only closed months qualify: the month in progress is partial by definition
 * and prompting about it would never stop. Ranking is by how much money the
 * upload would put a real number on, so a winter month missing a fortnight
 * outranks a summer one missing a day.
 */
export function suggestedEnergyUploads(
  series: EnergyBillingMonth[],
  moveInDate: string | null,
  today: Date = new Date(),
): SuggestedUpload[] {
  const currentMonthKey = monthKeyOf(today);
  const byMonth = new Map(series.map((month) => [month.monthKey, month]));
  const referenceGrid = median(
    series.map((month) => month.gridCostSek).filter((cost): cost is number => cost !== null),
  );
  const referenceElectricity = median(
    series
      .map((month) => month.electricityCostSek)
      .filter((cost): cost is number => cost !== null),
  );

  const suggestions: SuggestedUpload[] = [];
  for (const issue of getEnergyCoverageIssues(series, moveInDate)) {
    if (issue.monthKey >= currentMonthKey) continue;
    const month = byMonth.get(issue.monthKey);
    if (!month) continue;

    const kinds: Array<[SuggestedUploadKind, number, number | null]> = [
      ['grid', month.gridCoverageDays, referenceGrid],
      ['electricity', month.electricityCoverageDays, referenceElectricity],
    ];
    for (const [kind, coverageDays, reference] of kinds) {
      const coverage = kind === 'grid' ? issue.gridCoverage : issue.electricityCoverage;
      if (coverage === 'complete') continue;
      const missingDays = Math.max(0, month.daysInMonth - coverageDays);
      if (missingDays === 0) continue;
      suggestions.push({
        monthKey: issue.monthKey,
        kind,
        missingDays,
        unexplainedSek: reference === null
          ? null
          : Math.round(reference * (missingDays / month.daysInMonth)),
      });
    }
  }

  return suggestions.sort((left, right) => (
    (right.unexplainedSek ?? 0) - (left.unexplainedSek ?? 0)
    || right.monthKey.localeCompare(left.monthKey)
  ));
}

/** Months carried wholly or partly by an estimate rather than an uploaded file. */
export function estimatedMonthKeys(
  series: EnergyBillingMonth[],
  moveInDate: string | null,
): Set<string> {
  return new Set(
    getEnergyCoverageIssues(series, moveInDate).map((issue) => issue.monthKey),
  );
}
