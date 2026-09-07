// Lightweight status endpoint for the SHS Home Assistant integration.
// Device-token authenticated. The integration polls this to know whether the
// subscription is active, and raises/clears an HA repair issue accordingly.
// Reads only the webhook-synced customers columns — no Stripe round-trip.
//
// It is also where a replan the household asked for is handed to the device,
// and where the device reports that it could not produce one. Both belong on
// the poll the integration already makes rather than on a channel of their own.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { authenticateDevice } from "../_shared/ha-device-auth.ts";
import {
  HA_API_CORS_HEADERS,
  HA_API_VERSION,
  HA_MINIMUM_PLAN_SCHEMA_VERSION,
  HA_MINIMUM_SNAPSHOT_SCHEMA_VERSION,
  HA_SUPPORTED_PLAN_SCHEMA_VERSIONS,
  HA_SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS,
  HA_UUID,
  haApiResponse,
  haRequestId,
  pendingReplanRequestId,
} from "../_shared/ha-api-contract.ts";

// Long enough for a Home Assistant exception with its remedy, short enough that
// the column cannot be used as storage.
const MAX_REPLAN_ERROR_CHARS = 1000;

serve(async (req) => {
  const requestId = haRequestId(req);
  const json = (body: unknown, status = 200) =>
    haApiResponse(requestId, body, status);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: HA_API_CORS_HEADERS });
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

    // A device that cannot answer a replan says so here, so the portal reports
    // why instead of spinning until the person gives up. The failure is written
    // against its own request id: a late report must not bury a newer request,
    // and must not contradict a plan that has meanwhile arrived.
    if (req.method === "POST") {
      let body: Record<string, unknown>;
      try {
        body = await req.json();
      } catch {
        return json({ error: "invalid_body" }, 400);
      }
      if (body?.replan_request_id !== undefined) {
        const replanId = body.replan_request_id;
        const detail = body.error;
        if (
          typeof replanId !== "string" || !HA_UUID.test(replanId) ||
          typeof detail !== "string" || !detail.trim() ||
          detail.length > MAX_REPLAN_ERROR_CHARS
        ) {
          return json({ error: "invalid_replan_failure" }, 400);
        }
        const { error: failureError } = await supabase
          .from("energy_optimisation_current")
          .update({ replan_error: detail })
          .eq("home_id", auth.homeId)
          .eq("replan_request_id", replanId)
          .or(
            `replan_completed_request_id.is.null,` +
              `replan_completed_request_id.neq.${replanId}`,
          );
        if (failureError) {
          console.error(
            "[INTEGRATION-STATUS] replan failure write failed",
            failureError,
          );
          return json({ error: "storage_failed" }, 500);
        }
      }
    }

    const { data: current, error: currentError } = await supabase
      .from("energy_optimisation_current")
      .select(
        "generation_request_id, replan_request_id, " +
          "replan_completed_request_id, replan_error",
      )
      .eq("home_id", auth.homeId)
      .maybeSingle();
    if (currentError) {
      console.error(
        "[INTEGRATION-STATUS] plan request lookup failed",
        currentError,
      );
      return json({ error: "storage_failed" }, 500);
    }

    return json({
      api_version: HA_API_VERSION,
      supported_snapshot_schema_versions: HA_SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS,
      supported_plan_schema_versions: HA_SUPPORTED_PLAN_SCHEMA_VERSIONS,
      minimum_snapshot_schema_version: HA_MINIMUM_SNAPSHOT_SCHEMA_VERSION,
      minimum_plan_schema_version: HA_MINIMUM_PLAN_SCHEMA_VERSION,
      latest_plan_request_id: current?.generation_request_id ?? null,
      pending_replan_request_id: pendingReplanRequestId(current),
      subscription_active: auth.subscriptionActive,
      subscription_expires_at: auth.subscriptionExpiresAt,
      customer_name: auth.customerName,
      home_id: auth.homeId,
      server_time: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[INTEGRATION-STATUS] unexpected", error);
    return json({ error: "internal_error" }, 500);
  }
});
