import type { HouseholdProblem, HouseholdCandidate } from "./household-case.ts";
/** Shared planning inputs and published commands; no planner implementation. */
import type { PlanningWarning } from "./planning-warnings.ts";
import type { HeatPumpResponse, DeviceModels, BatteryModel } from "./device-models.ts";
import type { ExecutionFeedback, BatteryExecutionContract } from "./battery-plan-execution.ts";
import type { OperatingScope } from "./operating-scope.ts";
import type { MeasurementIssue } from "./measurement-isolation.ts";
import type { BatteryCommand, BatteryOperation } from "./battery-command.ts";
import type { BatteryDemand, BatteryInstruction } from "./battery-instruction.ts";
import type { LevelBasis, WindDay, StoredPriceRow } from "./energy-price-shape.ts";
import type { DemandDay } from "./demand-outlook.ts";
import type { ThermalZoneModel } from "./models/room/thermal.ts";
import type { DeviceCommand } from "./device-commands.ts";
import type { ThermostatInput } from "./thermostat.ts";
import type { UtilityCurve } from "./store-value.ts";
import type { ValueSettings, ValueStoreKey } from "./value-curves.ts";
import type { PoolDynamics } from "./pool-response.ts";
import type { ExecutionChange, ExecutionReplan } from "./execution-evidence.ts";

export type PlanKey = "baseline" | "priority" | "cost";

export type DeviceKey = "pool" | "boiler" | "ev";

export type PlanMode = "live" | "demo";

export type DeviceLoadType =
  | "fixed_full_load"
  | "variable_full_load"
  | "duty_cycle"
  | "inverter";

export type DevicePlanningRole = "base_load" | "controllable";

export type DeviceControlType =
  | "switch_schedule"
  | "variable_power"
  | "permit_inhibit"
  | "setpoint";

export interface OptimisationCapabilities {
  pv: boolean;
  battery: boolean;
  pool: boolean;
  boiler: boolean;
  ev: boolean;
}

export interface SourceProvenance {
  provider: string;
  entity_ids: string[];
  issued_at: string;
  valid_until: string;
  quality: "measured" | "calibrated" | "provider_raw" | "synthetic";
  sample_count?: number;
  /** Measured household quarters whose device subtraction needed estimation. */
  estimated_sample_count?: number;
  mape_percent?: number;
  bias_percent?: number;
  location?: {
    latitude?: number;
    longitude?: number;
    market_area?: string;
  };
}

export interface ForecastSlotInput {
  start: string;
  pv_forecast_w: number;
  base_load_forecast_w: number;
  import_price_sek_per_kwh: number | null;
  export_price_sek_per_kwh: number | null;
}

export interface BatteryInput extends BatteryModel {
  soc: number;
}

export interface PoolHardwareInput {
  start_c: number;
  stop_c: number;
  source_entity_ids: Record<string, string>;
  control: "external_enable";
}

export interface PoolStateInput {
  /** Actual cumulative compressor-meter evidence across the unfinished quarter.
   * Every pool meter is supplied; heater membership is resolved server-side.
   * Missing counters remain missing, rather than inferred from switch states. */
  electrical_history?: {
    start: string;
    end: string;
    counters: { device_key: string; start_kwh: number; end_kwh: number }[];
  };
  /** Observed actuator intervals in the unfinished quarter, including runs
   * that already stopped. Incomplete observations remain useful evidence. */
  heating_history?: {
    start: string;
    end: string;
    complete: boolean;
    intervals: { start: string; end: string; elapsed_seconds_at_start: number;
      elapsed_basis: "confirmed_transition" | "observed_on_lower_bound" }[];
  };
  hardware?: PoolHardwareInput;
  water_temperature_c: number;
  volume_m3: number;
  /** Confirmed actuator continuation, null when its state could not be read. */
  heating_running?: boolean | null;
  /** Enabled run age at captured_at, measured from confirmed switch history. */
  heating_elapsed_seconds?: number | null;
  heating_elapsed_basis?: "confirmed_transition" | "observed_on_lower_bound";
  source_entity_ids?: Record<string, string>;
}

export interface EvBatteryInput {
  name: string;
  /** Measured cable state; planning assumes the car can be plugged in. */
  connected: boolean;
  capacity_kwh: number;
  soc: number;
  /** Physical vehicle charge cap; independent of household range readiness. */
  charge_limit_soc: number;
  charge_efficiency: number;
  /**
   * The vehicle's own kWh per kilometre, when the installation states one.
   *
   * Optional so an older integration keeps validating, but the seeded fallback
   * is a guess about somebody else's car: it converts state of charge into the
   * range the EV curve is defined over, so getting it wrong biases every
   * comparison the vehicle takes part in.
   */
  kwh_per_km?: number | null;
  available_from: string | null;
  priority: number;
  source_entity_ids: {
    connected: string;
    soc: string;
    target_soc: string;
    energy_remaining: string | null;
    charge_current: string | null;
  };
}

