import { assertAlmostEquals, assertEquals, assertThrows } from '@std/assert';
import { baselineFixture } from './fixture';
import { prepareHomeBaseline, projectBaseline } from './model';
import { createWasmPlanner } from '../../../supabase/functions/_shared/planner-wasm/core';
import { monthLedger, monthsBetween, schedulerSavings } from './savings';
import { monthPeriod } from './period';

const engine = createWasmPlanner(new Uint8Array(Deno.readFileSync(new URL('../../../supabase/functions/_shared/planner-wasm/solver.wasm', import.meta.url))));
const rows = baselineFixture({ start: '2026-09-30T22:00:00.000Z', end: '2026-10-31T23:00:00.000Z' });
const input = prepareHomeBaseline(rows), capture = { input, result: projectBaseline(input, engine), engineHash: 'test' };

Deno.test('recorded grid costs use aligned quarters, separate imports/exports and signed prices, excluding the initial quarter', () => {
  const rows = baselineFixture();
  rows.actual.forEach(row => { row.grid_import_kwh = 0; row.grid_export_kwh = 0; });
  rows.actual[0].grid_import_kwh = 999;
  rows.actual[1].grid_import_kwh = 2; rows.actual[1].grid_export_kwh = 1;
  rows.prices[0].import_price_sek_per_kwh = 3; rows.prices[0].export_price_sek_per_kwh = 1;
  rows.actual[2].grid_import_kwh = 1; rows.actual[2].grid_export_kwh = 2;
  rows.prices[1].import_price_sek_per_kwh = -2; rows.prices[1].export_price_sek_per_kwh = -.5;
  assertEquals(prepareHomeBaseline(rows).recorded.ledger, { importKwh: 3, exportKwh: 3, importCostSek: 4, exportRevenueSek: 0, costSek: 4 });
});

Deno.test('missing recorded grid energy counts as zero and is disclosed, while invalid energy fails', () => {
  const rows = baselineFixture();
  rows.actual[1].grid_import_kwh = null; rows.actual[2].grid_export_kwh = null;
  const recorded = prepareHomeBaseline(rows).recorded;
  assertEquals(recorded.missingImportQuarters, 1); assertEquals(recorded.missingExportQuarters, 1);
  assertAlmostEquals(recorded.ledger.costSek, 287 * .265);
  rows.actual[1].grid_import_kwh = -1;
  assertThrows(() => prepareHomeBaseline(rows), Error, 'grid import');
});

Deno.test('a full DST calendar month uses the whole ledger and exactly one subscription', () => {
  const ledger = monthLedger(capture);
  assertEquals(capture.input.problem.slots.length, 2980);
  assertEquals(ledger.coverage, 1);
  const result = schedulerSavings([ledger], 299);
  assertAlmostEquals(result.grossSek, capture.result.ledger.costSek - capture.input.recorded.ledger.costSek);
  assertEquals(result.subscriptionSek, 299);
  assertAlmostEquals(result.netSek!, result.grossSek - 299);
  const expensive = { ...ledger, recorded: { ...ledger.recorded, costSek: ledger.baseline.costSek + 10 } };
  assertEquals(schedulerSavings([expensive], 0).grossSek, -10);
});

Deno.test('partial month and totals prorate subscription by home calendar duration without annualising', () => {
  const partial = monthLedger({ ...capture, input: { ...input, end: '2026-10-11T00:00:00.000Z' } });
  assertAlmostEquals(partial.coverage, (10 * 24 + 2) / (31 * 24 + 1));
  const result = schedulerSavings([monthLedger(capture), partial], 299);
  assertAlmostEquals(result.subscriptionSek!, 299 * (1 + partial.coverage));
  assertEquals(schedulerSavings([partial], null).netSek, null);
  assertThrows(() => schedulerSavings([partial], -1));
  assertThrows(() => monthLedger({ ...capture, input: { ...input, start: '2026-10-01T00:00:00.000Z' } }));
});

Deno.test('month ranges include gaps and year boundaries, clipping only the last recorded month', () => {
  assertEquals(monthsBetween('2025-12', '2026-02'), ['2025-12', '2026-01', '2026-02']);
  assertEquals(monthsBetween('9999-12', '9999-12'), ['9999-12']);
  assertEquals(monthsBetween('2025-11', '2026-10').length, 12);
  assertThrows(() => monthsBetween('2025-10', '2026-10'), Error, 'at most 12 months');
  assertThrows(() => monthsBetween('2026-09', '2026-08'));
  assertThrows(() => monthsBetween('2026-00', '2026-08'));
  const anchor = { snapshot: rows.snapshot, earliestStart: '2026-01-01T00:00:00.000Z', latestEnd: '2026-10-11T00:00:00.000Z' };
  assertEquals(monthPeriod(anchor, '2026-10')?.end, anchor.latestEnd);
  assertEquals(monthPeriod(anchor, '2026-11'), null);
});
