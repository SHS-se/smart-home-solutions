// Public endpoint for marketing-email unsubscribe links.
//
// - POST: sets/clears customers.marketing_opt_out by unsubscribe_token.
//   Accepts both RFC 8058 one-click POSTs from mail providers (form body
//   "List-Unsubscribe=One-Click", token in the query string) and JSON from
//   the app's /unsubscribe page ({ token, action }).
// - GET: never mutates — link scanners prefetch GETs, so a GET only
//   redirects humans to the app's /unsubscribe page.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getPrimaryAppOrigin } from "../_shared/app-origin.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[UNSUBSCRIBE] ${step}${detailsStr}`);
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
    status,
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);

    if (req.method === "GET") {
      const token = url.searchParams.get("token") ?? "";
      const target = `${getPrimaryAppOrigin()}/unsubscribe${token ? `?token=${encodeURIComponent(token)}` : ""}`;
      return new Response(null, { headers: { ...corsHeaders, Location: target }, status: 302 });
    }

    if (req.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    let token = url.searchParams.get("token");
    let action = "unsubscribe";
    if ((req.headers.get("content-type") ?? "").includes("application/json")) {
      const body = await req.json().catch(() => ({}));
      if (typeof body.token === "string") token = body.token;
      if (typeof body.action === "string") action = body.action;
    }

    if (!token || !/^[0-9a-f]{16,64}$/.test(token)) {
      return json({ error: "Invalid token" }, 400);
    }
    if (!["unsubscribe", "resubscribe", "status"].includes(action)) {
      return json({ error: "Invalid action" }, 400);
    }

    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: customer } = await serviceClient
      .from("customers")
      .select("id, marketing_opt_out")
      .eq("unsubscribe_token", token)
      .maybeSingle();
    if (!customer) return json({ error: "Unknown token" }, 404);

    if (action === "status") {
      return json({ success: true, marketing_opt_out: customer.marketing_opt_out }, 200);
    }

    const optOut = action === "unsubscribe";
    const { error: updateError } = await serviceClient
      .from("customers")
      .update({
        marketing_opt_out: optOut,
        marketing_opt_out_at: optOut ? new Date().toISOString() : null,
      })
      .eq("id", customer.id);
    if (updateError) throw new Error(updateError.message);

    logStep("Preference updated", { customerId: customer.id, optOut });
    return json({ success: true, marketing_opt_out: optOut }, 200);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: msg });
    return json({ error: msg }, 500);
  }
});
