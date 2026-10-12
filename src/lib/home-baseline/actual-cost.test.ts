import { assertEquals } from '@std/assert';
import { baselineFixture } from './fixture.ts';
import { prepareHomeBaseline } from './model.ts';
import { projectPlanChart } from '../energy-shift/plan-chart-data.ts';

Deno.test('Actual prices are independent of model prices, and an unpriced nonzero flow leaves a cumulative gap', () => {
  const rows = baselineFixture();
  rows.actual[1].grid_import_kwh = 0; rows.actual[1].grid_export_kwh = 0;
  rows.actualPrices[0].import_price_sek_per_kwh = null; rows.actualPrices[0].export_price_sek_per_kwh = null;
  rows.actual[2].grid_import_kwh = 1; rows.actual[2].grid_export_kwh = .2;
  rows.actualPrices[1].import_price_sek_per_kwh = 2; rows.actualPrices[1].export_price_sek_per_kwh = null;
  rows.actualPrices[2].import_price_sek_per_kwh = 3;
  const input = prepareHomeBaseline(rows);
  assertEquals(input.problem.slots[2].import_price, 1);
  assertEquals(input.recorded.rows[2].importPriceSekPerKwh, 3);
  assertEquals(input.recorded.rows[0].costSek, 0);
  assertEquals(input.recorded.rows[1].costSek, null);
  const chart = projectPlanChart({ rows: input.recorded.rows, devices: input.recorded.devices, range: { from: 0, to: 3 }, timeZone: input.timeZone, prices: { kind: 'actual' } });
  assertEquals(chart.rows.map(row => row.cumulativeCostSek), [0, null, null]);
});
