import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import {
  dispatchWorkbench,
  generateOptimisationPlan,
  type OptimisationPlan,
  type OptimisationSnapshot,
} from "../_shared/energy-optimisation.ts";
import {
  type FixedEnergyPlan,
  QUARTER_MS,
  validateFixedSchedule,
} from "../_shared/fixed-energy-plan.ts";
import {
  type DispatchSchedule,
  scoreDispatch,
} from "../_shared/dispatch-plan.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }
  try {
    const authorization = request.headers.get("Authorization");
    if (!authorization) return json({ error: "unauthorized" }, 401);
    const body = await request.json();
    if (
      !body.home_id || !["activate", "rescind", "status"].includes(body.action)
    ) return json({ error: "invalid_request" }, 400);
    const url = Deno.env.get("SUPABASE_URL")!;
    const caller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false },
    });
    const { data: row, error } = await caller.from(
      "energy_optimisation_current",
    )
      .select(
        "snapshot, plan, snapshot_id, fixed_plan, fixed_plan_revision, fixed_plan_generation_revision, ha_ack_status, ha_ack_error, valid_until, replan_error, replan_request_id, replan_completed_request_id",
      )
      .eq("home_id", body.home_id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) return json({ error: "not_found" }, 404);
    if (body.action === "status") {
      return json({
        fixed_plan: row.fixed_plan
          ? {
            id: row.fixed_plan.id,
            starts_at: row.fixed_plan.starts_at,
            ends_at: row.fixed_plan.ends_at,
          }
          : null,
        revision: row.fixed_plan_revision,
        generated_revision: row.fixed_plan_generation_revision,
        generated_fixed_plan_id: row.plan?.fixed_plan?.id ?? null,
        ha_ack_status: row.ha_ack_status,
        ha_ack_error: row.ha_ack_error,
        valid_until: row.valid_until,
        error: row.replan_error,
        pending: row.replan_request_id !== row.replan_completed_request_id,
      });
    }
    if (body.revision !== row.fixed_plan_revision) {
      return json({
        error: "The fixed plan changed. Refresh before submitting.",
      }, 409);
    }
    const service = createClient(
      url,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );
    let fixed: FixedEnergyPlan | null = null;
    if (body.action === "activate") {
      if (body.snapshot_id !== row.snapshot_id) {
        return json({
          error:
            "The planner has newer measurements. Reload your plan before activating it.",
        }, 409);
      }
      const source = row.plan as OptimisationPlan;
      const snapshot = row.snapshot as OptimisationSnapshot;
      if (snapshot.schema_version < 6) {
        return json(
          { error: "Fixed plans require the store-based planner." },
          400,
        );
      }
      const { data: curves, error: curveError } = await caller.from(
        "energy_optimisation_value_curves",
      )
        .select(
          "store_key, unit, points, max_value_sek_per_kwh, urgent_price_multiplier",
        ).eq("home_id", body.home_id);
      if (curveError) throw new Error(curveError.message);
      const resolved: OptimisationSnapshot = {
        ...snapshot,
        value_curves: {
          ...snapshot.value_curves,
          ...Object.fromEntries((curves ?? []).map((c) => [c.store_key, c])),
        },
      };
      const bench = dispatchWorkbench(resolved, [], source.price_outlook);
      if (!bench) {
        return json(
          { error: "This home has no editable dispatch schedule." },
          400,
        );
      }
      const schedule = body.schedule as DispatchSchedule;
      validateFixedSchedule(bench.slot_start_ms, bench.stores, schedule);
      const checked = scoreDispatch(
        bench.slots,
        bench.stores,
        bench.limits,
        schedule,
      );
      const start = (Math.floor(Date.now() / QUARTER_MS) + 1) * QUARTER_MS;
      if (body.starts_at !== new Date(start).toISOString()) {
        return json({
          error:
            "The start boundary changed. Submit again for the next quarter.",
        }, 409);
      }
      const end = Date.parse(body.ends_at);
      if (
        !Number.isFinite(end) || end % QUARTER_MS !== 0 || end <= start ||
        end > bench.slot_start_ms.at(-1)! + QUARTER_MS
      ) {
        return json({
          error: "Edit a future period before activating the plan.",
        }, 400);
      }
      const issues = checked.infeasibilities.filter((i) =>
        bench.slot_start_ms[Math.min(i.slot, bench.slot_start_ms.length - 1)] >=
          start &&
        bench.slot_start_ms[Math.min(i.slot, bench.slot_start_ms.length - 1)] <
          end
      );
      if (issues.length) {
        return json({ error: issues.map((i) => i.message).join("; ") }, 422);
      }
      const originalSlots = new Map(
        source.plans.priority.slots.map((s) => [Date.parse(s.start), s]),
      );
      fixed = {
        id: crypto.randomUUID(),
        starts_at: new Date(start).toISOString(),
        ends_at: new Date(end).toISOString(),
        source_snapshot_id: snapshot.snapshot_id,
        slots: bench.slot_start_ms.flatMap((at, i) =>
          at >= start && at < end
            ? [{
              start: new Date(at).toISOString(),
              power_w: Object.fromEntries(
                bench.stores.map((s) => [s.key, schedule.power_w[s.key][i]]),
              ),
              discharge_w: Object.fromEntries(
                bench.stores.map(
                  (s) => [s.key, schedule.discharge_w[s.key][i]],
                ),
              ),
              targets: originalSlots.get(at)!,
              allow_export: schedule.allow_export?.[i] === true,
            }]
            : []
        ),
      };
      if (
        fixed.slots.length !== (end - start) / QUARTER_MS ||
        fixed.slots.some((s) => !s.targets)
      ) {
        return json({
          error: "The edited interval is not covered by the source plan.",
        }, 400);
      }
      // Preserve the remainder of the current quarter on replacement as well.
      const currentAt = start - QUARTER_MS;
      const previous = (row.fixed_plan as FixedEnergyPlan | null)?.slots.find(
        (s) => Date.parse(s.start) === currentAt,
      );
      if (previous) fixed.slots.unshift(previous);
      // Materialise commands using the same simulator used for ordinary plans.
      // Historical validation time is intentional here: this is preflight only;
      // HA receives a later generation based on fresh measurements through ingest.
      const candidate = generateOptimisationPlan(
        resolved,
        new Date(snapshot.captured_at),
        [],
        source.price_outlook,
        fixed,
      );
      if (candidate.status !== "ready") {
        return json({ error: candidate.validation_errors.join("; ") }, 422);
      }
      const targets = new Map(
        candidate.plans.priority.slots.map((s) => [Date.parse(s.start), s]),
      );
      fixed.slots = fixed.slots.map((s) => ({
        ...s,
        targets: targets.get(Date.parse(s.start))!,
      }));
      if (Date.now() >= start) {
        return json({
          error:
            "The start boundary passed during validation. Submit again for the next quarter.",
        }, 409);
      }
    }
    const { data: requestId, error: writeError } = await service.rpc(
      "set_fixed_energy_plan",
      {
        p_home_id: body.home_id,
        p_expected_revision: row.fixed_plan_revision,
        p_expected_snapshot_id: row.snapshot_id,
        p_fixed_plan: fixed,
      },
    );
    if (writeError) return json({ error: writeError.message }, 409);
    return json({
      status: "queued",
      request_id: requestId,
      fixed_plan: fixed
        ? { id: fixed.id, starts_at: fixed.starts_at, ends_at: fixed.ends_at }
        : null,
    }, 202);
  } catch (error) {
    return json({
      error: error instanceof Error ? error.message : String(error),
    }, 400);
  }
});
