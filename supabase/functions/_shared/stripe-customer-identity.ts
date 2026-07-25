// What we publish to Stripe about the buyer: the same name and billing address
// that goes on our own invoice. Stripe copies these onto an invoice when it
// finalizes it, so anything missing here is missing from the Stripe dashboard
// and from every Stripe-side export — permanently, since a finalized invoice
// never re-reads the customer.
//
// Pure so it can be unit-tested; create-subscription publishes it at signup and
// stripe-webhook refreshes it while each renewal invoice is still a draft.

export interface StripeCustomerIdentity {
  name: string;
  address: { line1: string; postal_code: string; city: string; country: string };
}

export interface CustomerAddressRow {
  billing_same_as_site?: boolean | null;
  site_street?: string | null;
  site_postcode?: string | null;
  site_city?: string | null;
  billing_street?: string | null;
  billing_postcode?: string | null;
  billing_city?: string | null;
}

/** Null when the buyer details are incomplete — a half-filled address on a
 *  Swedish invoice is worse than none, and the portal blocks the subscription
 *  until the customer completes it. Country is SE: the service is installed at
 *  a Swedish address and invoiced in SEK. */
export function stripeCustomerIdentity(
  name: string | null | undefined,
  address: CustomerAddressRow | null | undefined,
): StripeCustomerIdentity | null {
  const useSite = address?.billing_same_as_site === true;
  const line1 = (useSite ? address?.site_street : address?.billing_street)?.trim();
  const postalCode = (useSite ? address?.site_postcode : address?.billing_postcode)?.trim();
  const city = (useSite ? address?.site_city : address?.billing_city)?.trim();
  const trimmedName = name?.trim();

  if (!trimmedName || !line1 || !postalCode || !city) return null;

  return {
    name: trimmedName,
    address: { line1, postal_code: postalCode, city, country: "SE" },
  };
}
