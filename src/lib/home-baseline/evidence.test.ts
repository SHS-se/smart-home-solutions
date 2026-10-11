import { assertAlmostEquals, assertEquals } from '@std/assert';
import { baselineFixture } from './fixture.ts';
import { prepareHomeBaseline, projectBaseline } from './model.ts';
import { assessAssumptions, hasAssumptions } from './evidence.ts';
import { createWasmPlanner } from '../../../supabase/functions/_shared/planner-wasm/core.ts';
import { captureEvidence } from './savings.ts';

const engine = createWasmPlanner(new Uint8Array(Deno.readFileSync(new URL('../../../supabase/functions/_shared/planner-wasm/solver.wasm', import.meta.url))));
const hour = () => baselineFixture({ start: '2026-09-01T00:00:00.000Z', end: '2026-09-01T01:00:00.000Z' });

Deno.test('billing timing preserves recovered energy, includes export sign and leaves measured quarters fixed', () => {
  const rows = hour();
  rows.actual.slice(1).forEach(r => { r.grid_import_kwh = 1; r.grid_export_kwh = .5; });
  rows.prices.forEach((p, i) => { p.import_price_sek_per_kwh = i + 1; p.export_price_sek_per_kwh = i + 1; });
  rows.hourlyFields = rows.prices.map(p => ({ start_ts: p.start_ts, fields: ['grid_import_kwh', 'grid_export_kwh'] }));
  const input = prepareHomeBaseline(rows);
  const full = assessAssumptions(input, 0, [0, 0, 0, 0], engine);
  assertEquals([full.timingSavingMinSek, full.timingSavingMaxSek], [-9, 9]);
  input.evidence.hourlyImport[0] = false; input.evidence.hourlyExport[0] = false;
  const partial = assessAssumptions(input, 0, [0, 0, 0, 0], engine);
  assertEquals([partial.timingSavingMinSek, partial.timingSavingMaxSek], [-4.5, 4.5]);
  input.recorded.rows.forEach(r => { r.importPriceSekPerKwh = 2; r.exportPriceSekPerKwh = 2; });
  const flat = assessAssumptions(input, 0, [0, 0, 0, 0], engine);
  assertEquals(flat.timingSavingMinSek, 0); assertEquals(flat.timingSavingMaxSek, 0);
});

Deno.test('supplier sensitivity changes only assumed import markup; reconstructed market prices alone are not assumptions', () => {
  const rows = hour(); rows.prices.forEach(p => { p.source = 'reconstructed'; });
  rows.prices[0].supplier_revision = 'historical_assumed';
  rows.actual[1].grid_import_kwh = 1;
  const input = prepareHomeBaseline(rows), result = assessAssumptions(input, 0, [8000, 0, 0, 0], engine);
  assertAlmostEquals(result.markup10OreDeltaSek, .1);
  const evidence = captureEvidence({ input, result: projectBaseline(input, engine), engineHash: 'test' });
  assertEquals(hasAssumptions(evidence), true);
  evidence.assumedPriceQuarters = 0; evidence.recovery.hours = 1;
  assertEquals(hasAssumptions(evidence), false);
});

Deno.test('member gaps count missing readings separately and distinguish observed zero', () => {
  const rows = hour(); delete rows.deviceSlots[0].device_energy_kwh['heater-id']; rows.deviceSlots[1].device_energy_kwh['pump-id'] = null;
  const input = prepareHomeBaseline(rows);
  assertEquals(input.evidence.missingDevices.map(m => [m.key, m.quarters]), [['pool_heater', 1], ['pool_pump', 1], ['car', 0]]);
  assertEquals(input.energyGaps.deviceReadings, 2);
});

Deno.test('initial-state scenarios run only for unobserved states and disclose infeasible trials', () => {
  const rows = hour(); rows.actual[0].battery_soc = null; rows.evInitial = null; rows.pool = [];
  const input = prepareHomeBaseline(rows), result = projectBaseline(input, engine);
  assertEquals(result.sensitivity.initial.map(s => [s.assumption, s.value]), [['battery', 100], ['ev', 20], ['pool', 28], ['pool', 30.5]]);
  assertEquals(result.sensitivity.initial.every(s => s.savingDeltaSek === null || Number.isFinite(s.savingDeltaSek)), true);
  const measured = prepareHomeBaseline(hour()); assertEquals(projectBaseline(measured, engine).sensitivity.initial, []);
});
