import { assertEquals } from 'jsr:@std/assert@1';
import { editedPeriodEnd, fixedPlanState, type FixedPlanStatus } from './fixed-plan.ts';
import type { WorkbenchModel } from './plan-workbench.ts';
const model = { columns: [{ startMs: 0, slots: [0,1,2,3] }, { startMs: 3600000, slots: [4,5,6,7] }], planned: { ev: [0, 0] } } as unknown as WorkbenchModel;
Deno.test('last edited period includes the full hour and reverts shorten it', () => {
  assertEquals(editedPeriodEnd(model, { ev: [1, 1] }, []), 7200000);
  assertEquals(editedPeriodEnd(model, { ev: [1, 0] }, []), 3600000);
  assertEquals(editedPeriodEnd(model, { ev: [0, 0] }, []), null);
});
const status: FixedPlanStatus = { fixed_plan: { id: 'fixed', starts_at: '2026-09-09T10:15:00Z', ends_at: '2026-09-09T11:00:00Z' }, generated_fixed_plan_id: 'fixed', revision: 2, generated_revision: 2, ha_ack_status: 'accepted', ha_ack_error: null, valid_until: '2026-09-09T11:30:00Z', error: null, pending: false };
Deno.test('activation and cancellation wait for matching generation and HA acceptance', () => {
  const now = Date.parse('2026-09-09T10:30:00Z');
  assertEquals(fixedPlanState(status, now), 'active');
  assertEquals(fixedPlanState(status, now - 30 * 60_000), 'scheduled');
  assertEquals(fixedPlanState({ ...status, generated_revision: 1 }, now), 'waiting');
  assertEquals(fixedPlanState({ ...status, ha_ack_status: 'pending' }, now), 'waiting');
  assertEquals(fixedPlanState({ ...status, ha_ack_status: 'rejected' }, now), 'rejected');
  assertEquals(fixedPlanState({ ...status, fixed_plan: null, revision: 3 }, now), 'waiting');
  assertEquals(fixedPlanState({ ...status, fixed_plan: null, generated_fixed_plan_id: null }, now), 'automatic');
  assertEquals(fixedPlanState(status, Date.parse('2026-09-09T12:00:00Z')), 'expired');
});
