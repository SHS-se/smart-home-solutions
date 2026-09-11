import { assertEquals } from 'jsr:@std/assert@1';
import { readPlanRefresh } from './plan-refresh.ts';
import { haRuntimeStatus, type HaRuntime } from './ha-runtime.ts';

const now = Date.parse('2026-09-11T13:15:00Z');
const runtime: HaRuntime = {
  observed_at: new Date(now).toISOString(), plan_id: 'latest-plan', state: 'ready',
  reason: 'A validated plan is available', binding_until: new Date(now + 3600000).toISOString(),
  valid_until: new Date(now + 3600000).toISOString(), recovering: false, retry_at: null, last_error: null,
};
const metadata = { plan_id: 'latest-plan', ha_runtime: runtime, ha_runtime_received_at: new Date(now).toISOString() };

Deno.test('the portal reads real producer plans including the battery schema upgrade', async () => {
  for (const name of ['schema-6-dispatched-ev-plan', 'schema-8-battery-plan']) {
    const fixture = JSON.parse(await Deno.readTextFile(new URL(`../../../contracts/ha-api/fixtures/${name}.json`, import.meta.url)));
    const result = readPlanRefresh({ ...metadata, plan: fixture.plan });
    assertEquals(result.unsupported, false);
    assertEquals(result.current?.plan, fixture.plan);
  }
});

Deno.test('an unreadable replacement clears the old chart but preserves fresh HA readiness', () => {
  const result = readPlanRefresh({ ...metadata, plan: { schema_version: 99 } });
  assertEquals(result.current, null);
  assertEquals(result.unsupported, true);
  assertEquals(haRuntimeStatus(result.runtime!, now).state, 'ready');
  assertEquals(result.runtime?.plan_id, 'latest-plan');
});

Deno.test('a malformed payload cannot masquerade as a readable schema-8 plan', () => {
  assertEquals(readPlanRefresh({ ...metadata, plan: {schema_version: 8} }).unsupported, true);
});

Deno.test('a deleted plan clears both the chart and its readiness report', () => {
  assertEquals(readPlanRefresh(null), { current: null, runtime: null, unsupported: false });
});
