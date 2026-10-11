import { buildEnergyBillingSeries, type EnergyBillingDocumentForSeries } from '../energy-billing-series';

export interface BilledMonth {
  month: string; electricitySek: number | null; gridSek: number | null; totalSek: number | null;
  importKwh: number | null; documentIds: string[]; allocated: boolean;
  reason: 'missing' | 'partial' | 'overlap' | 'multiple_homes' | null;
}

/** Original imported bills only. Metered or tariff estimates never become Actual. */
export function billedMonths(documents: EnergyBillingDocumentForSeries[], homeCount: number): Map<string, BilledMonth> {
  const overlaps = new Set<string>();
  for (let i = 0; i < documents.length; i++) for (let j = i + 1; j < documents.length; j++) {
    const a = documents[i], b = documents[j];
    if (a.documentKind !== b.documentKind) continue;
    const start = [a.periodStart, b.periodStart].sort()[1], end = [a.periodEnd, b.periodEnd].sort()[0];
    if (start > end) continue;
    for (let day = Date.parse(`${start}T00:00:00Z`); day <= Date.parse(`${end}T00:00:00Z`); day += 86_400_000) overlaps.add(new Date(day).toISOString().slice(0, 7));
  }
  return new Map(buildEnergyBillingSeries(documents).map(m => {
    const members = documents.filter(d => d.periodStart.slice(0, 7) <= m.monthKey && d.periodEnd.slice(0, 7) >= m.monthKey);
    const reason = homeCount !== 1 ? 'multiple_homes' : overlaps.has(m.monthKey) ? 'overlap'
      : m.electricityCoverage === 'missing' || m.gridCoverage === 'missing' ? 'missing'
      : m.electricityCoverage !== 'complete' || m.gridCoverage !== 'complete' ? 'partial' : null;
    return [m.monthKey, { month: m.monthKey, electricitySek: m.electricityCostSek, gridSek: m.gridCostSek,
      totalSek: reason === null ? m.totalCostSek : null, importKwh: m.consumptionKwh, documentIds: members.map(d => d.id),
      allocated: members.some(d => d.periodStart.slice(0, 7) !== d.periodEnd.slice(0, 7)), reason }];
  }));
}
