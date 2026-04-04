/**
 * Environment-aware application configuration
 * Single source of truth for APP_ENV and environment-aware behavior.
 *
 * Replaces stripe-env.ts — no Stripe dependency.
 */

export type AppEnvironment = "test" | "live";

/**
 * Get the current environment — fails hard if not configured.
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
 * Check if running in test environment.
 */
export function isTestEnvironment(): boolean {
  return getAppEnvironment() === "test";
}

/**
 * Get the invoice number prefix for the current environment.
 */
export function getInvoicePrefix(): string {
  return getAppEnvironment() === "live" ? "IN-" : "TIN-";
}

/**
 * Get the quote number prefix for the current environment.
 */
export function getQuotePrefix(): string {
  return getAppEnvironment() === "live" ? "Q-" : "TQ-";
}
