import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[DECLINE-QUOTE] ${step}${detailsStr}`);
};

async function hashToken(tokenHex: string): Promise<string> {
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(tokenHex));
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { quote_id, token, reason } = await req.json();

    if (!quote_id || !token) {
      return new Response(JSON.stringify({ error: "Missing required fields (quote_id, token)" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: quote, error: quoteError } = await serviceClient
      .from("quotes")
      .select("id, status, accept_token_hash, accept_token_expires_at")
      .eq("id", quote_id)
      .single();

    if (quoteError || !quote) {
      return new Response(JSON.stringify({ error: "Quote not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Validate token
    const tokenHash = await hashToken(token);
    if (quote.accept_token_hash !== tokenHash) {
      return new Response(JSON.stringify({ error: "Invalid or expired link" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (quote.accept_token_expires_at && new Date(quote.accept_token_expires_at) < new Date()) {
      return new Response(JSON.stringify({ error: "This link has expired" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Allow declining from sent, viewed, or revision_requested
    const declinableStatuses = ["sent", "viewed", "revision_requested"];
    if (!declinableStatuses.includes(quote.status)) {
      if (quote.status === "superseded") {
        return new Response(JSON.stringify({ error: "Offerten har ersatts av en nyare version" }), {
          status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: `Quote cannot be declined in status: ${quote.status}` }), {
        status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Update quote
    const { error: updateError } = await serviceClient
      .from("quotes")
      .update({
        status: "declined",
        declined_at: new Date().toISOString(),
        status_reason: reason || null,
        accept_token_expires_at: new Date().toISOString(), // Invalidate token
      })
      .eq("id", quote_id);

    if (updateError) throw new Error(`Failed to update quote: ${updateError.message}`);

    // Log event
    await serviceClient.from("quote_events").insert({
      quote_id,
      event_type: "declined",
      actor_type: "customer",
      metadata: reason ? { reason } : {},
    });

    logStep("Quote declined", { quoteId: quote_id });

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: msg });
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
