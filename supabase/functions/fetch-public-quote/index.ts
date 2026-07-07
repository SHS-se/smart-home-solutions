import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[FETCH-PUBLIC-QUOTE] ${step}${detailsStr}`);
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
    const url = new URL(req.url);
    const quoteId = url.searchParams.get("quote_id");
    const token = url.searchParams.get("token");

    if (!quoteId || !token) {
      return new Response(JSON.stringify({ error: "Missing quote_id or token" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Fetch quote
    const { data: quote, error: quoteError } = await serviceClient
      .from("quotes")
      .select("id, quote_number, status, expires_at, accept_token_hash, accept_token_expires_at, customer_id, created_at, sent_at, accepted_at, declined_at, customer_snapshot")
      .eq("id", quoteId)
      .single();

    if (quoteError || !quote) {
      return new Response(JSON.stringify({ error: "Quote not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Validate token
    const tokenHash = await hashToken(token);
    if (quote.accept_token_hash !== tokenHash) {
      logStep("Token mismatch");
      return new Response(JSON.stringify({ error: "Invalid or expired link" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check token expiry. Accepted quotes stay viewable indefinitely (also for
    // quotes accepted before the policy change, whose tokens were invalidated
    // with a past timestamp); undecided/declined quotes are viewable until the
    // validity period ends.
    if (
      quote.status !== "accepted" &&
      quote.accept_token_expires_at &&
      new Date(quote.accept_token_expires_at) < new Date()
    ) {
      logStep("Token expired");
      return new Response(JSON.stringify({ error: "This link has expired" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Frozen buyer details captured when the quote left draft; fall back to live
    // customer data for legacy quotes that have no snapshot.
    const frozenCustomer = (quote as { customer_snapshot?: { name?: string | null } | null })
      .customer_snapshot;

    // Fetch customer name (live fallback)
    const { data: customer } = await serviceClient
      .from("customers_with_identity")
      .select("name, contact_email")
      .eq("id", quote.customer_id)
      .single();

    // Fetch line items
    const { data: lineItems } = await serviceClient
      .from("quote_lines")
      .select("id, section, description, quantity, unit_price_ex_vat, unit_price_inc_vat, vat_rate, original_sku_name, original_sku_code")
      .eq("quote_id", quoteId)
      .order("section")
      .order("created_at");

    // Fetch totals
    const { data: totals } = await serviceClient
      .from("quote_computed_totals")
      .select("*")
      .eq("quote_id", quoteId)
      .single();

    // Log viewed event (only for actionable statuses — skip superseded)
    const actionableStatuses = ["sent", "viewed"];
    if (actionableStatuses.includes(quote.status) && quote.status !== "superseded") {
      // Update status to viewed if currently sent
      if (quote.status === "sent") {
        await serviceClient.from("quotes").update({ status: "viewed" }).eq("id", quoteId);
      }
      // Update last_viewed_at
      await serviceClient.from("quotes").update({ last_viewed_at: new Date().toISOString() }).eq("id", quoteId);

      await serviceClient.from("quote_events").insert({
        quote_id: quoteId,
        event_type: "viewed",
        actor_type: "customer",
        metadata: {},
      });
    }

    logStep("Quote fetched successfully", { quoteId, status: quote.status });

    return new Response(JSON.stringify({
      id: quote.id,
      quote_number: quote.quote_number,
      status: quote.status === "sent" ? "viewed" : quote.status,
      expires_at: quote.expires_at,
      created_at: quote.created_at,
      sent_at: quote.sent_at,
      accepted_at: quote.accepted_at,
      declined_at: quote.declined_at,
      customer_name: frozenCustomer?.name || customer?.name || null,
      line_items: lineItems || [],
      totals: totals || null,
    }), {
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
