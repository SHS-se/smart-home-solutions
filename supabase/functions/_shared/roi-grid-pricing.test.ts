import { assertAlmostEquals, assertEquals, assertThrows } from '@std/assert';
import { roiGridCatalogue } from './roi-grid-pricing.ts';
import { gridConfigurationOn } from './energy-grid-pricing.ts';
import { historicalElectricityPrices } from './historical-electricity-prices.ts';
import { roiSupplierVersion } from './roi-supplier-terms.ts';
import { scenarioBill } from '../../../src/lib/home-baseline/scenario-bill.ts';
import { emptyElectricityLedger } from '../../../src/lib/home-baseline/ledger.ts';
import { testTariff } from '../../../src/lib/home-baseline/fixture.ts';

// Synthetic fuse change and tariff versions; no household history.
Deno.test('ROI prices and both modeled bills use the current fuse while actual history remains dated', async () => {
  const actual = testTariff();
  actual.configuration!.fuse_a = 25;
  actual.configuration!.fuse_periods = [{ valid_from: null, fuse_a: 35 }, { valid_from: '2026-09-16', fuse_a: 25 }];
  const definition = actual.profiles[0].versions[0].definition;
  const plan = (definition.plans as Record<string, Record<string, unknown>>).three_phase;
  plan.fixed_monthly_sek_ex_vat = { '25': 400, '35': 800 };
  plan.transfer = { mode: 'flat_by_selector', ore_per_kwh_ex_vat: { '25': 10, '35': 20 } };
  const before = JSON.stringify(actual), modeled = roiGridCatalogue(actual);
  assertEquals(gridConfigurationOn(actual.configuration!, '2026-09-01').fuse_a, 35);
  assertEquals(gridConfigurationOn(modeled.configuration!, '2026-09-01').fuse_a, 25);
  assertEquals(gridConfigurationOn(modeled.configuration!, '2026-09-20').fuse_a, 25);

  const start = '2026-08-31T22:00:00Z', end = '2026-09-30T22:00:00Z';
  for (const costSek of [1000, 700]) {
    const bill = scenarioBill({ ...emptyElectricityLedger(), costSek }, start, end, 'Europe/Stockholm', Array(2880).fill(0), modeled);
    assertAlmostEquals(bill.gridFixedSek, 500);
    assertAlmostEquals(bill.supplierFixedSek, 49);
    assertAlmostEquals(bill.totalSek, costSek + 549);
  }
  const quotes = await historicalElectricityPrices([start], [], modeled, [roiSupplierVersion()], () => Promise.resolve([
    { time_start: start, time_end: '2026-08-31T22:15:00Z', SEK_per_kWh: .4 },
  ]));
  // The 10 öre transfer rate receives VAT once, independently of the old fuse.
  assertAlmostEquals(quotes[0].grid_import_price_sek_per_kwh, (.10 + .36) * 1.25);
  assertEquals(JSON.stringify(actual), before);
  assertThrows(() => roiGridCatalogue({ ...actual, configuration: null }), Error, 'unavailable');
});
