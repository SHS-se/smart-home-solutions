// Tests the buyer details we publish to Stripe. Stripe copies name + address
// onto an invoice when it finalizes, and a finalized invoice never re-reads
// them, so getting this wrong is not recoverable after the fact.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { stripeCustomerIdentity } from "../supabase/functions/_shared/stripe-customer-identity.ts";

const SITE = {
  billing_same_as_site: true,
  site_street: "Porfyrvägen 10",
  site_postcode: "187 34",
  site_city: "Täby",
  billing_street: null,
  billing_postcode: null,
  billing_city: null,
};

Deno.test("uses the installation address when billing matches it", () => {
  assertEquals(stripeCustomerIdentity("Anna Andersson", SITE), {
    name: "Anna Andersson",
    address: { line1: "Porfyrvägen 10", postal_code: "187 34", city: "Täby", country: "SE" },
  });
});

Deno.test("uses the separate billing address when there is one", () => {
  const identity = stripeCustomerIdentity("Anna Andersson", {
    ...SITE,
    billing_same_as_site: false,
    billing_street: "Fakturagatan 1",
    billing_postcode: "111 22",
    billing_city: "Stockholm",
  });

  assertEquals(identity?.address, {
    line1: "Fakturagatan 1",
    postal_code: "111 22",
    city: "Stockholm",
    country: "SE",
  });
});

Deno.test("incomplete details publish nothing rather than half an address", () => {
  assertEquals(stripeCustomerIdentity(null, SITE), null);
  assertEquals(stripeCustomerIdentity("   ", SITE), null);
  assertEquals(stripeCustomerIdentity("Anna Andersson", { ...SITE, site_city: null }), null);
  assertEquals(stripeCustomerIdentity("Anna Andersson", null), null);
  // billing_same_as_site false with no billing address filled in
  assertEquals(
    stripeCustomerIdentity("Anna Andersson", { ...SITE, billing_same_as_site: false }),
    null,
  );
});

Deno.test("values are trimmed", () => {
  const identity = stripeCustomerIdentity("  Anna Andersson  ", {
    ...SITE,
    site_street: "  Porfyrvägen 10 ",
  });
  assertEquals(identity?.name, "Anna Andersson");
  assertEquals(identity?.address.line1, "Porfyrvägen 10");
});
