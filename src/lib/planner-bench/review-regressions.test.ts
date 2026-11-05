import { assert, assertAlmostEquals, assertEquals, assertThrows } from '@std/assert';
import { HOUSEHOLD } from './household.ts';
import { findOpportunities, ruleState } from './opportunities.ts';
import { assertDecisions, simulate, type Decisions } from './referee.ts';
import { criteriaErrors, resolveRules } from './score.ts';
import { poolExposure, DEFAULT_SERVICE_GUARD } from './service.ts';
import { TARGETS, plan, within, world } from './world.fixture.ts';

Deno.test('unknown rules fail explicitly and service deductions cannot be saved at zero points', () => {
  assertEquals(criteriaErrors({ dear_buy: { points: -1 } }), ['Unknown rule "dear_buy".']);
  assertEquals(resolveRules({ pool_shortfall: { points: -2 } }).find(r => r.key === 'pool_shortfall')!.points, -2);
  assertEquals(criteriaErrors({ pool_shortfall: { points: 0 } }), ['pool_shortfall: the cost coefficient must be finite and negative.']);
});

Deno.test('missing decision streams fail explicitly before any simulation', () => {
  const d = plan();
  delete (d as Partial<Decisions>).ev_w;
  assertThrows(() => assertDecisions(d), Error, 'ev_w needs 288 finite quarters');
  assertThrows(() => assertDecisions({} as Decisions), Error, 'pool_w needs 288 finite quarters');
});

Deno.test('a battery outside its bound may move toward it without returning inside in one quarter', () => {
  for (const [soc, charge, discharge, direction] of [[0.02, 1000, 500, 1], [1.01, 500, 1000, -1]]) {
    const c = world({ start: { battery_soc: soc } });
    const d = plan({ charge: i => i === 0 ? charge : 0, discharge: i => i === 0 ? discharge : 0 });
    const sim = simulate(c, HOUSEHOLD, d);
    assertEquals(sim.violations, []);
    assert((sim.batteryKwh[0] - sim.start.batteryKwh) * direction > 0);
  }
});

Deno.test('continuous exposure detects a larger deficit without threshold counts', () => {
  const comfort = { pool_target_c: 30, pool_start_c: 30 } as Parameters<typeof poolExposure>[0];
  const before = poolExposure(comfort, [28, 28.9, 28.9], DEFAULT_SERVICE_GUARD);
  const after = poolExposure(comfort, [28, 28.1, 28.1], DEFAULT_SERVICE_GUARD);
  assert(after > before);
});

Deno.test('flat prices do not make pool timing inapplicable, and applicability is identical for every planner', () => {
  const c = world({ air: i => i < 96 ? 25 : 5, buy: () => 1, sell: () => 0.4, published: 288 });
  const idle = findOpportunities(c, HOUSEHOLD, TARGETS, plan(), 'told/nominal').audit;
  const late = findOpportunities(c, HOUSEHOLD, TARGETS, plan({ pool: i => within(i, 200, 204) ? 3764 : 0 }), 'told/nominal').audit;
  assertEquals(late.applicability, idle.applicability);
  assertEquals(idle.applicability.pool_cheaper_heating.applicable, true);
  // The heat pump's COP is its own, not the weather's, so at one price an hour of heat costs the same in
  // warm air as in cold: nothing is found for moving it between them.
  assertEquals(late.rules.pool_cheaper_heating.findings, 0);
});

Deno.test('one solar-storage saving explains dear import too without counting the money twice', () => {
  const c = world({ solar: i => within(i, 40, 64) ? 5000 : 0, buy: i => within(i, 68, 88) ? 2 : 1, load: () => 3000 });
  const { audit } = findOpportunities(c, HOUSEHOLD, TARGETS, plan(), 'told/nominal');
  assert(audit.findings.some(f => f.tags.includes('export_before_import') && f.tags.includes('import_avoidable_by_storage')));
  assertEquals(ruleState(audit, 'import_avoidable_by_storage'), 'loss_found');
  assertAlmostEquals(Object.values(audit.rules).reduce((sum, r) => sum + r.knownSek + r.hindsightSek, 0), audit.avoidableSek, 0.002);
});

Deno.test('removing a cycle can save net money even when the grid bill rises slightly', () => {
  const c = world({ load: () => 3000, buy: i => within(i, 40, 44) ? 1.13 : 1 });
  const d = plan({ charge: i => within(i, 12, 16) ? 3000 : 0, discharge: i => within(i, 40, 44) ? 2707.5 : 0 });
  const { audit, improved } = findOpportunities(c, HOUSEHOLD, TARGETS, d, 'told/nominal');
  assert(audit.knownSek > 0.05);
  assert(audit.improvedCostSek > audit.originalCostSek);
  assertAlmostEquals(audit.knownSek, 3 * (0.9025 * 0.05 - (0.9025 * 1.13 - 1)), 0.001);
  const before = simulate(c, HOUSEHOLD, d), after = simulate(c, HOUSEHOLD, improved);
  const throughput = (values: Float64Array) => values.reduce((sum, w) => sum + w * 0.25 / 1000, 0);
  assertAlmostEquals(audit.wearSek, (throughput(after.dischargeW) - throughput(before.dischargeW)) * HOUSEHOLD.site.battery_degradation_sek_per_kwh, 0.0001);
  assertAlmostEquals(before.cost - after.cost - audit.wearSek, audit.avoidableSek, 0.0001);
});
