import { assert, assertEquals } from "@std/assert";
import { syntheticHome, withPool } from "./synthetic.ts";
import { poolElectricalDemand } from "../../supabase/functions/_shared/planner/models/pool/electrical.ts";
import { poolPhysics } from "../../supabase/functions/_shared/planner/pool-physics.ts";
import { preparePoolService } from "../../supabase/functions/_shared/rules-pool-service.ts";
import { runRulesPlanner } from "../../supabase/functions/_shared/run-rules-planner.ts";

/** Synthetic thermal evidence deliberately disagrees with the equipment's ON rating. */
function installation() {
  const s = withPool(syntheticHome(24));
  s.pool_model!.heater_response = { kind: "bergvarme",
    startup: [{ elapsed_seconds: 0, electric_fraction: 1, heat_fraction: 1 },
      { elapsed_seconds: 900, electric_fraction: 1, heat_fraction: 1 }],
    evidence: { source: "synthetic_training", observed_start: s.captured_at,
      heat_basis: "synthetic_temperature_response", heat_flow_measured: false, steady_compressor_w: 1200 } };
  return s;
}

Deno.test("CONTRACT POOL-4: a thermal calibration cannot replace authoritative 3600 W ON electricity with 1200 W", () => {
  const s = installation();
  for (const thermalWatts of [1200, 100, 8000]) {
    assert(s.pool_model!.heater_response!.kind === "bergvarme");
    s.pool_model!.heater_response!.evidence!.steady_compressor_w = thermalWatts;
    assertEquals(poolElectricalDemand(s), { compressor_w: 3600, auxiliary_w: 0,
      member_w: { synthetic_pool: 3600 } });
    assertEquals(poolPhysics(s).heater.compressor_w, 3600);
    const empirical = structuredClone(s);
    empirical.pool_model!.rated_cop = null;
    empirical.pool_model!.loss_kw_per_k = null;
    // Missing thermal evidence now retains explicit accepted ON instructions;
    // it cannot manufacture a permission merely to exercise electrical rating.
    const permissions = preparePoolService(empirical, empirical.slots.map(slot => ({ start: slot.start,
      pool_permitted: true, pool_command_w: 3600 })), 30);
    assert(permissions.empirical);
    assert(permissions.command_w.every(w => w === 3600));
  }
  // Explicit supplied electrical capabilities remain authoritative over inventory.
  s.device_physics = { pool: {
    store: { capacity_kwh_per_c: 40 * 1.163, response_time_constant_h: 0,
      loss: { kind: "linear", kw_per_c: 0, surroundings_c: 10 } },
    heater: { setting_unit: "kw_thermal", selected_setting: 16, control: "switch", auxiliary_w: 0,
      operating_points: [{ setting: 16, electric_w: 4000, heat_w: 16000 }], response: { kind: "steady" } },
  } };
  assertEquals(poolElectricalDemand(s).compressor_w, 4000);
});

Deno.test("CONTRACT POOL-4: full published planning reserves equipment draw beside intermediate EV charging", () => {
  const s = installation();
  s.grid.import_limit_w = 500 + 3600 + 3 * 230 * 12;
  // A car above its floor and a cheap opening half hour: both loads want quarter 0.
  s.ev_battery!.soc = .5; s.slots.forEach((slot, i) => { if (i >= 2) slot.import_price_sek_per_kwh = 1; });
  const plan = runRulesPlanner({ snapshot: s, now: s.captured_at, price_archive: [] }).plan;
  const opening = plan.plans.priority.slots[0];
  assertEquals(opening.pool_w, 3600);
  assertEquals(opening.ev_target_current_a, 12);
  assert(opening.grid_import_w <= s.grid.import_limit_w);
});
