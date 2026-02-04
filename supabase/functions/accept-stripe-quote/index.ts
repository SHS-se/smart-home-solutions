import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

/**
 * Get the appropriate Stripe key based on is_test flag
 */
function getStripeKey(isTest: boolean): string {
  if (isTest) {
    const testKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!testKey) throw new Error("STRIPE_SECRET_KEY (test) is not set");
    return testKey;
  } else {
    const liveKey = Deno.env.get("STRIPE_SECRET_KEY_LIVE");
    if (!liveKey) throw new Error("STRIPE_SECRET_KEY_LIVE is not set");
    return liveKey;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Verify user is authenticated
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      throw new Error("No authorization header");
    }

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      {
        global: {
          headers: { Authorization: authHeader }
        }
      }
    );

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError || !userData.user) {
      throw new Error("Unauthorized");
    }

    const { quote_id } = await req.json();
    if (!quote_id) {
      throw new Error("quote_id is required");
    }

    // Fetch the quote to get stripe_quote_id and verify ownership
    // First check if user is a customer
    const { data: customer } = await supabaseClient
      .from("customers")
      .select("id, is_test")
      .eq("user_id", userData.user.id)
      .maybeSingle();

    if (!customer) {
      throw new Error("Customer not found");
    }

    // Fetch the quote ensuring it belongs to this customer
    const { data: quote, error: quoteError } = await supabaseClient
      .from("quotes")
      .select("id, stripe_quote_id, is_test, customer_id, stripe_status, status")
      .eq("id", quote_id)
      .eq("customer_id", customer.id)
      .single();

    if (quoteError || !quote) {
      throw new Error("Quote not found or access denied");
    }

    if (!quote.stripe_quote_id) {
      throw new Error("Quote has not been sent to Stripe yet");
    }

    // Check if already accepted
    if (quote.stripe_status === "accepted" || quote.status === "accepted") {
      throw new Error("Quote is already accepted");
    }

    const isTest = quote.is_test ?? true;
    const stripeKey = getStripeKey(isTest);
    console.log(`[ACCEPT-STRIPE-QUOTE] Using ${isTest ? 'TEST' : 'LIVE'} Stripe key for quote ${quote_id}`);

    const stripe = new Stripe(stripeKey, {
      apiVersion: "2025-08-27.basil",
    });

    // Accept the quote in Stripe
    const acceptedQuote = await stripe.quotes.accept(quote.stripe_quote_id);
    console.log(`[ACCEPT-STRIPE-QUOTE] Quote ${quote.stripe_quote_id} accepted in Stripe, status: ${acceptedQuote.status}`);

    // Update the quote status in our database
    const { error: updateError } = await supabaseClient
      .from("quotes")
      .update({
        stripe_status: acceptedQuote.status,
        status: "accepted",
        updated_at: new Date().toISOString(),
      })
      .eq("id", quote_id);

    if (updateError) {
      console.error("[ACCEPT-STRIPE-QUOTE] Failed to update local quote status:", updateError);
      // Don't throw - the Stripe quote was already accepted
    }

    return new Response(
      JSON.stringify({ 
        success: true,
        stripe_status: acceptedQuote.status,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("[ACCEPT-STRIPE-QUOTE] Error:", error);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
    );
  }
});
