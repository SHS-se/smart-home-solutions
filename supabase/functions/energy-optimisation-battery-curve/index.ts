import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { withTrafficMetrics } from "../_shared/edge-traffic.ts";
import { handleBatteryCostCurve } from "../_shared/battery-cost-portal.ts";
import { resolveCostCurve } from "../_shared/battery-cost-selection.ts";
import {
  resolveValueCurves,
  resolveValueSettings,
} from "../_shared/planner/value-curves.ts";
import type { OptimisationSnapshot } from "../_shared/planner/energy-optimisation.ts";

Deno.serve(
  withTrafficMetrics(
    "energy-optimisation-battery-curve",
    (request, traffic) => {
      const url = Deno.env.get("SUPABASE_URL") ?? "";
      const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
      return handleBatteryCostCurve(request, {
        async readHome(authorization, homeId) {
          if (!url || !anonKey || !serviceKey) {
            throw new Error("Battery curve endpoint is not configured");
          }
          const caller = createClient(url, anonKey, {
            global: {
              headers: { Authorization: authorization },
              fetch: traffic.fetch,
            },
            auth: { persistSession: false },
          });
          // The same subscription and customer/home RLS as the replan endpoint.
          const current = await caller.from("energy_optimisation_current")
            .select("customer_id,snapshot").eq("home_id", homeId).maybeSingle();
          if (current.error) {
            throw new Error(`Home read failed: ${current.error.message}`);
          }
          if (!current.data) return null;
          const [curves, settings] = await Promise.all([
            caller.from("energy_optimisation_value_curves")
              .select(
                "store_key,unit,points,max_value_sek_per_kwh,urgent_price_multiplier",
              )
              .eq("home_id", homeId),
            caller.from("energy_optimisation_value_settings")
              .select(
                "battery_degradation_sek_per_kwh,vehicle_fallback_sek_per_km",
              )
              .eq("home_id", homeId).maybeSingle(),
          ]);
          if (curves.error) {
            throw new Error(`Curve read failed: ${curves.error.message}`);
          }
          if (settings.error) {
            throw new Error(`Settings read failed: ${settings.error.message}`);
          }
          const resolved = resolveValueCurves(curves.data ?? []);
          if (resolved.warnings.length) {
            throw new Error(resolved.warnings.join("; "));
          }
          const snapshot: OptimisationSnapshot = {
            ...current.data.snapshot,
            battery_cost_curve: undefined,
            value_curves: {
              pool: resolved.curves.pool.curve,
              ev: resolved.curves.ev.curve,
              ...(resolved.curves.battery
                ? { battery: resolved.curves.battery.curve }
                : {}),
            },
            value_settings: resolveValueSettings(settings.data),
          };
          return {
            customerId: current.data.customer_id,
            input: { snapshot, now: new Date().toISOString() },
          };
        },
        async resolve(homeId, home) {
          const service = createClient(url, serviceKey, {
            global: { fetch: traffic.fetch },
            auth: { persistSession: false },
          });
          return await resolveCostCurve(
            service,
            homeId,
            home.customerId,
            home.input,
            {
              url,
              planningSecret: Deno.env.get("ENERGY_PLANNING_SECRET") ?? "",
              requestId: request.headers.get("x-request-id") ??
                crypto.randomUUID(),
            },
            traffic.fetch,
          );
        },
      });
    },
  ),
);
