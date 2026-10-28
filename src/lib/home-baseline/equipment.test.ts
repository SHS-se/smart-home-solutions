import { assertAlmostEquals, assertEquals, assertStrictEquals, assertThrows } from '@std/assert';
import { equipmentBenefit, equipmentInput, solarSizing, type EquipmentTrial } from './equipment.ts';
import { baselineFixture, captureStub } from './fixture.ts';
import { prepareHomeBaseline, projectBaseline } from './model.ts';
import { comparisonMonthLedger } from './savings.ts';
import { savingsForecast } from './savings-report.ts';
import { createWasmPlanner } from '../../../supabase/functions/_shared/planner-wasm/core.ts';

// Independently specified synthetic nameplates and AC generation, not household captures.
const current = { arrayKwp: 8, inverterKw: 5 };
const engine = createWasmPlanner(Deno.readFileSync(new URL('../../../supabase/functions/_shared/planner-wasm/solver.wasm', import.meta.url)));
function input() {
  const value = prepareHomeBaseline(baselineFixture({ start: '2026-08-31T22:00:00.000Z', end: '2026-08-31T23:00:00.000Z' }));
  value.problem.slots.forEach((slot, index) => { slot.solar_w = [1000, 4000, 5000, 0][index]; });
  return value;
}
Deno.test('equipment trials scale AC generation, clip at the selected inverter and leave all evidence unchanged', () => {
  const original = input(), before = structuredClone(original);
  const trial: EquipmentTrial = { solar: { current, proposed: { arrayKwp: 16, inverterKw: 6 } }, batteryKwh: 24 };
  const changed = equipmentInput(original, trial);
  assertEquals(changed.problem.slots.map(slot => slot.solar_w), [2000, 6000, 6000, 0]);
  assertEquals(original, before);
  assertStrictEquals(changed.recorded, original.recorded);
  assertStrictEquals(changed.settings, original.settings);
  assertEquals(changed.problem.limits.import_w, original.problem.limits.import_w);
  assertEquals(changed.problem.limits.export_w, original.problem.limits.export_w);
  const battery = original.problem.battery!;
  assertEquals(changed.problem.battery, { ...battery, capacity_kwh: 24 });
  assertAlmostEquals(changed.problem.initial.battery_kwh! / 24, original.problem.initial.battery_kwh! / battery.capacity_kwh);
  assertEquals(changed.equipment, trial);
  trial.solar!.proposed.arrayKwp = 100;
  assertEquals(changed.equipment!.solar!.proposed.arrayKwp, 16);
});
Deno.test('unchanged nameplates preserve the exact source, and inverter-only downsizing clips output', () => {
  const original = input();
  const same = equipmentInput(original, { solar: { current, proposed: current }, batteryKwh: null });
  assertStrictEquals(same.problem.slots, original.problem.slots);
  assertStrictEquals(same.problem.battery, original.problem.battery);
  const smaller = equipmentInput(original, { solar: { current, proposed: { arrayKwp: 8, inverterKw: 3 } }, batteryKwh: null });
  assertEquals(smaller.problem.slots.map(slot => slot.solar_w), [1000, 3000, 3000, 0]);
  const larger = equipmentInput(original, { solar: { current, proposed: { arrayKwp: 8, inverterKw: 10 } }, batteryKwh: null });
  assertEquals(larger.problem.slots.map(slot => slot.solar_w), original.problem.slots.map(slot => slot.solar_w), 'previously clipped energy is unknown, never invented');
});
Deno.test('zero solar/battery works through the real native projector and cannot change Actual', () => {
  const original = input();
  const changed = equipmentInput(original, { solar: { current, proposed: { arrayKwp: 0, inverterKw: 0 } }, batteryKwh: 0 });
  const result = projectBaseline(changed, engine, false);
  assertEquals(changed.problem.battery, null);
  assertEquals(changed.problem.initial.battery_kwh, null);
  assertEquals(changed.problem.limits.battery_export_enabled, false);
  assertEquals(changed.problem.limits.wear_per_kwh, 0);
  assertEquals(result.series.solarW, [0, 0, 0, 0]);
  assertEquals(result.series.homeSoc, [null, null, null, null]);
  assertStrictEquals(changed.recorded, original.recorded);
});
Deno.test('trial sizes and missing battery characteristics fail explicitly; nameplates are never inferred', () => {
  const original = input();
  for (const bad of [-1, NaN, Infinity]) {
    assertThrows(() => equipmentInput(original, { solar: null, batteryKwh: bad }), Error, 'Battery capacity');
    assertThrows(() => equipmentInput(original, { solar: { current, proposed: { arrayKwp: bad, inverterKw: 5 } }, batteryKwh: null }), Error, 'Solar array');
  }
  assertThrows(() => equipmentInput(original, { solar: { current: { arrayKwp: 0, inverterKw: 5 }, proposed: current }, batteryKwh: null }), Error, 'installed solar');
  const missing = { ...original, problem: { ...original.problem, battery: null, initial: { ...original.problem.initial, battery_kwh: null } } };
  assertThrows(() => equipmentInput(missing, { solar: null, batteryKwh: 20 }), Error, 'power limits, efficiencies and SOC bounds');
  assertEquals(solarSizing(null), null);
  assertEquals(solarSizing({ peak_kw: 8 }), null);
  assertEquals(solarSizing({ peak_kw: 8, inverter_kw: 5 }), current);
  assertThrows(() => solarSizing({ peak_kw: -1, inverter_kw: 5 }), Error, 'Invalid installed');
});
Deno.test('equipment benefit matches displayed monthly costs and ignores stored-energy valuations', () => {
  const source = input();
  const original = comparisonMonthLedger(captureStub({ input: source, result: projectBaseline(source, engine, false), engineHash: 'synthetic' }));
  const reference = structuredClone(original), selected = structuredClone(original);
  reference.modeled.schedulerBill = { totalSek: 500, supplierFixedSek: 20, gridFixedSek: 50, gridPeakSek: 100, peakKw: 2 };
  selected.modeled.schedulerBill = { totalSek: 600, supplierFixedSek: 20, gridFixedSek: 50, gridPeakSek: 300, peakKw: 6 };
  reference.modeled.baselineBill = { totalSek: 700, supplierFixedSek: 20, gridFixedSek: 50, gridPeakSek: 80, peakKw: 2 };
  selected.modeled.baselineBill = { totalSek: 660, supplierFixedSek: 20, gridFixedSek: 50, gridPeakSek: 120, peakKw: 3 };
  reference.modeled.schedulerService.endCreditSek = 0;
  selected.modeled.schedulerService.endCreditSek = -30;
  const benefit = equipmentBenefit([reference], [selected])!;
  assertEquals(benefit.rows.length, 1);
  assertEquals(benefit.withShs.currentSek, 400);
  assertEquals(benefit.withShs.selectedSek, 300);
  assertEquals(benefit.withShs.savingSek, 100);
  assertEquals(benefit.withoutShs.currentSek, 620);
  assertEquals(benefit.withoutShs.selectedSek, 540);
  assertEquals(benefit.withoutShs.savingSek, 80);
  // The user's financial comparison must not include hidden energy valuations.
  reference.modeled.baselineService.endCreditSek = 500;
  selected.modeled.baselineService.endCreditSek = -300;
  reference.modeled.schedulerService.endCreditSek = 1000;
  selected.modeled.schedulerService.endCreditSek = -900;
  assertEquals(equipmentBenefit([reference], [selected]), benefit);
  selected.modeled.schedulerBill.totalSek = 700;
  assertEquals(equipmentBenefit([reference], [selected])!.withShs.savingSek, 0);
  selected.modeled.schedulerBill.totalSek = 730;
  assertEquals(equipmentBenefit([reference], [selected])!.withShs.savingSek, -30);
  for (const change of [{ end: '2026-09-01T00:00:00.000Z' }, { coverage: 1 }, { timeZone: 'UTC' }]) {
    assertEquals(equipmentBenefit([reference], [{ ...selected, ...change }]), null);
  }
  assertEquals(equipmentBenefit([], [selected]), null);
  reference.modeled.schedulerBill.totalSek = 500.004;
  selected.modeled.schedulerBill.totalSek = 600.995;
  const displayed = equipmentBenefit([reference], [selected])!.withShs;
  assertEquals(displayed.currentSek, 400);
  assertEquals(displayed.selectedSek, 301);
  assertEquals(displayed.savingSek, 99, 'Savings subtract the exact displayed costs, not hidden fractions of an öre');
});

