import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { authenticateDevice } from "../_shared/ha-device-auth.ts";
import { HA_API_CORS_HEADERS } from "../_shared/ha-api-contract.ts";
import { withTrafficMetrics } from "../_shared/edge-traffic.ts";
import {
  handleBatteryPolicyExchange,
  type StoredBatteryGeneration,
} from "../_shared/battery-policy-exchange.ts";
import { compileBatteryExecutionPolicy } from "../_shared/battery-execution-policy.ts";

Deno.serve(
  withTrafficMetrics("energy-battery-policy", async (request, traffic) => {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: HA_API_CORS_HEADERS });
    }
    const db = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false }, global: { fetch: traffic.fetch } },
    );
    try {
      const result = await handleBatteryPolicyExchange(request, {
        authenticate: async (req) => {
          const auth = await authenticateDevice(db, req);
          return auth.ok
            ? {
              homeId: auth.homeId,
              subscriptionActive: auth.subscriptionActive,
            }
            : null;
        },
        load: async (homeId) => {
          const { data, error } = await db.from("energy_optimisation_current")
            .select(
              "plan_id,snapshot_id,ha_ack_status,plan,battery_projection,fixed_plan_revision,fixed_plan_generation_revision",
            )
            .eq("home_id", homeId).maybeSingle();
          if (error) throw new Error("policy_source_unavailable");
          return data as StoredBatteryGeneration | null;
        },
        compile: (request) =>
          Promise.resolve(compileBatteryExecutionPolicy(request)),
        now: Date.now,
      });
      for (const [key, value] of Object.entries(HA_API_CORS_HEADERS)) {
        result.headers.set(key, value);
      }
      return result;
    } catch (error) {
      console.error(
        "[BATTERY-POLICY] exchange failed",
        error instanceof Error ? error.message : "unknown",
      );
      return Response.json({ error: "policy_exchange_failed" }, {
        status: 503,
        headers: HA_API_CORS_HEADERS,
      });
    }
  }),
);
