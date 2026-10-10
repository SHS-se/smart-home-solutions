import { assert, assertAlmostEquals, assertEquals, assertThrows } from '@std/assert';
import vectors from '../../../planner-core/models/heater-transitions.json' with { type: 'json' };
import {
  parseHeaterResponse, parseHeaterState, publishHeater, stepHeater,
} from '../../../supabase/functions/_shared/planner/device-models.ts';
import { HOUSEHOLD } from './household.ts';
import { parseScenarioData } from './case.ts';
import { caseFromReplay } from './convert-replay.ts';
import { referee, reachability, simulate } from './referee.ts';
import { plan, TARGETS, within, world } from './world.fixture.ts';

Deno.test('device-owned heater transitions match the shared native electrical, thermal and command vectors', () => {
  const heater = { compressor_w: 3000, auxiliary_w: 0, heat_w: 12000, response: parseHeaterResponse(vectors.response) };
  for (const v of vectors.vectors) {
    const step = stepHeater(heater, parseHeaterState(v.state), v.on, v.seconds);
    assertAlmostEquals(step.electric_w, v.electric_w, 1e-9);
    assertAlmostEquals(step.heat_w, v.heat_w, 1e-9);
    assertEquals(step.next, v.next);
    assertEquals(step.start, v.start);
  }
  assertThrows(() => publishHeater({ ...HOUSEHOLD.pool.heater, response: undefined }));
});

Deno.test('heater restart events preserve the exact time since the latest stop', () => {
  const c = world();
  // First run stops at quarter 2. Quarter 49 is 11h45m later; quarter 50
  // would be exactly twelve hours. Continuing quarters never count as starts.
  const series = referee(c, HOUSEHOLD, TARGETS, plan({
    pool: i => within(i, 0, 2) || within(i, 49, 52) || within(i, 60, 63) ? 3764 : 0,
  })).series;
  assertEquals([series.poolStart![0], series.poolStart![49], series.poolStart![50], series.poolStart![60]],
    [{ off_seconds: null }, { off_seconds: 47 * 900 }, null, { off_seconds: 8 * 900 }]);
  const boundary = referee(c, HOUSEHOLD, TARGETS, plan({ pool: i => i === 0 || within(i, 49, 51) ? 3764 : 0 })).series;
  assertEquals(boundary.poolStart![49], { off_seconds: 43200 });
});

Deno.test('pre-horizon heater memory distinguishes recent stop, unknown stop and continuing run', () => {
  for (const [state, expected] of [
    [{ kind: 'off', seconds: 43199 }, { off_seconds: 43199 }],
    [{ kind: 'off', seconds: 43200 }, { off_seconds: 43200 }],
    [{ kind: 'off_unobserved' }, { off_seconds: null }],
    [{ kind: 'running', seconds: 300 }, null],
    [{ kind: 'steady' }, null],
  ] as const) {
    const c = world({ start: { pool_heater: state } });
    const d = plan({ pool: i => i < 3 ? 3764 : 0 });
    assertEquals(referee(c, HOUSEHOLD, TARGETS, d).series.poolStart![0], expected);
    assertEquals(reachability(c, HOUSEHOLD).poolC[0], Math.round(simulate(c, HOUSEHOLD, d).poolC[0] * 100) / 100);
  }
});

Deno.test('startup electricity and thermal energy remain independent', () => {
  const c = world({ start: { pool_heater: { kind: 'off', seconds: 3600 } } });
  const d = plan({ pool: i => i < 2 ? 3764 : 0 });
  const sim = simulate(c, HOUSEHOLD, d);
  const heater = publishHeater(HOUSEHOLD.pool.heater);
  const first = stepHeater(heater, c.start_state.pool_heater, true, 900);
  assertAlmostEquals(sim.poolW[0], first.electric_w);
  assert(sim.poolW[0] < sim.poolW[1]);
  assert(first.heat_w / heater.heat_w < first.electric_w / (heater.compressor_w + heater.auxiliary_w));
  // A command can start with zero actual draw. The event is still recorded.
  const zero = stepHeater({ ...heater, auxiliary_w: 0 }, c.start_state.pool_heater, true, 300);
  assertEquals([zero.electric_w, zero.heat_w, zero.start], [0, 0, { off_seconds: 3600 }]);
});

Deno.test('obsolete cases and missing initial heater state fail explicitly', () => {
  const c = world();
  assertThrows(() => parseScenarioData({ ...c, version: 1 }));
  assertThrows(() => parseScenarioData({ ...c, start_state: { ...c.start_state, pool_heater: null } }));

});

Deno.test('replay conversion retains captured run age and refuses unmeasured running age', () => {
  const c = world();
  const replay = (pool: unknown) => ({ format: 'shs-energy-optimisation-quarter-replay', entrypoint: { arguments: { snapshot: {
    captured_at: c.start, timezone: c.timezone, location: c.location, pool,
    slots: c.known_prices.import_sek_per_kwh.map((price, i) => ({ start: new Date(Date.parse(c.start) + i * 900000).toISOString(),
      pv_forecast_w: 0, base_load_forecast_w: 500, import_price_sek_per_kwh: price, export_price_sek_per_kwh: 0.5 })),
  } } } });
  assertEquals(caseFromReplay(replay({ water_temperature_c: 30, heating_running: true, heating_elapsed_seconds: 450 })).data.start_state.pool_heater,
    { kind: 'running', seconds: 450 });
  assertThrows(() => caseFromReplay(replay({ heating_running: true })));
});

Deno.test('pool starts add 3 kr modelled wear even after an unknown or long stop, without changing the meter bill', () => {
  for (const state of [{ kind: 'off_unobserved' }, { kind: 'off', seconds: 86400 },
    { kind: 'running', seconds: 300 }, { kind: 'steady' }] as const) {
    const c = world({ start: { pool_heater: state } });
    const d = plan({ pool: i => within(i, 0, 2) || within(i, 60, 63) ? 3764 : 0 });
    const { series } = referee(c, HOUSEHOLD, TARGETS, d);
    const count = series.poolStart!.filter(Boolean).length;
    assertEquals(count, state.kind === 'running' || state.kind === 'steady' ? 1 : 2);
    const batteryWear = series.wearSek!.reduce((sum, wear) => sum + wear, 0);
    assertAlmostEquals(series.bill!.wear_sek, batteryWear + 3 * count, 1e-2);
    assertAlmostEquals(series.bill!.grid_sek, series.costSek.reduce((sum, cost) => sum + cost, 0), 1e-2);
  }
});
