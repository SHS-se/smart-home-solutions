export type AppEnvironment = "test" | "live";

export function getAppEnvironment(): AppEnvironment {
  const env = import.meta.env.VITE_APP_ENV;
  if (env === "test" || env === "live") return env;
  // Default to test if not set (safe default)
  console.warn("VITE_APP_ENV not set, defaulting to 'test'");
  return "test";
}

export function isTestEnvironment(): boolean {
  return getAppEnvironment() === "test";
}
