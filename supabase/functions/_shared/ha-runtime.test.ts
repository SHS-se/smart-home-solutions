import { assertEquals } from 'jsr:@std/assert@1';
import { validRuntime as validate } from './ha-runtime.ts';
const validRuntime = (value: unknown) => validate(value, Date.parse('2026-09-09T10:00:00Z'));
const runtime = { observed_at: '2026-09-09T10:00:00Z', plan_id: null, state: 'unavailable',
  reason: 'Waiting for a plan', binding_until: null, valid_until: null, recovering: true,
  retry_at: null, last_error: null };
Deno.test('runtime accepts missing plans and all operational states', () => {
  for (const state of ['unavailable', 'invalid', 'incomplete', 'infeasible', 'disabled', 'not_configured', 'advisory_only', 'expired'])
    assertEquals(validRuntime({ ...runtime, state }), true);
});
Deno.test('runtime refuses malformed reports and contradictory ready states', () => {
  for (const value of [null, [], {}, { ...runtime, state: 'accepted' },
    { ...runtime, state: 'ready' }, { ...runtime, observed_at: 'yesterday' },
    { ...runtime, reason: 'x'.repeat(1001) }, { ...runtime, plan_id: 'bad' },
    { ...runtime, observed_at: '2026-09-09T11:00:00Z' },
    { ...runtime, observed_at: '2026-09-09T09:55:00Z' },
    { ...runtime, recovering: 'yes' }, { ...runtime, extra: true }])
    assertEquals(validRuntime(value), false);
});
Deno.test('ready reports carry identity and both expiry boundaries', () => {
  assertEquals(validRuntime({ ...runtime, state: 'ready',
    plan_id: '2f1c0c74-9d31-4f0e-9a45-9c6f2f5f0a11',
    binding_until: '2026-09-09T10:15:00Z', valid_until: '2026-09-09T10:30:00Z' }), true);
});

Deno.test('the published status contract accepts runtime reports independently of replan failure', async () => {
  const spec = JSON.parse(await Deno.readTextFile(new URL('../../../contracts/ha-api/openapi.json', import.meta.url)));
  const variants = spec.paths['/integration-status'].post.requestBody.content['application/json'].schema.oneOf;
  assertEquals(variants.map((v: { $ref: string }) => v.$ref), [
    '#/components/schemas/ReplanFailureRequest', '#/components/schemas/RuntimeStatusRequest',
    '#/components/schemas/ManualReplanRequest',
  ]);
  assertEquals(spec.components.schemas.RuntimeStatusRequest.properties.runtime.required.sort(), Object.keys(runtime).sort());
});
