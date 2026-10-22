import { assertEquals, assertMatch } from '@std/assert';
import { captureCapacityEvidence } from '../supabase/functions/_shared/entsoe-capacity-evidence.ts';
const from = '2026-01-01T00:00:00Z', to = '2027-01-01T00:00:00Z';
Deno.test('capacity acquisition retains redacted HTTP error evidence and conceals credential-bearing transport exceptions', async () => {
  const token = 'sensitive+token';
  const error = await captureCapacityEvidence('production_outages', from, to, token, input => {
    const query = new URL(String(input));
    assertEquals(query.searchParams.get('securityToken'), token);
    return Promise.resolve(new Response(`${token} ${encodeURIComponent(token)}`, { status: 503 }));
  });
  assertEquals(error.status, 'provider_error');
  assertEquals(atob(error.raw_base64!), '[REDACTED] [REDACTED]');
  assertMatch(error.body_sha256!, /^[a-f0-9]{64}$/);
  const failed = await captureCapacityEvidence('installed_generation_units', from, to, token, input => { throw Error(String(input)); });
  assertEquals(failed, { status: 'transport_error', error_code: 'entsoe_capacity_transport_failed',
    http_status: null, body_sha256: null, raw_base64: null });
});
Deno.test('capacity parser errors preserve original bounded evidence instead of manufacturing availability', async () => {
  const result = await captureCapacityEvidence('generation_outages', from, to, 'credential', () => Promise.resolve(new Response('<unsupported/>')));
  assertEquals(result.status, 'parse_error');
  assertEquals(atob(result.raw_base64!), '<unsupported/>');
  let calls = 0;
  const missing = await captureCapacityEvidence('generation_outages', from, to, '', () => { calls++; throw Error('Unexpected call'); });
  assertEquals(calls, 0);
  assertEquals(missing.status, 'transport_error');
});
