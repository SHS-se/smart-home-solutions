// Entirely synthetic equations and equipment: no household replay data.
import { assert, assertAlmostEquals, assertEquals } from '@std/assert';
import { PGlite } from 'npm:@electric-sql/pglite@0.3.14';
import { poolSquaredExposure } from '../supabase/functions/_shared/planner-wasm/pool-comfort.ts';
import { createWasmPlanner } from '../supabase/functions/_shared/planner-wasm/core.ts';
import { problemEndCredit } from '../supabase/functions/_shared/planner-wasm/end-credit.ts';
const plannerBytes = await Deno.readFile('supabase/functions/_shared/planner-wasm/solver.wasm');
import { problem } from './planner-wasm.fixture.ts';
import recipe from '../planner-core/recipe.json' with { type: 'json' };

Deno.test('pool exposure integrates partial durations and target crossings without rounding cliffs', () => {
  assertEquals(poolSquaredExposure(31, 30, 30, 2), 2);
  assertAlmostEquals(poolSquaredExposure(31, 30, 32, 1), 1/6, 1e-12);
  assertAlmostEquals(poolSquaredExposure(31, 32, 30, 1), 1/6, 1e-12);
  assertEquals(poolSquaredExposure(31, 32, 33, 1), 0);
  const whole = poolSquaredExposure(31, 29, 32, 1);
  const pieces = poolSquaredExposure(31, 29, 30.5, .5) + poolSquaredExposure(31, 30.5, 32, .5);
  assertAlmostEquals(whole, pieces, 1e-12);
});

Deno.test('synthetic pool builds reserve before an expensive multi-day period within its equipment stop', () => {
  const p = problem();
  p.work_grant = recipe.work_grant;
  p.battery = null; p.initial.battery_kwh = null;
  p.car = null; p.charger = null; p.car_policy = null; p.initial.ev_kwh = null;
  p.pool_store = { capacity_kwh_per_c: 60, response_time_constant_h: 0, loss: { kind: 'measured', points: [{ at_c: 31, c_per_h: -.04 }] } };
  p.heater = { compressor_w: 3000, auxiliary_w: 700, heat_w: 15000, response: { kind: 'steady' } };
  p.initial.pool_c = 31; p.initial.heater_state = { kind: 'off_unobserved' };
  p.targets.pool_c = 31; p.pool_stop_c = 34;
  p.slots = Array.from({ length: 288 }, (_, i) => ({ ...p.slots[0], start_seconds: i*900, import_price: i < 96 ? 1 : 4, export_price: 0, published: true, solar_w: 0, ev_available: false }));
  p.rules = [{ key: 'pool_shortfall', threshold: 0, points: -2, required: false }];
  p.end_credit = problemEndCredit(p);
  const result = createWasmPlanner(plannerBytes).solve(p).outcome;
  assert(result.kind === 'selected', result.kind === 'failed' ? result.issue : '');
  const temperatures = result.selection.quarters.map(q => q.pool_c!);
  assert(Math.max(...temperatures.slice(0,96)) > 31.5, 'use cheap heat to create a useful above-target reserve');
  assert(Math.max(...temperatures) <= 34 + 1e-8);
  assert(result.selection.commands.slice(96,160).some(q => !q.pool_on), 'coast into the high-price period');
});

Deno.test('pool policy migration removes retired overrides and preserves unrelated preferences', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE energy_planner_rule_policy(id boolean PRIMARY KEY, criteria jsonb, updated_at timestamptz);
      CREATE TABLE bench_rules(id boolean PRIMARY KEY, criteria jsonb);
      INSERT INTO energy_planner_rule_policy VALUES(true,'{"pool_low":{"points":-2},"pool_cold":{"enabled":false},"pool_hot":{"threshold":3},"car_floor":{"points":-1},"pool_shortfall":{"points":-1.5}}',now());
      INSERT INTO bench_rules SELECT id,criteria FROM energy_planner_rule_policy;`);
    await db.exec(await Deno.readTextFile('supabase/migrations/20261104170000_pool_continuous_comfort_policy.sql'));
    for (const table of ['energy_planner_rule_policy','bench_rules']) {
      const { rows } = await db.query<{criteria: unknown}>(`SELECT criteria FROM ${table}`);
      assertEquals(rows[0].criteria, { car_floor: { points: -1 }, pool_shortfall: { points: -1.5 } });
    }
  } finally { await db.close(); }
});
