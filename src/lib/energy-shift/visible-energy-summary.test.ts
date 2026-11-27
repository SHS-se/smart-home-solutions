import { assertAlmostEquals, assertEquals } from '@std/assert';
import { summariseTimeline, type TimelineRow } from './energy-timeline.ts';
import { summariseVisibleEnergy } from './visible-energy-summary.ts';

// Independently generated synthetic quarters, not household measurements.
const quarter = (overrides: Partial<TimelineRow> = {}): TimelineRow => ({
  start: '2026-08-16T12:00:00Z', startMs: Date.parse('2026-08-16T12:00:00Z'),
  measured: false, solarW: 2000, loadW: 8000, baseW: 2000,
  gridImportW: 6000, gridExportW: 0, batteryChargeW: 0, batteryDischargeW: 0,
  batterySoc: null, evSoc: null, deviceW: { heater: 6000 }, costSek: 3,
  importPriceSekPerKwh: 2, exportPriceSekPerKwh: 0.5,
  shadowImportSekPerKwh: null, shadowExportSekPerKwh: null,
  ...overrides,
});

Deno.test('all visible series retain the exact original totals', () => {
  const rows = [quarter(), quarter({ measured: true, costSek: 7.1234 })];
  assertEquals(summariseVisibleEnergy(rows, []), {
    ...summariseTimeline(rows, { from: 0, to: 2 }), filtered: false, incomplete: false,
  });
});

Deno.test('hidden loads reduce demand and imports using each quarter price', () => {
  const rows = [quarter(), quarter({ importPriceSekPerKwh: 4, costSek: 6 })];
  const result = summariseVisibleEnergy(rows, [[4000, 2000]]);
  assertEquals(result.consumptionKwh, 2.5);
  assertEquals(result.gridImportKwh, 1.5);
  assertEquals(result.netCostSek, 5);
  assertEquals(result.solarKwh, 1);
  assertEquals(result.gridExportKwh, 0);
  assertEquals(result.fullyPriced, true);
  assertEquals(rows[0].loadW, 8000, 'display filtering never mutates the plan');
  assertEquals(summariseVisibleEnergy(rows, []).netCostSek, 9, 'restoring series restores the original cost');
});

Deno.test('removed demand beyond imports becomes export at the sell price', () => {
  const result = summariseVisibleEnergy([quarter()], [[8000]]);
  assertEquals(result.consumptionKwh, 0);
  assertEquals(result.gridImportKwh, 0);
  assertEquals(result.gridExportKwh, 0.5);
  assertEquals(result.netCostSek, -0.25);
});

Deno.test('battery charging and discharging schedules stay fixed', () => {
  const charging = quarter({ solarW: 0, batteryChargeW: -4000, gridImportW: 12000, costSek: 6 });
  const discharging = quarter({ solarW: 0, batteryDischargeW: 8000, gridImportW: 0, costSek: 0 });
  const result = summariseVisibleEnergy([charging, discharging], [[8000, 8000]]);
  assertEquals(result.gridImportKwh, 1, 'grid energy for battery charging remains');
  assertEquals(result.gridExportKwh, 2, 'fixed discharge is exported when no load remains');
  assertEquals(result.netCostSek, 1);
});

Deno.test('multiple hidden bands include base load and cannot remove more than the house consumed', () => {
  const result = summariseVisibleEnergy([quarter()], [[2000], [6000], [2000]]);
  assertEquals(result.consumptionKwh, 0);
  assertEquals(result.gridExportKwh, 0.5);
});

Deno.test('simultaneous metered import and export retain their separate totals', () => {
  const result = summariseVisibleEnergy([quarter({ gridExportW: -1000, costSek: 2.875 })], [[4000]]);
  assertEquals(result.gridImportKwh, 0.5);
  assertEquals(result.gridExportKwh, 0.25);
  assertEquals(result.netCostSek, 0.875);
});

Deno.test('negative purchase and sale prices keep their signs', () => {
  const result = summariseVisibleEnergy([quarter({
    importPriceSekPerKwh: -2, exportPriceSekPerKwh: -0.5, costSek: -3,
  })], [[8000]]);
  assertEquals(result.netCostSek, 0.25);
});

for (const missingIndex of [1, 2]) {
  Deno.test(`missing hidden-load reading at index ${missingIndex} excludes only known consumption`, () => {
    const rows = [quarter(), quarter({ measured: true }), quarter({ measured: true })];
    const values = [4000, 4000, 4000];
    values[missingIndex] = NaN;
    const result = summariseVisibleEnergy(rows, [values]);
    assertEquals(result.incomplete, true);
    assertEquals(result.consumptionKwh, 4);
    assertEquals(result.gridImportKwh, 2.5);
    assertEquals(result.netCostSek, 5);
  });
}

Deno.test('an unavailable base-load counter preserves totals and reports incomplete exclusion', () => {
  const result = summariseVisibleEnergy([quarter()], [[NaN]]);
  assertEquals(result.incomplete, true);
  assertEquals(result.consumptionKwh, 2);
  assertEquals(result.netCostSek, 3);
});

Deno.test('missing timeline quarters stay gaps and do not contribute synthetic exports', () => {
  const result = summariseVisibleEnergy([quarter(), quarter({ missing: true, loadW: null, costSek: null })], [[4000, NaN]]);
  assertEquals(result.slotCount, 2);
  assertEquals(result.plannedSlotCount, 1);
  assertEquals(result.consumptionKwh, 1);
  assertEquals(result.gridExportKwh, 0);
  assertEquals(result.fullyPriced, false);
});

Deno.test('missing grid readings and prices remain incomplete rather than implying free energy', () => {
  const noGrid = summariseVisibleEnergy([quarter({ gridImportW: null })], [[4000]]);
  assertEquals(noGrid.incomplete, true);
  assertEquals(noGrid.fullyPriced, false);
  assertEquals(noGrid.consumptionKwh, 1);
  const noSellPrice = summariseVisibleEnergy([quarter({ exportPriceSekPerKwh: null })], [[8000]]);
  assertEquals(noSellPrice.fullyPriced, false);
  assertEquals(noSellPrice.gridExportKwh, 0.5);
  const unpriced = summariseVisibleEnergy([quarter({ costSek: null })], [[4000]]);
  assertEquals(unpriced.fullyPriced, false);
  assertAlmostEquals(unpriced.netCostSek, 0);
});
