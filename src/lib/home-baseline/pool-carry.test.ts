import { assertThrows, assertAlmostEquals, assertEquals, assertRejects } from '@std/assert';
import { baselineFixture } from './fixture.ts';
import { prepareHomeBaseline } from './model.ts';
import { compareModels } from './model-comparison.ts';
import { createWasmPlanner } from '../../../supabase/functions/_shared/planner-wasm/core.ts';
import { createCaptureSource } from './source.ts';
import { monthPeriod } from './period.ts';
import { seedPool, quarterPool, withPoolState } from './pool-carry.ts';

const engine = createWasmPlanner(new Uint8Array(Deno.readFileSync(new URL('../../../supabase/functions/_shared/planner-wasm/solver.wasm', import.meta.url))));

Deno.test('independent pool temperatures and native heater memory carry from October into November, and frames slice the same models', async () => {
  const fixture = baselineFixture({ start: '2025-09-30T22:00:00.000Z', end: '2025-11-30T23:00:00.000Z' });
  fixture.snapshot.roi_pool_seed = { month: '2025-10', temperatureC: 28.9, hash: 'a'.repeat(64) };
  fixture.snapshot.device_physics!.pool!.store = { response_time_constant_h: 0, capacity_kwh_per_c: 1, loss: { kind: 'linear', kw_per_c: 0, surroundings_c: 20 } };
  fixture.snapshot.device_physics!.battery!.capacity_kwh = .1;
  fixture.snapshot.comfort!.pool!.target_c = 29.5;
  const anchor = { snapshot: fixture.snapshot, earliestStart: fixture.start, latestEnd: fixture.end };
  const generated: string[] = [];
  const source = createCaptureSource({ homeId: 'home', customerId: 'customer' }, { resolveAnchor: () => Promise.resolve(anchor),
    generate: (_, pinned, period, signal, pool) => {
      signal.throwIfAborted(); generated.push(period.start);
      const rows = baselineFixture(period); rows.snapshot = pinned.snapshot;
      const input = prepareHomeBaseline(rows); input.pool = pool;
      return Promise.resolve({ input, ...compareModels(input, engine), engineHash: 'test' });
    } });
  try {
    const november = await source.capture(monthPeriod(anchor, '2025-11')!, new AbortController().signal);
    const october = source.cached(monthPeriod(anchor, '2025-10')!)!;
    assertEquals(generated, ['2025-09-30T22:00:00.000Z', '2025-10-31T23:00:00.000Z']);
    assertEquals(october.input.pool, seedPool(fixture.snapshot.roi_pool_seed));
    assertEquals(november.input.pool!.initial.baseline, october.result.poolStates.at(-1));
    assertEquals(november.input.pool!.initial.scheduler, october.scheduler.poolStates.at(-1));
    // One 29.5 °C target, two operators: the thermostat heats back up to it, while the scheduler
    // accepts a pool this close to it. Each month starts from its own model's end state.
    assertAlmostEquals(november.input.pool!.initial.baseline.poolC, 29.5);
    assertAlmostEquals(november.input.pool!.initial.scheduler.poolC, 28.9);
    assertEquals(november.input.pool!.initial.scheduler.heaterState.kind, 'off_unobserved');
    const frame = await source.capture({ view: 'frame', start: '2025-11-12T23:00:00.000Z', end: '2025-11-15T23:00:00.000Z' }, new AbortController().signal);
    const from = (Date.parse(frame.input.start) - Date.parse(november.input.start)) / 900_000;
    assertEquals(frame.result.series.poolC, november.result.series.poolC.slice(from, from + 288));
    assertEquals(frame.scheduler.series.poolC, november.scheduler.series.poolC.slice(from, from + 288));
    assertEquals(frame.result.commands, november.result.commands.slice(from, from + 288));
    assertEquals(frame.input.pool!.initial.baseline, november.result.poolStates[from - 1]);
    assertEquals(generated.length, 2);
  } finally { source.dispose(); }
});

Deno.test('a requested October seed cannot silently move to November when prerequisite history is missing', async () => {
  const fixture = baselineFixture(); fixture.snapshot.roi_pool_seed = { month: '2025-10', temperatureC: 30, hash: 'a'.repeat(64) };
  const anchor = { snapshot: fixture.snapshot, earliestStart: '2025-10-31T23:00:00.000Z', latestEnd: fixture.end };
  const source = createCaptureSource({ homeId: 'home', customerId: 'customer' }, { resolveAnchor: () => Promise.resolve(anchor), generate: () => { throw new Error('Unexpected model'); } });
  try { await assertRejects(() => source.capture(monthPeriod(anchor, '2025-11')!, new AbortController().signal), Error, 'needs history for 2025-10'); }
  finally { source.dispose(); }
});

Deno.test('pool continuation preserves pending response independently for each operator', () => {
  const input = prepareHomeBaseline(baselineFixture());
  const state = { poolC: 29.2, pendingHeatKwh: 6.4, sourceDepletionKwh: 8.2, heaterState: { kind: 'off' as const, seconds: 900 } };
  input.problem.heater!.source = {recovery_rate_per_h: .1, heat_loss_per_kwh: .02};
  const problem = withPoolState(input.problem, state);
  assertEquals(problem.initial.pool_source_depletion_kwh, 8.2);
  assertEquals(problem.initial.pool_pending_heat_kwh, 6.4);
  assertEquals(problem.initial.heater_state, state.heaterState);
  const quarter = { pool_c: state.poolC, pool_pending_heat_kwh: state.pendingHeatKwh, pool_source_depletion_kwh: state.sourceDepletionKwh, heater_state: state.heaterState } as Parameters<typeof quarterPool>[0];
  assertEquals(quarterPool(quarter), state);
  assertEquals(seedPool({ month: '2026-10', temperatureC: 29, hash: 'a'.repeat(64) }).initial.baseline.pendingHeatKwh, 0);
});

Deno.test('source continuation refuses an unmeasured fresh source and accepts a measured seed', () => {
  const input = prepareHomeBaseline(baselineFixture());
  input.problem.heater!.source = {recovery_rate_per_h:.1,heat_loss_per_kwh:.02};
  const seed = {month:'2026-10',temperatureC:29,hash:'a'.repeat(64)};
  const unobserved = seedPool(seed).initial.baseline;
  assertEquals(unobserved.sourceDepletionKwh,null);
  assertThrows(()=>withPoolState(input.problem,unobserved),Error,'measured initial source');
  const response = {at:'2026-10-01T00:00:00Z',pending_heat_kwh:2,source_depletion_kwh:9};
  const measured = withPoolState(input.problem,seedPool(seed,response).initial.baseline);
  assertEquals(measured.initial.pool_source_depletion_kwh,9);
  assertEquals(measured.initial.pool_pending_heat_kwh,2);
});