interface ServiceWindowInput {
  id: string;
  device: DeviceKey;
  earliest_start: string;
  deadline: string;
  priority: number;
}

interface DispatchableServiceInputBase extends ServiceWindowInput {
  required_kwh: number;
  baseline_preferred_start?: string;
}

export interface FixedPowerControl {
  type: "fixed_power";
  power_w: number;
  /**
   * The lowest non-zero power the hardware can actually hold, when it can hold
   * more than one. Omitted means the device is a relay: one power and off.
   *
   * The absence is the contract. An integration that learns to modulate can add
   * these two keys and an older planner, which reads only `power_w`, keeps
   * planning the home as a relay; an older integration stays silent and a newer
   * planner reaches the same envelope it does today. Neither side negotiates a
   * schema version to say a heat pump gained a power dial.
   */
  min_power_w?: number;
  /** The executable increment above `min_power_w`. Requires it. */
  power_step_w?: number;
}

export interface DiscreteCurrentControl {
  type: "discrete_current";
  min_current_a: number;
  max_current_a: number;
  current_step_a: number;
  phase_count: number;
  voltage_v: number;
}

export interface DutyCycleControl {
  type: "duty_cycle";
  rated_power_w: number | null;
  expected_power_w_by_slot: number[];
}

export interface FixedPowerServiceInput extends DispatchableServiceInputBase {
  device: "pool" | "ev";
  control: FixedPowerControl;
}

export interface DiscreteCurrentServiceInput
  extends DispatchableServiceInputBase {
  device: "ev";
  control: DiscreteCurrentControl;
}

export interface DutyCycleServiceInput extends ServiceWindowInput {
  device: "boiler";
  required_kwh: number;
  control: DutyCycleControl;
}

export type ServiceInput =
  | FixedPowerServiceInput
  | DiscreteCurrentServiceInput
  | DutyCycleServiceInput;

type DispatchableServiceInput =
  | FixedPowerServiceInput
  | DiscreteCurrentServiceInput;

export interface EmpiricalDeviceModelInput {
  key: string;
  name: string;
  statistic_id: string;
  category: string;
  suggested_load_type: DeviceLoadType;
  load_type: DeviceLoadType;
  planning_role: "controllable";
  control_type: DeviceControlType;
  /** Room heaters: configured or observed mean electrical draw during actual
   * heating. Never an idle reading, duty-average forecast or reservation peak.
   * Null denotes missing operating evidence; native admission owns its separate
   * conservative electrical bound. */
  active_power_w: number | null;
  /** Native thermostat sensor, target, HVAC state and supported target grid. */
  thermostat?: ThermostatInput | null;
  /** Explicit membership resolved from the installation mapping, never category alone. */
  planning_service?: "pool";
  /**
   * What a pool device does. Only the heater heats: the pump circulates water
   * past the heat exchanger and must run whenever the heater does. Absent, the
   * pool device drawing the most power is taken to be the heater.
   */
  pool_role?: "heater" | "circulation";
  profile_sample_count: number;
  /**
   * Named explicitly because this series is consumed as the baseline control
   * schedule. Setpoint zones are replaced server-side by the fitted thermal
   * model plus the portal comfort routine before the planner runs.
   */
  forecast_method?:
    | "empirical_recent_history"
    | "seasonal_heating_lockout_v1"
    | "thermal_comfort_schedule_v1";
  forecast_w_by_slot: number[];
}

export interface ThermalZonePlanningInput {
  key: string;
  name: string;
  device_keys: string[];
  model: ThermalZoneModel | null;
  start_temperature_c: number | null;
  /** Heater heat still on its way through the room's delay at the start, W. */
  start_delivered_w?: number | null;
  rated_power_w: number;
  comfort_min_c: number[];
  target_c: number[];
  comfort_max_c: number[];
  maximum_power_w_by_slot: number[];
  unplanned_power_w: number[];
}

