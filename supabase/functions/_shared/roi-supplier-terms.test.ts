import { assertAlmostEquals, assertEquals } from '@std/assert';
import fixture from './grid-price-parity.fixture.json' with { type: 'json' };
import { currentGridPrices, type GridTariffCatalogue } from './energy-grid-pricing.ts';
import { historicalElectricityPrices, historicalPriceRange } from './historical-electricity-prices.ts';
import { calculateSupplierPrice } from './energy-supplier-pricing.ts';
import { ROI_SUPPLIER_TERMS, roiSupplierVersion } from './roi-supplier-terms.ts';

const older = structuredClone(fixture.profile.versions[0]);
older.revision = 'test-grid-2025'; older.valid_from = '2025-01-01'; older.valid_to = '2026-05-31';
older.definition.energy_tax.ore_per_kwh_ex_vat = 43.9;
const catalogue = { timezone: fixture.timezone, configuration: fixture.base_configuration,
  profiles: [{ ...fixture.profile, versions: [older, ...fixture.profile.versions] }] } as GridTariffCatalogue;
Deno.test('ROI uses published VAT-inclusive Tibber charges, with no monthly fee in marginal prices', () => {
  const interval = { SEK_per_kWh: -.8, time_start: '2026-01-01T00:00:00Z', time_end: '2026-01-01T00:15:00Z' };
  const price = calculateSupplierPrice(interval, ROI_SUPPLIER_TERMS.definition);
  assertAlmostEquals(price.supplier_import_price_sek_per_kwh, -.8 * 1.25 + .075 + .044);
  assertEquals(price.supplier_export_price_sek_per_kwh, -.8);
  assertEquals(ROI_SUPPLIER_TERMS.definition.monthly_fee_sek_in_vat, 49);
  assertEquals(roiSupplierVersion().revision, ROI_SUPPLIER_TERMS.revision);
});

Deno.test('all twelve replay months use the same current contract and dated signed spot/grid prices', async () => {
  const terms = roiSupplierVersion(), before = JSON.stringify(terms);
  for (let i = 0; i < 12; i++) {
    const start = new Date(Date.UTC(2025, 10 + i, 4)).toISOString(), end = new Date(Date.parse(start) + 900_000).toISOString();
    const market = [{ time_start: start, time_end: end, SEK_per_kWh: i % 2 ? -.8 : .8 }];
    const prices = await historicalElectricityPrices(historicalPriceRange(start, end), [], catalogue, [terms], () => Promise.resolve(market));
    const grid = currentGridPrices(catalogue, new Date(start))!;
    assertAlmostEquals(prices[0].import_price_sek_per_kwh, Math.round((market[0].SEK_per_kWh * 1.25 + .119 + grid.import_price_sek_per_kwh) * 100_000) / 100_000);
    assertAlmostEquals(prices[0].export_price_sek_per_kwh, Math.round((market[0].SEK_per_kWh + grid.export_price_sek_per_kwh) * 100_000) / 100_000);
    assertEquals(prices[0].supplier_revision, ROI_SUPPLIER_TERMS.revision);
    assertEquals(prices[0].supplier_revision.includes('assumed'), false);
  }
  assertEquals(JSON.stringify(terms), before);
});
