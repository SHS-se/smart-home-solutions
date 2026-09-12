// Shared auth for Home Assistant device-token endpoints.
//
// Devices authenticate with `Authorization: Bearer shs_<64 hex>`; only the
// SHA-256 hash of the token is stored. Subscription entitlement is read from
// the customers table, which stripe-webhook / check-subscription keep synced,
// so these endpoints never need a Stripe round-trip.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

export const DEVICE_TOKEN_PREFIX = "shs_";

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface DeviceAuthSuccess {
  ok: true;
  tokenId: string;
  customerId: string;
  homeId: string;
  customerName: string | null;
  subscriptionActive: boolean;
  subscriptionExpiresAt: string | null;
}

export interface DeviceAuthFailure {
  ok: false;
  status: number;
  error: string;
}

export type DeviceAuthResult = DeviceAuthSuccess | DeviceAuthFailure;

/** Resolve a Bearer device token to its customer, updating last_seen_at. */
export async function authenticateDevice(
  supabase: SupabaseClient,
  req: Request,
  options: { includeCustomerName?: boolean } = {},
): Promise<DeviceAuthResult> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";

  if (!token.startsWith(DEVICE_TOKEN_PREFIX)) {
    return { ok: false, status: 401, error: "missing_or_malformed_token" };
  }

  const tokenHash = await sha256Hex(token);
  const { data: tokenRow, error: tokenError } = await supabase
    .from("ha_device_tokens")
    .select("id, customer_id, home_id, revoked_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (tokenError) {
    console.error("[HA-DEVICE-AUTH] token lookup failed", tokenError);
    return { ok: false, status: 500, error: "token_lookup_failed" };
  }
  if (!tokenRow) {
    return { ok: false, status: 401, error: "invalid_token" };
  }
  if (tokenRow.revoked_at) {
    return { ok: false, status: 401, error: "token_revoked" };
  }
  if (!tokenRow.home_id) {
    return { ok: false, status: 401, error: "token_not_bound_to_home" };
  }

  // Entitlement is checked on every request; identity is display data and is
  // fetched only by the status endpoint that actually returns it.
  const { data: customer, error: customerError } = await supabase
    .from("customers")
    .select("id, subscription_active, subscription_expires_at")
    .eq("id", tokenRow.customer_id)
    .maybeSingle();

  if (customerError || !customer) {
    console.error("[HA-DEVICE-AUTH] customer lookup failed", customerError);
    return { ok: false, status: 500, error: "customer_lookup_failed" };
  }

  let customerName: string | null = null;
  if (options.includeCustomerName) {
    const { data: identity } = await supabase
      .from("customers_with_identity")
      .select("name")
      .eq("id", tokenRow.customer_id)
      .maybeSingle();
    customerName = identity?.name ?? null;
  }

  // Freshness marker; awaited because the edge runtime may not run work
  // scheduled after the response is returned. Failures must not block auth.
  const { error: seenError } = await supabase
    .from("ha_device_tokens")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", tokenRow.id);
  if (seenError) {
    console.error("[HA-DEVICE-AUTH] last_seen update failed", seenError);
  }

  const notExpired = !customer.subscription_expires_at ||
    new Date(customer.subscription_expires_at) > new Date();

  return {
    ok: true,
    tokenId: tokenRow.id,
    customerId: customer.id,
    homeId: tokenRow.home_id,
    customerName,
    subscriptionActive: Boolean(customer.subscription_active) && notExpired,
    subscriptionExpiresAt: customer.subscription_expires_at ?? null,
  };
}