export interface OptimisationSnapshot {
  /** Unresolved execution evidence, independent of snapshot capture and plan IDs. */
  execution_availability?: ExecutionChange[];
  planning_warnings?: PlanningWarning[];
  battery_execution_feedback?: ExecutionFeedback;
  /** Required by schema 9; frozen before server forecast enrichment. */
  operating_scope?: OperatingScope;
  /** Server-derived economic reference, frozen with the replay input; never physical authority. */
  replan_reference?: ReplanReference | null;
  /**
   * Devices Home Assistant left out because a reading was unusable or
   * impossible. The planner adds its own findings and leaves out the same
   * devices (see `isolateMeasurements`).
   */
  measurement_issues?: MeasurementIssue[];
  schema_version: 5 | 6 | 7 | 8 | 9 | 10 | 11;
  // Only Home Assistant live snapshots cross the ingestion boundary. The
  // website's promotional demo is a client-side plan fixture, not a snapshot.
  mode: "live";
  capabilities: OptimisationCapabilities;
  snapshot_id: string;
  captured_at: string;
  timezone: string;
  // Where the house is. Optional only because integrations older than
  // 0.8.0-beta.7 published it inside `sources.pv` instead, which made weather
  // a privilege of homes that generate; read it through `homeLocation()`,
  // never directly, so the older shape keeps working.
  location?: { latitude: number; longitude: number };
  slot_minutes: 15;
  slots: ForecastSlotInput[];
  sources: {
    pv: SourceProvenance | null;
    base_load: SourceProvenance;
    import_price: SourceProvenance;
    export_price: SourceProvenance;
    battery: SourceProvenance | null;
    // Present only once a home has named a weather entity. Thermal planning
    // is optional, so its absence must not invalidate an electrical snapshot.
    outdoor_temperature?: SourceProvenance | null;
  };
  pv_calibration: {
    correction_factor_by_lead_day: number[];
    sample_count_by_lead_day: number[];
  };
  battery: BatteryInput | null;
  // Optional while existing Home Assistant installations roll forward to the
  // EV telemetry publisher. Missing metadata must not stop their established
  // charging service from being planned.
  ev_battery?: EvBatteryInput | null;
  // Pool state, once its water temperature sensor is mapped (§8.3). Carried
  // and validated here but not yet consumed: the planner still sizes the pool
  // from a daily requirement, and will keep doing so until the whole objective
  // moves to marginal value at once. A planner reading a state for one store
  // and an energy budget for another cannot rank them against each other.
  pool?: PoolStateInput | null;
  /**
   * The home's utility curves, resolved by the edge before planning.
   *
   * Set server-side rather than sent by Home Assistant: the curves are a
   * customer preference held in the portal, and the integration has no business
   * knowing what a degree of pool water is worth. Absent means the shipped
   * defaults apply, which is what a home that has never opened the editor gets.
   */
  value_curves?: Partial<Record<ValueStoreKey, UtilityCurve>> | null;
  /** Resolved server-side; explicit points are manual unless a generation mode is stated. */
  /**
   * What the owner wants: one number per store. Present, the planner derives
   * the pool's and the car's service utility with target-economics.ts, using
   * the import reference and the existing urgency policy; `value_curves`
   * for those stores is not read.
   */
  comfort?: { pool?: { target_c: number }; ev?: { target_km: number } } | null;
  /**
   * Daily mean wind speed over the home's bidding zone, observed for the past
   * weeks and forecast for the days ahead (energy-price-shape.ts). The server
   * supplies it; the price level of unpublished days is estimated from it.
   */
  wind_outlook?: { provider?: string; zone?: string; days: WindDay[] } | null;
  /**
   * Recent days' base-load forecasts beside what those days drew
   * (demand-outlook.ts). The server supplies it; the base-load forecast is
   * levelled to it, and the demand planned for sits above the forecast by what
   * running short would cost.
   */
  demand_outlook?: { provider?: string; days: DemandDay[] } | null;
  /**
   * An administrator's scale on what each store's derived curve is worth; 1
   * when absent. Turns a store up or down without moving its target.
   */
  valuation?: Partial<Record<"pool" | "ev" | "battery", number>> | null;
  /**
   * `balanced` derives the curve from the forecast every plan; `custom` uses the
   * points in `value_curves.battery`. Any other stored value plans as balanced.
   */
  battery_curve_mode?: "custom" | "balanced";
  /**
   * The home's scalar prices, resolved by the edge alongside the curves.
   *
   * Same provenance and the same reason as `value_curves`: a customer figure
   * held in the portal, resolved before planning so a malformed row degrades to
   * the shipped default rather than failing the plan. Absent means the
   * defaults, which is what every snapshot written before this field existed
   * carries — including the replay capsules.
   */
  value_settings?: ValueSettings | null;
  /**
   * The home's device models (device-models.ts), for the devices that have
   * one: what each can be told to do and what it then does. Where a device has
   * a model here, the planner plans it with that and reads none of its numbers
   * from anywhere else: a pool's `pool_model`, the volume beside its reading
   * and its declared power, a car's capacity, consumption and charger control,
   * a battery's capacity, limits and efficiencies. A device without one is
   * planned from those older fields, as before.
   */
  device_physics?: Partial<DeviceModels> | null;
  /**
   * The pool's fitted loss and COP, when the fit was accepted.
   *
   * Absent through an unheated summer, which is the normal state rather than a
   * fault: with the heater idle there is no COP to identify. The planner uses
   * the seeded figures then, and says so through `forecast_method`.
   */
  pool_model?: {
    /** Learned response to compressor electricity, including its shutdown tail. */
    thermal_dynamics?: PoolDynamics;
    /** Reconstructed at this capture, separate from the daily parameter fit. */
    pending_heat_kwh?: number;
    source_depletion_kwh?: number;
    hardware?: PoolHardwareInput;
    heater_response?: HeatPumpResponse;
    /** Null while only the measured response exists; the seeded loss stands in then. */
    loss_kw_per_k: number | null;
    /** Null while only the idle loss is fitted; the seeded COP stands then. */
    rated_cop: number | null;
    cop_per_air_c: number | null;
    /**
     * Air temperature below which the unit cannot run, when one is on record.
     * Null — the default — means no cut-out is known, not that it is zero.
     */
    cutout_air_c?: number | null;
    /**
     * What the water temperature was measured to do, by the temperature it was
     * at (pool-training.ts `fitPoolResponse`): how fast the unheated pool's
     * reading moved, and what a kWh into the heater added to it. Where present
     * it replaces the loss coefficient and the COP: the cooling rate by the
     * temperature the pool is at, so a pool that stalls at one temperature is
     * planned to stall there, and the warming as one figure over all of it.
     */
    response?: { at_c: number; idle_c_per_h: number | null; heat_c_per_kwh: number | null; heated_kwh?: number }[] | null;
  } | null;
  grid: {
    import_limit_w: number;
    export_limit_w: number;
  };
  policy: {
    battery_end_of_solar_target_soc: number;
    battery_target_is_hard: boolean;
    terminal_soc_min: number;
    terminal_energy_value_sek_per_kwh: number;
    battery_export_enabled: boolean;
    battery_export_reserve_soc: number;
    battery_export_min_price_sek_per_kwh: number;
  };
  device_models: EmpiricalDeviceModelInput[];
  services: ServiceInput[];
  service_requirement_sample_days: Record<string, number>;
  /**
   * Forecast outdoor temperature per slot, aligned to `slots`. A null entry
   * is a quarter the weather provider did not cover; the series is absent
   * entirely when no weather entity is configured. Thermal projection needs
   * this, electrical planning does not.
   */
  outdoor_temperature_c?: (number | null)[];
  /**
   * Global horizontal irradiance per slot, W/m². Filled server-side for every
   * home, and optional in a way outdoor temperature is not: a zone with a
   * solar term falls back to the mean sun it was fitted on, so its absence
   * costs accuracy rather than shortening the horizon.
   */
  /** The house rooms sit in, per slot: their boundary when their model couples to it. */
  house_temperature_c?: (number | null)[] | null;
  solar_irradiance_w_per_m2?: (number | null)[] | null;
  /** Injected and validated by the planning edge, never supplied by the app. */
  thermal_zones?: ThermalZonePlanningInput[];
}

