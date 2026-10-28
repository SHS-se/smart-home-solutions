import { assertEquals } from '@std/assert';
import { energyBillingCost } from './energy-billing-cost.ts';
import { buildEnergyBillingSeries } from './energy-billing-series.ts';
import { parseEnergyBillingDocument } from './energy-billing-parser.ts';

// Independently generated synthetic charges, unrelated to any household invoice.
const charges = (spot: number, markup: number, variable: number, vat: number, production: number) => [
  { category: 'spot_energy', amountSek: spot }, { category: 'markup', amountSek: markup },
  { category: 'variable_fee', amountSek: variable }, { category: 'vat', amountSek: vat },
  { category: 'fixed_fee', amountSek: 8 }, { category: 'discount', amountSek: -8 },
  { category: 'export_credit', amountSek: -production },
];

Deno.test('Tibber credit balances are preserved while each month counts only its own charges', () => {
  const invoices = [
    { settlementSek: -20, lineItems: charges(10, 1, 1, 3, 35) },
    { settlementSek: -35, lineItems: charges(14, 1, 1, 4, 35) },
    { settlementSek: 25, lineItems: charges(40, 4, 4, 12, 0) },
  ];
  const before = JSON.stringify(invoices);
  const costs = invoices.map(invoice => energyBillingCost({ ...invoice, parserId: 'tibber_quarterly', exportedKwh: 35 }));
  assertEquals(costs.map(cost => cost.periodCostSek), [-20, -15, 60]);
  assertEquals(costs.map(cost => cost.settlementSek), [-20, -35, 25]);
  assertEquals(costs.reduce((sum, cost) => sum + cost.periodCostSek!, 0), 25);
  assertEquals(JSON.stringify(invoices), before);
});

Deno.test('incomplete Tibber charges cannot substitute a settlement balance or invalidate another month', () => {
  const incomplete = energyBillingCost({ parserId: 'tibber_quarterly', settlementSek: -900, exportedKwh: 0,
    lineItems: charges(10, 1, 1, 3, 0).filter(line => line.category !== 'vat') });
  assertEquals(incomplete.kind, 'unavailable'); assertEquals(incomplete.periodCostSek, null);
  const rows = buildEnergyBillingSeries(['01', '02'].map(month => ({ id: month, documentKind: 'electricity',
    periodStart: `2024-${month}-01`, periodEnd: `2024-${month}-${month === '01' ? 31 : 29}`,
    consumptionKwh: 12, exportedKwh: 0, peakDemandKw: null, periodCostSek: month === '01' ? incomplete.periodCostSek : 20,
    lineItems: [] })));
  assertEquals(rows.map(row => row.electricityCostSek), [null, 20]);
  assertEquals(rows.map(row => row.electricityCoverage), ['complete', 'complete']);
  assertEquals(rows[0].totalCostSek, null);
});

Deno.test('other invoice formats preserve their stated period amount including payment rounding', () => {
  const cost = energyBillingCost({ parserId: 'ellevio_flat_transfer', settlementSek: 100, exportedKwh: null,
    lineItems: [{ category: 'fixed_fee', amountSek: 99.87 }] });
  assertEquals(cost.periodCostSek, 100);
});

Deno.test('Tibber admission requires every period charge while retaining the original settlement', () => {
  const synthetic = `Tibber AB Fakturanummer: 50123456 Fakturadatum: 3 februari 2024 Avtal: Kvartspris
    Spotpris för januari 2024 10,00 kr 10 kWh à 100,00 öre/kWh
    Fasta påslag för januari 2024 1,00 kr 10 kWh à 10,00 öre/kWh
    Rörliga kostnader för januari 2024 1,00 kr 10 kWh à 10,00 öre/kWh
    Månadsavgift för januari 2024 8,00 kr 31 dagar à 8,00 kr/mån
    Rabatt månadsavgift för januari 2024 -8,00 kr 31 dagar à -8,00 kr/mån
    Elproduktion för januari 2024 -35,00 kr 35 kWh à -100,00 öre/kWh
    Moms 25% 3,00 kr Tidigare saldo -50,00 kr Överförs till nästkommande faktura -70,00 kr`;
  const parsed = parseEnergyBillingDocument(synthetic);
  assertEquals(parsed.importable, true); assertEquals(parsed.totalAmountSek, -70);
  assertEquals(energyBillingCost({ parserId: parsed.parserId!, settlementSek: parsed.totalAmountSek!,
    exportedKwh: parsed.exportedKwh, lineItems: parsed.lineItems }).periodCostSek, -20);
  assertEquals(parseEnergyBillingDocument(synthetic.replace('Moms 25% 3,00 kr', '')).importable, false);
  assertEquals(parseEnergyBillingDocument(`${synthetic} Serviceavgift för januari 2024 2,00 kr`).errors.includes('unrecognized_charge'), true);
});
