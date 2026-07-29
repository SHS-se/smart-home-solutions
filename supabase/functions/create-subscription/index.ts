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
import { SUBSCRIPTION_PRICE_LOOKUP_KEY } from "../_shared/subscription-product.ts";
import { stripeCustomerIdentity } from "../_shared/stripe-customer-identity.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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
      .select(
        "id, stripe_customer_id, subscription_active, billing_same_as_site, site_street, site_postcode, site_city, billing_street, billing_postcode, billing_city",
      )
      .eq("user_id", user.id)
      .maybeSingle();
    if (!customer) throw new Error("No customer record for this user");
    if (customer.subscription_active) {
      return new Response(JSON.stringify({ alreadySubscribed: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    // Buyer details are required for a valid invoice (name + billing address).
    const { data: identity } = await serviceClient
      .from("customers_with_identity")
      .select("contact_name")
      .eq("id", customer.id)
      .maybeSingle();
    // Doubles as the Stripe-side identity: same name and address, published so
    // the buyer is visible in Stripe too, not only on our own invoice.
    const buyer = stripeCustomerIdentity(identity?.contact_name, customer);
    if (!buyer) {
      return new Response(
        JSON.stringify({
          error: "Komplettera ditt namn och din faktureringsadress innan du startar prenumerationen.",
          code: "incomplete_customer_details",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 },
      );
    }

    const stripe = getStripe();

    // Reuse one Stripe Customer per customer.
    let stripeCustomerId = customer.stripe_customer_id as string | null;
    if (!stripeCustomerId) {
      const created = await stripe.customers.create({
        email: user.email,
        ...buyer,
        metadata: { shs_customer_id: customer.id },
      });
      stripeCustomerId = created.id;
      await serviceClient.from("customers").update({ stripe_customer_id: stripeCustomerId }).eq("id", customer.id);
      logStep("Stripe customer created", { stripeCustomerId });
    } else {
      // Existing Stripe customer: refresh it, both to pick up a rename since the
      // last subscription and to fill in customers created before we sent any of
      // this. Advisory — a failure here must not block the subscription.
      try {
        await stripe.customers.update(stripeCustomerId, buyer);
        logStep("Stripe customer details refreshed", { stripeCustomerId });
      } catch (updateError) {
        logStep("Stripe customer refresh failed", {
          message: updateError instanceof Error ? updateError.message : String(updateError),
        });
      }
    }

    // Resolve the recurring price by lookup_key (env-agnostic).
    const prices = await stripe.prices.list({
      lookup_keys: [SUBSCRIPTION_PRICE_LOOKUP_KEY],
      active: true,
      limit: 1,
    });
    const price = prices.data[0];
    if (!price) {
      throw new Error(`Subscription price (lookup_key ${SUBSCRIPTION_PRICE_LOOKUP_KEY}) not found`);
    }

    const subscription = await stripe.subscriptions.create({
      customer: stripeCustomerId,
      items: [{ price: price.id }],
      payment_behavior: "default_incomplete",
      payment_settings: {
        save_default_payment_method: "on_subscription",
        // Card only. Explicit types override the account's dynamic payment
        // methods, so Link / Klarna / Amazon Pay never appear in this flow
        // regardless of dashboard settings — the Payment Element renders as a
        // plain card form (fields stay in Stripe's iframe; PCI unchanged).
        payment_method_types: ["card"],
        // NO request_three_d_secure here: subscription-level payment_settings
        // apply to EVERY invoice, and an off-session renewal that is forced
        // into 3DS fails with requires_action (nobody is present to complete
        // the challenge) and drives the subscription past_due. 3DS is instead
        // requested on the first PaymentIntent below, where the customer is
        // on-session; renewals ride the merchant-initiated exemption that the
        // authenticated first payment establishes.
      },
      expand: ["latest_invoice.payment_intent"],
    });

    await serviceClient
      .from("customers")
      .update({ stripe_subscription_id: subscription.id })
      .eq("id", customer.id);

    // deno-lint-ignore no-explicit-any
    const latestInvoice = subscription.latest_invoice as any;
    const paymentIntent = latestInvoice?.payment_intent ?? null;
    const clientSecret: string | null = paymentIntent?.client_secret ?? null;
    if (!clientSecret) throw new Error("No client secret on the subscription's first invoice");

    // Always request 3DS on the first, on-session payment (BankID for Swedish
    // banks). Scoped to this PaymentIntent only — see payment_settings above.
    await stripe.paymentIntents.update(paymentIntent.id, {
      payment_method_options: { card: { request_three_d_secure: "any" } },
    });

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
