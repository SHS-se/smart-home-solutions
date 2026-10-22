import { entsoeParameters } from "../_shared/entsoe-market-data.ts";

const TEST = "https://vxqpgbzseckgceopitpm.supabase.co";

/** Read-only acquisition lane. It has no database, planner or production client. */
export function createMarketResearchHandler(
  config: { projectUrl: string; secret: string; token: string },
  fetchProvider: typeof fetch = fetch,
) {
  return async (request: Request): Promise<Response> => {
    if (config.projectUrl !== TEST) return Response.json({ error: "test_lane_only" }, { status: 403 });
    if (!config.secret || request.headers.get("authorization") !== `Bearer ${config.secret}`) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (request.method !== "POST") return Response.json({ error: "post_required" }, { status: 405 });
    if (!config.token) return Response.json({ error: "entsoe_token_not_configured" }, { status: 503 });
    let parameters: URLSearchParams;
    try { parameters = entsoeParameters(await request.json()); }
    catch { return Response.json({ error: "invalid_entsoe_query" }, { status: 400 }); }
    const url = new URL("https://web-api.tp.entsoe.eu/api");
    url.search = parameters.toString();
    url.searchParams.set("securityToken", config.token);
    try {
      const response = await fetchProvider(url, { signal: AbortSignal.timeout(90_000), redirect: "error" });
      // Preserve upstream error replies as evidence; never return the credential-bearing URL.
      const body = await response.arrayBuffer();
      return new Response(body, { status: response.status, headers: {
        "content-type": response.headers.get("content-type") ?? "application/octet-stream",
        "cache-control": "no-store",
      } });
    } catch { return Response.json({ error: "entsoe_transport_failed" }, { status: 502 }); }
  };
}

if (import.meta.main) Deno.serve(createMarketResearchHandler({
  projectUrl: Deno.env.get("SUPABASE_URL") ?? "",
  secret: Deno.env.get("PLANNER_PROBE_SECRET") ?? "",
  token: Deno.env.get("ENTSOE_API_TOKEN") ?? "",
}));
