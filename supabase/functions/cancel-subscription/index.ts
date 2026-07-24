// Self-serve cancel for the logged-in portal customer: sets the Stripe
// subscription to cancel at period end (access retained until then). The
// stripe-webhook then syncs the entitlement flags; we also set the local flag
// immediately so the UI reflects it without waiting for the webhook.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getAppEnvironment } from "../_shared/app-env.ts";
import { getStripe } from "../_shared/stripe-client.ts";
import { sendCancelConfirmationEmail } from "../_shared/subscription-emails.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[CANCEL-SUBSCRIPTION] ${step}${detailsStr}`);
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
      .select("id, stripe_subscription_id, subscription_cancel_at_period_end")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!customer?.stripe_subscription_id) throw new Error("No active subscription to cancel");
    const alreadyCanceling = customer.subscription_cancel_at_period_end === true;

    const stripe = getStripe();
    const updated = await stripe.subscriptions.update(customer.stripe_subscription_id, {
      cancel_at_period_end: true,
    });

    await serviceClient
      .from("customers")
      .update({ subscription_cancel_at_period_end: true })
      .eq("id", customer.id);

    logStep("Subscription set to cancel at period end", { subscriptionId: customer.stripe_subscription_id });

    // Confirm the cancellation by email (the only email for a voluntary cancel;
    // the webhook stays silent when the period later runs out). Skipped on
    // repeat calls, and a send failure must not fail the completed cancel.
    if (!alreadyCanceling) {
      const { data: identity } = await serviceClient
        .from("customers_with_identity")
        .select("contact_email, contact_name")
        .eq("id", customer.id)
        .maybeSingle();
      const email = (identity as { contact_email: string | null } | null)?.contact_email;
      if (email) {
        const periodEnd = (updated as { current_period_end?: number | null }).current_period_end;
        const accessUntil = typeof periodEnd === "number"
          ? new Date(periodEnd * 1000).toISOString().slice(0, 10)
          : null;
        try {
          await sendCancelConfirmationEmail(
            email,
            (identity as { contact_name: string | null } | null)?.contact_name ?? null,
            accessUntil,
          );
          logStep("Cancel confirmation email sent");
        } catch (emailError) {
          logStep("Cancel confirmation email failed", {
            message: emailError instanceof Error ? emailError.message : String(emailError),
          });
        }
      }
    }
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
