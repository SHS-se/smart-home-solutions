import type {
  BatteryModel,
  CarBatteryModel,
  ChargerModel,
  HeaterState,
  HeatPumpResponse,
  PoolSourceModel,
  ThermalStoreModel,
} from "../planner/device-models.ts";

import type { EndCreditTerms } from "./end-credit.ts";

export const READY_ABI = 18 as const;

export type BatteryOperation =
  | "idle"
  | "solar_charge"
  | "hold"
  | "self_consumption"
  | "grid_charge"
  | "supply_house"
  | "export"
  | "shave_import";
export interface NativeOwnerMask { pool: boolean; ev: boolean; battery: boolean }
export interface NativeCommand {
  pool_on: boolean;
  ev_amps: number;
  battery: BatteryOperation;
  charge_limit_w: number;
  discharge_limit_w: number;
}
export const RULE_KEYS = ["pool_shortfall", "car_floor"] as const;
export type PlannerRuleKey = typeof RULE_KEYS[number];
export interface ReadySlot {
  battery_export_allowed?: boolean | null;
  local_month: number;
  start_seconds: number;
  hours: number;
  base_w: number;
  /** EV load already included in base_w, outside the controlled charger. */
  base_ev_w: number;
  solar_w: number;
  outdoor_c: number;
  import_price: number;
  export_price: number;
  published: boolean;
  ev_available: boolean;
  ev_current_ceiling_a: number | null;
  pool_auxiliary_dispatch: { fixed_w: number; on_w: number } | null;
}
/** Already prepared: no historical, source-fetching or fitting API is reachable here. */
export interface ReadyProblem {
  abi: typeof READY_ABI;
  /** Supply permission, independent of comfort scoring and grid capacity. */
  ev_battery_supply_allowed: boolean;
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
    source?: PoolSourceModel | null;
    compressor_w: number;
    auxiliary_w: number;
    heat_w: number;
    response: HeatPumpResponse;
  } | null;
  pool_stop_c: number | null;
  charging_before: { ev_amps: number | null; battery_grid_w: number | null };
  initial: {
    battery_kwh: number | null;
    ev_kwh: number | null;
    pool_c: number | null;
    pool_pending_heat_kwh: number | null;
    pool_source_depletion_kwh: number | null;
    heater_state: HeaterState | null;
  };
  targets: {
    pool_c: number | null;
  };
  /** The car's levels and one breach line per slot (car-policy.ts). Present exactly when there is a car. */
  car_policy: { floor_kwh: number; limit_kwh: number; breach_permille: (number | null)[] } | null;
  limits: {
    import_w: number;
    export_w: number;
    battery_export_enabled: boolean;
    battery_export_reserve_kwh: number;
    battery_export_min_price: number;
    wear_per_kwh: number;
    pool_start_cost_sek: number;
    ev_change_preference_sek: number;
    battery_change_preference_sek: number;
  };
  /** What the energy left in the stores is worth to the plan's score (end-credit.ts). */
  end_credit: EndCreditTerms;
  /** Comfort deductions. Economic witnesses improve the cash-and-wear objective. */
  rules: {
    key: PlannerRuleKey;
    threshold: number;
    points: number;
    required: boolean;
  }[];
  accepted: NativeCommand[] | null;
  released: NativeOwnerMask[] | null;
  unavailable: NativeOwnerMask[] | null;
  fixed_commands?: Array<NativeCommand | null> | null;
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
