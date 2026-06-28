// Starts a self-serve subscription for the logged-in portal customer. Creates
// (or reuses) one Stripe Customer per customer, then a Subscription with
// payment_behavior=default_incomplete and returns the first invoice's
// PaymentIntent client_secret so the front-end Payment Element can confirm the
// card on our own page. The price is resolved by lookup_key so this works in
// both test and live without an env var.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getAppEnvironment } from "../_shared/app-env.ts";
import { getStripe } from "../_shared/stripe-client.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PRICE_LOOKUP_KEY = "shs_subscription_monthly";

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[CREATE-SUBSCRIPTION] ${step}${detailsStr}`);
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });
  const anonClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    auth: { persistSession: false },
  });

  try {
    getAppEnvironment(); // fail fast if APP_ENV is misconfigured
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header provided");
    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await anonClient.auth.getUser(token);
    if (userError) throw new Error(`Authentication error: ${userError.message}`);
    const user = userData.user;
    if (!user?.email) throw new Error("User not authenticated");

    const { data: customer } = await serviceClient
      .from("customers")
      .select("id, stripe_customer_id, subscription_active")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!customer) throw new Error("No customer record for this user");
    if (customer.subscription_active) {
      return new Response(JSON.stringify({ alreadySubscribed: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    const stripe = getStripe();

    // Reuse one Stripe Customer per customer.
    let stripeCustomerId = customer.stripe_customer_id as string | null;
    if (!stripeCustomerId) {
      const created = await stripe.customers.create({
        email: user.email,
        metadata: { shs_customer_id: customer.id },
      });
      stripeCustomerId = created.id;
      await serviceClient.from("customers").update({ stripe_customer_id: stripeCustomerId }).eq("id", customer.id);
      logStep("Stripe customer created", { stripeCustomerId });
    }

    // Resolve the recurring price by lookup_key (env-agnostic).
    const prices = await stripe.prices.list({
      lookup_keys: [PRICE_LOOKUP_KEY],
      active: true,
      limit: 1,
    });
    const price = prices.data[0];
    if (!price) throw new Error(`Subscription price (lookup_key ${PRICE_LOOKUP_KEY}) not found`);

    const subscription = await stripe.subscriptions.create({
      customer: stripeCustomerId,
      items: [{ price: price.id }],
      payment_behavior: "default_incomplete",
      payment_settings: { save_default_payment_method: "on_subscription" },
      expand: ["latest_invoice.payment_intent"],
    });

    await serviceClient
      .from("customers")
      .update({ stripe_subscription_id: subscription.id })
      .eq("id", customer.id);

    // deno-lint-ignore no-explicit-any
    const latestInvoice = subscription.latest_invoice as any;
    const clientSecret: string | null = latestInvoice?.payment_intent?.client_secret ?? null;
    if (!clientSecret) throw new Error("No client secret on the subscription's first invoice");

    logStep("Subscription created", { subscriptionId: subscription.id });
    return new Response(JSON.stringify({ subscriptionId: subscription.id, clientSecret }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: msg });
    return new Response(JSON.stringify({ error: msg }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