Deno.test('all twelve equipment months and both SHS modes reconcile to the displayed monthly amounts', () => {
  // Independently generated synthetic prices expose fractional-öre aggregation errors.
  const source = input();
  const original = comparisonMonthLedger(captureStub({ input: source, result: projectBaseline(source, engine, false), engineHash: 'synthetic' }));
  const reference = Array.from({ length: 12 }, (_, index) => {
    const start = new Date(Date.UTC(2025, 10 + index, 1)).toISOString();
    const end = new Date(Date.UTC(2025, 11 + index, 1)).toISOString();
    const ledger = { ...structuredClone(original), month: start.slice(0, 7), start, end, timeZone: 'UTC', coverage: 1 };
    ledger.modeled.baselineBill = { totalSek: 100.004, supplierFixedSek: 0, gridFixedSek: 0, gridPeakSek: 0, peakKw: 0 };
    ledger.modeled.schedulerBill = { ...ledger.modeled.baselineBill, totalSek: 80.006 };
    return ledger;
  });
  const selected = structuredClone(reference);
  selected.forEach(month => { month.modeled.baselineBill.totalSek = 90.006; month.modeled.schedulerBill.totalSek = 75.004; });
  const benefit = equipmentBenefit(reference, selected)!;
  assertEquals(benefit.rows.length, 12);
  const currentTable = savingsForecast(reference, 0), selectedTable = savingsForecast(selected, 0);
  assertEquals([benefit.withoutShs.currentSek, benefit.withoutShs.selectedSek, benefit.withoutShs.savingSek], [1200, 1080.12, 119.88]);
  assertEquals([benefit.withShs.currentSek, benefit.withShs.selectedSek, benefit.withShs.savingSek], [960.12, 900, 60.12]);
  assertEquals([benefit.withoutShs.currentSek, benefit.withShs.currentSek], [currentTable.withoutSek, currentTable.withSek]);
  assertEquals([benefit.withoutShs.selectedSek, benefit.withShs.selectedSek], [selectedTable.withoutSek, selectedTable.withSek]);
});
