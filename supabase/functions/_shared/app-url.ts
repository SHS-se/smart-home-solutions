export function getAppUrl(): string {
  const configuredUrl = Deno.env.get("APP_URL");
  if (!configuredUrl) {
    throw new Error("FATAL: APP_URL is not set. Deployment is misconfigured.");
  }

  return configuredUrl.replace(/\/+$/, "");
}
