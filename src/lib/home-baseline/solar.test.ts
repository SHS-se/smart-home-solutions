import { assertAlmostEquals, assertEquals, assertThrows } from '@std/assert';
import { modeledSolar } from './solar.ts';
import { prepareHomeBaseline } from './model.ts';
import { baselineFixture } from './fixture.ts';
import { compareModels } from './model-comparison.ts';
import { createWasmPlanner } from '../../../supabase/functions/_shared/planner-wasm/core.ts';

const profile = { profile_hash: 'a'.repeat(64), start_ts: '2026-03-29T00:00:00Z', end_ts: '2026-03-29T02:00:00Z' };
const hours = [{ start_ts: profile.start_ts, raw_kwh: 4, modeled_kwh: 3 }, { start_ts: '2026-03-29T01:00:00Z', raw_kwh: 2, modeled_kwh: 1 }];
Deno.test('reconstructed solar preserves hourly energy across DST and fails on incomplete or invalid publication', () => {
  const solar = modeledSolar(profile, hours);
  const values = Array.from({ length: 8 }, (_, i) => solar(Date.parse(profile.start_ts) + i * 900_000)!);
  assertEquals(values, [.75,.75,.75,.75,.25,.25,.25,.25]);
  assertEquals(values.reduce((a,b) => a+b), 4);
  assertEquals(solar(Date.parse(profile.end_ts)), null);
  assertThrows(() => modeledSolar(profile, hours.slice(1))(Date.parse(profile.start_ts)), Error, 'unavailable');
  assertThrows(() => modeledSolar(profile, [...hours,hours[0]]), Error, 'Invalid');
  assertThrows(() => modeledSolar(profile, [{ ...hours[0], modeled_kwh: -1 }]), Error, 'Invalid');
});
Deno.test('both hypothetical models use reconstructed solar while Actual and post-publication measured zeros stay unchanged', () => {
  const rows = baselineFixture({ start: profile.start_ts, end: '2026-03-29T03:00:00Z' });
  rows.actual.forEach(r => { r.solar_production_kwh = 0; });
  const before = prepareHomeBaseline(rows);
  rows.snapshot.roi_solar_profile = profile.profile_hash;
  rows.solar = { profile, hours };
  const after = prepareHomeBaseline(rows);
  assertEquals(after.recorded, before.recorded);
  assertEquals(after.problem.slots.map(s => s.solar_w), [3000,3000,3000,3000,1000,1000,1000,1000,0,0,0,0]);
  assertEquals(after.solar, { profileHash: profile.profile_hash, reconstructedKwh: 4, reconstructedQuarters: 8 });
  const engine = createWasmPlanner(Deno.readFileSync(new URL('../../../supabase/functions/_shared/planner-wasm/solver.wasm',import.meta.url)));
  const compared = compareModels(after, engine);
  assertAlmostEquals(compared.result.series.solarW.reduce((a,b)=>a+b)/4000, 4);
  assertAlmostEquals(compared.scheduler.series.solarW.reduce((a,b)=>a+b)/4000, 4);
  rows.snapshot.roi_solar_profile = 'b'.repeat(64);
  assertThrows(() => prepareHomeBaseline(rows), Error, 'profile changed');
});
