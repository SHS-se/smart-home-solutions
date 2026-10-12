import { assertAlmostEquals, assertEquals } from '@std/assert';
import { actualContractPrices, type PriceInvoice, type InvoicePriceLine } from './actual-contract-prices.ts';
import type { HistoricalPrice } from './historical-electricity-prices.ts';

const line = (category: string, value: number, vat = true): InvoicePriceLine => ({ category, label: category, unit: 'kWh', unit_price_sek: value, amount_includes_vat: vat, period_start: null, period_end: null });
const invoice = (kind: string, parser: string, lines: InvoicePriceLine[], start = '2026-02-01', end = '2026-02-28'): PriceInvoice => ({ id: kind, provider_key: kind, parser_id: parser, document_kind: kind, period_start: start, period_end: end, energy_billing_line_items: lines });
const price = (at: string, spot = .5): HistoricalPrice => ({ start_ts: at, import_price_sek_per_kwh: 9, export_price_sek_per_kwh: 8, grid_import_price_sek_per_kwh: 7, source: 'reconstructed', supplier_revision: 'current', spot_price_sek_per_kwh: spot });
const karlstad = invoice('electricity', 'karlstads_energi_consolidated', [line('spot_energy', 1.3779), line('variable_fee', .08444), line('markup', .0375), line('fixed_fee', 24)]);
const grid = invoice('grid', 'ellevio_peak_demand', [line('energy_transfer', .07), line('energy_tax', .45), line('peak_demand', 81.25), line('fixed_fee', 990)]);

Deno.test('Actual Karlstads monthly prices use invoice rates, grid tax and VAT once, excluding fixed/demand charges', () => {
  const prices = [price('2026-02-01T00:00:00Z', -.1), price('2026-02-01T00:15:00Z', 4)];
  const before = JSON.stringify(prices);
  const actual = actualContractPrices(prices, [karlstad, grid], [{ ...prices[0], source: 'integration' }], 'Europe/Stockholm');
  actual.forEach(p => assertAlmostEquals(p.import_price_sek_per_kwh!, 2.01984));
  assertEquals(JSON.stringify(prices), before);
  assertEquals(actual[0].export_price_sek_per_kwh, null);
});

Deno.test('the mid-June supplier switch preserves Tibber market variation, signed spot and historical invoice adders', () => {
  const before = { ...karlstad, period_start: '2026-06-01', period_end: '2026-06-15' };
  const tibber = invoice('electricity', 'tibber_quarterly', [line('spot_energy', .9, false), line('markup', .06, false), line('variable_fee', .0328, false), line('export_credit', -.9, false)], '2026-06-16', '2026-06-30');
  tibber.energy_billing_line_items.push({ ...line('vat', 0), label: 'Moms 25%', unit: null });
  const ellevio = invoice('grid', 'ellevio_flat_transfer', [line('energy_transfer', .26), line('energy_tax', .45), line('export_credit', -.033, false)], '2026-06-01', '2026-06-30');
  const actual = actualContractPrices([price('2026-06-15T21:45:00Z'), price('2026-06-15T22:00:00Z', -.5), price('2026-06-15T22:15:00Z', .5)], [before, tibber, ellevio], [], 'Europe/Stockholm');
  assertAlmostEquals(actual[0].import_price_sek_per_kwh!, 2.20984);
  assertAlmostEquals(actual[1].import_price_sek_per_kwh!, -.5 * 1.25 + (.06 + .0328) * 1.25 + .71);
  assertAlmostEquals(actual[2].import_price_sek_per_kwh! - actual[1].import_price_sek_per_kwh!, 1.25);
  assertAlmostEquals(actual[1].export_price_sek_per_kwh!, -.467);
});

Deno.test('only unbilled live receipts supply quotes; gaps, overlapping invoices and assumed portal backfills remain unknown', () => {
  const prices = [price('2026-02-01T00:00:00Z')];
  assertEquals(actualContractPrices(prices, [], [], 'Europe/Stockholm')[0].import_price_sek_per_kwh, null);
  assertEquals(actualContractPrices(prices, [karlstad, karlstad, grid], [], 'Europe/Stockholm')[0].import_price_sek_per_kwh, null);
  assertEquals(actualContractPrices(prices, [], [{ ...prices[0], source: 'portal_backfill' }], 'Europe/Stockholm')[0].import_price_sek_per_kwh, null);
  assertEquals(actualContractPrices(prices, [], [{ ...prices[0], source: 'integration' }], 'Europe/Stockholm')[0].import_price_sek_per_kwh, 9);
  const incomplete = structuredClone(grid); incomplete.energy_billing_line_items = incomplete.energy_billing_line_items.filter(l => l.category !== 'energy_tax');
  assertEquals(actualContractPrices(prices, [karlstad, incomplete], [], 'Europe/Stockholm')[0].import_price_sek_per_kwh, null);
});
