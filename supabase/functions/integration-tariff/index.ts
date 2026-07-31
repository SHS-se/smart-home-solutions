// Delivers the staff-selected, effective-dated tariff catalogue to a paired
// Home Assistant device. Customers never configure or publish this data;
// service-role reads intentionally bypass the staff-only catalogue policies.

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
  if (req.method !== "GET") {
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
    if (!auth.subscriptionActive) {
      return json({ error: "subscription_inactive" }, 402);
    }

    const { data: assignments, error: assignmentError } = await supabase
      .from("customer_energy_tariff_assignments")
      .select("id, profile_id, valid_from, valid_to, configuration")
      .eq("customer_id", auth.customerId)
      .order("valid_from", { ascending: true });

    if (assignmentError) {
      console.error("[INTEGRATION-TARIFF] assignment lookup failed", assignmentError);
      return json({ error: "tariff_lookup_failed" }, 500);
    }

    const profileIds = Array.from(
      new Set((assignments ?? []).map((assignment) => assignment.profile_id)),
    );
    if (profileIds.length === 0) {
      return json({
        schema_version: 1,
        calculation_version: 1,
        timezone: "Europe/Stockholm",
        assignments: [],
        profiles: [],
      });
    }

    const [{ data: profiles, error: profileError }, { data: versions, error: versionError }] =
      await Promise.all([
        supabase
          .from("energy_tariff_profiles")
          .select("id, provider_key, tariff_key, provider_name, display_name, currency")
          .in("id", profileIds)
          .order("provider_key", { ascending: true })
          .order("tariff_key", { ascending: true }),
        supabase
          .from("energy_tariff_versions")
          .select(
            "id, profile_id, revision, valid_from, valid_to, calculation_model, definition, source_url, published_at",
          )
          .in("profile_id", profileIds)
          .order("valid_from", { ascending: true }),
      ]);

    if (profileError || versionError) {
      console.error("[INTEGRATION-TARIFF] catalogue lookup failed", {
        profileError,
        versionError,
      });
      return json({ error: "tariff_lookup_failed" }, 500);
    }

    return json({
      schema_version: 1,
      calculation_version: 1,
      timezone: "Europe/Stockholm",
      assignments: assignments ?? [],
      profiles: (profiles ?? []).map((profile) => ({
        ...profile,
        versions: (versions ?? []).filter((version) => version.profile_id === profile.id),
      })),
    });
  } catch (error) {
    console.error("[INTEGRATION-TARIFF] unexpected", error);
    return json({ error: "internal_error" }, 500);
  }
});
