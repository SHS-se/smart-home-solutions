import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[CANCEL-QUOTE] ${step}${detailsStr}`);
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Verify staff authorization
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization header" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const anonClient = createClient(supabaseUrl, supabaseAnonKey);
    const { data: userData, error: userError } = await anonClient.auth.getUser(token);

    if (userError || !userData.user) {
      return new Response(JSON.stringify({ error: "Invalid authorization" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    logStep("User authenticated", { userId: userData.user.id });

    const serviceClient = createClient(supabaseUrl, supabaseServiceRoleKey);
    const { data: staffCheck } = await serviceClient
      .from("staff_users").select("user_id").eq("user_id", userData.user.id).single();

    if (!staffCheck) {
      return new Response(JSON.stringify({ error: "Staff access required" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    logStep("Staff verified");

    const { quote_id, reason } = await req.json();
    if (!quote_id) {
      return new Response(JSON.stringify({ error: "quote_id is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Load the quote
    const { data: quote, error: quoteError } = await serviceClient
      .from("quotes").select("*").eq("id", quote_id).single();

    if (quoteError || !quote) {
      return new Response(JSON.stringify({ error: "Quote not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    logStep("Quote loaded", { quoteId: quote.id, status: quote.status });

    // Idempotency
    if (quote.status === "cancelled") {
      logStep("Already cancelled");
      return new Response(JSON.stringify({ success: true, quote, message: "Quote was already cancelled" }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Update the quote (local DB only, no Stripe)
    const { data: updatedQuote, error: updateError } = await serviceClient
      .from("quotes")
      .update({
        status: "cancelled",
        cancelled_at: new Date().toISOString(),
        cancelled_by_user_id: userData.user.id,
        status_reason: reason || null,
        accept_token_expires_at: new Date().toISOString(), // Invalidate any active token
      })
      .eq("id", quote_id)
      .select()
      .single();

    if (updateError) {
      return new Response(JSON.stringify({ error: "Failed to update quote" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Log event
    await serviceClient.from("quote_events").insert({
      quote_id,
      event_type: "cancelled",
      actor_type: "staff",
      actor_email: userData.user.email,
      metadata: reason ? { reason } : {},
    });

    logStep("Quote cancelled successfully");

    return new Response(JSON.stringify({ success: true, quote: updatedQuote }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: msg });
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
