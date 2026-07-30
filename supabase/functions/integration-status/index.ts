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
    if (!auth.ok) return json({ error: auth.error }, auth.status);

    return json({
      subscription_active: auth.subscriptionActive,
      subscription_expires_at: auth.subscriptionExpiresAt,
      customer_name: auth.customerName,
      server_time: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[INTEGRATION-STATUS] unexpected", error);
    return json({ error: "internal_error" }, 500);
  }
});
