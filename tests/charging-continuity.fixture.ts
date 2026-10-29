import type { ReadyProblem } from "../supabase/functions/_shared/planner-wasm/ready-problem.ts";
import { resolveRulePolicy } from "../supabase/functions/_shared/planner-wasm/rule-policy.ts";
import { problem } from "./planner-wasm.fixture.ts";

/** Anonymous, rounded power/price pattern from the switching regression.
 * No device identifiers, recorded history, absolute timestamps or fitted model data. */
export function activeCurrentCompetition(): ReadyProblem {
  const p: ReadyProblem = problem();
  Object.assign(p, resolveRulePolicy());
  p.pool_stop_c = 34;
  p.work_grant = 1_520_000_000;
  p.recipe = { beam_width: 16, max_actions: 32, finalists: 4, witness_trials: 96, repair_trials: 24 };
  p.battery = {"capacity_kwh": 18, "min_soc": 0.05, "max_soc": 1, "charge_max_w": 8800, "discharge_max_w": 9600, "charge_efficiency": 0.95, "discharge_efficiency": 0.95};
  p.car = {"capacity_kwh": 86, "kwh_per_km": 0.16, "charge_efficiency": 0.92};
  p.charger = {"voltage_v": 230, "phase_count": 3, "max_current_a": 16, "min_current_a": 5, "current_step_a": 1};
  p.targets = {"pool_c": 30.5, "ev_km": 360, "ev_limit_kwh": 68.8};
  p.limits = {"import_w": 15000, "export_w": 13200, "battery_export_enabled": true, "battery_export_reserve_kwh": 14.4, "battery_export_min_price": 2.5, "wear_per_kwh": 0.05, "ev_start_preference_sek": 0.25, "battery_start_preference_sek": 0.25, "pool_start_cost_sek": 3};
  p.end_credit = {"reference_sek_per_kwh": 1.9, "battery": {"cap": 18, "grid_kwh_per_unit": 1.0526315789473684}, "pool": {"cap": 30.5, "grid_kwh_per_unit": 18.461538461538463}, "ev": {"cap": 57.6, "grid_kwh_per_unit": 1.0869565217391304}};
  p.pool_store = { ...p.pool_store!, response_time_constant_h: 0, capacity_kwh_per_c: 64, loss: { kind: "measured", points: [{ at_c: 29, c_per_h: -.03 }, { at_c: 31, c_per_h: -.04 }] } };
  p.heater = { compressor_w: 3000, auxiliary_w: 750, heat_w: 13000, response: { kind: "steady" } };
  p.initial = { ...p.initial, battery_kwh: 3.7, ev_kwh: 23.2, pool_c: 30.1, heater_state: { kind: "steady" } };
  p.slots = pattern.map(([base_w, solar_w, import_price, export_price], i) => ({ ...p.slots[0], local_month: 10, start_seconds: i * 900, base_w, solar_w, import_price, export_price }));
  return p;
}

const pattern = [
  [900, 2300, 1.27, 0.38],
  [900, 2300, 1.31, 0.41],
  [1000, 2300, 1.29, 0.4],
  [1000, 2300, 1.33, 0.42],
  [1100, 2200, 1.33, 0.43],
  [1100, 2200, 1.62, 0.66],
  [2400, 2100, 1.32, 0.42],
  [2200, 2000, 1.31, 0.41],
  [2200, 1900, 1.25, 0.36],
  [1500, 1700, 1.61, 0.65],
  [1200, 1500, 1.37, 0.46],
  [1100, 1300, 1.32, 0.42],
  [1300, 1000, 1.77, 0.78],
  [1300, 800, 1.97, 0.94],
  [2300, 400, 2.08, 1.03],
  [2700, 0, 2.06, 1.01],
  [3000, 0, 1.98, 0.95],
  [2900, 0, 1.99, 0.95],
  [2800, 0, 1.62, 0.66],
  [3300, 0, 1.8, 0.8],
  [2800, 0, 1.38, 0.47],
  [2500, 0, 1.34, 0.43],
  [2400, 0, 2.01, 0.97],
  [2000, 0, 1.75, 0.77],
  [2200, 0, 1.45, 0.52],
  [1900, 0, 1.2, 0.32],
  [1500, 0, 1.17, 0.3],
  [1500, 0, 1.09, 0.24],
  [1800, 0, 1.08, 0.23],
  [1600, 0, 1.01, 0.17],
  [1800, 0, 1.12, 0.26],
  [1300, 0, 1.09, 0.24],
  [1200, 0, 1.08, 0.23],
  [1300, 0, 1.09, 0.24],
  [1200, 0, 1.09, 0.23],
  [1000, 0, 1.09, 0.24],
  [1200, 0, 1.07, 0.22],
  [800, 0, 1.03, 0.19],
  [800, 0, 1.06, 0.21],
  [900, 0, 1.05, 0.2],
  [1000, 0, 1.02, 0.18],
  [1100, 0, 0.98, 0.14],
  [900, 0, 1.39, 0.48],
  [900, 0, 1.4, 0.49],
  [1000, 0, 1.37, 0.46],
  [1000, 0, 1.37, 0.46],
  [1100, 0, 1.36, 0.46],
  [1000, 0, 1.37, 0.46],
  [1200, 0, 1.38, 0.47],
  [1000, 0, 1.39, 0.47],
  [1200, 0, 1.38, 0.47],
  [1200, 0, 1.37, 0.46],
  [1000, 0, 1.39, 0.47],
  [1000, 0, 1.4, 0.48],
  [1000, 0, 1.35, 0.45],
  [1100, 0, 1.38, 0.47],
  [1100, 0, 1.39, 0.48],
  [1000, 0, 1.41, 0.49],
  [1100, 0, 1.38, 0.47],
  [900, 0, 1.39, 0.47],
  [900, 0, 1.4, 0.48],
  [1000, 0, 1.44, 0.51],
  [2700, 0, 1.32, 0.42],
  [3100, 0, 1.39, 0.48],
  [3600, 0, 1.47, 0.54],
  [3900, 0, 1.58, 0.63],
  [3200, 0, 1.38, 0.47],
  [2700, 0, 1.4, 0.49],
  [2500, 0, 1.73, 0.75],
  [2600, 0, 1.77, 0.78],
  [2400, 0, 1.67, 0.7],
  [2500, 0, 1.73, 0.75],
  [2500, 0, 1.88, 0.86],
  [2600, 100, 2.13, 1.07],
  [2400, 200, 1.79, 0.8],
  [2300, 300, 1.77, 0.78],
  [2200, 400, 1.9, 0.88],
  [2400, 500, 2.14, 1.07],
  [2500, 600, 1.54, 0.59],
  [2000, 700, 1.62, 0.66],
  [1600, 700, 1.75, 0.77],
  [1700, 800, 1.9, 0.88],
  [1700, 800, 1.73, 0.75],
  [1600, 900, 1.61, 0.65],
  [1400, 900, 1.72, 0.74],
  [1100, 1000, 1.84, 0.84],
  [1100, 1200, 1.7, 0.72],
  [1100, 1400, 1.76, 0.78],
  [1200, 1500, 1.8, 0.81],
  [1100, 1700, 1.89, 0.87],
  [1200, 1900, 1.76, 0.77],
  [1000, 2000, 1.74, 0.75],
  [1000, 2100, 1.77, 0.78],
  [1100, 2300, 1.82, 0.82],
  [1200, 2300, 1.78, 0.79],
  [1400, 2400, 1.81, 0.81],
];
