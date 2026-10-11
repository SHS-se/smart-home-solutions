import { assertAlmostEquals, assertEquals, assertRejects, assertThrows } from '@std/assert';
import fixture from './grid-price-parity.fixture.json' with { type: 'json' };
import { currentGridPrices, type GridTariffCatalogue } from './energy-grid-pricing.ts';
import { historicalElectricityPrices, historicalPriceRange } from './historical-electricity-prices.ts';
const catalogue = { timezone: fixture.timezone, configuration: fixture.base_configuration, profiles: [fixture.profile] } as GridTariffCatalogue;
const terms = [{ revision: 'test', valid_from: '2026-01-01', valid_to: null, definition: {
  schema_version: 1, vat_rate: .25, import: { spot_multiplier: 1, fixed_markup_sek_per_kwh_ex_vat: .06, variable_cost_sek_per_kwh_ex_vat: .041 },
  export: { spot_multiplier: 1, adjustment_sek_per_kwh: 0 }, monthly_fee_sek_in_vat: 49,
} }];
const start = '2026-09-01T00:00:00.000Z', end = '2026-09-01T00:30:00.000Z', starts = historicalPriceRange(start, end);
const market = starts.map((at, i) => ({ time_start: at, time_end: new Date(Date.parse(at) + 900_000).toISOString(), SEK_per_kWh: i ? -.8 : .8 }));
Deno.test('historical reads are quarter aligned and bounded to one calendar month', () => {
  assertEquals(starts.length, 2);
  assertEquals(historicalPriceRange('2026-09-30T22:00:00Z', '2026-10-31T23:00:00Z').length, 2980);
  for (const range of [[start, start], [start, '2026-09-01T00:31:00Z'], [start, '2026-10-04T00:00:00Z']]) assertThrows(() => historicalPriceRange(...range as [string, string]));
});
Deno.test('archived all-in prices win and require no market reads', async () => {
  const prices = await historicalElectricityPrices(starts, starts.map(start_ts => ({ start_ts, import_price_sek_per_kwh: 9, export_price_sek_per_kwh: -1 })), catalogue, [], () => { throw new Error('Unexpected fetch'); });
  assertEquals(prices.map(p => p.source), ['archive', 'archive']);
  assertEquals(prices.map(p => p.import_price_sek_per_kwh), [9, 9]);
  assertEquals(prices[0].grid_import_price_sek_per_kwh, currentGridPrices(catalogue, new Date(start))!.import_price_sek_per_kwh);
});
Deno.test('only price holes use real signed market prices and effective supplier/grid components', async () => {
  const days: string[] = [];
  const prices = await historicalElectricityPrices(starts, [{ start_ts: start, import_price_sek_per_kwh: 9, export_price_sek_per_kwh: 2 }], catalogue, terms, day => { days.push(day); return Promise.resolve(market); });
  assertEquals(days, ['2026-09-01']); assertEquals(prices[0].import_price_sek_per_kwh, 9);
  assertEquals(prices[1].source, 'reconstructed'); assertEquals(prices[1].supplier_revision, 'test');
  assertAlmostEquals(prices[1].import_price_sek_per_kwh, (-.8 + .101) * 1.25 + prices[1].grid_import_price_sek_per_kwh);
  assertAlmostEquals(prices[1].export_price_sek_per_kwh, -.8 + currentGridPrices(catalogue, new Date(start))!.export_price_sek_per_kwh);
  await assertRejects(() => historicalElectricityPrices(starts, [], catalogue, terms, () => Promise.resolve(market.slice(0, 1))), Error, 'Missing historical market price');
  await assertRejects(() => historicalElectricityPrices(starts, [], catalogue, [], () => Promise.resolve(market)), Error, 'Missing supplier terms');
});
