// Exchanges a single-use pairing code (generated in the portal) for a
// long-lived device token. Called by the SHS Home Assistant integration's
// config flow — unauthenticated by design; the pairing code IS the credential.
//
// Brute-force resistance: codes are 8 chars from a 31-char alphabet
// (~5e11 combinations), valid 10 minutes, single-use, and consumed atomically.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import {
  DEVICE_TOKEN_PREFIX,
  randomHex,
  sha256Hex,
} from "../_shared/ha-device-auth.ts";

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
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  try {
    let code = "";
    let deviceName = "Home Assistant";
    try {
      const body = await req.json();
      code = String(body?.code ?? "").trim().toUpperCase();
      if (typeof body?.device_name === "string" && body.device_name.trim()) {
        deviceName = body.device_name.trim().slice(0, 100);
      }
    } catch {
      return json({ error: "invalid_body" }, 400);
    }

    if (!/^[A-Z2-9]{8}$/.test(code)) {
      return json({ error: "invalid_code_format" }, 400);
    }

    const codeHash = await sha256Hex(code);

    // Atomic consume: only one caller can flip used_at from NULL.
    const { data: consumed, error: consumeError } = await supabase
      .from("ha_pairing_codes")
      .update({ used_at: new Date().toISOString() })
      .eq("code_hash", codeHash)
      .is("used_at", null)
      .gt("expires_at", new Date().toISOString())
      .select("id, customer_id, home_id")
      .maybeSingle();

    if (consumeError) {
      console.error("[PAIR-DEVICE] code consume failed", consumeError);
      return json({ error: "pairing_failed" }, 500);
    }
    if (!consumed) {
      return json({ error: "invalid_or_expired_code" }, 401);
    }

    const deviceToken = DEVICE_TOKEN_PREFIX + randomHex(32);
    const { data: tokenRow, error: tokenError } = await supabase
      .from("ha_device_tokens")
      .insert({
        customer_id: consumed.customer_id,
        home_id: consumed.home_id,
        device_name: deviceName,
        token_hash: await sha256Hex(deviceToken),
      })
      .select("id")
      .single();

    if (tokenError || !tokenRow) {
      console.error("[PAIR-DEVICE] token insert failed", tokenError);
      return json({ error: "pairing_failed" }, 500);
    }

    const { data: customer } = await supabase
      .from("customers")
      .select("subscription_active, subscription_expires_at")
      .eq("id", consumed.customer_id)
      .maybeSingle();

    // Name lives on the linked contact, exposed via this view; best-effort.
    const { data: identity } = await supabase
      .from("customers_with_identity")
      .select("name")
      .eq("id", consumed.customer_id)
      .maybeSingle();

    return json({
      device_token: deviceToken,
      device_token_id: tokenRow.id,
      home_id: consumed.home_id,
      customer_name: identity?.name ?? null,
      subscription_active: Boolean(customer?.subscription_active),
    });
  } catch (error) {
    console.error("[PAIR-DEVICE] unexpected", error);
    return json({ error: "internal_error" }, 500);
  }
});
