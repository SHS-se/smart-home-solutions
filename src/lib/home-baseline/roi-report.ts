import { compareContract, type ComparisonContract, type RoiInvestment } from '../contract-roi';
import { schedulerSavings, type MonthLedger } from './savings';

/** All displayed ROI and contract amounts derive from the same successful home months. */
export function roiReport(months: readonly MonthLedger[], contract: ComparisonContract | null, investment: RoiInvestment) {
  if ([investment.equipmentSek, investment.installationSek, investment.currentMonthlyFeeSek].some(v => !Number.isFinite(v) || v < 0)) throw new Error('Invalid ROI costs');
  const compared = contract ? compareContract(months.map(m => ({ month: m.month, days: (Date.parse(m.end) - Date.parse(m.start)) / 86_400_000,
    monthFraction: m.coverage, importKwh: m.recorded.importKwh, importCostSek: m.recorded.importCostSek - m.gridImportCostSek })), contract,
    { ...investment, equipmentSek: 0, installationSek: 0, subscriptionSek: 0 }) : null;
  const rows = months.map((ledger, i) => {
    const scheduler = schedulerSavings([ledger], investment.subscriptionSek);
    const fee = investment.currentMonthlyFeeSek * ledger.coverage;
    const alternative = compared?.months[i];
    return { ledger, baselineSek: ledger.baseline.costSek + fee, recordedSek: ledger.recorded.costSek + fee,
      grossSek: scheduler.grossSek, subscriptionSek: scheduler.subscriptionSek!, netSek: scheduler.netSek!,
      contractSavingSek: alternative?.saving ?? null,
      alternativeSek: alternative ? alternative.alternative + ledger.gridImportCostSek - ledger.recorded.exportRevenueSek : null };
  });
  const sum = (key: 'baselineSek' | 'recordedSek' | 'grossSek' | 'subscriptionSek' | 'netSek') => rows.reduce((n, row) => n + row[key], 0);
  const coverage = months.reduce((sum, month) => sum + month.coverage, 0), netSek = sum('netSek');
  const investmentSek = investment.equipmentSek + investment.installationSek;
  const monthlyNetSek = coverage > 0 ? netSek / coverage : null;
  return { rows, baselineSek: sum('baselineSek'), recordedSek: sum('recordedSek'), grossSek: sum('grossSek'), subscriptionSek: sum('subscriptionSek'), netSek,
    contractSavingSek: compared?.saving ?? null, investmentSek, monthlyNetSek,
    roiPercent: investmentSek > 0 && months.length ? netSek / investmentSek * 100 : null,
    paybackMonths: monthlyNetSek !== null && monthlyNetSek > 0 && investmentSek > 0 ? investmentSek / monthlyNetSek : null };
}
export type RoiReport = ReturnType<typeof roiReport>;
