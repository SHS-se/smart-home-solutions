import type {
  NativeCommand,
  ReadyProblem,
} from "../supabase/functions/_shared/planner-wasm/ready-problem.ts";
import { HOUSEHOLD } from "../src/lib/planner-bench/household.ts";

export const command = (pool_on = false): NativeCommand => ({
  pool_on,
  ev_amps: 0,
  battery: "hold",
  charge_limit_w: 8800,
  discharge_limit_w: 9600,
});
export function problem(): ReadyProblem {
  return {
    abi: 2,
    work_grant: 12_000_000,
    recipe: {
      beam_width: 8,
      max_actions: 24,
      finalists: 3,
      witness_trials: 32,
      repair_trials: 4,
    },
    slots: Array.from(
      { length: 8 },
      (_, i) => ({
        start_seconds: i * 900,
        hours: .25,
        base_w: 500,
        solar_w: 0,
        outdoor_c: 10,
        import_price: 1 + i / 10,
        export_price: .5,
        published: true,
      }),
    ),
    battery: HOUSEHOLD.battery,
    car: HOUSEHOLD.car.battery,
    charger: HOUSEHOLD.car.charger,
    pool_store: HOUSEHOLD.pool.store,
    heater: {
      compressor_w: 3000,
      auxiliary_w: 764,
      heat_w: 12000,
      response: { kind: "steady" },
    },
    initial: {
      battery_kwh: 10,
      ev_kwh: 60,
      pool_c: 32,
      heater_age: { kind: "off" },
    },
    targets: { pool_c: 30, ev_km: 300, ev_limit_kwh: 70 },
    limits: {
      import_w: 16000,
      export_w: 16000,
      battery_export_enabled: false,
      battery_export_reserve_kwh: 2,
      battery_export_min_price: 4,
      wear_per_kwh: .1,
    },
    rules: [],
    service_guard: { pool: [1, 2], ev: [50, 100] },
    accepted: null,
    locked_through_seconds: 0,
  };
}
