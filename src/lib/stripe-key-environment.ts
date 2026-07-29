export type StripeKeyEnvironment = "test" | "live";

/**
 * Reject a publishable key from the opposite Stripe mode before Stripe.js is
 * loaded. This keeps a test build from ever initiating requests to live Stripe
 * (and vice versa) when an environment file is configured incorrectly.
 */
export function validateStripePublishableKey(
  key: string | undefined,
  environment: StripeKeyEnvironment,
): string | undefined {
  if (!key) return undefined;

  const expectedPrefix = environment === "test" ? "pk_test_" : "pk_live_";
  if (!key.startsWith(expectedPrefix)) {
    throw new Error(
      `VITE_STRIPE_PUBLISHABLE_KEY must start with ${expectedPrefix} when VITE_APP_ENV is ${environment}.`,
    );
  }

  return key;
}
