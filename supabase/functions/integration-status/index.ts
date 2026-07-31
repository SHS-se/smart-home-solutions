// Lightweight status endpoint for the SHS Home Assistant integration.
// Device-token authenticated. The integration polls this (default 12 h) to
// know whether the subscription is active, and raises/clears an HA repair
// issue accordingly. Reads only the webhook-synced customers columns —
// no Stripe round-trip.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { authenticateDevice } from "../_shared/ha-device-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "GET" && req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  try {
    const auth = await authenticateDevice(supabase, req);
    if (auth.ok === false) return json({ error: auth.error }, auth.status);

    const today = new Date().toISOString().slice(0, 10);
    const { data: tariffAssignment, error: tariffError } = await supabase
      .from("customer_energy_tariff_assignments")
      .select("id")
      .eq("customer_id", auth.customerId)
      .lte("valid_from", today)
      .or(`valid_to.is.null,valid_to.gte.${today}`)
      .limit(1)
      .maybeSingle();
    if (tariffError) {
      console.error("[INTEGRATION-STATUS] tariff lookup failed", tariffError);
      return json({ error: "status_lookup_failed" }, 500);
    }

    return json({
      subscription_active: auth.subscriptionActive,
      subscription_expires_at: auth.subscriptionExpiresAt,
      customer_name: auth.customerName,
      tariff_configured: Boolean(tariffAssignment),
      server_time: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[INTEGRATION-STATUS] unexpected", error);
    return json({ error: "internal_error" }, 500);
  }
});
