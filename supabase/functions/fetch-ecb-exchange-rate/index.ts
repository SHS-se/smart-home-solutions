import { fetchEcbExchangeRatesDirect, type EcbRateRequest } from "../../../src/lib/ecb-rate-core.ts";
import { requireStaff } from "../_shared/staff-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Only used by the staff purchase-import flow; without this gate the
    // endpoint is an open proxy to the ECB API.
    const auth = await requireStaff(req, corsHeaders);
    if (auth instanceof Response) return auth;

    const body = await req.json();
    const requests = Array.isArray(body?.requests) ? body.requests as EcbRateRequest[] : [];
    if (requests.length === 0) {
      return new Response(JSON.stringify({ error: "No rate requests supplied" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const results = await fetchEcbExchangeRatesDirect(requests);

    return new Response(JSON.stringify({ results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
