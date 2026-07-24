import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getAppEnvironment } from "../_shared/app-env.ts";
import { getStripe } from "../_shared/stripe-client.ts";
import { entitlementFromSubscription } from "../_shared/subscription-entitlement.ts";
import { cardExpiryStatus } from "../_shared/card-expiry.ts";
import {
  loadActiveSubscriptionProduct,
  subscriptionProductFromSubscription,
} from "../_shared/subscription-product.ts";

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
    const appEnv = getAppEnvironment();
    logStep("Function started", { environment: appEnv });

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header provided");

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError) throw new Error(`Authentication error: ${userError.message}`);
    const user = userData.user;
    if (!user?.email) throw new Error("User not authenticated or email not available");
    logStep("User authenticated", { userId: user.id });

    // Parse optional customer_id from request body
    let customerIdParam: string | null = null;
    try {
      const body = await req.json();
      customerIdParam = body?.customer_id || null;
    } catch {
      // No body or invalid JSON
    }

    let customerId: string | null = null;

    if (customerIdParam) {
      // Verify caller is staff
      const { data: staffRow } = await supabaseClient
        .from("staff_users")
        .select("user_id")
        .eq("user_id", user.id)
        .maybeSingle();

      if (!staffRow) throw new Error("Only staff can look up customer subscriptions");
      customerId = customerIdParam;
    } else {
      // Look up the customer for this user
      const { data: custRow } = await supabaseClient
        .from("customers")
        .select("id")
        .eq("user_id", user.id)
        .maybeSingle();

      customerId = custRow?.id || null;
    }

    if (!customerId) {
      logStep("No customer found");
      return new Response(JSON.stringify({ subscribed: false }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    // Read internal entitlement from customers table. When a Stripe
    // subscription is attached, Stripe is the source of truth and this row is
    // synced below.
    const { data: customer } = await supabaseClient
      .from("customers")
      .select("subscription_active, subscription_expires_at, subscription_cancel_at_period_end, stripe_subscription_id")
      .eq("id", customerId)
      .single();

    if (!customer) {
      const product = await loadActiveSubscriptionProduct(getStripe());
      return new Response(JSON.stringify({ subscribed: false, product }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    const stripe = getStripe();
    const activeProduct = await loadActiveSubscriptionProduct(stripe);

    if (customer.stripe_subscription_id) {
      const subscription = await stripe.subscriptions.retrieve(customer.stripe_subscription_id, {
        expand: ["items.data.price.product", "default_payment_method"],
      });
      const entitlement = entitlementFromSubscription(subscription);
      await supabaseClient
        .from("customers")
        .update({ ...entitlement, stripe_subscription_id: subscription.id })
        .eq("id", customerId);

      const product = entitlement.subscription_active
        ? subscriptionProductFromSubscription(subscription) ?? activeProduct
        : activeProduct;

      // Saved card summary (brand/last4/expiry) so the portal can show the
      // card on file and warn before an expired card kills a renewal. Only
      // non-sensitive display fields ever leave this function.
      // deno-lint-ignore no-explicit-any
      const pm = subscription.default_payment_method as any;
      const card = pm && typeof pm === "object" ? pm.card : null;
      const paymentMethod = card
        ? {
            brand: card.brand ?? null,
            last4: card.last4 ?? null,
            exp_month: card.exp_month ?? null,
            exp_year: card.exp_year ?? null,
            expiry_status:
              typeof card.exp_month === "number" && typeof card.exp_year === "number"
                ? cardExpiryStatus({
                    expMonth: card.exp_month,
                    expYear: card.exp_year,
                    now: new Date(),
                    renewalAt: entitlement.subscription_expires_at,
                  })
                : null,
          }
        : null;

      logStep("Subscription checked from Stripe", {
        customerId,
        active: entitlement.subscription_active,
        expiresAt: entitlement.subscription_expires_at,
      });

      return new Response(JSON.stringify({
        subscribed: entitlement.subscription_active,
        subscription_end: entitlement.subscription_expires_at,
        cancel_at_period_end: entitlement.subscription_cancel_at_period_end,
        product,
        payment_method: paymentMethod,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    const isActive = customer.subscription_active &&
      (!customer.subscription_expires_at || new Date(customer.subscription_expires_at) > new Date());

    logStep("Subscription check", { customerId, active: isActive, expiresAt: customer.subscription_expires_at });

    return new Response(JSON.stringify({
      subscribed: isActive,
      subscription_end: customer.subscription_expires_at || null,
      cancel_at_period_end: customer.subscription_cancel_at_period_end ?? false,
      product: activeProduct,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: errorMessage });
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
