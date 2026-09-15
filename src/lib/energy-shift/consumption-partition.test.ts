import { assertEquals, assertThrows } from 'jsr:@std/assert@1';
import { consumptionPlanSlots } from './consumption-partition.ts';
import type { OptimisationPlan, PlannedSlot } from './contracts.ts';
const fixture = JSON.parse(Deno.readTextFileSync('contracts/ha-api/fixtures/schema-6-dispatched-ev-plan.json'));
// The generated consumer fixture provides a complete real plan slot.
const plan = fixture.plan ?? fixture;
const slot: PlannedSlot = { ...plan.plans.priority.slots[0], device_loads_w: { ev: 800 }, load_w: 3800 };
const parent: Pick<OptimisationPlan, 'plans' | 'operating_scope'> = {
  plans: { ...plan.plans, priority: { ...plan.plans.priority, slots: [slot, { ...slot, start: new Date(Date.parse(slot.start) + 900000).toISOString() }] } },
  operating_scope: {
    modes: { ev: 'controlling', pool: 'control_verification' },
    device_owners: { ev: 'ev', pool: 'pool' },
    external_demands: { pool: { forecast_w_by_slot: [1500, 1600], recent_observation: {
      start: '2026-09-15T12:00:00Z', end: '2026-09-15T12:15:00Z', average_w: 2000,
      source: 'completed_meter_quarter',
    } } },
  },
};
Deno.test('executable chart retains Verification consumption without changing commands or house total', () => {
  const rows = consumptionPlanSlots(parent, parent.plans.priority.slots, true);
  assertEquals(rows.map(row => row.device_loads_w), [{ ev: 800, pool: 2000 }, { ev: 800, pool: 1600 }]);
  assertEquals(rows[0].load_w, 3800);
  assertEquals(slot.device_loads_w, { ev: 800 });
  assertEquals(consumptionPlanSlots(parent, parent.plans.priority.slots, false), parent.plans.priority.slots);
});
Deno.test('ambiguous chart partition is rejected instead of subtracting a meter twice', () => {
  assertThrows(() => consumptionPlanSlots(parent, [{ ...slot, device_loads_w: { pool: 2000 } }], true));
});
