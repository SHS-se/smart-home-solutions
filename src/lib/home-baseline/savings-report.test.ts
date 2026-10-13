import { assertEquals, assertThrows } from '@std/assert';
import { billedRecord, savingsForecast } from './savings-report';
import type { MonthLedger } from './savings';
import type { BilledMonth } from './billed-months';
const month = (key: string, coverage: number, baseline: number, scheduler: number): MonthLedger => ({ month: key, coverage,
  modeled: { baselineBill: { totalSek: baseline, supplierFixedSek: 0, gridFixedSek: 0, gridPeakSek: 0, peakKw: 0 },
    schedulerBill: { totalSek: scheduler, supplierFixedSek: 0, gridFixedSek: 0, gridPeakSek: 0, peakKw: 0 } } } as MonthLedger);
const bills = new Map<string, BilledMonth>([['2026-06', { month: '2026-06', totalSek: 500, electricitySek: 200, gridSek: 300, documentIds: ['e','g'], importKwh: 100, reason: null, allocated: false }]]);
Deno.test('the forecast compares the two modeled costs and charges the subscription once per month', () => {
  const f = savingsForecast([month('2026-06', 1, 600, 400), month('2026-07', 1, 300, 350)], 30);
  assertEquals(f.rows.map(x => [x.withoutSek, x.withSek, x.savingSek]), [[600, 400, 200], [300, 350, -50]]);
  assertEquals([f.withoutSek, f.withSek, f.savingSek, f.subscriptionSek, f.netSek, f.monthlyNetSek], [900, 750, 150, 60, 90, 45]);
});
Deno.test('saved demand evidence is excluded from the forecast and the stored ledger stays intact', () => {
  const saved = month('2026-06', 1, 1200, 1400);
  saved.modeled.baselineBill.gridPeakSek = 600;
  saved.modeled.schedulerBill.gridPeakSek = 1000;
  const before = JSON.stringify(saved);
  const f = savingsForecast([saved], 30);
  assertEquals([f.withoutSek, f.withSek, f.savingSek, f.netSek], [600, 400, 200, 170]);
  assertEquals(JSON.stringify(saved), before);
});
Deno.test('a month in progress pays its share of the subscription, and no months means no monthly figure', () => {
  const f = savingsForecast([month('2026-06', 1, 600, 400), month('2026-07', .5, 300, 350)], 30);
  assertEquals([f.coverage, f.savingSek, f.subscriptionSek, f.netSek, f.monthlyNetSek], [1.5, 150, 45, 105, 70]);
  assertEquals(savingsForecast([], 30).monthlyNetSek, null);
  assertThrows(() => savingsForecast([month('2026-06', 1, 600, 400)], NaN));
  assertThrows(() => savingsForecast([month('2026-06', 1, 600, 400)], -1));
});
Deno.test('bills are listed as invoiced and a missing bill never becomes an estimate', () => {
  const r = billedRecord(['2026-06', '2026-07'], bills);
  assertEquals(r.rows, [{ month: '2026-06', billedSek: 500 }, { month: '2026-07', billedSek: null }]);
  assertEquals([r.billedMonths, r.billedSek], [1, 500]);
  assertEquals(billedRecord(['2026-07'], bills).billedSek, null);
});
