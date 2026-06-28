import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getAppEnvironment } from "../_shared/app-env.ts";

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

    // Read internal entitlement from customers table
    const { data: customer } = await supabaseClient
      .from("customers")
      .select("subscription_active, subscription_expires_at, subscription_cancel_at_period_end")
      .eq("id", customerId)
      .single();

    if (!customer) {
      return new Response(JSON.stringify({ subscribed: false }), {
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
