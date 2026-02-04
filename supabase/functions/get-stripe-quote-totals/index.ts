import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const logStep = (step: string, details?: Record<string, unknown>) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[GET-STRIPE-QUOTE-TOTALS] ${step}${detailsStr}`);
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
    logStep("Function started");

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey);
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // Authenticate user
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header provided");

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError) throw new Error(`Authentication error: ${userError.message}`);
    if (!userData.user) throw new Error("User not authenticated");

    const userId = userData.user.id;

    // Check if user is staff
    const { data: staffData } = await supabaseAdmin
      .from('staff_users')
      .select('user_id')
      .eq('user_id', userId)
      .single();

    const isStaff = !!staffData;

    // Get customer ID for non-staff users
    let customerId: string | null = null;
    if (!isStaff) {
      const { data: customer } = await supabaseAdmin
        .from('customers')
        .select('id')
        .eq('user_id', userId)
        .single();

      if (!customer) throw new Error("Customer not found");
      customerId = customer.id;
    }

    const { quote_ids } = await req.json();

    if (!Array.isArray(quote_ids) || quote_ids.length === 0) {
      return new Response(
        JSON.stringify({ totals: {} }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
      );
    }

    logStep("Fetching quotes from database", { count: quote_ids.length });

    // Fetch quotes with stripe_quote_id
    let query = supabaseAdmin
      .from('quotes')
      .select('id, stripe_quote_id, is_test')
      .in('id', quote_ids)
      .not('stripe_quote_id', 'is', null);

    // Non-staff users can only see their own quotes
    if (!isStaff && customerId) {
      query = query.eq('customer_id', customerId);
    }

    const { data: quotes, error: quotesError } = await query;

    if (quotesError) throw new Error(`Error fetching quotes: ${quotesError.message}`);
    if (!quotes || quotes.length === 0) {
      return new Response(
        JSON.stringify({ totals: {} }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
      );
    }

    logStep("Found quotes with Stripe IDs", { count: quotes.length });

    // Group quotes by is_test to batch API calls
    const testQuotes = quotes.filter(q => q.is_test);
    const liveQuotes = quotes.filter(q => !q.is_test);

    const totals: Record<string, { amount_total: number; currency: string }> = {};

    // Helper to fetch quote totals from Stripe
    async function fetchStripeTotals(quoteList: NonNullable<typeof quotes>, isTest: boolean) {
      if (!quoteList || quoteList.length === 0) return;

      const stripeKey = getStripeKey(isTest);
      const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });

      for (const quote of quoteList) {
        try {
          const stripeQuote = await stripe.quotes.retrieve(quote.stripe_quote_id!);
          totals[quote.id] = {
            amount_total: stripeQuote.amount_total ?? 0,
            currency: stripeQuote.currency ?? 'sek',
          };
        } catch (err) {
          logStep("Error fetching Stripe quote", { 
            quoteId: quote.id, 
            stripeQuoteId: quote.stripe_quote_id,
            error: err instanceof Error ? err.message : String(err)
          });
          // Skip this quote on error
        }
      }
    }

    // Fetch test and live quotes in parallel
    await Promise.all([
      fetchStripeTotals(testQuotes, true),
      fetchStripeTotals(liveQuotes, false),
    ]);

    logStep("Fetched Stripe totals", { count: Object.keys(totals).length });

    return new Response(
      JSON.stringify({ totals }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
    );

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: errorMessage });
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
    );
  }
});
