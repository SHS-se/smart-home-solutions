import { assertEquals, assertAlmostEquals } from '@std/assert';
import { HOUSEHOLD } from './household.ts';
import { referee, simulate, type Decisions } from './referee.ts';
import { plan, quarters, TARGETS, world } from './world.fixture.ts';

const first = (w: number) => (i: number) => i === 0 ? w : 0;
const permitted = { ...HOUSEHOLD, site: { ...HOUSEHOLD.site, ev_battery_supply_allowed: true } };

Deno.test('EV battery permission applies to fixed supply and export with proportional PV attribution', () => {
  assertEquals(HOUSEHOLD.site.ev_battery_supply_allowed, false);
  for (const solarW of [0, 2725, 5450, 7000]) {
    const c = world({ load: () => 2000, solar: first(solarW) });
    const allowedW = solarW >= 5450 ? 8000 : 2000 * (1 - solarW / 5450);
    for (const dischargeW of [1000, 5000, 8000]) {
      const d = plan({ ev: first(3450), discharge: first(dischargeW) });
      // Explicit fixed-power commands include export; they cannot bypass permission.
      d.battery_follow = quarters(i => ({ follows: false, charge_limit_w: 0,
        discharge_limit_w: dischargeW, planned: [0, i === 0 ? dischargeW : 0] }));
      const outcome = simulate(c, HOUSEHOLD, d);
      assertAlmostEquals(outcome.dischargeW[0], Math.min(dischargeW, allowedW), 1e-6);
      assertEquals(outcome.violations.map(v => v.kind), dischargeW > allowedW ? ['battery_supply'] : []);
      const allowed = simulate(c, permitted, d);
      assertEquals(allowed.violations, []);
      assertAlmostEquals(allowed.dischargeW[0], dischargeW, 1e-6);
    }
  }
});

Deno.test('hold and charging operations remain feasible while the car charges', () => {
  for (const solarW of [0, 7000]) for (const chargeW of [0, 1000]) {
    const c = world({ load: () => 2000, solar: first(solarW) });
    const d = plan({ ev: first(3450), charge: first(chargeW) });
    const result = simulate(c, HOUSEHOLD, d);
    assertEquals(result.violations, []);
    assertEquals(result.chargeW[0], chargeW);
    assertEquals(result.dischargeW[0], 0);
  }
});

Deno.test('measured demand-following supply obeys EV permission without treating forecast error as a violation', () => {
  for (const solarW of [0, 2225]) {
    const c = world({ load: () => 2000, solar: () => 0 });
    c.recorded.actual = { base_load_w: quarters(() => 1000), solar_w: quarters(first(solarW)) };
    const d: Decisions = plan({ ev: first(3450), discharge: first(2000) });
    d.battery_follow = quarters(i => ({ follows: true, charge_limit_w: 8800,
      discharge_limit_w: i === 0 ? 9600 : 0, planned: [0, i === 0 ? 2000 : 0] }));
    const limited = referee(c, HOUSEHOLD, TARGETS, d);
    assertEquals(limited.violations, []);
    assertAlmostEquals(limited.series.batteryDischargeW[0], 1000 * (1 - solarW / 4450), 0.1);
    const allowed = referee(c, permitted, TARGETS, d);
    assertEquals(allowed.violations, []);
    assertAlmostEquals(allowed.series.batteryDischargeW[0], 4450 - solarW, 0.1);
  }
});

Deno.test('forbidden EV supply fails a plan even when the requested battery power fits its physical limits', () => {
  const c = world({ load: () => 2000 });
  const result = referee(c, HOUSEHOLD, TARGETS, plan({ ev: first(3450), discharge: first(3000) }));
  assertEquals(result.violations, [{ quarter: 0, kind: 'battery_supply', clipped_w: 1000 }]);
});
