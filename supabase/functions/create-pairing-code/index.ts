// Generates a short-lived, single-use pairing code for linking a Home
// Assistant instance. Called from the portal by a logged-in customer (or by
// staff on behalf of a customer via body.customer_id). Only the SHA-256 hash
// is stored; the plaintext code is shown once in the portal UI.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { sha256Hex } from "../_shared/ha-device-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const CODE_TTL_MINUTES = 10;
// No ambiguous characters (0/O, 1/I/L) — customers type this into HA by hand.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

function generateCode(): string {
  const buf = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length])
    .join("");
}

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
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "not_authenticated" }, 401);

    const jwt = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabase.auth.getUser(jwt);
    if (userError || !userData.user) {
      return json({ error: "not_authenticated" }, 401);
    }
    const user = userData.user;

    let requestedCustomerId: string | null = null;
    try {
      const body = await req.json();
      requestedCustomerId = body?.customer_id ?? null;
    } catch {
      // Empty body is fine.
    }

    let customerId: string | null = null;
    if (requestedCustomerId) {
      const { data: staffRow } = await supabase
        .from("staff_users")
        .select("user_id")
        .eq("user_id", user.id)
        .maybeSingle();
      if (!staffRow) {
        return json({ error: "staff_only_customer_override" }, 403);
      }
      customerId = requestedCustomerId;
    } else {
      const { data: custRow } = await supabase
        .from("customers")
        .select("id")
        .eq("user_id", user.id)
        .maybeSingle();
      customerId = custRow?.id ?? null;
    }
    if (!customerId) return json({ error: "no_customer" }, 404);

    const { data: customer } = await supabase
      .from("customers")
      .select("subscription_active, subscription_expires_at")
      .eq("id", customerId)
      .maybeSingle();

    const active = Boolean(customer?.subscription_active) &&
      (!customer?.subscription_expires_at ||
        new Date(customer.subscription_expires_at) > new Date());
    if (!active) return json({ error: "subscription_inactive" }, 402);

    // A new code supersedes any outstanding unused ones.
    await supabase
      .from("ha_pairing_codes")
      .update({ expires_at: new Date().toISOString() })
      .eq("customer_id", customerId)
      .is("used_at", null);

    const code = generateCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60_000)
      .toISOString();

    const { error: insertError } = await supabase
      .from("ha_pairing_codes")
      .insert({
        customer_id: customerId,
        code_hash: await sha256Hex(code),
        created_by: user.id,
        expires_at: expiresAt,
      });
    if (insertError) {
      console.error("[CREATE-PAIRING-CODE] insert failed", insertError);
      return json({ error: "code_creation_failed" }, 500);
    }

    return json({ code, expires_at: expiresAt });
  } catch (error) {
    console.error("[CREATE-PAIRING-CODE] unexpected", error);
    return json({ error: "internal_error" }, 500);
  }
});
