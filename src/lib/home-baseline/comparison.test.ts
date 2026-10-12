import { assertAlmostEquals, assertEquals } from '@std/assert';
import { baselineFixture } from './fixture';
import { prepareHomeBaseline, projectBaseline } from './model';
import { createWasmPlanner } from '../../../supabase/functions/_shared/planner-wasm/core';
import { projectPlanChart } from '../energy-shift/plan-chart-data';
import { periodComparison } from './comparison';

const engine = createWasmPlanner(new Uint8Array(Deno.readFileSync(new URL('../../../supabase/functions/_shared/planner-wasm/solver.wasm', import.meta.url))));

Deno.test('recorded graph uses measured device energy, storage and temperature with the same quarter cost ledger', () => {
  const rows = baselineFixture();
  const first = rows.actual[1];
  first.grid_import_kwh = 2; first.grid_export_kwh = .5; first.solar_production_kwh = 1;
  first.battery_charge_kwh = .1; first.battery_discharge_kwh = .2; first.battery_soc = .7; first.ev_soc = .8;
  rows.prices[0].import_price_sek_per_kwh = -1; rows.prices[0].export_price_sek_per_kwh = .5;
  rows.actualPrices[0].import_price_sek_per_kwh = -1; rows.actualPrices[0].export_price_sek_per_kwh = .5;
  rows.pool.push({ start_ts: first.start_ts, water_temperature_c: 29.25 });
  rows.actual.splice(2, 1); // Offline energy is zero, storage and temperatures retain gaps.
  const input = prepareHomeBaseline(rows);
  const recorded = input.recorded;
  const chart = projectPlanChart({ rows: recorded.rows, devices: recorded.devices, prices: { kind: 'bench' }, timeZone: input.timeZone, range: { from: 0, to: 288 } });
  assertEquals(recorded.rows.length, 288);
  const row = chart.rows[0];
  assertEquals(row.measured, true); assertEquals(row.gridImportW, 8000); assertEquals(row.gridExportW, -2000);
  assertEquals(row.batteryChargeW, -400); assertEquals(row.batteryDischargeW, 800);
  assertEquals(row.homeSoc, 70); assertEquals(row.evSoc, 80); assertEquals(row.poolTemperatureC, 29.25);
  assertEquals(row.cumulativeCostSek, -2.25);
  assertEquals(chart.rows[1].loadW, 0); assertEquals(chart.rows[1].homeSoc, null); assertEquals(chart.rows[1].poolTemperatureC, null);
  assertEquals(recorded.rows[0].deviceW.pool_pump, 60);
  assertAlmostEquals(chart.rows.at(-1)!.cumulativeCostSek!, recorded.ledger.costSek);
});

Deno.test('period energy comparison uses grid meters and retained solar, excluding the initial quarter', () => {
  const rows = baselineFixture();
  rows.actual[0].solar_production_kwh = 1000;
  rows.actual[1].solar_production_kwh = 1; rows.actual[1].grid_export_kwh = .25;
  rows.actual[2].solar_production_kwh = 1; rows.actual[2].grid_export_kwh = .5;
  const input = prepareHomeBaseline(rows), result = projectBaseline(input, engine);
  const comparison = periodComparison({ input, result, engineHash: 'test' });
  assertEquals(comparison.actual.solarKwh, 1.25); assertEquals(comparison.actual.exportKwh, .75);
  assertAlmostEquals(comparison.actual.gridKwh, 288 * .265);
  assertAlmostEquals(comparison.savingSek, result.ledger.costSek - input.recorded.ledger.costSek);
  assertAlmostEquals(comparison.baseline.solarKwh + comparison.baseline.exportKwh, result.series.solarW.reduce((sum, w) => sum + w / 4000, 0));
});
