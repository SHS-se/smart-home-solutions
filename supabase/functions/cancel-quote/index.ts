import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import Stripe from "https://esm.sh/stripe@18.5.0";

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
    logStep("Function started");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Helper to get the appropriate Stripe key
    const getStripeKey = (isTest: boolean): string => {
      if (isTest) {
        const testKey = Deno.env.get("STRIPE_SECRET_KEY");
        if (!testKey) throw new Error("STRIPE_SECRET_KEY (test) is not set");
        return testKey;
      } else {
        const liveKey = Deno.env.get("STRIPE_SECRET_KEY_LIVE");
        if (!liveKey) throw new Error("STRIPE_SECRET_KEY_LIVE is not set");
        return liveKey;
      }
    };

    // Verify staff authorization
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const anonClient = createClient(supabaseUrl, supabaseAnonKey);
    const { data: userData, error: userError } = await anonClient.auth.getUser(token);
    
    if (userError || !userData.user) {
      return new Response(JSON.stringify({ error: "Invalid authorization" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    logStep("User authenticated", { userId: userData.user.id });

    // Check staff status using service role
    const serviceClient = createClient(supabaseUrl, supabaseServiceRoleKey);
    const { data: staffCheck } = await serviceClient
      .from("staff_users")
      .select("user_id")
      .eq("user_id", userData.user.id)
      .single();

    if (!staffCheck) {
      return new Response(JSON.stringify({ error: "Staff access required" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    logStep("Staff verified");

    // Parse request body
    const { quote_id, reason } = await req.json();
    
    if (!quote_id) {
      return new Response(JSON.stringify({ error: "quote_id is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Load the quote
    const { data: quote, error: quoteError } = await serviceClient
      .from("quotes")
      .select("*")
      .eq("id", quote_id)
      .single();

    if (quoteError || !quote) {
      return new Response(JSON.stringify({ error: "Quote not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    logStep("Quote loaded", { quoteId: quote.id, status: quote.status, stripeQuoteId: quote.stripe_quote_id });

    // Idempotency: if already cancelled, return success
    if (quote.status === "cancelled") {
      logStep("Quote already cancelled, returning success");
      return new Response(JSON.stringify({ success: true, quote, message: "Quote was already cancelled" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Initialize Stripe with the correct key based on is_test flag
    const isTest = quote.is_test ?? true;
    const stripeKey = getStripeKey(isTest);
    logStep("Using Stripe mode", { isTest });
    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });

    let stripeStatus: string | null = null;

    // If there's a Stripe quote, try to cancel it
    if (quote.stripe_quote_id) {
      logStep("Cancelling Stripe quote", { stripeQuoteId: quote.stripe_quote_id });

      try {
        // First, retrieve the current status
        const stripeQuote = await stripe.quotes.retrieve(quote.stripe_quote_id);
        logStep("Stripe quote retrieved", { status: stripeQuote.status });

        // Only try to cancel if not already cancelled
        if (stripeQuote.status === "canceled") {
          logStep("Stripe quote already canceled");
          stripeStatus = "canceled";
        } else if (stripeQuote.status === "draft" || stripeQuote.status === "open") {
          // Cancel the quote in Stripe
          const cancelledStripeQuote = await stripe.quotes.cancel(quote.stripe_quote_id);
          stripeStatus = cancelledStripeQuote.status;
          logStep("Stripe quote cancelled", { newStatus: stripeStatus });
        } else {
          // Quote is in a state that can't be cancelled (accepted, etc.)
          stripeStatus = stripeQuote.status;
          logStep("Stripe quote in non-cancellable state", { status: stripeStatus });
        }
      } catch (stripeError: unknown) {
        const error = stripeError as { message?: string; code?: string };
        logStep("Stripe cancel error", { message: error.message, code: error.code });
        
        // If the quote is already cancelled or doesn't exist, proceed
        if (error.code === "resource_missing" || error.message?.includes("already been canceled")) {
          stripeStatus = "canceled";
          logStep("Treating as already cancelled");
        } else {
          // Stripe cancel failed - do not update local DB
          return new Response(JSON.stringify({ 
            error: "Stripe cancel failed; quote was not cancelled.",
            details: error.message 
          }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
    } else {
      logStep("No Stripe quote ID, proceeding with local cancel only");
    }

    // Update the quote in the database
    const { data: updatedQuote, error: updateError } = await serviceClient
      .from("quotes")
      .update({
        status: "cancelled",
        cancelled_at: new Date().toISOString(),
        cancelled_by_user_id: userData.user.id,
        stripe_status: stripeStatus,
        status_reason: reason || null,
      })
      .eq("id", quote_id)
      .select()
      .single();

    if (updateError) {
      console.error("Update error:", updateError);
      return new Response(JSON.stringify({ error: "Failed to update quote in database" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    logStep("Quote cancelled successfully", { quoteId: updatedQuote.id });

    return new Response(JSON.stringify({ success: true, quote: updatedQuote }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("Error:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
