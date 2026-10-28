import { assertAlmostEquals, assertEquals, assertStrictEquals, assertThrows } from '@std/assert';
import { equipmentBenefit, equipmentInput, solarSizing, type EquipmentTrial } from './equipment.ts';
import { baselineFixture, captureStub } from './fixture.ts';
import { prepareHomeBaseline, projectBaseline } from './model.ts';
import { comparisonMonthLedger } from './savings.ts';
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
Deno.test('equipment benefit matches exact periods, excludes demand fees and balances stored energy without annualising', () => {
  const source = input();
  const original = comparisonMonthLedger(captureStub({ input: source, result: projectBaseline(source, engine, false), engineHash: 'synthetic' }));
  const reference = structuredClone(original), selected = structuredClone(original);
  reference.modeled.schedulerBill = { totalSek: 500, supplierFixedSek: 20, gridFixedSek: 50, gridPeakSek: 100, peakKw: 2 };
  selected.modeled.schedulerBill = { totalSek: 600, supplierFixedSek: 20, gridFixedSek: 50, gridPeakSek: 300, peakKw: 6 };
  reference.modeled.schedulerService.endCreditSek = 0;
  selected.modeled.schedulerService.endCreditSek = -30;
  const benefit = equipmentBenefit([reference], [selected])!;
  assertEquals(benefit.rows.length, 1);
  assertEquals(benefit.currentSek, 400);
  assertEquals(benefit.selectedSek, 330);
  assertEquals(benefit.savingSek, 70);
  // A lower cash bill due solely to extra initial inventory is not an upgrade benefit.
  selected.modeled.schedulerBill.totalSek = 670;
  assertEquals(equipmentBenefit([reference], [selected])!.savingSek, 0);
  selected.modeled.schedulerBill.totalSek = 700;
  assertEquals(equipmentBenefit([reference], [selected])!.savingSek, -30);
  for (const change of [{ end: '2026-09-01T00:00:00.000Z' }, { coverage: 1 }, { timeZone: 'UTC' }]) {
    assertEquals(equipmentBenefit([reference], [{ ...selected, ...change }]), null);
  }
  assertEquals(equipmentBenefit([], [selected]), null);
});
