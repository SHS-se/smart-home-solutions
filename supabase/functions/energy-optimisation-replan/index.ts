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

const PRICE_SHAPE_WINDOW_DAYS = 60;

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

  const authorization = request.headers.get("Authorization");
  if (!authorization) return json({ error: "unauthorized" }, 401);

  // The caller's own token, so row-level security decides which homes they may
  // touch. A replan must never be able to reach a home the user cannot read.
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    { global: { headers: { Authorization: authorization } } },
  );

  let homeId: string;
  try {
    const body = await request.json();
    homeId = String(body?.home_id ?? "");
    if (!homeId) return json({ error: "home_id_required" }, 400);
  } catch {
    return json({ error: "invalid_body" }, 400);
  }

  const { data: current, error: readError } = await supabase
    .from("energy_optimisation_current")
    .select("customer_id, home_id, snapshot")
    .eq("home_id", homeId)
    .maybeSingle();
  if (readError) {
    console.error("[ENERGY-REPLAN] current read failed", readError);
    return json({ error: "read_failed" }, 500);
  }
  if (!current?.snapshot) return json({ error: "no_snapshot" }, 404);

  const stored = current.snapshot as OptimisationSnapshotV5;

  const { data: curveRows } = await supabase
    .from("energy_optimisation_value_curves")
    .select("store_key, unit, points")
    .eq("home_id", homeId);
  const resolved = resolveValueCurves(curveRows ?? []);

  const shapeFrom = new Date(
    Date.now() - PRICE_SHAPE_WINDOW_DAYS * 24 * 60 * 60_000,
  ).toISOString();
  const { data: shapeRows } = await supabase
    .from("energy_optimisation_price_slots")
    .select("start_ts, import_price_sek_per_kwh")
    .eq("home_id", homeId)
    .gte("start_ts", shapeFrom)
    .order("start_ts");
  const priceShape = buildPriceShape(shapeRows ?? [], stored.timezone);

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
    return json({ error: "cannot_replan", detail, warnings: resolved.warnings }, 409);
  }

  const { error: writeError } = await supabase
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
    return json({ error: "storage_failed" }, 500);
  }

  return json({
    status: generated.status,
    issued_at: generated.issued_at,
    valid_until: generated.valid_until,
    model_version: generated.model_version,
    validation_errors: generated.validation_errors,
    store_diagnostics: generated.plans.priority.store_diagnostics,
    warnings: resolved.warnings,
  });
});
