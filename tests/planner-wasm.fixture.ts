import { type BenchCase, QUARTERS } from "../src/lib/planner-bench/case.ts";
import type {
  NativeCommand,
  ReadyProblem,
} from "../supabase/functions/_shared/planner-wasm/ready-problem.ts";
import { HOUSEHOLD } from "../src/lib/planner-bench/household.ts";
import { syntheticReadyProblem } from "../scripts/planner-synthetic.fixture.ts";

/** Expensive opening; the pool can coast safely into later cheap/surplus sun. */
export function forecastProblem(): ReadyProblem {
  const p = syntheticReadyProblem();
  p.initial.pool_c = 29.7;
  return p;
}

export const command = (pool_on = false): NativeCommand => ({
  pool_on,
  ev_amps: 0,
  battery: "hold",
  charge_limit_w: 8800,
  discharge_limit_w: 9600,
});
/** This fixture intentionally contains every device; live absence has separate tests. */
export type EquippedProblem =
  & ReadyProblem
  & {
    [K in "battery" | "car" | "charger" | "pool_store" | "heater"]: NonNullable<
      ReadyProblem[K]
    >;
  }
  & {
    initial: {
      [K in keyof ReadyProblem["initial"]]: NonNullable<
        ReadyProblem["initial"][K]
      >;
    };
    targets: {
      [K in keyof ReadyProblem["targets"]]: NonNullable<
        ReadyProblem["targets"][K]
      >;
    };
  };
export function problem(): EquippedProblem {
  return {
    abi: 5,
    pool_cycle_seconds: 43200,
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
        local_month: 7,
        start_seconds: i * 900,
        hours: .25,
        base_w: 500,
        solar_w: 0,
        outdoor_c: 10,
        import_price: 1 + i / 10,
        export_price: .5,
        published: true,
        ev_available: true,
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
    pool_stop_c: null,
    initial: {
      battery_kwh: 10,
      ev_kwh: 60,
      pool_c: 32,
      heater_state: { kind: "off_unobserved" },
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

export function causalCase(): BenchCase {
  const all = (value: number) => Array(QUARTERS).fill(value);
  return {
    format: "shs-bench-case",
    version: 2,
    start: "2026-09-28T00:00:00Z",
    timezone: "Europe/Stockholm",
    origin: {
      kind: "manual",
      detail: "causal boundary",
      created_at: "2026-09-28T00:00:00Z",
    },
    location: { latitude: 59, longitude: 18 },
    known_prices: { import_sek_per_kwh: all(1), export_sek_per_kwh: all(.5) },
    solar_forecast_w: all(0),
    base_load_forecast_w: all(500),
    other_devices_w: {},
    comfort: { pool_c: 30, ev_km: 300 },
    start_state: {
      battery_soc: .5,
      pool_water_c: 30,
      pool_heater: { kind: "off_unobserved" },
      ev: { soc: .5, target_soc: .9 },
    },
    recorded: {
      actual: { base_load_w: all(500), solar_w: all(0) },
      prices: { import_sek_per_kwh: all(1), export_sek_per_kwh: all(.5) },
      outdoor_temperature_c: all(10),
      solar_irradiance_w_per_m2: Array(QUARTERS).fill(null),
      recorded_at: "2026-10-01T00:00:00Z",
      history: {
        prices: {
          start: "2026-09-27T00:00:00Z",
          import_sek_per_kwh: Array(96).fill(1),
          export_sek_per_kwh: Array(96).fill(.5),
        },
        grid_import_kwh: { start: "2026-09-01T00:00:00Z", kwh: [] },
      },
    },
  };
}

/** Three-day thermal evidence with a committed warm short restart. */
export function bufferProblem(): EquippedProblem {
  const p = problem();
  p.work_grant = 900_000_000;
  p.slots = Array.from({ length: 288 }, (_, i) => ({
    ...p.slots[0], start_seconds: i * 900, import_price: 1,
    solar_w: i < 96 ? 1000 : i < 192 ? 500 : 100,
  }));
  p.initial.pool_c = 35;
  p.initial.heater_state = { kind: 'off', seconds: 43200 };
  p.pool_store = {
    capacity_kwh_per_c: 100,
    loss: { kind: 'measured', points: [{ at_c: 30, c_per_h: -1 / 30 }] },
  };
  p.rules = [{ key: 'pool_buffer', threshold: 2, points: 2, required: false, unless: null }];
  p.accepted = p.slots.slice(0, 4).map((_, i) => command(i === 0 || i === 2));
  p.locked_through_seconds = 3600;
  return p;
}
