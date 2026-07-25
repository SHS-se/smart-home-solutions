// Undoes a customer's pending cancellation: clears cancel_at_period_end so the
// subscription renews as normal again. Only works while the subscription is
// still active (a fully ended subscription can't be resumed — the customer
// starts a new one via create-subscription instead).
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getAppEnvironment } from "../_shared/app-env.ts";
import { getStripe } from "../_shared/stripe-client.ts";
import {
  loadNoticeCustomer,
  sendSubscriptionStaffNotice,
} from "../_shared/subscription-staff-notice.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[RESUME-SUBSCRIPTION] ${step}${detailsStr}`);
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
    getAppEnvironment();
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header provided");
    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await anonClient.auth.getUser(token);
    if (userError) throw new Error(`Authentication error: ${userError.message}`);
    const user = userData.user;
    if (!user) throw new Error("User not authenticated");

    const { data: customer } = await serviceClient
      .from("customers")
      .select("id, stripe_subscription_id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!customer?.stripe_subscription_id) throw new Error("No subscription to resume");

    const stripe = getStripe();
    const subscription = await stripe.subscriptions.retrieve(customer.stripe_subscription_id);
    if (subscription.status === "canceled") {
      // Period already ran out — resuming is impossible; the UI offers a fresh
      // subscribe flow in this state.
      return new Response(
        JSON.stringify({
          error: "Prenumerationen har redan avslutats. Starta en ny prenumeration istället.",
          code: "already_ended",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 },
      );
    }

    await stripe.subscriptions.update(customer.stripe_subscription_id, {
      cancel_at_period_end: false,
    });

    await serviceClient
      .from("customers")
      .update({ subscription_cancel_at_period_end: false })
      .eq("id", customer.id);

    logStep("Subscription resumed", { subscriptionId: customer.stripe_subscription_id });

    // Counterpart to the cancellation notice — without it the sales inbox keeps
    // showing a churn that the customer already took back.
    const periodEnd = (subscription as { current_period_end?: number | null }).current_period_end;
    await sendSubscriptionStaffNotice({
      event: "resumed",
      customer: await loadNoticeCustomer(serviceClient, customer.id),
      date: typeof periodEnd === "number"
        ? new Date(periodEnd * 1000).toISOString().slice(0, 10)
        : null,
    });

    return new Response(JSON.stringify({ success: true }), {
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
