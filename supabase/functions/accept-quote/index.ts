import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[ACCEPT-QUOTE] ${step}${detailsStr}`);
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
    const { quote_id, token } = await req.json();

    if (!quote_id || !token) {
      return new Response(JSON.stringify({ error: "Missing required fields (quote_id, token)" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Fetch quote with customer info
    const { data: quote, error: quoteError } = await serviceClient
      .from("quotes")
      .select("id, status, accept_token_hash, accept_token_expires_at, customer_id")
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

    // Validate status
    const acceptableStatuses = ["sent", "viewed"];
    if (!acceptableStatuses.includes(quote.status)) {
      if (quote.status === "accepted") {
        return new Response(JSON.stringify({ error: "Offerten är redan godkänd", already_accepted: true }), {
          status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: `Quote cannot be accepted in status: ${quote.status}` }), {
        status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Resolve customer identity from the database
    let customerName = "Unknown";
    let customerEmail = "unknown";

    if (quote.customer_id) {
      const { data: customer } = await serviceClient
        .from("customers_with_identity")
        .select("name, contact_name, contact_email")
        .eq("id", quote.customer_id)
        .single();

      if (customer) {
        customerName = customer.name || customer.contact_name || "Unknown";
        customerEmail = customer.contact_email || "unknown";
      }
    }

    // Extract request metadata
    const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      || req.headers.get("x-real-ip")
      || "unknown";
    const userAgent = req.headers.get("user-agent") || "unknown";

    // Update quote
    const { error: updateError } = await serviceClient
      .from("quotes")
      .update({
        status: "accepted",
        accepted_at: new Date().toISOString(),
        accepted_by_name: customerName,
        accepted_by_email: customerEmail,
        accepted_ip: clientIp,
        accepted_user_agent: userAgent,
        accept_token_expires_at: new Date().toISOString(), // Invalidate token
      })
      .eq("id", quote_id);

    if (updateError) throw new Error(`Failed to update quote: ${updateError.message}`);

    // Log event
    await serviceClient.from("quote_events").insert({
      quote_id,
      event_type: "accepted",
      actor_type: "customer",
      actor_email: customerEmail,
      metadata: { name: customerName, ip: clientIp, user_agent: userAgent },
    });

    logStep("Quote accepted", { quoteId: quote_id, name: customerName, email: customerEmail });

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
