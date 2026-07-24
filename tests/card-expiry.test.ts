// Tests the pure card-expiry classification used by check-subscription to warn
// customers before a renewal charge fails.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { cardExpiryStatus } from "../supabase/functions/_shared/card-expiry.ts";

const NOW = new Date("2026-07-25T12:00:00Z");

Deno.test("card valid well past renewal is ok", () => {
  const s = cardExpiryStatus({ expMonth: 12, expYear: 2027, now: NOW, renewalAt: "2026-08-25T00:00:00Z" });
  assertEquals(s, "ok");
});

Deno.test("card is valid through the last day of its expiry month", () => {
  // Expiry 07/2026 checked on 2026-07-25: still valid.
  assertEquals(cardExpiryStatus({ expMonth: 7, expYear: 2026, now: NOW }), "ok");
  // First instant of the next month: expired.
  assertEquals(
    cardExpiryStatus({ expMonth: 7, expYear: 2026, now: new Date("2026-08-01T00:00:00Z") }),
    "expired",
  );
});

Deno.test("card expiring before the next renewal is flagged", () => {
  // Expiry 07/2026, renewal on 2026-08-25 — the renewal falls after validity ends.
  const s = cardExpiryStatus({ expMonth: 7, expYear: 2026, now: NOW, renewalAt: "2026-08-25T00:00:00Z" });
  assertEquals(s, "expires_before_renewal");
});

Deno.test("expired beats expires_before_renewal", () => {
  const s = cardExpiryStatus({
    expMonth: 6,
    expYear: 2026,
    now: NOW,
    renewalAt: "2026-08-25T00:00:00Z",
  });
  assertEquals(s, "expired");
});

Deno.test("unknown renewal date only reports expired/ok", () => {
  assertEquals(cardExpiryStatus({ expMonth: 8, expYear: 2026, now: NOW, renewalAt: null }), "ok");
  assertEquals(cardExpiryStatus({ expMonth: 8, expYear: 2026, now: NOW, renewalAt: "not-a-date" }), "ok");
});
