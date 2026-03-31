export function getAppUrl(): string {
  const configuredUrl =
    Deno.env.get("APP_URL") ||
    Deno.env.get("PORTAL_URL") ||
    Deno.env.get("SITE_URL");

  if (configuredUrl) {
    return configuredUrl.replace(/\/+$/, "");
  }

  const appEnv = Deno.env.get("APP_ENV");
  if (appEnv === "live") {
    return "https://smarthomesolutions.se";
  }

  return "https://smarthomesolutions.se";
}
