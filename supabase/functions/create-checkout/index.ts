import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Price IDs for test and live modes
const PRICE_ID_TEST = "price_1StBDfFXcb7HEmpU2WQ58M1G";
const PRICE_ID_LIVE = "price_1StB0xFat41qiV6YdaKBrFzE";

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[CREATE-CHECKOUT] ${step}${detailsStr}`);
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

    const authHeader = req.headers.get("Authorization")!;
    const token = authHeader.replace("Bearer ", "");
    const { data } = await supabaseClient.auth.getUser(token);
    const user = data.user;
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

    // Use appropriate Stripe key and price based on customer test status
    const stripeKey = isTestCustomer 
      ? Deno.env.get("STRIPE_SECRET_KEY") 
      : Deno.env.get("STRIPE_SECRET_KEY_LIVE");
    if (!stripeKey) throw new Error(isTestCustomer ? "STRIPE_SECRET_KEY is not set" : "STRIPE_SECRET_KEY_LIVE is not set");
    
    const priceId = isTestCustomer ? PRICE_ID_TEST : PRICE_ID_LIVE;
    logStep("Stripe configuration", { mode: isTestCustomer ? "test" : "live", priceId });

    const stripe = new Stripe(stripeKey, {
      apiVersion: "2025-08-27.basil",
    });

    // Check if customer exists in Stripe
    const customers = await stripe.customers.list({ email: user.email, limit: 1 });
    let customerId;
    if (customers.data.length > 0) {
      customerId = customers.data[0].id;
    }
    logStep("Stripe customer lookup", { customerId: customerId || "new customer" });

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      customer_email: customerId ? undefined : user.email,
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: "subscription",
      success_url: `${req.headers.get("origin")}/portal/billing?success=true`,
      cancel_url: `${req.headers.get("origin")}/portal/billing?canceled=true`,
    });

    logStep("Checkout session created", { sessionId: session.id });

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Error in create-checkout:", errorMessage);
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
