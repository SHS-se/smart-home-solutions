import { assertEquals, assertThrows } from '@std/assert';
import { billedRecord, modelCheck, savingsForecast, trackRecord } from './savings-report';
import type { EnergyBillingMonth } from '../energy-billing-series';
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
Deno.test('forecast arithmetic adds visible monthly cents and subtracts the visible costs without hidden fractions', () => {
  const f = savingsForecast([month('2026-06', 1, 100.004, 80.006), month('2026-07', .5, 100.004, 80.006)], 20.01);
  assertEquals(f.rows.map(row => [row.withoutSek, row.withSek, row.savingSek]), [[100, 80.01, 19.99], [100, 80.01, 19.99]]);
  assertEquals([f.withoutSek, f.withSek, f.savingSek, f.subscriptionSek, f.netSek], [200, 160.02, 39.98, 30.02, 9.96]);
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

const metered = (key: string, recordedSek: number, peakSek: number, extra: Partial<MonthLedger> = {}) => ({ month: key, coverage: 1,
  recorded: { costSek: recordedSek }, quarters: 2880, gaps: { gridImportQuarters: 1, gridExportQuarters: 0 },
  modeled: { baselineBill: { totalSek: 0, supplierFixedSek: 50, gridFixedSek: 100, gridPeakSek: peakSek, peakKw: 0 } }, ...extra } as unknown as MonthLedger);
const invoiceMonth = (key: string, gridPeakSek: number, gridVatSek: number, gridCostSek: number) => ({ monthKey: key, gridPeakSek, gridVatSek, gridCostSek } as EnergyBillingMonth);
const billed = (key: string, totalSek: number): [string, BilledMonth] => [key, { month: key, totalSek, electricitySek: null, gridSek: null, documentIds: [], importKwh: null, reason: null, allocated: false }];

Deno.test('the model check prices metered use like the invoice, both without the demand charge', () => {
  // Grid invoice: 400 kr of lines before VAT, of which 80 kr demand charge, plus 100 kr VAT (25 %).
  const check = modelCheck([metered('2026-06', 850, 120)], new Map([billed('2026-06', 1100)]), new Map([['2026-06', invoiceMonth('2026-06', 80, 100, 500)]]));
  assertEquals(check!.rows, [{ month: '2026-06', pricedSek: 1000, billedSek: 1000, differenceSek: 0 }]);
  assertEquals([check!.pricedSek, check!.billedSek, check!.share], [1000, 1000, 0]);
});

Deno.test('a month is checked only when both sides describe the same charges', () => {
  const invoices = new Map([['2026-06', invoiceMonth('2026-06', 0, 0, 400)], ['2026-07', invoiceMonth('2026-07', 80, 100, 500)]]);
  const bills = new Map([billed('2026-06', 1000), billed('2026-07', 1100)]);
  // June's invoice does not itemise a demand charge the tariff has; July has over 1 % unmetered; August has no bill.
  assertEquals(modelCheck([metered('2026-06', 850, 120), metered('2026-07', 850, 120, { gaps: { gridImportQuarters: 29, gridExportQuarters: 1 } } as Partial<MonthLedger>), metered('2026-08', 850, 0)], bills, invoices), null);
  // Without a demand charge in the tariff there is nothing to itemise.
  assertEquals(modelCheck([metered('2026-06', 850, 0)], bills, invoices)!.rows.map(r => r.billedSek), [1000]);
});

const run = (key: string, baselineSek: number, recordedSek: number, schedulerSek: number, extra: Partial<MonthLedger> = {}) => ({ month: key, coverage: 1, quarters: 2880,
  baseline: { costSek: baselineSek }, recorded: { costSek: recordedSek }, scheduler: { costSek: schedulerSek },
  gaps: { gridImportQuarters: 0, gridExportQuarters: 0 }, ...extra } as unknown as MonthLedger);
const devices = ['$battery', '$pool', '$ev'];

Deno.test('the track record counts only months SHS controlled every scheduled device, and compares them with the estimate', () => {
  const control = [
    { month: '2026-08', runs: 100, controlling: { $battery: 100, $pool: 100, $ev: 95 } },
    { month: '2026-09', runs: 100, controlling: { $battery: 100, $pool: 40, $ev: 100 } },
    { month: '2026-10', runs: 100, controlling: { $battery: 100, $pool: 100, $ev: 100 } },
  ];
  const record = trackRecord([run('2026-07', 900, 800, 700), run('2026-08', 1000, 850, 800), run('2026-09', 1000, 900, 800), run('2026-10', 1000, 880, 820, { coverage: .5 })], control, devices)!;
  // July has no record of control, the pool was mostly manual in September, and October is not over.
  assertEquals(record.rows, [{ month: '2026-08', measuredSek: 150, estimatedSek: 200 }]);
  assertEquals([record.measuredSek, record.estimatedSek, record.realised], [150, 200, .75]);
});

Deno.test('no controlled month means no track record, and a home with no scheduled devices has none', () => {
  assertEquals(trackRecord([run('2026-08', 1000, 850, 800)], [], devices), null);
  assertEquals(trackRecord([run('2026-08', 1000, 850, 800)], [{ month: '2026-08', runs: 10, controlling: {} }], []), null);
});
