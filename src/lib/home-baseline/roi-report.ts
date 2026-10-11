import type { MonthLedger } from './savings';
import type { BilledMonth } from './billed-months';

export type RoiBasis = 'baseline' | 'actual';
export interface ReplayInvestment { equipmentSek: number; installationSek: number; subscriptionSek: number }
/** Full modeled bills and original invoices share a period; only matched bills enter Actual ROI. */
export function roiReport(months: readonly MonthLedger[], bills: ReadonlyMap<string, BilledMonth>, investment: ReplayInvestment, basis: RoiBasis = 'baseline') {
  if (Object.values(investment).some(v => !Number.isFinite(v) || v < 0)) throw new Error('Invalid ROI costs');
  const rows = months.map(ledger => {
    const bill = bills.get(ledger.month) ?? null;
    const actualSek = ledger.coverage === 1 ? bill?.totalSek ?? null : null;
    const baselineSek = ledger.modeled.baselineBill.totalSek, schedulerSek = ledger.modeled.schedulerBill.totalSek;
    return { ledger, bill, baselineSek, actualSek, schedulerSek, vsBaselineSek: baselineSek - schedulerSek,
      vsActualSek: actualSek === null ? null : actualSek - schedulerSek };
  });
  const sum = (get: (r: typeof rows[number]) => number) => rows.reduce((n, r) => n + get(r), 0);
  const eligible = rows.filter(r => basis === 'baseline' || r.actualSek !== null);
  const coverage = eligible.reduce((n, r) => n + r.ledger.coverage, 0);
  const grossSek = eligible.reduce((n, r) => n + (basis === 'baseline' ? r.vsBaselineSek : r.vsActualSek!), 0);
  const subscriptionSek = investment.subscriptionSek * coverage, netSek = grossSek - subscriptionSek;
  const investmentSek = investment.equipmentSek + investment.installationSek;
  const monthlyNetSek = coverage > 0 ? netSek / coverage : null;
  return { rows, basis, eligibleMonths: eligible.length, coverage, baselineSek: sum(r => r.baselineSek), schedulerSek: sum(r => r.schedulerSek),
    actualSek: rows.some(r => r.actualSek !== null) ? sum(r => r.actualSek ?? 0) : null, actualMonths: rows.filter(r => r.actualSek !== null).length,
    vsBaselineSek: sum(r => r.vsBaselineSek), vsActualSek: rows.some(r => r.vsActualSek !== null) ? sum(r => r.vsActualSek ?? 0) : null,
    grossSek, subscriptionSek, netSek, investmentSek, monthlyNetSek,
    roiPercent: investmentSek > 0 && coverage > 0 ? netSek / investmentSek * 100 : null,
    paybackMonths: monthlyNetSek !== null && monthlyNetSek > 0 && investmentSek > 0 ? investmentSek / monthlyNetSek : null };
}
export type RoiReport = ReturnType<typeof roiReport>;
