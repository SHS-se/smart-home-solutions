// Tests the pure Stripe-subscription → entitlement mapping that stripe-webhook
// applies to the customers row.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { entitlementFromSubscription } from "../supabase/functions/_shared/subscription-entitlement.ts";

const PERIOD_END = 1782950400; // 2026-07-01T00:00:00Z

Deno.test("active subscription grants access with an expiry", () => {
  const e = entitlementFromSubscription({ status: "active", current_period_end: PERIOD_END });
  assertEquals(e.subscription_active, true);
  assertEquals(e.subscription_expires_at, new Date(PERIOD_END * 1000).toISOString());
  assertEquals(e.subscription_cancel_at_period_end, false);
});

Deno.test("cancel_at_period_end is surfaced while still active", () => {
  const e = entitlementFromSubscription({
    status: "active",
    current_period_end: PERIOD_END,
    cancel_at_period_end: true,
  });
  assertEquals(e.subscription_active, true);
  assertEquals(e.subscription_cancel_at_period_end, true);
});

Deno.test("past_due and trialing keep access", () => {
  assertEquals(entitlementFromSubscription({ status: "past_due" }).subscription_active, true);
  assertEquals(entitlementFromSubscription({ status: "trialing" }).subscription_active, true);
});

Deno.test("canceled/unpaid/incomplete revoke access and clear expiry", () => {
  for (const status of ["canceled", "unpaid", "incomplete", "incomplete_expired"]) {
    const e = entitlementFromSubscription({ status, current_period_end: PERIOD_END, cancel_at_period_end: true });
    assertEquals(e.subscription_active, false, status);
    assertEquals(e.subscription_expires_at, null, status);
    assertEquals(e.subscription_cancel_at_period_end, false, status);
  }
});
