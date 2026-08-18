// Rebuild the plan from the snapshot already on file, on request.
//
// A curve change is a change to *how* the planner values things, not to what it
// knows about the house. Waiting up to 45 minutes for Home Assistant's next
// replan to see the effect makes the editor unusable — you cannot tune a
// preference you cannot observe.
//
// So this re-runs the planner against the stored snapshot with the current
// curves. That is legitimate rather than a shortcut: the resulting plan is
// built from exactly the same measured state as the one it replaces, so it is
// never staler than what was already published. The freshness rule still
// applies — a snapshot older than the planner's limit is refused rather than
// planned against, and Home Assistant's own push is a minute or two away in
// that case anyway.
//
// The thermal projection is deliberately not recomputed. It is descriptive
// only, it needs the zone models and comfort schedules the ingest path
// assembles, and rebuilding that here would duplicate the one piece of this
// system it is most important to have a single copy of.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import {
  generateOptimisationPlan,
  type OptimisationSnapshotV5,
} from "../_shared/energy-optimisation.ts";
import { buildPriceShape } from "../_shared/energy-price-shape.ts";
import { resolveValueCurves } from "../_shared/value-curves.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Shorter than the ingest path's window. The shape only prices the tail beyond
// day-ahead, a month is ample for that, and this endpoint is interactive.
const PRICE_SHAPE_WINDOW_DAYS = 30;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

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
      global: { headers: { Authorization: authorization } },
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
      auth: { persistSession: false },
    });

    const { data: current, error: currentError } = await service
      .from("energy_optimisation_current")
      .select("customer_id, home_id, snapshot")
      .eq("home_id", homeId)
      .maybeSingle();
    if (currentError) {
      console.error("[ENERGY-REPLAN] current read failed", currentError);
      return json({ error: "read_failed", detail: currentError.message }, 500);
    }
    if (!current?.snapshot) return json({ error: "no_snapshot" }, 404);

    const stored = current.snapshot as OptimisationSnapshotV5;

    const { data: curveRows } = await service
      .from("energy_optimisation_value_curves")
      .select("store_key, unit, points")
      .eq("home_id", homeId);
    const resolved = resolveValueCurves(curveRows ?? []);

    const shapeFrom = new Date(
      Date.now() - PRICE_SHAPE_WINDOW_DAYS * 24 * 60 * 60_000,
    ).toISOString();
    const { data: shapeRows } = await service
      .from("energy_optimisation_price_slots")
      .select("start_ts, import_price_sek_per_kwh")
      .eq("home_id", homeId)
      .gte("start_ts", shapeFrom)
      .order("start_ts");
    // Anchored to the snapshot's own capture time, so the shape is built from
    // the days that had happened when the plan was made rather than from
    // whatever the clock says at replan.
    const priceShape = buildPriceShape(
      shapeRows ?? [],
      stored.timezone,
      Date.parse(stored.captured_at),
    );

    const snapshot: OptimisationSnapshotV5 = {
      ...stored,
      value_curves: {
        pool: resolved.curves.pool.curve,
        ev: resolved.curves.ev.curve,
      },
    };

    let generated;
    try {
      generated = generateOptimisationPlan(snapshot, new Date(), priceShape);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "replan failed";
      // The commonest case by far: the snapshot has aged past the planner's
      // freshness limit. Say so plainly rather than returning a bare failure,
      // because the remedy is simply to wait for the next push.
      return json(
        { error: "cannot_replan", detail, warnings: resolved.warnings },
        409,
      );
    }

    const { error: writeError } = await service
      .from("energy_optimisation_current")
      .update({
        plan: generated,
        issued_at: generated.issued_at,
        valid_until: generated.valid_until,
        binding_until: generated.binding_until,
        status: generated.status,
        model_version: generated.model_version,
        updated_at: new Date().toISOString(),
      })
      .eq("home_id", homeId);
    if (writeError) {
      console.error("[ENERGY-REPLAN] write failed", writeError);
      return json({ error: "storage_failed", detail: writeError.message }, 500);
    }

    return json({
      status: generated.status,
      issued_at: generated.issued_at,
      valid_until: generated.valid_until,
      model_version: generated.model_version,
      validation_errors: generated.validation_errors,
      store_diagnostics: generated.plans.priority.store_diagnostics ?? [],
      warnings: resolved.warnings,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[ENERGY-REPLAN] unhandled", detail, error);
    return json({ error: "replan_failed", detail }, 500);
  }
});
