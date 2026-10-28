import { assert, assertAlmostEquals, assertEquals } from '@std/assert';
import vectors from '../../../contracts/battery-physics-v1.json' with { type: 'json' };
import { HOUSEHOLD } from './household.ts';
import { findOpportunities } from './opportunities.ts';
import { referee, simulate } from './referee.ts';
import { plan, TARGETS, world } from './world.fixture.ts';

Deno.test('bench state and billed grid energy use refined terminal and installation physics', () => {
  const h = { ...HOUSEHOLD, battery: vectors.battery };
  for (const row of vectors.projection) {
    const c = world({ load: () => row.house_w, solar: () => row.pv_w,
      start: { battery_soc: row.stored_kwh / h.battery.capacity_kwh } });
    const d = plan({ charge: i => i === 0 ? row.charge_w : 0,
      discharge: i => i === 0 ? row.discharge_w : 0 });
    const sim = simulate(c, h, d);
    assertAlmostEquals(sim.chargeW[0], row.expected.charge_w, 1e-9, row.name);
    assertAlmostEquals(sim.dischargeW[0], row.expected.discharge_w, 1e-9, row.name);
    assertAlmostEquals(sim.batteryKwh[0], row.expected.battery_kwh, 1e-9, row.name);
    assertAlmostEquals(sim.netW[0], row.house_w - row.pv_w + row.expected.charge_w -
      row.expected.discharge_w + row.expected.battery_idle_w, 1e-9, row.name);
  }
});

Deno.test('idle installation demand appears once in the bench bill and chart load', () => {
  const h = { ...HOUSEHOLD, battery: vectors.battery };
  const c = world({ load: () => 500, buy: () => 2, start: { battery_soc: .5 } });
  const result = referee(c, h, TARGETS, plan());
  assertEquals(result.violations, []);
  assertEquals(result.series.batteryIdleW?.[0], 60);
  assertEquals(result.series.loadW[0], 560);
  assertEquals(result.series.gridImportW[0], 560);
  assertAlmostEquals(result.cost_sek, .56 * 72 * 2, 1e-9);
});

Deno.test('battery opportunity transfers preserve stored energy across affine conversion losses', () => {
  const h = { ...HOUSEHOLD, battery: vectors.battery };
  const c = world({ load: () => 2000, buy: i => i % 96 < 24 ? .2 : 3,
    sell: () => .1, published: 288, start: { battery_soc: .5 } });
  const d = plan();
  const original = simulate(c, h, d);
  const result = findOpportunities(c, h, TARGETS, d, 'told/nominal');
  const improved = simulate(c, h, result.improved);
  assert(result.audit.avoidableSek > 0);
  assertAlmostEquals(improved.batteryKwh.at(-1)!, original.batteryKwh.at(-1)!, 1e-6);
  assert(improved.cost < original.cost);
  assertEquals(improved.violations, []);
});
