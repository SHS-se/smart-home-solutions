// After the customer saves a new card via a SetupIntent, make it the default for
// the customer + their subscription, and immediately retry any open/past-due
// invoice so a failed renewal recovers without waiting for Stripe's next retry.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getAppEnvironment } from "../_shared/app-env.ts";
import { getStripe } from "../_shared/stripe-client.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[SET-DEFAULT-PAYMENT-METHOD] ${step}${detailsStr}`);
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

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

    const { payment_method_id } = await req.json().catch(() => ({}));
    if (!payment_method_id) throw new Error("payment_method_id is required");

    const { data: customer } = await serviceClient
      .from("customers")
      .select("stripe_customer_id, stripe_subscription_id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!customer?.stripe_customer_id) throw new Error("No Stripe customer for this user");

    const stripe = getStripe();

    // Make the new card the default for the customer.
    await stripe.customers.update(customer.stripe_customer_id, {
      invoice_settings: { default_payment_method: payment_method_id },
    });

    // ...and for the subscription, then retry any open invoice immediately.
    if (customer.stripe_subscription_id) {
      await stripe.subscriptions.update(customer.stripe_subscription_id, {
        default_payment_method: payment_method_id,
      });
      const sub = await stripe.subscriptions.retrieve(customer.stripe_subscription_id, {
        expand: ["latest_invoice"],
      });
      // deno-lint-ignore no-explicit-any
      const latest = sub.latest_invoice as any;
      if (latest && (latest.status === "open" || latest.status === "past_due")) {
        try {
          await stripe.invoices.pay(latest.id);
          logStep("Retried open invoice", { invoiceId: latest.id });
        } catch (payErr) {
          // Card may still be declined; Stripe keeps retrying on schedule.
          logStep("Immediate retry failed (will retry on schedule)", {
            message: payErr instanceof Error ? payErr.message : String(payErr),
          });
        }
      }
    }

    logStep("Default payment method updated");
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
