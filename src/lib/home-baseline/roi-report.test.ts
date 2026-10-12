import { assertAlmostEquals, assertEquals, assertThrows } from '@std/assert';
import { roiReport } from './roi-report';
import type { MonthLedger } from './savings';
import type { BilledMonth } from './billed-months';
const month = (key: string, coverage: number, baseline: number, scheduler: number): MonthLedger => ({ month: key, coverage,
  modeled: { baselineBill: { totalSek: baseline, supplierFixedSek: 0, gridFixedSek: 0, gridPeakSek: 0, peakKw: 0 },
    schedulerBill: { totalSek: scheduler, supplierFixedSek: 0, gridFixedSek: 0, gridPeakSek: 0, peakKw: 0 } } } as MonthLedger);
const investment = { equipmentSek: 1000, installationSek: 1000, subscriptionSek: 30 };
const bills = new Map<string, BilledMonth>([['2026-06', { month: '2026-06', totalSek: 500, electricitySek: 200, gridSek: 300, documentIds: ['e','g'], importKwh: 100, reason: null, allocated: false }]]);
Deno.test('ROI columns use modeled costs and original invoices; missing bills never become recorded estimates', () => {
  const r = roiReport([month('2026-06', 1, 600, 400), month('2026-07', 1, 300, 350)], bills, investment);
  assertEquals(r.rows.map(x => [x.baselineSek,x.actualSek,x.schedulerSek,x.vsBaselineSek,x.vsActualSek]), [[600,500,400,200,100],[300,null,350,-50,null]]);
  assertEquals([r.baselineSek,r.actualSek,r.schedulerSek,r.vsBaselineSek,r.vsActualSek,r.actualMonths], [900,500,750,150,100,1]);
  assertEquals(r.netSek, 90); assertAlmostEquals(r.roiPercent!, 4.5); assertAlmostEquals(r.paybackMonths!, 2000/45);
});
Deno.test('saved demand evidence is excluded from model ROI while Actual invoices and stored ledgers stay intact', () => {
  const saved = month('2026-06', 1, 1200, 1400);
  saved.modeled.baselineBill.gridPeakSek = 600;
  saved.modeled.schedulerBill.gridPeakSek = 1000;
  const before = JSON.stringify(saved);
  const r = roiReport([saved], bills, investment);
  assertEquals([r.baselineSek, r.schedulerSek, r.actualSek, r.vsBaselineSek, r.vsActualSek, r.netSek], [600, 400, 500, 200, 100, 170]);
  assertEquals(JSON.stringify(saved), before);
});
Deno.test('actual-bill ROI uses matched months only, and a full invoice is never compared with a partial replay', () => {
  const months = [month('2026-06', 1, 600, 400), month('2026-07', .5, 300, 350)];
  const r = roiReport(months,bills,investment,'actual');
  assertEquals([r.eligibleMonths,r.coverage,r.grossSek,r.subscriptionSek,r.netSek], [1,1,100,30,70]);
  assertEquals(roiReport([month('2026-06',.5,600,400)],bills,investment,'actual').rows[0].actualSek,null);
  assertEquals(roiReport(months,new Map(),investment,'actual').monthlyNetSek,null);
  assertThrows(() => roiReport(months,bills,{...investment,subscriptionSek:NaN}));
});
