// Home Assistant's explicit accept/reject acknowledgement for one generated
// optimisation plan. Generation and local executability are separate states.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { authenticateDevice } from "../_shared/ha-device-auth.ts";
import {
  HA_API_CORS_HEADERS,
  HA_API_VERSION,
  HA_SUPPORTED_PLAN_SCHEMA_VERSIONS,
  haApiResponse,
  haRequestId,
} from "../_shared/ha-api-contract.ts";

interface Rejection {
  code: string;
  message: string;
  path: string | null;
  details: unknown;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

serve(async (request) => {
  const requestId = haRequestId(request);
  const json = (body: unknown, status = 200) =>
    haApiResponse(requestId, body, status);
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: HA_API_CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  try {
    const auth = await authenticateDevice(supabase, request);
    if (auth.ok === false) return json({ error: auth.error }, auth.status);
    if (!auth.subscriptionActive) {
      return json({ error: "subscription_inactive" }, 402);
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_body" }, 400);
    }

    const outcome = body.outcome;
    const planSchemaVersion = body.plan_schema_version;
    const integrationVersion = body.integration_version;
    const rejection = body.error as Rejection | null | undefined;
    if (
      body.api_version !== HA_API_VERSION ||
      typeof body.plan_id !== "string" || !UUID.test(body.plan_id) ||
      typeof body.snapshot_id !== "string" || !UUID.test(body.snapshot_id) ||
      !HA_SUPPORTED_PLAN_SCHEMA_VERSIONS.includes(
        planSchemaVersion as 5 | 6,
      ) ||
      typeof integrationVersion !== "string" ||
      integrationVersion.length < 1 || integrationVersion.length > 100 ||
      (outcome !== "accepted" && outcome !== "rejected") ||
      (outcome === "accepted" && rejection != null) ||
      (outcome === "rejected" && (
        !rejection || typeof rejection !== "object" ||
        typeof rejection.code !== "string" || rejection.code.length < 1 ||
        typeof rejection.message !== "string" || rejection.message.length < 1 ||
        (rejection.path !== null && typeof rejection.path !== "string")
      ))
    ) {
      return json({ error: "invalid_body" }, 400);
    }

    const acknowledgedAt = new Date().toISOString();
    const { data: acknowledged, error } = await supabase.rpc(
      "acknowledge_energy_optimisation_plan",
      {
        p_home_id: auth.homeId,
        p_plan_id: body.plan_id,
        p_snapshot_id: body.snapshot_id,
        p_plan_schema_version: planSchemaVersion,
        p_ack_status: outcome,
        p_acknowledged_at: acknowledgedAt,
        p_integration_version: integrationVersion,
        p_ack_request_id: requestId,
        p_ack_error: outcome === "rejected" ? rejection : null,
      },
    );
    if (error) {
      console.error("[ENERGY-OPTIMISATION-ACK] update failed", error);
      return json({ error: "storage_failed" }, 500);
    }
    if (!acknowledged) {
      return json({
        error: "stale_plan_ack",
        path: "plan_id",
        details: { plan_id: body.plan_id, snapshot_id: body.snapshot_id },
      }, 409);
    }

    return json({
      plan_id: body.plan_id,
      snapshot_id: body.snapshot_id,
      outcome,
      acknowledged_at: acknowledgedAt,
    });
  } catch (error) {
    console.error("[ENERGY-OPTIMISATION-ACK] unexpected", error);
    return json({ error: "internal_error" }, 500);
  }
});