export interface BatteryValueCurveDiagnostic {
  schema_version: 2;
  source: "automatic" | "customer";
  automatic_curve: UtilityCurve;
  generation_mode?: "custom" | "balanced";
  curve: UtilityCurve;
  state_basis: "usable_kwh_above_min_soc";
  initial_state_kwh: number;
  usable_capacity_kwh: number;
  covering_window: Array<{
    start: string;
    import_price_sek_per_kwh: number;
    residual_load_ac_kwh: number;
    battery_energy_kwh: number;
  }>;
  terminal_replacement_sek_per_kwh: number;
  curve_input: {
    future_surplus_kwh: number;
    usable_kwh: number;
    /** What the curve converts a stored kWh with; see `dischargeEfficiency`. */
    discharge_efficiency: number;
    /** Energy held back, kWh above the hard floor, from `terminal_soc_min`. */
    reserve_kwh: number;
    /** What that energy is priced at: the dearest hour in the horizon. */
    worst_import_sek_per_kwh: number;
    degradation_sek_per_kwh: number;
    expected_draw_kwh: number;
  };
}

export type OptimisationSnapshotV5 =
  & Omit<OptimisationSnapshot, "schema_version">
  & {
    schema_version: 5;
  };

export type OptimisationSnapshotV6 =
  & Omit<OptimisationSnapshot, "schema_version">
  & {
    schema_version: 6;
  };

export type OptimisationSnapshotV7 = Omit<OptimisationSnapshot, "schema_version"> & { schema_version: 7 };

export type OptimisationSnapshotV8 = Omit<OptimisationSnapshot, "schema_version"> & { schema_version: 8 };

export interface QuarterGridBalanceDiagnostic {
  load_w: number;
  pv_w: number;
  battery_charge_w: number;
  battery_discharge_w: number;
  residual_w: number;
  direction: "import" | "export" | "balanced";
  power_w: number;
  limit_w: number;
  limit_binding: boolean;
  reason:
    | "residual_after_dispatch"
    | "import_limit"
    | "export_limit"
    | "balanced";
}

export interface QuarterDecisionDiagnostic {
  schema_version: 1;
  store_allocations: DispatchAllocationDiagnostic[];
  battery: DispatchBatteryDiagnostic | null;
  grid_balance: QuarterGridBalanceDiagnostic;
}

