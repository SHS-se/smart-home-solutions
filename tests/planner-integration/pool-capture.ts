/** Independently specified synthetic plant; measurements come from the real HA exchange. */
import { assert, assertAlmostEquals, assertEquals, assertRejects } from "@std/assert";
import { prepareActualUpload } from "../../supabase/functions/_shared/actual-upload.ts";
import { capturedPoolResponseState } from "../../supabase/functions/_shared/pool-capture.ts";
import { generateRulesPlan, prepareRulesPlanningInput, type PublishedCommandReference } from "../../supabase/functions/_shared/rules-planner.ts";
import { resolveRulePolicy } from "../../supabase/functions/_shared/planner-wasm/rule-policy.ts";
import type { OptimisationSnapshot } from "../../supabase/functions/_shared/planner/planning-contracts.ts";
import type { PoolDynamics } from "../../supabase/functions/_shared/planner/pool-response.ts";

const context = { home_id: "synthetic-home", customer_id: "synthetic-customer", device_token_id: "synthetic-token" };

/** Reads expose only measurements accepted by the real upload parser. */
function observationDatabase(actuals: unknown[], at: number) {
  const parsed = prepareActualUpload(actuals, new Map([["synthetic_pool", { id: "synthetic-device" }]]), context, at);
  const tables: Record<string, Record<string, unknown>[]> = {
    energy_optimisation_devices: [{ id: "synthetic-device", home_id: context.home_id, device_key: "synthetic_pool" }],
    energy_optimisation_device_slots: parsed.deviceSlotRows,
  };
  return { from(table: string) {
    assert(table in tables);
    let rows = tables[table];
    const query = {
      select(_columns: string) { return query; },
      eq(key: string, value: unknown) { rows = rows.filter(r => r[key] === value); return query; },
      in(key: string, values: unknown[]) { rows = rows.filter(r => values.includes(r[key])); return query; },
      gte(key: string, value: string) { rows = rows.filter(r => Date.parse(String(r[key])) >= Date.parse(value)); return query; },
      lt(key: string, value: string) { rows = rows.filter(r => Date.parse(String(r[key])) < Date.parse(value)); return query; },
      order(_key: string) { return query; },
      range(from: number, to: number) { return Promise.resolve({ data: rows.slice(from, to + 1), error: null }); },
      then(resolve: (result: { data: Record<string, unknown>[]; error: null }) => unknown) {
        return Promise.resolve({ data: rows, error: null }).then(resolve);
      },
    };
    return query;
  } } as unknown as Parameters<typeof capturedPoolResponseState>[0];
}

export async function qualifyPoolCapture(produced: { snapshot: OptimisationSnapshot; actuals: unknown[] }, watts: number) {
  const s = structuredClone(produced.snapshot), at = Date.parse(s.captured_at);
  const boundary = Math.floor(at / 900_000) * 900_000;
  const anchor = new Date(boundary - 900_000).toISOString();
  const model: PoolDynamics = {
    version: 2, heat_c_per_kwh: .08, response_time_constant_h: .5, idle_c_per_h: -.04,
    source: null, reference_c: 28, sample_count: 100, rmse_c: 0, instantaneous_rmse_c: null, constant_gain_rmse_c: 0,
    recovery_evidence: { restarts: 0, shortest_off_h: null, longest_off_h: null, profile: [],
      minimum_at_search_boundary: false, steady_heat_fraction_at_observed_peak: null },
    initial_state: { at: anchor, pending_heat_kwh: 2, source_depletion_kwh: 0 },
    state: { at: anchor, pending_heat_kwh: 2, source_depletion_kwh: 0 },
  };
  assertEquals(produced.actuals.length, 2, "manual exchange must carry both completed quarters");
  assert(s.capabilities.pool && s.pool?.electrical_history?.counters.length);
  const state = await capturedPoolResponseState(observationDatabase(produced.actuals, at), context.home_id, s, model);
  const hours = (at - Date.parse(anchor)) / 3_600_000;
  // Analytic constant-input ODE solution, independent of production kernels.
  const decay = Math.exp(-hours / .5);
  const expected = 2 * decay + watts / 1000 * .08 * (40 * 1.163) * .5 * (1 - decay);
  assertAlmostEquals(state.pending_heat_kwh, expected, 1e-10);
  assertEquals(state.source_depletion_kwh, 0);
  await assertRejects(() => capturedPoolResponseState(observationDatabase([], at), context.home_id, s, model),
    Error, "missing compressor history", "negative control: the former manual upload omission cannot pass");
  s.comfort = { ev: { floor_soc: .3 }, pool: { target_c: 30 } };
  s.outdoor_temperature_c = s.slots.map(() => 10);
  s.pool_model = { thermal_dynamics: model, pending_heat_kwh: state.pending_heat_kwh, source_depletion_kwh: 0,
    loss_kw_per_k: null, rated_cop: null, cop_per_air_c: null, heater_response: { kind: "steady" }, hardware: s.pool!.hardware! };
  const run = (reference: PublishedCommandReference | null = null) => generateRulesPlan(prepareRulesPlanningInput({ snapshot: s, now: s.captured_at, price_archive: [],
    resolved_price_outlook: { shaped: true, observed_days: 1, effective_days: 1, level_sek_per_kwh: .2,
      shadow_import_sek_per_kwh: s.slots.map(slot => slot.import_price_sek_per_kwh!) } }, reference, resolveRulePolicy())).plan;
  const plan = run(), slots = plan.plans.priority.slots;
  assertEquals(plan.pool!.planning_basis, "thermal");
  assert(slots.every(q => Number.isFinite(q.pool_temperature_c)), "every graph point must carry a temperature");
  assert(Math.max(...slots.map(q => q.pool_temperature_c!)) > s.pool!.water_temperature_c + 1, "heating must affect the temperature");
  assert(slots.some(q => q.pool_command_w > 0) && slots.some(q => q.pool_command_w === 0), "recovery must finish, not run continuously");
  assertEquals([...new Set(slots.filter(q => q.pool_command_w > 0).map(q => q.pool_command_w))], [3600]);
  assert(!plan.planning_warnings?.some(w => w.scope === "synthetic_pool" || w.scope === "pool"));
  // A genuinely missing wireless meter quarter has the same capture symptom as
  // the old upload omission. Keep parameters and measured water, retain the
  // accepted instructions, and recover without relearning when data arrives.
  const reference: PublishedCommandReference = { plan_id: plan.plan_id, pool_planning_basis: "thermal",
    pool_stop_temperature_c: plan.pool!.stop_temperature_c, slots };
  delete s.pool_model.pending_heat_kwh;
  const retained = run(reference);
  assertEquals(retained.pool!.water_temperature_c, s.pool!.water_temperature_c);
  assertEquals(s.pool_model.thermal_dynamics, model);
  assertEquals(retained.plans.priority.slots.map(q => q.pool_permitted), slots.map(q => q.pool_permitted));
  assert(retained.plans.priority.slots.every(q => q.pool_temperature_c === undefined));
  assertEquals(retained.planning_warnings?.filter(w => w.scope === "pool").length, 1);
  s.pool_model.pending_heat_kwh = state.pending_heat_kwh;
  assertEquals(run(reference).pool!.planning_basis, "thermal");
  return { scenario: "manual_pool_capture", observed_w: watts, pending_heat_kwh: state.pending_heat_kwh,
    temperature_points: slots.length, on_quarters: slots.filter(q => q.pool_command_w > 0).length };
}
