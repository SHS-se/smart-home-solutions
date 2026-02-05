/**
 * Environment-aware Stripe configuration
 * Single source of truth for Stripe API access
 */

export type AppEnvironment = "test" | "live";

/**
 * Get the current environment - fails hard if not configured
 */
export function getAppEnvironment(): AppEnvironment {
  const env = Deno.env.get("APP_ENV");
  if (!env) {
    throw new Error("FATAL: APP_ENV is not set. Deployment is misconfigured.");
  }
  if (env !== "test" && env !== "live") {
    throw new Error(`FATAL: APP_ENV must be 'test' or 'live', got '${env}'`);
  }
  return env as AppEnvironment;
}

/**
 * Get and validate Stripe secret key for current environment
 * Enforces key prefix matches environment (fail-closed)
 */
export function getStripeSecretKey(): string {
  const env = getAppEnvironment();
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  
  if (!key) {
    throw new Error("FATAL: STRIPE_SECRET_KEY is not set");
  }
  
  // CRITICAL: Validate key matches environment
  const isLiveKey = key.startsWith("sk_live_");
  const isTestKey = key.startsWith("sk_test_");
  
  if (env === "live" && !isLiveKey) {
    throw new Error(
      "FATAL: APP_ENV is 'live' but STRIPE_SECRET_KEY is not a live key. " +
      "Refusing to proceed - check secret configuration."
    );
  }
  
  if (env === "test" && !isTestKey) {
    throw new Error(
      "FATAL: APP_ENV is 'test' but STRIPE_SECRET_KEY is not a test key. " +
      "Refusing to proceed - check secret configuration."
    );
  }
  
  return key;
}

/**
 * Check if running in test environment
 */
export function isTestEnvironment(): boolean {
  return getAppEnvironment() === "test";
}

/**
 * Get quote number prefix for current environment
 */
export function getQuotePrefix(): string {
  return isTestEnvironment() ? "TQ-" : "Q-";
}