export interface PlannedSlot {
  /** Installation overhead already included in total load_w. */
  battery_idle_w?: number;
  /** Forecast charging assumes a future cable connection; telemetry stays truthful. */
  ev_charging_conditional?: boolean;
  /** Null explicitly means no new instruction; forecast watts cannot grant permission. */
  pool_permitted?: boolean | null;
  /** Hot water may use storage only with forecast replaceable surplus. */
  boiler_battery_allowed?: boolean;
  /** Physical time modelled after the effective planning timestamp. */
  duration_hours?: number;
  start: string;
  binding: boolean;
  pv_raw_w: number;
  pv_w: number;
  base_w: number;
  import_price_sek_per_kwh: number | null;
  export_price_sek_per_kwh: number | null;
  /**
   * What the planner actually valued this quarter at, in SEK per kWh.
   *
   * Equal to the published price where the market set one, and the measured
   * price shape times the recent level where it did not (§1.4.2). Nord Pool
   * prices about a day of a 72-hour horizon, so two thirds of every plan is
   * decided on these — and until they were published, nothing downstream could
   * show what the far half of a plan was reasoning about, or distinguish a
   * modelled price from a real one.
   */
  shadow_import_sek_per_kwh: number;
  shadow_export_sek_per_kwh: number;
  pool_w: number;
  /** Relay command at nominal input; required for a transient heater response. */
  pool_command_w?: number;
  /**
   * The pool water at the end of this quarter, °C, on the trajectory the
   * selected dispatch was scored on.
   *
   * Published because nothing else in a plan says it. `decision` records
   * accepted bids, and a plan that keeps a previous decision — continuity, a
   * fixed plan — has none, so a reader rebuilding the temperature from them
   * drew three nights of heating as one straight line. Present wherever the
   * pool is dispatched; absent on plans stored before it was published.
   */
  pool_temperature_c?: number;
  boiler_expected_w: number;
  boiler_permitted: boolean;
  ev_w: number;
  room_heating_w: Record<string, number>;
  device_loads_w: Record<string, number>;
  device_commands?: Record<string, DeviceCommand>;
  ev_target_current_a: number;
  ev_min_current_a: number;
  ev_max_current_a: number;
  ev_soc: number | null;
  ev_connected: boolean;
  load_w: number;
  battery_charge_w: number;
  battery_discharge_w: number;
  battery_export_w: number;
  battery_command?: BatteryCommand | null;
  /** Schema 10: the instruction HA executes for this quarter (contract v2). */
  battery_instruction?: BatteryInstruction;
  battery_soc: number;
  grid_import_w: number;
  grid_export_w: number;
  curtailed_w: number;
  unserved_w: number;
  import_cost_sek: number | null;
  export_revenue_sek: number | null;
  /** Recorded planner arithmetic; the portal must not reconstruct decisions. */
  decision: QuarterDecisionDiagnostic;
  /**
   * The rules that fired in this quarter of the selected schedule and the
   * points each gave or took, by rule key (planner-wasm/rule-policy.ts).
   *
   * The rules planner's own account, on the prices it planned with: what it
   * maximised, not a referee's verdict. Empty when no rule fired; absent on
   * every other scenario and on plans from a planner without rules.
   */
  rule_points?: Record<string, number>;
}

export interface PlanSummary {
  load_kwh: number;
  flexible_load_kwh: number;
  pv_kwh: number;
  grid_import_kwh: number;
  grid_export_kwh: number;
  curtailed_kwh: number;
  priced_import_kwh: number;
  priced_export_kwh: number;
  net_cost_sek: number;
  terminal_adjusted_cost_sek: number;
  battery_soc_start: number;
  battery_soc_end: number;
  battery_soc_low: number;
  battery_end_of_solar_soc: Record<string, number>;
  service_required_kwh: number;
  service_delivered_kwh: number;
  duty_cycle_deferred_kwh: number;
}

export interface GeneratedPlan {
  continuity?: ReplanDecision;
  key: PlanKey;
  label: string;
  status: "ready" | "infeasible";
  validation_errors: string[];
  slots: PlannedSlot[];
  summary: PlanSummary;
  service_slots: Record<string, number[]>;
  service_currents_a: Record<string, number[]>;
  service_inhibited_slots: Record<string, number[]>;
  /**
   * Devices this scenario planned as states rather than as fixed blocks.
   *
   * Published because a reader cannot otherwise tell an empty `service_slots`
   * apart from a service that was dropped, and would reject a perfectly good
   * plan for failing to fill a window it no longer has. Both the integration
   * and the portal read this.
   */
  dispatched_devices: string[];
  /** Why each dispatched store bought what it did (empty on schema 5). */
  store_diagnostics: StoreDiagnostic[];
}

/** A comparison that could not be projected has no forecast or cost to report. */
export type BaselinePlan = GeneratedPlan | (Omit<GeneratedPlan, "summary"> & {
  status: "infeasible";
  summary: null;
});

