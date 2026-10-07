import type {
  BatteryModel,
  CarBatteryModel,
  ChargerModel,
  HeatPumpResponse,
  ThermalStoreModel,
} from '../planner/device-models.ts';

export type RunAge = { kind: 'off' } | { kind: 'steady' } | { kind: 'running'; seconds: number };
export type BatteryOperation =
  | 'hold'
  | 'self_consumption'
  | 'grid_charge'
  | 'supply_house'
  | 'export';
export interface NativeCommand {
  pool_on: boolean;
  ev_amps: number;
  battery: BatteryOperation;
  charge_limit_w: number;
  discharge_limit_w: number;
}
export const DIRECT_RULE_KEYS = [
  'pool_low',
  'pool_cold',
  'pool_hot',
  'pool_buffer',
  'ev_low',
  'ev_short',
  'cheap_buy',
  'cheapest_buy',
  'dear_load',
  'dearest_load',
  'base_load_dear_import',
  'base_load_dearest_import',
  'missed_cheap_quarter',
  'arbitrage_no_export',
  'arbitrage_not_full',
  'ev_from_home_battery',
] as const;
export type DirectRuleKey = typeof DIRECT_RULE_KEYS[number];
export interface ReadySlot {
  start_seconds: number;
  hours: number;
  base_w: number;
  solar_w: number;
  outdoor_c: number;
  import_price: number;
  export_price: number;
  published: boolean;
  cheap_rank: number;
  dear_rank: number;
  next_day_buffer: boolean | null;
}
/** Already prepared: no historical, source-fetching or fitting API is reachable here. */
export interface ReadyProblem {
  abi: 1;
  work_grant: number;
  recipe: { max_passes: number; coupled_masks: number[] };
  slots: ReadySlot[];
  battery: BatteryModel;
  car: CarBatteryModel;
  charger: ChargerModel;
  pool_store: ThermalStoreModel;
  heater: { compressor_w: number; auxiliary_w: number; heat_w: number; response: HeatPumpResponse };
  initial: { battery_kwh: number; ev_kwh: number; pool_c: number; heater_age: RunAge };
  targets: { pool_c: number; ev_km: number; ev_limit_kwh: number };
  limits: {
    import_w: number;
    export_w: number;
    battery_export_enabled: boolean;
    battery_export_reserve_kwh: number;
    battery_export_min_price: number;
    wear_per_kwh: number;
  };
  rules: { key: DirectRuleKey; threshold: number; points: number }[];
  accepted: NativeCommand[] | null;
  locked_through_seconds: number;
}
