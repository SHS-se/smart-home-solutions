import { assertAlmostEquals, assertEquals, assertThrows } from '@std/assert';
import { baselineFixture } from './fixture';
import { prepareHomeBaseline, projectBaseline } from './model';
import { createWasmPlanner } from '../../../supabase/functions/_shared/planner-wasm/core';
import { monthLedger } from './savings';
import { roiReport } from './roi-report';
import type { ComparisonContract } from '../contract-roi';
const engine = createWasmPlanner(new Uint8Array(Deno.readFileSync(new URL('../../../supabase/functions/_shared/planner-wasm/solver.wasm', import.meta.url))));
const input = prepareHomeBaseline(baselineFixture({ start: '2026-09-30T22:00:00Z', end: '2026-10-31T23:00:00Z' }));
const ledger = { ...monthLedger({ input, result: projectBaseline(input, engine), engineHash: 'test' }),
  baseline: { importKwh: 100, exportKwh: 10, importCostSek: 300, exportRevenueSek: 20, costSek: 280 },
  recorded: { importKwh: 100, exportKwh: 10, importCostSek: 200, exportRevenueSek: 20, costSek: 180 }, gridImportCostSek: 50 };
const investment = { equipmentSek: 1000, installationSek: 1000, subscriptionSek: 30, currentMonthlyFeeSek: 10 };
const contract: ComparisonContract = { kind: 'fixed', method: 'quote', rateOre: 200, monthlyFeeSek: 0, variableRateOre: 0, fixedSharePercent: 0, markupDifferenceOre: 0, monthlyMarkupPercent: 0, monthlyRates: {} };
Deno.test('ROI uses the same month rows and keeps grid costs and exports out of supplier savings', () => {
  const result = roiReport([ledger], contract, investment), row = result.rows[0];
  assertEquals(row.baselineSek, 290); assertEquals(row.recordedSek, 190);
  assertEquals(row.alternativeSek, 230); assertEquals(row.contractSavingSek, 40);
  assertEquals(result.grossSek, 100); assertEquals(result.netSek, 70);
  assertAlmostEquals(result.roiPercent!, 3.5); assertAlmostEquals(result.paybackMonths!, 2000 / 70);
  assertEquals(roiReport([ledger], { ...contract, rateOre: 500 }, investment).netSek, 70);
  assertEquals(roiReport([ledger], contract, { ...investment, subscriptionSek: 0 }).contractSavingSek, 40);
});
Deno.test('partial months prorate fees and subscription once and the hero equals row totals', () => {
  const result = roiReport([ledger, { ...ledger, month: '2026-11', coverage: .5 }], contract, investment);
  assertEquals(result.baselineSek, 575); assertEquals(result.recordedSek, 375);
  assertEquals(result.subscriptionSek, 45); assertEquals(result.netSek, 155);
  assertAlmostEquals(result.monthlyNetSek!, 155 / 1.5);
  assertEquals(result.rows.reduce((n, r) => n + r.netSek, 0), result.netSek);
});
Deno.test('losses remain signed, missing contract prices do not block scheduler ROI, and invalid costs fail', () => {
  const result = roiReport([{ ...ledger, baseline: { ...ledger.baseline, costSek: -10 } }], null, investment);
  assertEquals(result.netSek, -220); assertEquals(result.contractSavingSek, null); assertEquals(result.paybackMonths, null);
  assertEquals(roiReport([], contract, investment).monthlyNetSek, null);
  assertThrows(() => roiReport([ledger], contract, { ...investment, subscriptionSek: NaN }));
  assertThrows(() => roiReport([ledger], contract, { ...investment, currentMonthlyFeeSek: -1 }));
});
