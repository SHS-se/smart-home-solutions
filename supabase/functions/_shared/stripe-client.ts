// Single place that instantiates the Stripe SDK for edge functions, using the
// environment-validated secret key from stripe-env.ts. Deno needs the fetch
// HTTP client. NOTE: stripe-env.ts only accepts sk_test_/sk_live_ keys (not
// restricted rk_ keys), so SHS_STRIPE_SECRET_KEY must be a standard secret key.
import Stripe from "https://esm.sh/stripe@17.7.0?target=deno";
import { getStripeSecretKey } from "./stripe-env.ts";

let cached: Stripe | null = null;

export function getStripe(): Stripe {
  if (!cached) {
    cached = new Stripe(getStripeSecretKey(), {
      // Pinned API version; cast avoids coupling to the SDK's bundled literal type.
      apiVersion: "2024-06-20" as unknown as Stripe.LatestApiVersion,
      httpClient: Stripe.createFetchHttpClient(),
    });
  }
  return cached;
}

export { Stripe };
