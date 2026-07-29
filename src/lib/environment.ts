export type AppEnvironment = "test" | "live";

export function getAppEnvironment(): AppEnvironment {
  const env = import.meta.env.VITE_APP_ENV;
  if (env === "test" || env === "live") return env;
  // No fallback: a build without a valid VITE_APP_ENV must break loudly rather
  // than quietly impersonate an environment. vite.config.ts asserts this (plus
  // Supabase/Stripe consistency) at build time, so this throw is the runtime
  // backstop for bundles produced outside that pipeline.
  throw new Error(`VITE_APP_ENV must be "test" or "live", got ${JSON.stringify(env)}.`);
}

export function isTestEnvironment(): boolean {
  return getAppEnvironment() === "test";
}