export interface OptimisationPlan {
  execution_availability?: ExecutionChange[];
  execution_replan?: { request_id: string; accepted_plan_id: string; changes: ExecutionChange[];
    released_intervals: Array<{owner: string; start: string; end: string}> };
  thermal_projection?: ThermalPlanningProjection;
  planning_warnings?: PlanningWarning[];
  /** Selected opportunities retained across rolling replans, keyed by UTC start. */
  hot_water_permissions?: string[];
  hot_water_shortfall_minutes?: Record<string, number>;
  /** Exact solver inputs for current-plan charts; never reconstructed in a UI. */
  resolved_value_stores?: Array<{
    key: string; curve: UtilityCurve; initial_state: number; max_state?: number;
    units_per_kwh: number; reference_sek_per_kwh: number;
    /** How the curve was derived, when the planner derived it from a target. */
    derivation?: TargetEconomicsEvidence;
  }>;
  battery_execution?: BatteryExecutionContract;
  /** Explicit default planning intent: all household consumption is eligible. */
  battery_supply_scope?: {kind:"whole_house"} | {kind:"none"} | {kind:"selected";include_base:boolean;planned_device_keys:string[]};
  /** Schema 10: the loads separated from base load and the battery's demand profiles. */
  battery_demand?: BatteryDemand;
  /** Required by schema 9. Top-level priority is the authoritative execution schedule. */
  operating_scope?: OperatingScope;
  execution_plan?: OptimisationPlan;
  /** Daily curve evidence for the conditional battery verification branch. */
  battery_verification_value_curve?: BatteryValueCurveDiagnostic | null;
  fixed_plan?: { id: string; starts_at: string; ends_at: string };
  schema_version: 5 | 6 | 7 | 8 | 9 | 10 | 11;
  mode: PlanMode;
  capabilities: OptimisationCapabilities;
  model_version: string;
  /** Independent version for descriptive, non-executable decision evidence. */
  decision_diagnostics_version: 2;
  plan_id: string;
  snapshot_id: string;
  issued_at: string;
  valid_until: string;
  binding_until: string;
  timezone: string;
  slot_minutes: 15;
  status: "ready" | "incomplete" | "infeasible";
  validation_errors: string[];
  /**
   * Devices this plan leaves out because a reading could not be real, and why.
   * Every other device is planned; both interfaces show these. Always present
   * from marginal-value-planner-v43; absent on plans stored before it.
   */
  measurement_issues?: MeasurementIssue[];
  sources: OptimisationSnapshot["sources"];
  pv_calibration: OptimisationSnapshot["pv_calibration"];
  /**
   * Where the prices past the day-ahead window came from.
   *
   * Published because a flat modelled price is indistinguishable from a broken
   * one when all a reader sees is a flat line. `shaped` false means the archive
   * has not yet reached `MIN_SHAPE_COVERAGE_DAYS`, so the tail is priced at the
   * recent level with no time preference — correct behaviour, and worth saying
   * out loud rather than drawing without comment (§1.4.3).
   */
  price_outlook: {
    /** Present when the level of the unpublished days was estimated from the wind forecast. */
    level_basis?: LevelBasis;
    /** False only when the plan carries no published price at all. */
    shaped: boolean;
    /** Distinct days of price history behind the shape. */
    observed_days: number;
    /** The same evidence weighted by recency, day type and season. */
    effective_days: number;
    level_sek_per_kwh: number | null;
    /** Exact unrounded series used by the solve and by deterministic replay. */
    shadow_import_sek_per_kwh: number[];
  };
  /**
   * How the base-load forecast was turned into the demand planned for; absent
   * when it was planned as given. `base_w` in every slot is the planned demand:
   * the forecast times `level_factor`, and times `margin_factor` when applied.
   */
  demand_outlook?: DemandOutlookDiagnostic;
  /** Exact derived home-battery curve used by every scenario in this solve. */
  battery_value_curve: BatteryValueCurveDiagnostic | null;
  policy: OptimisationSnapshot["policy"];
  battery: BatteryInput | null;
  ev_battery: EvBatteryInput | null;
  /** Measured planning state plus the website-owned upper temperature for execution. */
  pool: (PoolStateInput & { stop_temperature_c: number | null; heater_response?: HeatPumpResponse; planning_basis?: "thermal" | "empirical" }) | null;
  grid: OptimisationSnapshot["grid"];
  /**
   * The shaping constants this solve used (§8.16).
   *
   * Published because they are recoverable from nothing else the plan carries:
   * the same snapshot under a different threshold produces a different
   * schedule, so without these a stored plan cannot say which shaping it is an
   * answer to. Constants rather than policy, which is why they sit beside
   * `grid` instead of inside the echoed `policy`.
   */
  peak_shaping: {
    threshold_w: number;
    sek_per_kwh_per_kw: number;
    grid_ramp_sek_per_kw: number;
    load_start_preference_sek: number;
  };
  device_models: EmpiricalDeviceModelInput[];
  services: ServiceInput[];
  service_requirement_sample_days: Record<string, number>;
  plans: Record<Exclude<PlanKey, "baseline">, GeneratedPlan> & { baseline: BaselinePlan };
}

