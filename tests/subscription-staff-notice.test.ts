// Tests the internal sales-inbox notices raised when a subscription changes
// state. The important property is the negative one: these mails identify the
// customer and say why something happened, but never describe the card itself.

import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildSubscriptionStaffNotice,
  reasonLabel,
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
  "signup_abandoned",
  "dispute_opened",
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
  // Guards the whole copy table at once: adding a brand/last4/expiry date to
  // any notice fails here. Decline codes are fine — they name the failure, not
  // the card — so expired_card is passed in and deliberately not forbidden.
  const forbidden = ["visa", "mastercard", "•", "last4", "sista siffror", "kortnummer"];

  for (const event of ALL_EVENTS) {
    const { subject, text } = buildSubscriptionStaffNotice(
      { event, customer: CUSTOMER, date: "2026-08-25", reasonCode: "expired_card", amount: 320 },
      CONTEXT,
    );
    const haystack = `${subject}\n${text}`.toLowerCase();
    for (const term of forbidden) {
      assert(!haystack.includes(term), `${event} notice mentions "${term}"`);
    }
  }
});

Deno.test("an expired card is called out in the subject of a failed renewal", () => {
  const expired = buildSubscriptionStaffNotice(
    { event: "payment_failed", customer: CUSTOMER, reasonCode: "expired_card" },
    CONTEXT,
  );
  assertEquals(expired.subject, "Förnyelsen misslyckades – kortet har gått ut: Anna Andersson");
  assertStringIncludes(expired.text, "Orsak: Kortet har gått ut (expired_card)");

  const other = buildSubscriptionStaffNotice(
    { event: "payment_failed", customer: CUSTOMER, reasonCode: "insufficient_funds" },
    CONTEXT,
  );
  assertEquals(other.subject, "Förnyelsen misslyckades: Anna Andersson");
  assertStringIncludes(other.text, "Orsak: Täckning saknas på kontot (insufficient_funds)");
});

Deno.test("a dispute carries the amount and the deadline to respond", () => {
  const { subject, text } = buildSubscriptionStaffNotice(
    {
      event: "dispute_opened",
      customer: CUSTOMER,
      date: "2026-08-08",
      reasonCode: "fraudulent",
      amount: 320,
    },
    CONTEXT,
  );

  assertEquals(subject, "Chargeback öppnad: Anna Andersson");
  assertStringIncludes(text, "Sista svarsdag: 2026-08-08.");
  assertStringIncludes(text, "Belopp: 320 kr");
  assertStringIncludes(text, "Orsak: Kortinnehavaren säger sig inte ha godkänt köpet (fraudulent)");
});

Deno.test("an unmapped reason code still reaches the inbox", () => {
  assertEquals(reasonLabel("some_new_stripe_code"), "some_new_stripe_code");
  assertEquals(reasonLabel(null), null);
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
