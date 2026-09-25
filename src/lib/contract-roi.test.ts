import { assertEquals, assertAlmostEquals, assertThrows } from '@std/assert';
import { compareContract, hoursInDay, invoiceRoiHistory, supplierRoiHistory, type ComparisonContract, type RoiInvestment } from './contract-roi.ts';
import type { EnergySupplierDailyCostRecord } from './energy-supplier-series.ts';
import type { EnergyBillingDocumentForSeries } from './energy-billing-series.ts';

const contract: ComparisonContract = { kind: 'fixed', method: 'components', rateOre: 100, monthlyFeeSek: 50, variableRateOre: 60, fixedSharePercent: 50, markupDifferenceOre: 10, monthlyRates: {}, monthlyMarkupPercent: 0 };
const investment: RoiInvestment = { equipmentSek: 10000, installationSek: 2000, subscriptionSek: 100, currentMonthlyFeeSek: 40 };
const months = [{ month: '2026-01', days: 31, monthFraction: 1, importKwh: 1000, importCostSek: 500 }];

Deno.test('ROI compares matching imports, includes both fees and subtracts subscription before payback', () => {
  const result = compareContract(months, contract, investment)!;
  assertEquals(result.actual, 540);
  assertEquals(result.alternative, 1050);
  assertEquals(result.saving, 510);
  assertEquals(result.net, 410);
  assertEquals(result.annualNet, 4920);
  assertAlmostEquals(result.paybackYears!, 12000 / 4920);
  assertEquals(result.breakEvenOre, 64);
});
Deno.test('bundled screenshot quotes never double-count monthly fees', () => {
  assertEquals(compareContract(months, { ...contract, method: 'quote' }, investment)!.alternative, 1000);
});
Deno.test('month rates, mixed shares and equivalent spot profile have distinct costs', () => {
  assertEquals(compareContract(months, { ...contract, kind: 'monthly', monthlyRates: { '2026-01': 70 } }, investment)!.alternative, 750);
  assertEquals(compareContract(months, { ...contract, kind: 'mixed' }, investment)!.alternative, 850);
  assertEquals(compareContract(months, { ...contract, kind: 'quarterly', method: 'profile' }, investment)!.alternative, 650);
});
Deno.test('partial coverage prorates all monthly fees and annualizes only covered month fractions', () => {
  const result = compareContract([{ ...months[0], days: 10, monthFraction: 10 / 31, importKwh: 100, importCostSek: 50 }], contract, investment)!;
  assertAlmostEquals(result.subscription, 1000 / 31);
  assertAlmostEquals(result.actual, 50 + 400 / 31);
  assertAlmostEquals(result.annualNet, result.net * 31 / 10 * 12);
});
Deno.test('losses, no imports, no data, zero investment and invalid input are explicit', () => {
  assertEquals(compareContract(months, contract, { ...investment, subscriptionSek: 600 })!.paybackYears, null);
  assertEquals(compareContract(months, contract, { ...investment, equipmentSek: 0, installationSek: 0 })!.paybackYears, 0);
  assertEquals(compareContract([{ ...months[0], importKwh: 0 }], contract, investment)!.breakEvenOre, null);
  assertEquals(compareContract([], contract, investment), null);
  assertThrows(() => compareContract(months, { ...contract, rateOre: NaN }, investment));
  assertThrows(() => compareContract(months, contract, { ...investment, equipmentSek: -1 }));
  assertThrows(() => compareContract(months, { ...contract, fixedSharePercent: 101 }, investment));
  assertEquals(compareContract(months, { ...contract, rateOre: -20 }, investment)!.alternative, -150);
});
const day = (date: string, hours: number): EnergySupplierDailyCostRecord => ({
  cost_date: date, priced_hours: hours, import_kwh: 20, import_cost_sek: 10, export_credit_sek: 500,
  export_kwh: 100, id: date, customer_id: 'customer', device_token_id: null, created_at: '', updated_at: '',
});
Deno.test('HA days require full price coverage and use local DST length', () => {
  assertEquals(hoursInDay('2026-03-29', 'Europe/Stockholm'), 23);
  assertEquals(hoursInDay('2026-10-25', 'Europe/Stockholm'), 25);
  const history = supplierRoiHistory([day('2026-03-29', 23), day('2026-03-30', 23), day('2026-03-31', 24), day('2026-10-25', 24)], 'Europe/Stockholm');
  assertEquals(history.excluded, 2);
  assertEquals(history.months.length, 1);
  assertEquals(history.months[0].days, 2);
  assertEquals(history.months[0].importCostSek, 20);
  assertAlmostEquals(history.months[0].monthFraction, 2 / 31);
  assertThrows(() => supplierRoiHistory([day('2026-03-31', 24), day('2026-03-31', 24)], 'Europe/Stockholm'));
});
const invoice: EnergyBillingDocumentForSeries = {
  id: 'bill', documentKind: 'electricity', periodStart: '2026-01-01', periodEnd: '2026-01-31', consumptionKwh: 1000,
  exportedKwh: 100, peakDemandKw: null, totalAmountSek: 400,
  lineItems: [{ category: 'spot_energy', amountSek: 500, quantity: 1000, periodStart: null, periodEnd: null },
    { category: 'export_credit', amountSek: -100, periodStart: null, periodEnd: null }],
};
Deno.test('bills preserve import kWh and billed charges, exclude export credits and grid bills', () => {
  const history = invoiceRoiHistory([invoice, { ...invoice, id: 'grid', documentKind: 'grid', totalAmountSek: 9999 }]);
  assertEquals(history.months[0].importCostSek, 500);
  assertEquals(history.months[0].importKwh, 1000);
  assertEquals(history.excluded, 0);
});
Deno.test('partial and overlapping invoice periods cannot inflate ROI', () => {
  assertEquals(invoiceRoiHistory([{ ...invoice, periodEnd: '2026-01-15' }]).months.length, 0);
  const overlap = invoiceRoiHistory([invoice, { ...invoice, id: 'duplicate' }]);
  assertEquals(overlap.months.length, 0);
  assertEquals(overlap.excluded, 1);
});

Deno.test('monthly averages require real market data and apply supplier markup separately', () => {
  assertThrows(() => compareContract(months, { ...contract, kind: 'monthly' }, investment));
  const monthly = { ...contract, kind: 'monthly' as const, monthlyRates: { '2026-01': 80 }, monthlyMarkupPercent: 10, monthlyFeeSek: 0 };
  assertAlmostEquals(compareContract(months, monthly, investment)!.alternative, 880);
  assertAlmostEquals(compareContract(months, { ...monthly, monthlyMarkupPercent: 0, monthlyFeeSek: 49 }, investment)!.alternative, 849);
  assertThrows(() => compareContract(months, { ...monthly, monthlyMarkupPercent: -1 }, investment));
});
