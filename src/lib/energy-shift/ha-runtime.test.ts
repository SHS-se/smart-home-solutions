import { assertEquals } from 'jsr:@std/assert@1';
import { haRuntimeStatus, planDeliveryStatus, type HaRuntime } from './ha-runtime.ts';
const NOW = Date.parse('2026-09-09T10:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const runtime: HaRuntime = { observed_at: iso(NOW), plan_id: 'plan', state: 'ready',
  reason: 'A validated plan is available', binding_until: iso(NOW + 600_000),
  valid_until: iso(NOW + 900_000), recovering: false, retry_at: null, last_error: null };
const row = { plan_id: 'plan', ha_runtime: runtime, ha_runtime_received_at: iso(NOW) };
Deno.test('missing reports remain unknown while a cached reported schedule stays available', () => {
  assertEquals(haRuntimeStatus({ ...row, ha_runtime: null }, NOW).state, 'unconfirmed');
  assertEquals(haRuntimeStatus(row, NOW + 600_000).ready, true);
  assertEquals(haRuntimeStatus({ ...row, ha_runtime_received_at: 'invalid' }, NOW).ready, false);
});
Deno.test('a matching report describes last known availability', () => {
  assertEquals(haRuntimeStatus(row, NOW).state, 'ready');
  assertEquals(haRuntimeStatus(row, NOW).ready, true);
});
Deno.test('lost memory and invalid plans supersede a historical acknowledgement', () => {
  for (const state of ['unavailable', 'invalid', 'disabled', 'not_configured', 'incomplete', 'infeasible']) {
    const status = haRuntimeStatus({ ...row, ha_runtime: { ...runtime, plan_id: null, state } }, NOW);
    assertEquals(status.state, state);
    assertEquals(status.ready, false);
  }
});
Deno.test('a late report about an older plan cannot confirm a new plan', () => {
  assertEquals(haRuntimeStatus({ ...row, plan_id: 'new-plan' }, NOW).state, 'different_plan');
  assertEquals(haRuntimeStatus({ ...row, plan_id: null }, NOW).ready, false);
});
Deno.test('expiry ends execution but the published-price boundary does not', () => {
  assertEquals(haRuntimeStatus({ ...row, ha_runtime: { ...runtime, valid_until: iso(NOW) } }, NOW).state, 'expired');
  assertEquals(haRuntimeStatus({ ...row, ha_runtime: { ...runtime, binding_until: iso(NOW) } }, NOW).state, 'ready');
});
Deno.test('old observations remain visible but future clock errors are rejected', () => {
  assertEquals(haRuntimeStatus({ ...row, ha_runtime: { ...runtime, observed_at: iso(NOW - 3_600_000) } }, NOW).ready, true);
  assertEquals(haRuntimeStatus({ ...row, ha_runtime: { ...runtime, observed_at: iso(NOW + 60_000) } }, NOW).ready, false);
});

const rejected = { plan_id: 'new-plan', ha_ack_status: 'rejected' as const,
  ha_ack_error: { message: 'Not issued recently', details: ['Not issued recently', 42] },
  ha_integration_version: 'beta.86', ha_acknowledged_at: iso(NOW) };
Deno.test('rejected delivery and an executable retained schedule remain separate', () => {
  const status = planDeliveryStatus({ displayedPlanId: 'new-plan', acknowledgement: rejected, reported: row, now: NOW });
  assertEquals(status.runtimeStatus.ready, false);
  assertEquals(status.rejection.messages, ['Not issued recently']);
  assertEquals(status.rejection.integrationVersion, 'beta.86');
  assertEquals(status.retained.runtime.plan_id, 'plan');
  assertEquals(status.retained.ready, true);
  assertEquals(planDeliveryStatus({ displayedPlanId: 'new-plan', acknowledgement: rejected,
    reported: row, now: NOW + 900_000 }).retained.ready, false);
});
Deno.test('a newer cloud identity never confirms an older displayed chart or attributes its rejection', () => {
  const reported = { ...row, plan_id: 'new-plan', ha_runtime: { ...runtime, plan_id: 'new-plan' } };
  const status = planDeliveryStatus({ displayedPlanId: 'plan', acknowledgement: rejected, reported, now: NOW });
  assertEquals(status.runtimeStatus.state, 'different_plan');
  assertEquals(status.runtimeStatus.ready, false);
  assertEquals(status.rejection, null);
});
Deno.test('pending and accepted acknowledgements invent no rejection, and invalid reports confirm no retained schedule', () => {
  for (const ha_ack_status of ['pending', 'accepted'] as const) {
    assertEquals(planDeliveryStatus({ displayedPlanId: 'new-plan', acknowledgement: { ...rejected, ha_ack_status },
      reported: row, now: NOW }).rejection, null);
  }
  assertEquals(planDeliveryStatus({ displayedPlanId: 'new-plan', acknowledgement: rejected,
    reported: { ...row, ha_runtime_received_at: 'invalid' }, now: NOW }).retained, null);
});
