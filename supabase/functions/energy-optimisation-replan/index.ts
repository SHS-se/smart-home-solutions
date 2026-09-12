import { withTrafficMetrics } from "../_shared/edge-traffic.ts";
// Ask the house for a plan built on measurements taken from now.
//
// This used to re-solve the snapshot already on file with the current curves.
// The reasoning was that a curve change is a change to *how* the planner values
// things rather than to what it knows about the house, so the stored
// measurements were still the right ones — and waiting for Home Assistant's
// next push made a preference you cannot observe impossible to tune.
//
// It does not survive contact with the freshness rule. The stored snapshot is
// only replaced when Home Assistant pushes one, so for most of every quarter it
// was already older than the planner's fifteen-minute limit and the button
// answered `captured_at must describe a fresh snapshot`. That is not a bug in
// the limit: a plan is a set of commitments about the next few hours, and one
// solved against measurements of unknown age is not worth publishing.
//
// So the request is recorded and the house answers it on the ordinary ingest
// path. That is one planning route rather than two, which also settles what
// used to be quietly missing here: the thermal projection, the plan-run
// history, and Home Assistant's acknowledgement that it can execute the plan.
// The reply below is therefore an acknowledgement of the request, not a plan.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

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

serve(withTrafficMetrics("energy-optimisation-replan", async (request, traffic) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  // Everything is inside one guard so a fault is reported rather than escaping
  // as an opaque runtime envelope. The first failure of this endpoint returned
  // a bare 500 with no message, which said nothing about where it broke.
  try {
    const authorization = request.headers.get("Authorization");
    if (!authorization) return json({ error: "unauthorized" }, 401);

    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!url || !anonKey || !serviceKey) {
      console.error("[ENERGY-REPLAN] missing environment configuration");
      return json({ error: "not_configured" }, 500);
    }

    let homeId: string;
    try {
      const body = await request.json();
      homeId = String(body?.home_id ?? "");
      if (!homeId) return json({ error: "home_id_required" }, 400);
    } catch {
      return json({ error: "invalid_body" }, 400);
    }

    // Authorise with the caller's own token: a row-level-security-checked read
    // is what proves they may touch this home.
    const asCaller = createClient(url, anonKey, {
      global: { headers: { Authorization: authorization }, fetch: traffic.fetch },
      auth: { persistSession: false },
    });
    const { data: readable, error: readError } = await asCaller
      .from("energy_optimisation_current")
      .select("home_id")
      .eq("home_id", homeId)
      .maybeSingle();
    if (readError) {
      console.error("[ENERGY-REPLAN] authorisation read failed", readError);
      return json({ error: "read_failed", detail: readError.message }, 500);
    }
    if (!readable) return json({ error: "not_found" }, 404);

    // Then write as the service role. `energy_optimisation_current` carries a
    // read policy for subscribers and no write policy at all — it is the
    // device's table — so an update with the caller's token silently matches no
    // rows and the replan appears to succeed while changing nothing.
    const service = createClient(url, serviceKey, {
      global: { fetch: traffic.fetch },
      auth: { persistSession: false },
    });

    // One request per home at a time: a second click while one is outstanding
    // returns the same id rather than queueing a request the house would answer
    // twice with the same measurements.
    const { data: queuedId, error: queueError } = await service.rpc(
      "request_energy_optimisation_replan",
      { p_home_id: homeId },
    );
    if (queueError) {
      console.error("[ENERGY-REPLAN] queue failed", queueError);
      return json({ error: "storage_failed", detail: queueError.message }, 500);
    }
    return json({ status: "queued", replan_request_id: queuedId }, 202);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[ENERGY-REPLAN] unhandled", detail, error);
    return json({ error: "replan_failed", detail }, 500);
  }
}));
