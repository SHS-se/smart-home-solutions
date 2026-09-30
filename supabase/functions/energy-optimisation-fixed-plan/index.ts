import { resolveValueCurves } from "../_shared/planner/value-curves.ts";
import { withTrafficMetrics } from "../_shared/edge-traffic.ts";
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import {
  dispatchWorkbenchInputs,
  type OptimisationPlan,
  type OptimisationSnapshot,
} from "../_shared/planner/energy-optimisation.ts";
import {
  EnergyPlanningError,
  generateRemoteOptimisationPlan,
} from "../_shared/energy-planning-client.ts";
import {
  type FixedEnergyPlan,
  fixedPlanPreflightInput,
  QUARTER_MS,
  validateFixedSchedule,
} from "../_shared/planner/fixed-energy-plan.ts";
import {
  type DispatchSchedule,
  scoreDispatch,
} from "../_shared/planner/dispatch-plan.ts";

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

/** The current-plan columns activation reads, as ingest stored them. */
interface CurrentPlanRow {
  snapshot: OptimisationSnapshot;
  price_outlook: OptimisationPlan["price_outlook"];
  issued_at: string;
  priority_slots: OptimisationPlan["plans"]["priority"]["slots"];
  snapshot_id: string;
  fixed_plan: FixedEnergyPlan | null;
  fixed_plan_revision: number;
}

serve(withTrafficMetrics("energy-optimisation-fixed-plan", async (request, traffic) => {
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
      global: { headers: { Authorization: authorization }, fetch: traffic.fetch },
      auth: { persistSession: false },
    });
    if (body.action === "status") {
      const { data: status, error } = await caller.rpc("get_energy_fixed_plan_status", {
        p_home_id: body.home_id,
      });
      if (error) throw new Error(error.message);
      if (!status) return json({ error: "not_found" }, 404);
      return json(status);
    }
    const { data: row, error } = await caller.from(
      "energy_optimisation_current",
    )
      .select(
        "snapshot, price_outlook:plan->price_outlook, issued_at:plan->>issued_at, priority_slots:plan->plans->priority->slots, snapshot_id, fixed_plan, fixed_plan_revision",
      )
      .eq("home_id", body.home_id).maybeSingle<CurrentPlanRow>();
    if (error) throw new Error(error.message);
    if (!row) return json({ error: "not_found" }, 404);
    if (body.revision !== row.fixed_plan_revision) {
      return json({
        error: "The fixed plan changed. Refresh before submitting.",
      }, 409);
    }
    const service = createClient(
      url,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false }, global: { fetch: traffic.fetch } },
    );
    let fixed: FixedEnergyPlan | null = null;
    if (body.action === "activate") {
      if (body.snapshot_id !== row.snapshot_id) {
        return json({
          error:
            "The planner has newer measurements. Reload your plan before activating it.",
        }, 409);
      }
      const source = {
        price_outlook: row.price_outlook,
        issued_at: row.issued_at,
        slots: row.priority_slots,
      };
      const snapshot = row.snapshot;
      if (snapshot.schema_version < 6) {
        return json(
          { error: "Fixed plans require the store-based planner." },
          400,
        );
      }
      // The planner refuses any fixed plan alongside an operating scope
      // (mixed-mode-execution.md): say so before doing any work for it.
      if (snapshot.schema_version === 9) {
        return json({
          error:
            "Fixed plans are not available for operating-scope plans (snapshot schema 9).",
        }, 400);
      }
      const { data: curves, error: curveError } = await caller.from(
        "energy_optimisation_value_curves",
      )
        .select(
          "store_key, unit, points, max_value_sek_per_kwh, urgent_price_multiplier",
        ).eq("home_id", body.home_id);
      if (curveError) throw new Error(curveError.message);
      const saved = resolveValueCurves(curves ?? []).curves;
      const resolved: OptimisationSnapshot = {
        ...snapshot,
        value_curves: {
          ...Object.fromEntries(Object.entries(saved).map(([key, value]) => [key, value.curve])),
        },
      };
      // Checking a hand-built schedule needs the auction's inputs, not its
      // answer: solving the workbench took seconds of CPU on a 288-quarter home.
      const bench = dispatchWorkbenchInputs(resolved, [], source.price_outlook, new Date(source.issued_at));
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
        source.slots.map((s) => [Date.parse(s.start), s]),
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
      const previous = row.fixed_plan?.slots.find(
        (s) => Date.parse(s.start) === currentAt,
      );
      if (previous) fixed.slots.unshift(previous);
      // Materialise commands using the same simulator used for ordinary plans,
      // solved by the planning worker in CPU-bounded calls as ingest's are: a
      // whole plan does not fit in one request's CPU budget.
      let candidate: OptimisationPlan;
      try {
        candidate = (await generateRemoteOptimisationPlan(
          fixedPlanPreflightInput(resolved, source.price_outlook, fixed),
          {
            url,
            planningSecret: Deno.env.get("ENERGY_PLANNING_SECRET") ?? "",
            requestId: crypto.randomUUID(),
          },
          traffic.fetch,
        )).plan;
      } catch (error) {
        // The planner rejecting the schedule is the household's to correct
        // (400 below); the worker failing is not, and a retry may succeed.
        if (error instanceof EnergyPlanningError && error.status === 502) {
          return json({ error: error.message, retryable: true }, 502);
        }
        throw error;
      }
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
}));
