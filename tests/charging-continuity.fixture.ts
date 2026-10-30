import { syntheticIdentityConversion } from '../supabase/functions/_shared/planner/battery-physics.fixture.ts';
import type { ReadyProblem } from '../supabase/functions/_shared/planner-wasm/ready-problem.ts';
import { resolveRulePolicy } from '../supabase/functions/_shared/planner-wasm/rule-policy.ts';
import { problem } from './planner-wasm.fixture.ts';

/** Independently invented current/headroom competition, not a household replay.
 * A cheap interval spans a high-current opening and a constrained trailing block;
 * stationary charging shares the opening headroom before both stores finish. */
export function activeCurrentCompetition(): ReadyProblem {
  const p: ReadyProblem = problem();
  Object.assign(p, resolveRulePolicy());
  p.work_grant = 1_520_000_000;
  p.recipe = { beam_width: 16, max_actions: 32, finalists: 4, witness_trials: 96, repair_trials: 24 };
  p.battery = { capacity_kwh: 20, min_soc: .1, max_soc: 1,
    charge_max_w: 6000, discharge_max_w: 600, charge_efficiency: .96,
    discharge_efficiency: .94, conversion: syntheticIdentityConversion() };
  p.car = { capacity_kwh: 90, kwh_per_km: .18, charge_efficiency: .94 };
  p.charger = { voltage_v: 230, phase_count: 3, min_current_a: 5, max_current_a: 16, current_step_a: 1 };
  p.pool_store = null; p.heater = null; p.pool_stop_c = null;
  p.initial = { battery_kwh: 18.5, ev_kwh: 51.5, pool_c: null, pool_pending_heat_kwh: null,
    pool_source_depletion_kwh: null, heater_state: null };
  p.targets = { pool_c: null };
    p.limits = { ...p.limits, import_w: 15000, export_w: 10000, battery_export_enabled: false,
    ev_start_preference_sek: .25, battery_start_preference_sek: .25,
    battery_export_reserve_kwh: 16, battery_export_min_price: 3, wear_per_kwh: .04 };
  p.car_policy = { floor_kwh: 72, limit_kwh: 72, breach_permille: Array.from({ length: 96 }, () => null) };
  p.end_credit = { reference_sek_per_kwh: 1,
    battery: { cap: 20, grid_kwh_per_unit: 1 / .96 }, pool: null,
    ev: { grid_kwh_per_unit: 1 / .94, tiers: [{ up_to: 72, sek_per_kwh: 1 }] } };
  p.slots = Array.from({ length: 96 }, (_, i) => ({ ...p.slots[0], local_month: 2,
    start_seconds: i * 900, base_w: i < 25 ? 0 : i < 28 ? 1800 : i < 44 ? 11550 : 1800,
    solar_w: 0, import_price: i < 25 ? 2 : i < 44 ? .2 : .6,
    export_price: .05 }));
  return p;
}