export type OptimisationPlanV5 = Omit<OptimisationPlan, "schema_version"> & {
  schema_version: 5;
};

export type OptimisationPlanV6 = Omit<OptimisationPlan, "schema_version"> & {
  schema_version: 6;
};

export type OptimisationPlanV8 = Omit<OptimisationPlan, "schema_version"> & { schema_version: 8 };

export type OptimisationPlanV7 = Omit<OptimisationPlan, "schema_version"> & { schema_version: 7 };

export interface DemandOutlookDiagnostic {
  /** Recent draw over recent forecast. */
  level_factor: number;
  /** What the margin would raise the levelled forecast by; 1 without a battery to charge for it. */
  margin_factor: number;
  /** Whether the plan was made for the margined demand, or for the levelled forecast alone. */
  margin_applied: boolean;
  /** The point of the day-to-day spread planned for; 0.5 is the forecast. */
  quantile: number;
  /** Day-to-day spread of draw around the levelled forecast, as a share of it. */
  spread: number;
  short_sek_per_kwh: number;
  over_sek_per_kwh: number;
  solar_refill_share: number;
  days: number;
}

export interface StoreDiagnostic {
  key: string;
  unit: string;
  /** Measured state in the curve's units, or null when there was none to read. */
  state: number | null;
  /**
   * What one more kWh into this store is worth right now, in SEK.
   *
   * Null when the store never reached the auction, which is a different
   * statement from zero: zero means "considered and worth nothing", null means
   * "never considered". Collapsing the two is exactly how a connected car
   * disappeared from a plan that reported no errors.
   */
  marginal_value_sek_per_kwh: number | null;
  /** The cheapest energy available to it anywhere in the horizon, in SEK. */
  cheapest_energy_sek_per_kwh: number | null;
  planned_kwh: number;
  returned_kwh: number;
  /**
   * Where the store ends up at the horizon edge, in its own units.
   *
   * Published because the schedule cannot answer the question a household
   * actually asks — "so how warm is the pool on Wednesday?" — from watts per
   * quarter. Null when the store never ran, so there was no trajectory.
   */
  end_state: number | null;
  reason:
    | "scheduled"
    | "state_above_curve"
    | "value_below_price"
    /**
     * Already at the state it may not pass, so there was nothing to bid for.
     *
     * Distinct from `outbid`, which says the store competed and lost. A car
     * sitting at its own charge limit never entered the auction — reporting a
     * contest it could not take part in is the §8.12.2 defect one level in,
     * where "considered and declined" and "could not participate" are made to
     * look alike.
     */
    | "at_state_cap"
    /** Cleared the cheapest price somewhere, but that energy went elsewhere. */
    | "outbid"
    // Everything below this line means the store was never in the auction.
    /** State is known, but no meter routes to this service (§3.2 capability). */
    | "not_controllable"
    /** The service is controllable, but nothing is plugged in to serve. */
    | "disconnected"
    /** Controllable, but the measured state the curve is over is missing. */
    | "state_unavailable"
    /** Nothing to price stored energy against, so no curve could be derived. */
    | "no_price_reference";
}

export interface OptimisationResult {
  plan: OptimisationPlan;
  battery_projection: BatteryProjection;
}

export interface EnergyPlanningInput {
  /** Explicit automatic request; never interpreted as a manual booking or energy debt. */
  execution_replan?: ExecutionReplan | null;
  snapshot: OptimisationSnapshot;
  now: string;
  price_archive: StoredPriceRow[];
  fixed_plan?: FixedEnergyPlan | null;
  resolved_price_outlook?: OptimisationPlan["price_outlook"];
}

export interface FixedEnergyPlan {
  id: string;
  starts_at: string;
  ends_at: string;
  source_snapshot_id: string;
  /** Absolute timestamps, never indices into a later rolling horizon. */
  slots: {
    start: string;
    power_w: Record<string, number>;
    discharge_w: Record<string, number>;
    targets: PlannedSlot;
    allow_export: boolean;
  }[];
}



