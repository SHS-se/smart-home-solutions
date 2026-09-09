import { assertEquals } from 'jsr:@std/assert@1';
import { haRuntimeStatus, HA_RUNTIME_LEASE_MS, type HaRuntime } from './ha-runtime.ts';
const NOW = Date.parse('2026-09-09T10:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const runtime: HaRuntime = { observed_at: iso(NOW), plan_id: 'plan', state: 'ready',
  reason: 'A validated plan is available', binding_until: iso(NOW + 600_000),
  valid_until: iso(NOW + 900_000), recovering: false, retry_at: null, last_error: null };
const row = { plan_id: 'plan', ha_runtime: runtime, ha_runtime_received_at: iso(NOW) };
Deno.test('historical acceptance cannot prove current readiness', () => {
  assertEquals(haRuntimeStatus({ ...row, ha_runtime: null }, NOW).state, 'unconfirmed');
  assertEquals(haRuntimeStatus(row, NOW + HA_RUNTIME_LEASE_MS).ready, false);
  assertEquals(haRuntimeStatus({ ...row, ha_runtime_received_at: 'invalid' }, NOW).ready, false);
});
Deno.test('a matching fresh report proves availability, not device execution', () => {
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
Deno.test('expiry and advisory boundary apply even between heartbeats', () => {
  assertEquals(haRuntimeStatus({ ...row, ha_runtime: { ...runtime, valid_until: iso(NOW) } }, NOW).state, 'expired');
  assertEquals(haRuntimeStatus({ ...row, ha_runtime: { ...runtime, binding_until: iso(NOW) } }, NOW).state, 'advisory_only');
});
Deno.test('a delayed report and clock errors cannot renew readiness', () => {
  assertEquals(haRuntimeStatus({ ...row, ha_runtime: { ...runtime, observed_at: iso(NOW - HA_RUNTIME_LEASE_MS) } }, NOW).ready, false);
  assertEquals(haRuntimeStatus({ ...row, ha_runtime: { ...runtime, observed_at: iso(NOW + 60_000) } }, NOW).ready, false);
});
