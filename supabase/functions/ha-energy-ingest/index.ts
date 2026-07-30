// Receives daily category-level kWh readings pushed by the SHS Home Assistant
// integration. Device-token authenticated; subscription-gated (402 when
// inactive so the integration can raise a repair issue and pause pushing).
// Upserts are idempotent per (customer, date, category), so the integration
// may safely retry and backfill.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { authenticateDevice } from "../_shared/ha-device-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const CATEGORIES = new Set([
  "heating",
  "hot_water",
  "cooling",
  "property_energy",
  "pool_heating",
  "ev_charging",
  "household",
  "grid_import",
  "grid_export",
  "solar_production",
  "total_consumption",
]);

const MAX_READINGS_PER_PUSH = 500; // ~45 days of full category backfill
const MAX_KWH_PER_READING = 10000; // sanity bound for a single day/category
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

interface IncomingReading {
  date: string;
  category: string;
  kwh: number;
}

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
    const auth = await authenticateDevice(supabase, req);
    if (!auth.ok) return json({ error: auth.error }, auth.status);
    if (!auth.subscriptionActive) {
      return json({ error: "subscription_inactive" }, 402);
    }

    let readings: IncomingReading[] = [];
    try {
      const body = await req.json();
      if (!Array.isArray(body?.readings)) throw new Error("no readings");
      readings = body.readings;
    } catch {
      return json({ error: "invalid_body" }, 400);
    }

    if (readings.length === 0) return json({ accepted: 0 });
    if (readings.length > MAX_READINGS_PER_PUSH) {
      return json({ error: "too_many_readings" }, 400);
    }

    const today = new Date().toISOString().slice(0, 10);
    const rows: Array<{
      customer_id: string;
      reading_date: string;
      category: string;
      kwh: number;
      device_token_id: string;
    }> = [];

    for (const r of readings) {
      const date = String(r?.date ?? "");
      const category = String(r?.category ?? "");
      const kwh = Number(r?.kwh);
      if (!DATE_RE.test(date) || date > today) {
        return json({ error: "invalid_date", detail: date }, 400);
      }
      if (!CATEGORIES.has(category)) {
        return json({ error: "invalid_category", detail: category }, 400);
      }
      if (!Number.isFinite(kwh) || kwh < 0 || kwh > MAX_KWH_PER_READING) {
        return json({ error: "invalid_kwh", detail: `${category} ${date}` }, 400);
      }
      rows.push({
        customer_id: auth.customerId,
        reading_date: date,
        category,
        kwh: Math.round(kwh * 1000) / 1000,
        device_token_id: auth.tokenId,
      });
    }

    const { error: upsertError } = await supabase
      .from("energy_device_readings")
      .upsert(rows, { onConflict: "customer_id,reading_date,category" });

    if (upsertError) {
      console.error("[HA-ENERGY-INGEST] upsert failed", upsertError);
      return json({ error: "storage_failed" }, 500);
    }

    return json({ accepted: rows.length });
  } catch (error) {
    console.error("[HA-ENERGY-INGEST] unexpected", error);
    return json({ error: "internal_error" }, 500);
  }
});
