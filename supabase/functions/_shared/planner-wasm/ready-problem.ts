import type {
  BatteryModel,
  CarBatteryModel,
  ChargerModel,
  HeaterState,
  HeatPumpResponse,
  ThermalStoreModel,
} from "../planner/device-models.ts";

import type { EndCreditTerms } from "./end-credit.ts";

export type BatteryOperation =
  | "idle"
  | "solar_charge"
  | "hold"
  | "self_consumption"
  | "grid_charge"
  | "supply_house"
  | "export";
export interface NativeCommand {
  pool_on: boolean;
  ev_amps: number;
  battery: BatteryOperation;
  charge_limit_w: number;
  discharge_limit_w: number;
}
export const RULE_KEYS = [
  "pool_low",
  "pool_cold",
  "pool_hot",
  "pool_buffer",
  "pool_restart",
  "ev_low",
  "ev_short",
  "cheap_buy",
  "cheapest_buy",
  "dear_load",
  "dearest_load",
  "base_load_dear_import",
  "base_load_dearest_import",
  "missed_cheap_quarter",
  "arbitrage_no_export",
  "arbitrage_not_full",
  "ev_from_home_battery",
  "large_load_overlap",
  "pool_short_gap",
  "early_grid_charge",
] as const;
export type PlannerRuleKey = typeof RULE_KEYS[number];
export interface ReadySlot {
  local_month: number;
  start_seconds: number;
  hours: number;
  base_w: number;
  solar_w: number;
  outdoor_c: number;
  import_price: number;
  export_price: number;
  published: boolean;
  ev_available: boolean;
}
/** Already prepared: no historical, source-fetching or fitting API is reachable here. */
export interface ReadyProblem {
  abi: 7;
  /** Shared cycle clock even when the restart deduction is disabled. */
  pool_cycle_seconds: number;
  work_grant: number;
  recipe: {
    beam_width: number;
    max_actions: number;
    finalists: number;
    witness_trials: number;
    repair_trials: number;
  };
  slots: ReadySlot[];
  battery: BatteryModel | null;
  car: CarBatteryModel | null;
  charger: ChargerModel | null;
  pool_store: ThermalStoreModel | null;
  heater: {
    compressor_w: number;
    auxiliary_w: number;
    heat_w: number;
    response: HeatPumpResponse;
  } | null;
  pool_stop_c: number | null;
  initial: {
    battery_kwh: number | null;
    ev_kwh: number | null;
    pool_c: number | null;
    heater_state: HeaterState | null;
  };
  targets: {
    pool_c: number | null;
    ev_km: number | null;
    ev_limit_kwh: number | null;
  };
  limits: {
    import_w: number;
    export_w: number;
    battery_export_enabled: boolean;
    battery_export_reserve_kwh: number;
    battery_export_min_price: number;
    wear_per_kwh: number;
    pool_start_cost_sek: number;
  };
  /** What the energy left in the stores is worth to the plan's score (end-credit.ts). */
  end_credit: EndCreditTerms;
  /** The deduction rules: evidence rules are measured by the bench and never sent. */
  rules: {
    key: PlannerRuleKey;
    threshold: number;
    points: number;
    required: boolean;
    unless: PlannerRuleKey | null;
  }[];
  service_guard: { pool: [number, number]; ev: [number, number] };
  accepted: NativeCommand[] | null;
  locked_through_seconds: number;
}

/** Strip version/probe metadata; the five construction limits define the Rust recipe. */
export function builderRecipe(
  recipe: ReadyProblem["recipe"],
): ReadyProblem["recipe"] {
  const { beam_width, max_actions, finalists, witness_trials, repair_trials } =
    recipe;
  return { beam_width, max_actions, finalists, witness_trials, repair_trials };
}