export interface DispatchAllocationDiagnostic {
  store_key: string;
  direction: "charge" | "discharge";
  trigger: "economic_winner";
  allocation_order: number;
  /** Power/state were changed by the service-preserving cost refinement. */
  cost_refined?: boolean;
  /** Power was rounded onto the store's minimum active power, or to rest. */
  minimum_adjusted?: boolean;
  fixed_profile?: boolean;
  run_start_index: number;
  run_slots: number;
  power_w: number;
  state_before: number;
  state_after: number;
  state_unit: string;
  retention_factor: number;
  average_value_sek_per_kwh: number;
  energy_cost_sek_per_kwh: number;
  wear_cost_sek_per_kwh: number;
  start_cost_sek: number;
  net_value_sek: number;
  run_net_value_sek: number;
  solar_w: number;
  grid_w: number;
  discharge_destination: "load" | "export" | "mixed" | null;
  /** Joint storage transactions, priced together rather than against reserve value. */
  energy_transfers?: {
    charge_index: number;
    discharge_index: number;
    charged_kwh: number;
    discharged_kwh: number;
    saving_sek: number;
    grid_charged_kwh: number;
  }[];
}



export interface DispatchBatteryDiagnostic {
  action: "charge" | "discharge" | "hold";
  reason:
    | "profitable_charge"
    | "profitable_discharge"
    | "retained_value_exceeds_import"
    | "charge_value_below_export"
    | "state_floor"
    | "state_ceiling"
    | "future_state_constraint"
    | "load_added_after_dispatch"
    | "balanced";
  state_before: number;
  state_after: number;
  state_unit: string;
  /** Power the comparison covered; zero only when there was nothing to trade. */
  comparison_power_w: number;
  power_w: number;
  comparison_price_sek_per_kwh: number | null;
  stored_value_sek_per_kwh: number | null;
  wear_cost_sek_per_kwh: number;
  net_value_sek: number | null;
}


export interface ReplanReference {
  version: 2;
  source_plan_id: string;
  issued_at: string;
  evaluated_at: string;
  valid_until: string;
  slot_start: string;
  store_keys: string[];
  pool_heat: boolean | null;
  /**
   * Published quarters, from the current one, that the previous plan kept the
   * pool on without a break. Absent in references frozen before it existed.
   */
  pool_run_quarters?: number | null;
  battery: {
    operation: Exclude<BatteryOperation, "self_consumption">;
    charge_w: number;
    discharge_w: number;
  } | null;
}


export interface ReplanDecision {
  source_plan_id: string;
  selected: "proposed" | "direct" | "repaired" | "held";
  reason: string;
  proposed_sek: number | null;
  reference_sek: number | null;
  deadband_sek: number;
  /** Present when a running pool was held or deliberately let go. */
  held_run?: { quarters: number; held_sek: number; release_sek: number; released: boolean };
}



export interface TargetEconomicsEvidence {
  method: "target_utility";
  target: number;
  scale: number;
  reference_sek_per_kwh: number;
  willingness_multiplier: number;
  service_basis: "service_day" | "readiness_event";
}



/** Captured before display rounding, after all non-battery scheduling. */
export interface BatteryProjectionRow {
  start: string;
  end: string;
  house_w: number;
  /** Includes external demand in the execution branch; this is not graph base load. */
  residual_w: number;
  device_loads_w: Record<string, number>;
  charge_w: number;
  discharge_w: number;
  charge_dc_w: number;
  discharge_dc_w: number;
  battery_idle_w: number;
  /** Exact native stored-energy endpoint, never reconstructed from AC flows. */
  stored_end_kwh: number | null;
  export_w: number;
  curtailed_w: number;
  unserved_w: number;
}


export interface BatteryProjectionIdentity {
  snapshot_id: string;
  model_version: string;
  issued_at: string;
  branch: "execution" | "priority" | "battery_verification";
  operating_scope: OperatingScope | null;
}


export type BatteryProjection = {
  status: "unsupported";
  reasons: string[];
} | {
  status: "ready";
  problem: HouseholdProblem;
  selected_candidate: HouseholdCandidate;
  /** Add to household total to reproduce the conditional dispatch total. */
  dispatch_total_offset_sek: number;
  provenance: BatteryProjectionIdentity & {
    state_basis: "usable_kwh_above_min_soc";
    objective: "conditional_final_non_battery_schedule";
    final_demand: BatteryProjectionRow[];
    /** Bidding heuristics do not constitute physical grid-charge permission. */
    permission_basis: "dispatch_feasibility_not_actuator_authority";
  };
};

/** Only modelled temperatures are published; unknown temperatures remain absent. */
export interface ThermalPlanningProjection {
 source:"comfort_schedule_model"|"synthetic_season_fixture";season:"winter"|"spring"|"summer"|"autumn"|"ev_only"|null;slot_minutes:15;starts:string[];outdoor_temperature_c:number[];
 planned_total_power_w:number[];unplanned_total_power_w:number[];
 zones:{key:string;name:string;
 /** The room's device models, whose owners' operating modes say whether it is controlled. */
 device_keys?:string[];control_type:"switch_schedule"|"setpoint"|"mixed";load_type:DeviceLoadType|"mixed";
 priority:number;rated_power_w:number;comfort_min_c:number[];target_c:number[];comfort_max_c:number[];
 planned_temperature_c:number[];unplanned_temperature_c:number[];planned_power_w:number[];unplanned_power_w:number[]}[];
}
