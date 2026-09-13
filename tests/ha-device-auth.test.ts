import { assertEquals } from 'jsr:@std/assert@1';
import { authenticateDevice } from '../supabase/functions/_shared/ha-device-auth.ts';

function database(overrides: Record<string, Record<string, unknown> | null> = {}) {
  const reads: string[] = [];
  const writes: string[] = [];
  const rows: Record<string, Record<string, unknown> | null> = {
    ha_device_tokens: { id: 'token', customer_id: 'customer', home_id: 'home', revoked_at: null },
    customers: { id: 'customer', subscription_active: true, subscription_expires_at: '2999-01-01' },
    customers_with_identity: { name: 'Customer' },
    ...overrides,
  };
  const client = { from(table: string) {
    const query = {
      select() { reads.push(table); return query; },
      eq() { return query; },
      update() { writes.push(table); return query; },
      maybeSingle: async () => ({ data: rows[table], error: null }),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve),
    };
    return query;
  } };
  return { client: client as Parameters<typeof authenticateDevice>[0], reads, writes };
}

const request = () => new Request('https://example.test', { headers: { Authorization: 'Bearer shs_' + 'a'.repeat(64) } });

Deno.test('HA auth omits unused identity reads but preserves entitlement and last-seen writes', async () => {
  const db = database();
  const result = await authenticateDevice(db.client, request());
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.customerName, null);
    assertEquals(result.subscriptionActive, true);
    assertEquals(result.homeId, 'home');
  }
  assertEquals(db.reads, ['ha_device_tokens', 'customers']);
  assertEquals(db.writes, ['ha_device_tokens']);
});

Deno.test('status still receives the customer display name', async () => {
  const db = database();
  const result = await authenticateDevice(db.client, request(), { includeCustomerName: true });
  assertEquals(result.ok && result.customerName, 'Customer');
  assertEquals(db.reads, ['ha_device_tokens', 'customers', 'customers_with_identity']);
});

Deno.test('revocation and expiry still apply on the very next request', async () => {
  const revoked = database({ ha_device_tokens: { revoked_at: '2026-01-01' } });
  assertEquals(await authenticateDevice(revoked.client, request()), { ok: false, status: 401, error: 'token_revoked' });
  assertEquals(revoked.reads, ['ha_device_tokens']);
  assertEquals(revoked.writes, []);
  const expired = database({ customers: { id: 'customer', subscription_active: true, subscription_expires_at: '2020-01-01' } });
  const result = await authenticateDevice(expired.client, request());
  assertEquals(result.ok && result.subscriptionActive, false);
});
