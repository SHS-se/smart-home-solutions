// Tests the internal sales-inbox notices raised when a subscription changes
// state. The important property is the negative one: these mails identify the
// customer and nothing else, so no card data can leak into an inbox or a mail log.

import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildSubscriptionStaffNotice,
  type SubscriptionNoticeEvent,
} from "../supabase/functions/_shared/subscription-staff-notice.ts";

const CUSTOMER = {
  id: "c0ffee00-0000-4000-8000-000000000001",
  name: "Anna Andersson",
  email: "anna@example.com",
};

const CONTEXT = {
  appEnv: "live" as const,
  appOrigin: "https://smarthomesolutions.se",
  now: new Date("2026-07-25T12:00:00Z"),
};

const ALL_EVENTS: SubscriptionNoticeEvent[] = [
  "started",
  "canceled_by_customer",
  "resumed",
  "ended_payment_failure",
  "payment_failed",
  "card_updated",
  "card_expires_before_renewal",
];

Deno.test("notice identifies the customer and links to their page", () => {
  const { subject, text } = buildSubscriptionStaffNotice(
    { event: "started", customer: CUSTOMER, date: "2026-08-25" },
    CONTEXT,
  );

  assertEquals(subject, "Ny prenumeration: Anna Andersson");
  assertStringIncludes(text, "Anna Andersson");
  assertStringIncludes(text, "anna@example.com");
  assertStringIncludes(text, CUSTOMER.id);
  assertStringIncludes(text, `https://smarthomesolutions.se/portal/customers/${CUSTOMER.id}`);
  assertStringIncludes(text, "2026-08-25");
});

Deno.test("no event leaks anything about the card", () => {
  // Guards the whole copy table at once: adding a brand/last4/expiry to any
  // notice fails here.
  const forbidden = ["visa", "mastercard", "•", "last4", "sista siffror", "utgår", "kortnummer", "exp_"];

  for (const event of ALL_EVENTS) {
    const { subject, text } = buildSubscriptionStaffNotice(
      { event, customer: CUSTOMER, date: "2026-08-25" },
      CONTEXT,
    );
    const haystack = `${subject}\n${text}`.toLowerCase();
    for (const term of forbidden) {
      assert(!haystack.includes(term), `${event} notice mentions "${term}"`);
    }
  }
});

Deno.test("test environment is visible in the subject", () => {
  const { subject } = buildSubscriptionStaffNotice(
    { event: "canceled_by_customer", customer: CUSTOMER, date: "2026-08-25" },
    { ...CONTEXT, appEnv: "test" },
  );
  assertEquals(subject, "[TEST] Uppsagd prenumeration: Anna Andersson");
});

Deno.test("missing identity degrades to placeholders", () => {
  const { subject, text } = buildSubscriptionStaffNotice(
    { event: "card_updated", customer: { id: CUSTOMER.id, name: null, email: null } },
    CONTEXT,
  );

  assertEquals(subject, "Betalkort uppdaterat: Namn saknas");
  assertStringIncludes(text, "E-post: saknas");
});

Deno.test("a date only appears where it means something", () => {
  // card_updated carries no date, so a stray one must not be rendered.
  const { text } = buildSubscriptionStaffNotice(
    { event: "card_updated", customer: CUSTOMER, date: "2026-08-25" },
    CONTEXT,
  );
  assert(!text.includes("2026-08-25"));
});
