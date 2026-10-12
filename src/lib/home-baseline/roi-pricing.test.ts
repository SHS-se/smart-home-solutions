import { assertAlmostEquals, assertEquals, assertThrows } from '@std/assert';
import { modeledCosts, cumulativeModeledCost, roiComparisonExport, ROI_PRICING_POLICY } from './roi-pricing.ts';
import { baselineFixture, captureStub } from './fixture.ts';
import { prepareHomeBaseline, projectBaseline } from './model.ts';
import { createWasmPlanner } from '../../../supabase/functions/_shared/planner-wasm/core.ts';

Deno.test('ROI pricing excludes unequal demand charges, retains fixed fees and signed export income', () => {
  const bills = {
    baselineBill: { supplierFixedSek: 49, gridFixedSek: 395, gridPeakSek: 601.51, peakKw: 7.4, totalSek: 2230.26 },
    schedulerBill: { supplierFixedSek: 49, gridFixedSek: 395, gridPeakSek: 1157.59, peakKw: 14.2, totalSek: 2241.49 },
  };
  const before = JSON.stringify(bills), costs = modeledCosts(bills);
  assertEquals(costs.policy, ROI_PRICING_POLICY);
  assertAlmostEquals(costs.baseline.totalSek, 1628.75);
  assertAlmostEquals(costs.scheduler.totalSek, 1083.9);
  assertAlmostEquals(costs.savingSek, 544.85);
  assertAlmostEquals(costs.scheduler.energySek, 639.9);
  assertEquals(JSON.stringify(bills), before);
  const negative = modeledCosts({ ...bills, baselineBill: { ...bills.baselineBill, totalSek: bills.baselineBill.gridPeakSek + 44.4 - 100, supplierFixedSek: 4.9, gridFixedSek: 39.5 } });
  assertAlmostEquals(negative.baseline.energySek, -100);
  assertAlmostEquals(negative.baseline.totalSek, -55.6);
  assertThrows(() => modeledCosts({ ...bills, baselineBill: { ...bills.baselineBill, gridPeakSek: NaN } }));
});

Deno.test('modeled cumulative costs add prorated fixed fees without an end-of-period demand spike', () => {
  const cost = { energySek: 30, supplierFixedSek: 4, gridFixedSek: 8, totalSek: 42 };
  assertEquals(cumulativeModeledCost(cost, [10, 20, 30]), [14, 28, 42]);
  assertEquals(cumulativeModeledCost(cost, [10, null, null]), [14, null, null]);
  assertEquals(cumulativeModeledCost(cost, []), []);
});

Deno.test('model export reports the same demand-free totals and names original tariff evidence without mutating the capture', () => {
  const input = prepareHomeBaseline(baselineFixture({ start: '2026-05-01T00:00:00Z', end: '2026-05-01T01:00:00Z' }));
  const engine = createWasmPlanner(new Uint8Array(Deno.readFileSync(new URL('../../../supabase/functions/_shared/planner-wasm/solver.wasm', import.meta.url))));
  const capture = captureStub({ input, result: projectBaseline(input, engine, false), engineHash: 'test' });
  capture.modeled.baselineBill = { supplierFixedSek: 4, gridFixedSek: 8, gridPeakSek: 200, peakKw: 3, totalSek: capture.result.ledger.costSek + 212 };
  capture.modeled.schedulerBill = { supplierFixedSek: 4, gridFixedSek: 8, gridPeakSek: 500, peakKw: 6, totalSek: capture.scheduler.ledger.costSek + 512 };
  const before = JSON.stringify(capture), exported = roiComparisonExport(capture), costs = modeledCosts(capture.modeled);
  assertEquals(exported.pricingPolicy, ROI_PRICING_POLICY);
  assertEquals(exported.modeled.baselineBill, costs.baseline);
  assertEquals(exported.modeled.schedulerBill, costs.scheduler);
  assertEquals(exported.tariffEvidence.schedulerBill.gridPeakSek, 500);
  assertEquals('gridPeakSek' in exported.modeled.schedulerBill, false);
  assertEquals(JSON.stringify(capture), before);
});
