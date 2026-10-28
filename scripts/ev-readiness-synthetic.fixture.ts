import type { ReadyProblem } from '../supabase/functions/_shared/planner-wasm/ready-problem.ts';
import { problem } from '../tests/planner-wasm.fixture.ts';
import { syntheticIdentityConversion } from '../supabase/functions/_shared/planner/battery-physics.fixture.ts';
import { resolveRulePolicy } from '../supabase/functions/_shared/planner-wasm/rule-policy.ts';

/** Entirely invented overnight readiness example, generated mathematically.
 * No recorded observations, fitted household models or captured commands. */
export function syntheticOvernightReadiness() {
  const p: ReadyProblem = problem();
  Object.assign(p, resolveRulePolicy());
  p.battery = { capacity_kwh: 8, min_soc: .1, max_soc: .95,
    charge_max_w: 2000, discharge_max_w: 2500, charge_efficiency: .95,
    discharge_efficiency: .9, conversion: syntheticIdentityConversion() };
  p.car = { capacity_kwh: 50, kwh_per_km: .2, charge_efficiency: .92 };
  p.charger = { voltage_v: 230, phase_count: 3, min_current_a: 5, max_current_a: 16, current_step_a: 1 };
  p.pool_store = null; p.heater = null; p.pool_stop_c = null;
  p.initial = { battery_kwh: 3, ev_kwh: 5, pool_c: null, pool_pending_heat_kwh: null,
    pool_source_depletion_kwh: null, heater_state: null };
  p.targets = { pool_c: null, ev_km: 200, ev_limit_kwh: 40 };
  p.limits = { ...p.limits, import_w: 10000, export_w: 5000, wear_per_kwh: .03,
    battery_export_enabled: false, battery_export_reserve_kwh: 6, battery_export_min_price: 4 };
  p.slots = Array.from({ length: 96 }, (_, i) => ({ ...p.slots[0], local_month: 2,
    start_seconds: i * 900 - 450, hours: .25, base_w: 600 + 200 * Math.sin(i * Math.PI / 48),
    base_ev_w: 0, solar_w: i >= 40 && i < 72 ? 2400 * Math.sin((i - 40) * Math.PI / 32) : 0,
    import_price: i < 38 ? .2 : i < 60 ? 1.8 : .9, export_price: .05,
    published: true, ev_available: true, outdoor_c: 10, pool_auxiliary_dispatch: null }));
  p.accepted = Array.from({ length: 5 }, () => ({ pool_on: false, ev_amps: 0,
    battery: 'hold' as const, charge_limit_w: 2000, discharge_limit_w: 0 }));
  p.locked_through_seconds = 3600;
  p.work_grant = 1_520_000_000;
  p.end_credit = { reference_sek_per_kwh: 1,
    battery: { cap: 7.6, grid_kwh_per_unit: 1 / .95 }, pool: null,
    ev: { cap: 40, grid_kwh_per_unit: 1 / .92 } };
  return { provenance: 'Independently invented synthetic equipment, mathematical demand/solar/price shapes and explicit held commands. No household measurements or anonymized capture.',
    generated_by: 'scripts/ev-readiness-synthetic.fixture.ts', night_quarters: 38, problem: p };
}

if (import.meta.main) await Deno.writeTextFile(new URL('../tests/ev-readiness-overnight.fixture.json', import.meta.url),
  JSON.stringify(syntheticOvernightReadiness(), null, 2) + '\n');
