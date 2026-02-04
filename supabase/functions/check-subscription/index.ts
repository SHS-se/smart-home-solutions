import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[CHECK-SUBSCRIPTION] ${step}${detailsStr}`);
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }
  );

  try {
    logStep("Function started");

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header provided");
    logStep("Authorization header found");

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError) throw new Error(`Authentication error: ${userError.message}`);
    const user = userData.user;
    if (!user?.email) throw new Error("User not authenticated or email not available");
    logStep("User authenticated", { userId: user.id, email: user.email });

    // Check if customer is a test customer
    const { data: customerData } = await supabaseClient
      .from('customers')
      .select('is_test')
      .eq('user_id', user.id)
      .single();
    
    const isTestCustomer = customerData?.is_test ?? false;
    logStep("Customer test status", { isTestCustomer });

    // Use appropriate Stripe key based on customer test status
    const stripeKey = isTestCustomer 
      ? Deno.env.get("STRIPE_SECRET_KEY") 
      : Deno.env.get("STRIPE_SECRET_KEY_LIVE");
    if (!stripeKey) throw new Error(isTestCustomer ? "STRIPE_SECRET_KEY is not set" : "STRIPE_SECRET_KEY_LIVE is not set");
    logStep("Stripe key verified", { mode: isTestCustomer ? "test" : "live" });

    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });
    const customers = await stripe.customers.list({ email: user.email, limit: 1 });

    if (customers.data.length === 0) {
      logStep("No Stripe customer found");
      return new Response(JSON.stringify({ subscribed: false, is_test: isTestCustomer }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    const customerId = customers.data[0].id;
    logStep("Found Stripe customer", { customerId });

    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: "active",
      limit: 1,
    });
    const hasActiveSub = subscriptions.data.length > 0;
    let subscriptionEnd = null;
    let stripeSubscriptionId = null;
    let cancelAtPeriodEnd = false;

    if (hasActiveSub) {
      const subscription = subscriptions.data[0];
      stripeSubscriptionId = subscription.id;
      cancelAtPeriodEnd = subscription.cancel_at_period_end || false;
      
      logStep("Raw subscription data", { 
        current_period_end: subscription.current_period_end,
        current_period_end_type: typeof subscription.current_period_end,
        cancel_at: subscription.cancel_at,
      });
      
      const endTimestamp = subscription.current_period_end || subscription.cancel_at;
      if (endTimestamp) {
        try {
          if (typeof endTimestamp === 'number') {
            subscriptionEnd = new Date(endTimestamp * 1000).toISOString();
          } else if (typeof endTimestamp === 'string') {
            subscriptionEnd = endTimestamp;
          }
        } catch (e) {
          logStep("Could not parse subscription end date", { endTimestamp, error: String(e) });
        }
      }
      
      logStep("Active subscription found", { 
        subscriptionId: subscription.id, 
        endDate: subscriptionEnd,
        cancelAtPeriodEnd 
      });
    } else {
      logStep("No active subscription found");
    }

    return new Response(JSON.stringify({
      subscribed: hasActiveSub,
      subscription_end: subscriptionEnd,
      stripe_subscription_id: stripeSubscriptionId,
      cancel_at_period_end: cancelAtPeriodEnd,
      is_test: isTestCustomer,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logStep("ERROR in check-subscription", { message: errorMessage });
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
