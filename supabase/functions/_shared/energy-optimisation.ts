/**
 * Pure 15-minute energy planner shared by the ingestion edge function and its
 * contract tests. It deliberately has no database or browser dependencies.
 *
 * The planner is a deterministic, explainable heuristic. It is not a device
 * controller: Home Assistant still owns interlocks, overrides, thermostats and
 * command confirmation. Every schedule is simulated independently and then
 * verified before it may be published as `ready`.
 */

import {
  buildPriceOutlook,
  type PriceOutlook,
  type StoredPriceRow,
} from "./energy-price-shape.ts";
import {
  projectZoneTemperature,
  type ThermalZoneModel,
} from "./thermal-model.ts";
import {
  type DispatchAllocationDiagnostic,
  type DispatchBatteryDiagnostic,
  type DispatchResult,
  type DispatchSlot,
  type DispatchStore,
  planDispatch,
} from "./dispatch-plan.ts";
import {
  poolCop,
  stepPoolTemperature,
  WATER_KWH_PER_M3_K,
} from "./store-models.ts";
import {
  batteryValueCurve,
  marginalValue,
  type StoredEnergyValueInput,
  type UtilityCurve,
} from "./store-value.ts";
import {
  DEFAULT_VALUE_CURVES,
  DEFAULT_VALUE_SETTINGS,
  type ValueStoreKey,
} from "./value-curves.ts";

/**
 * Snapshot versions this planner can read, and the plan version it emits.
 *
 * A plan is emitted at the same version as the snapshot that produced it. That
 * is the whole rollout mechanism: an installation that can only send schema 5
 * keeps getting a schema 5 plan and the schema 5 planner, and one that has
 * updated to send 6 gets the store-based planner. Neither is ever handed a
 * contract it cannot read, which is what went wrong when v8 shipped.
 *
 * Schema 6 adds measured pool state. That is not decoration: it is the
 * difference between the pool being a temperature the planner schedules against
 * and a daily energy budget it has to believe.
 */
export const OPTIMISATION_SCHEMA_VERSION = 6;
export const SUPPORTED_SNAPSHOT_VERSIONS = [5, 6] as const;
/**
 * The planner's own version. It lives here because the planner lives here — the
 * integration only validates the string, against a set since beta.19, so this
 * can move without stopping control on an installation that has not updated.
 *
 * Bump it whenever the *decisions* change, not merely the code: the ROI page
 * medians over runs, and two planners sharing a label make that median
 * meaningless. v8 makes comfort schedules room-temperature constraints and
 * moves preheating inside the shared electrical objective. v10 replaces the
 * battery's peak-price step with the weighted merit order of displaced import.
 * v11 integrates every sizeable curve move, applies configured EV curves,
 * prices minimum runs as complete blocks and records exact quarter evidence.
 */
export const OPTIMISATION_MODEL_VERSION = "marginal-value-planner-v11";
/** The planner a schema 5 snapshot still receives, unchanged. */
export const LEGACY_MODEL_VERSION = "thermal-room-planner-v8";
export const SLOT_MINUTES = 15;
export const SLOT_HOURS = SLOT_MINUTES / 60;
export const MAX_FORECAST_SLOTS = 72 * 4;
const SLOT_MS = SLOT_MINUTES * 60_000;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SNAPSHOT_AGE_MS = 15 * 60_000;
const MAX_SOURCE_FUTURE_SKEW_MS = 5 * 60_000;
const SOURCE_MAX_AGE_MS = {
  pv: 12 * 60 * 60_000,
  base_load: 3 * 60 * 60_000,
  import_price: 48 * 60 * 60_000,
  export_price: 48 * 60 * 60_000,
  battery: 15 * 60_000,
} as const;

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
  base_load_p10_w: number;
  base_load_p90_w: number;
  import_price_sek_per_kwh: number | null;
  export_price_sek_per_kwh: number | null;
}

export interface BatteryInput {
  capacity_kwh: number;
  soc: number;
  min_soc: number;
  max_soc: number;
  charge_max_w: number;
  discharge_max_w: number;
  charge_efficiency: number;
  discharge_efficiency: number;
}

/**
 * Read-only vehicle state used to explain the EV energy requirement and to
 * project SOC. The executable charging envelope still comes exclusively from
 * the EV service below, so adding this metadata cannot actuate the vehicle.
 */
/**
 * Measured pool state.
 *
 * Volume is a reviewed installation figure; the loss coefficient and the heat
 * pump's COP curve are deliberately absent, because both are fitted from the
 * water-temperature series against outdoor temperature and the pool heater's
 * metered energy rather than entered at commissioning (§8.10).
 */
export interface PoolStateInput {
  water_temperature_c: number;
  volume_m3: number;
  source_entity_ids?: Record<string, string>;
}

export interface EvBatteryInput {
  name: string;
  connected: boolean;
  capacity_kwh: number;
  soc: number;
  departure_target_soc: number;
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
  departure: string | null;
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
  min_run_slots: number;
  baseline_preferred_start?: string;
}

export interface FixedPowerControl {
  type: "fixed_power";
  power_w: number;
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
  rated_power_w: number;
  expected_power_w_by_slot: number[];
  max_consecutive_inhibit_slots: number;
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
  active_power_w: number | null;
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

/**
 * Server-prepared room constraint. Home Assistant identifies the room and its
 * actuators; the planning edge joins that to the learned 1R1C model and the
 * portal-owned weekly routine before the pure planner sees it.
 */
export interface ThermalZonePlanningInput {
  key: string;
  name: string;
  device_keys: string[];
  model: ThermalZoneModel;
  start_temperature_c: number;
  rated_power_w: number;
  comfort_min_c: number[];
  target_c: number[];
  comfort_max_c: number[];
  maximum_power_w_by_slot: number[];
  unplanned_power_w: number[];
}

export interface OptimisationSnapshot {
  schema_version: 5 | 6;
  // Only Home Assistant live snapshots cross the ingestion boundary. The
  // website's promotional demo is a client-side plan fixture, not a snapshot.
  mode: "live";
  capabilities: OptimisationCapabilities;
  snapshot_id: string;
  captured_at: string;
  timezone: string;
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
  /**
   * The pool's fitted loss and COP, when the fit was accepted.
   *
   * Absent through an unheated summer, which is the normal state rather than a
   * fault: with the heater idle there is no COP to identify. The planner uses
   * the seeded figures then, and says so through `forecast_method`.
   */
  pool_model?: {
    loss_kw_per_k: number;
    rated_cop: number;
    cop_per_air_c: number;
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
  /** Injected and validated by the planning edge, never supplied by the app. */
  thermal_zones?: ThermalZonePlanningInput[];
}

/** The read-only curve the planner derived for usable home-battery energy. */
export interface BatteryValueCurveDiagnostic {
  schema_version: 1;
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
  curve_input: {
    future_surplus_kwh: number;
    usable_kwh: number;
    round_trip_efficiency: number;
    degradation_sek_per_kwh: number;
    expected_draw_kwh: number;
  };
}

/** Exact snapshot contracts; the discriminator never spans versions. */
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
  start: string;
  binding: boolean;
  pv_raw_w: number;
  pv_w: number;
  base_w: number;
  base_p10_w: number;
  base_p90_w: number;
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
  boiler_expected_w: number;
  boiler_permitted: boolean;
  ev_w: number;
  room_heating_w: Record<string, number>;
  device_loads_w: Record<string, number>;
  ev_target_current_a: number;
  ev_min_current_a: number;
  ev_max_current_a: number;
  ev_soc: number | null;
  ev_connected: boolean;
  load_w: number;
  battery_charge_w: number;
  battery_discharge_w: number;
  battery_export_w: number;
  battery_soc: number;
  grid_import_w: number;
  grid_export_w: number;
  curtailed_w: number;
  unserved_w: number;
  import_cost_sek: number | null;
  export_revenue_sek: number | null;
  /** Recorded planner arithmetic; the portal must not reconstruct decisions. */
  decision: QuarterDecisionDiagnostic;
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

export interface OptimisationPlan {
  schema_version: 5 | 6;
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
  /** Exact derived home-battery curve used by every scenario in this solve. */
  battery_value_curve: BatteryValueCurveDiagnostic | null;
  policy: OptimisationSnapshot["policy"];
  battery: BatteryInput | null;
  ev_battery: EvBatteryInput | null;
  /** Echoed like the batteries, so a reader can see the state it was planned from. */
  pool: PoolStateInput | null;
  grid: OptimisationSnapshot["grid"];
  device_models: EmpiricalDeviceModelInput[];
  services: ServiceInput[];
  service_requirement_sample_days: Record<string, number>;
  plans: Record<PlanKey, GeneratedPlan>;
}

/** Exact plan contracts; model names are deliberately independent. */
export type OptimisationPlanV5 = Omit<OptimisationPlan, "schema_version"> & {
  schema_version: 5;
};

export type OptimisationPlanV6 = Omit<OptimisationPlan, "schema_version"> & {
  schema_version: 6;
};

interface PreparedSlot extends ForecastSlotInput {
  index: number;
  epoch_ms: number;
  local_day: string;
  local_minute_of_day: number;
  pv_raw_w: number;
  pv_w: number;
  uncontrolled_device_w: number;
  binding: boolean;
  /**
   * What a kWh is worth here, in SEK: the published price where the market has
   * set one, and the measured shape prior where it has not
   * (ENERGY_OPTIMISATION_ARCHITECTURE.md §1.4.2). Nord Pool publishes day-ahead
   * against a 72-hour horizon, so two thirds of every plan depends on this.
   */
  shadow_import_sek_per_kwh: number;
  shadow_export_sek_per_kwh: number;
}

/**
 * Weight on the convex peak term, in SEK per kW of slot draw squared.
 *
 * The grid tariff has no demand charge today and Phil expects an equivalent to
 * return, so this is deliberately small: enough to break a tie toward a flat
 * draw, not enough to outweigh a real price difference (§1.4.4). Convexity is
 * what makes spreading win — the previous objective was linear in power, so
 * four quarters at 2 kW and one at 8 kW scored identically. When a demand
 * charge returns this becomes its actual rate.
 */
const PEAK_WEIGHT_SEK_PER_KW2 = 0.004;

interface Schedule {
  pool: number[];
  boiler: number[];
  boilerPermitted: boolean[];
  ev: number[];
  evTargetCurrentA: number[];
  evMinCurrentA: number[];
  evMaxCurrentA: number[];
  roomHeating: Record<string, number[]>;
  serviceSlots: Record<string, number[]>;
  serviceCurrentsA: Record<string, number[]>;
  serviceInhibitedSlots: Record<string, number[]>;
  /**
   * Devices the marginal-value dispatch owns.
   *
   * Empty on schema 5. When it names a device, the block-model reconciliations
   * below must not be applied to it: a dispatched store has no `required_kwh`
   * to deliver and no per-service window to fill, so checking it against either
   * reports a plan as infeasible for failing to obey a model it is no longer
   * using.
   */
  dispatched: Set<string>;
  batteryChargeW: number[];
  batteryDischargeW: number[];
  dispatchAllocations: DispatchAllocationDiagnostic[][];
  dispatchBattery: (DispatchBatteryDiagnostic | null)[];
  dispatchImportW: number[];
  storeDiagnostics: StoreDiagnostic[];
}

/**
 * Why a store did what it did, in the plan itself.
 *
 * A planner that only reports validation errors cannot answer "why is nothing
 * scheduled?", which is the question actually asked of it. Answering it
 * previously meant querying the database for the snapshot and re-running the
 * planner locally — for a pool that turned out to be sitting one degree above
 * the top of its own curve and was therefore right to do nothing.
 *
 * Every number here is in the units the decision was made in, so the comparison
 * that produced the outcome can be read directly: a store buys when its
 * marginal value beats the cheapest energy it could have used.
 */
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

/** Reasons that mean the store never bid, as opposed to bidding and losing. */
export const UNCONSIDERED_STORE_REASONS = [
  "not_controllable",
  "disconnected",
  "state_unavailable",
  "no_price_reference",
] as const;

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const inRange = (value: number, min: number, max: number) =>
  finite(value) && value >= min && value <= max;

const isoMs = (value: string) => Date.parse(value);

const round = (value: number, digits = 5) => {
  const multiplier = 10 ** digits;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
};

const stepAligned = (value: number, origin: number, step: number) =>
  Math.abs((value - origin) / step - Math.round((value - origin) / step)) <
    1e-6;

const isDiscreteCurrentService = (
  service: ServiceInput,
): service is DiscreteCurrentServiceInput =>
  service.control.type === "discrete_current";

const isDutyCycleService = (
  service: ServiceInput,
): service is DutyCycleServiceInput => service.control.type === "duty_cycle";

const isDispatchableService = (
  service: ServiceInput,
): service is DispatchableServiceInput => !isDutyCycleService(service);

const wattsPerAmp = (control: DiscreteCurrentControl) =>
  control.phase_count * control.voltage_v;

/**
 * The charger's declared current control, or null.
 *
 * Read rather than assumed. The phase count and voltage arrive from the
 * installation's own configuration, and this planner used to ignore them in
 * favour of a hard-coded three 230 V phases — which models a single-phase
 * charger at three times the power it can deliver, and produces a confident
 * plan rather than an error.
 */
const evCurrentControl = (
  snapshot: OptimisationSnapshot,
): DiscreteCurrentControl | null =>
  snapshot.services
    .filter(isDispatchableService)
    .find(isDiscreteCurrentService)?.control ?? null;

/** The vehicle's stated consumption, or the seeded fallback. */
const vehicleKwhPerKm = (vehicle: EvBatteryInput): number =>
  typeof vehicle.kwh_per_km === "number" && vehicle.kwh_per_km > 0
    ? vehicle.kwh_per_km
    : SEEDED_VEHICLE_KWH_PER_KM;

const localTimeFormatters = new Map<string, Intl.DateTimeFormat>();

/** Resolve a slot's local calendar coordinates with one cached ICU formatter. */
const localSlotTime = (epochMs: number, timezone: string) => {
  let formatter = localTimeFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    localTimeFormatters.set(timezone, formatter);
  }
  const values: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(epochMs))) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  return {
    day: `${values.year}-${values.month}-${values.day}`,
    minuteOfDay: Number(values.hour) * 60 + Number(values.minute),
  };
};

function completedLocalDays(
  slots: PreparedSlot[],
  timezone: string,
): Set<string> {
  const endDay = localSlotTime(
    slots[slots.length - 1].epoch_ms + SLOT_MS,
    timezone,
  ).day;
  return new Set(
    slots.map((slot) => slot.local_day).filter((day) => day < endDay),
  );
}

export function validateSnapshot(snapshot: OptimisationSnapshot): string[] {
  const errors: string[] = [];
  if (
    !SUPPORTED_SNAPSHOT_VERSIONS.includes(
      snapshot?.schema_version as 5 | 6,
    )
  ) {
    errors.push("schema_version must be 5 or 6");
  }
  if (snapshot?.mode !== "live") {
    errors.push("mode must be live");
  }
  const capabilityKeys = ["pv", "battery", "pool", "boiler", "ev"] as const;
  if (
    !snapshot?.capabilities ||
    capabilityKeys.some((key) =>
      typeof snapshot.capabilities[key] !== "boolean"
    )
  ) {
    errors.push("capabilities are invalid");
  }
  if (snapshot?.slot_minutes !== SLOT_MINUTES) {
    errors.push("slot_minutes must be 15");
  }
  if (!UUID_RE.test(snapshot?.snapshot_id ?? "")) {
    errors.push("snapshot_id must be a UUID");
  }
  if (!Number.isFinite(isoMs(snapshot?.captured_at))) {
    errors.push("captured_at is invalid");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: snapshot?.timezone }).format();
  } catch {
    errors.push("timezone is invalid");
  }
  if (
    !Array.isArray(snapshot?.slots) || snapshot.slots.length < 4 ||
    snapshot.slots.length > MAX_FORECAST_SLOTS
  ) {
    errors.push(`slots must contain 4..${MAX_FORECAST_SLOTS} quarter-hours`);
  }

  let previous = -1;
  for (const [index, slot] of (snapshot?.slots ?? []).entries()) {
    const start = isoMs(slot?.start);
    if (!Number.isFinite(start)) {
      errors.push(`slots[${index}].start is invalid`);
    }
    if (start % (SLOT_MINUTES * 60_000) !== 0) {
      errors.push(`slots[${index}].start is not quarter-hour aligned`);
    }
    if (previous >= 0 && start - previous !== SLOT_MINUTES * 60_000) {
      errors.push(`slots[${index}] is not contiguous`);
    }
    previous = start;
    for (
      const [field, value] of [
        ["pv_forecast_w", slot?.pv_forecast_w],
        ["base_load_forecast_w", slot?.base_load_forecast_w],
      ] as const
    ) {
      if (!finite(value) || value < 0 || value > 100_000) {
        errors.push(`slots[${index}].${field} is invalid`);
      }
    }
    if (
      !finite(slot?.base_load_p10_w) || !finite(slot?.base_load_p90_w) ||
      slot.base_load_p10_w < 0 || slot.base_load_p90_w < slot.base_load_p10_w ||
      slot.base_load_forecast_w < slot.base_load_p10_w ||
      slot.base_load_forecast_w > slot.base_load_p90_w
    ) {
      errors.push(`slots[${index}] has invalid base-load confidence bounds`);
    }
    for (
      const field of [
        "import_price_sek_per_kwh",
        "export_price_sek_per_kwh",
      ] as const
    ) {
      const value = slot?.[field];
      if (value !== null && (!finite(value) || value < -20 || value > 100)) {
        errors.push(`slots[${index}].${field} is invalid`);
      }
    }
    if (
      (slot?.import_price_sek_per_kwh === null) !==
        (slot?.export_price_sek_per_kwh === null)
    ) {
      errors.push(
        `slots[${index}] must price import and export over the same binding interval`,
      );
    }
  }

  const battery = snapshot?.battery;
  if (snapshot?.capabilities?.battery && !battery) {
    errors.push("battery is required when the capability is enabled");
  } else if (!snapshot?.capabilities?.battery && battery !== null) {
    errors.push("battery must be null when the capability is disabled");
  } else if (battery) {
    if (!inRange(battery.capacity_kwh, 0.1, 1_000)) {
      errors.push("battery.capacity_kwh is invalid");
    }
    if (
      !inRange(battery.min_soc, 0, 1) || !inRange(battery.max_soc, 0, 1) ||
      battery.min_soc >= battery.max_soc
    ) errors.push("battery SOC bounds are invalid");
    if (!inRange(battery.soc, battery.min_soc, battery.max_soc)) {
      errors.push("battery.soc is outside its configured bounds");
    }
    if (
      !inRange(battery.charge_efficiency, 0.5, 1) ||
      !inRange(battery.discharge_efficiency, 0.5, 1)
    ) {
      errors.push("battery efficiencies are invalid");
    }
    if (
      !inRange(battery.charge_max_w, 0, 100_000) ||
      !inRange(battery.discharge_max_w, 0, 100_000)
    ) {
      errors.push("battery power limits are invalid");
    }
  }
  const evBattery = snapshot?.ev_battery;
  // Vehicle state may be reported without the EV capability, exactly as pool
  // state may. A capability is a *control contract* — "a meter is routed to
  // this service" — while the state is a measurement, and requiring them to
  // agree made an unrouted car unrepresentable rather than merely unplanned.
  // The planner still refuses to dispatch what it may not control; it can now
  // say what it declined to plan and why (§8.12.1).
  if (evBattery) {
    const sourceIds = evBattery.source_entity_ids;
    if (
      !evBattery.name || !inRange(evBattery.capacity_kwh, 1, 500) ||
      !inRange(evBattery.soc, 0, 1) ||
      !inRange(evBattery.departure_target_soc, 0, 1) ||
      !inRange(evBattery.charge_efficiency, 0.5, 1) ||
      !Number.isInteger(evBattery.priority) || evBattery.priority < 1 ||
      !sourceIds ||
      [sourceIds.connected, sourceIds.soc, sourceIds.target_soc].some((value) =>
        typeof value !== "string" || value.length === 0
      ) ||
      [sourceIds.energy_remaining, sourceIds.charge_current].some((value) =>
        value !== null && (typeof value !== "string" || value.length === 0)
      )
    ) {
      errors.push("ev_battery is invalid");
    }
    const availableFrom = evBattery.available_from === null
      ? Number.NaN
      : isoMs(evBattery.available_from);
    const departure = evBattery.departure === null
      ? null
      : isoMs(evBattery.departure);
    if (
      evBattery.connected &&
      (!Number.isFinite(availableFrom) ||
        (departure !== null &&
          (!Number.isFinite(departure) || availableFrom >= departure)))
    ) {
      errors.push(
        "connected ev_battery requires a valid availability start and optional departure",
      );
    }
    if (
      !evBattery.connected &&
      (evBattery.available_from !== null || evBattery.departure !== null)
    ) {
      errors.push(
        "disconnected ev_battery must not declare an availability window",
      );
    }
  }
  const pool = snapshot?.pool;
  if (pool !== undefined && pool !== null) {
    // A pool sensor reading an air probe, or a volume nobody reviewed, would
    // silently mis-scale every degree the planner later buys. Refuse it here
    // rather than store a state that reads plausibly and models nothing.
    if (
      !finite(pool.water_temperature_c) ||
      !inRange(pool.water_temperature_c, -5, 60) ||
      !finite(pool.volume_m3) ||
      !inRange(pool.volume_m3, 0.5, 5_000)
    ) {
      errors.push("pool state is invalid");
    }
  }
  if (
    !snapshot?.grid || !inRange(snapshot.grid.import_limit_w, 100, 500_000) ||
    !inRange(snapshot.grid.export_limit_w, 0, 500_000)
  ) {
    errors.push("grid limits are invalid");
  }
  if (
    !snapshot?.policy ||
    typeof snapshot.policy.battery_target_is_hard !== "boolean" ||
    !inRange(snapshot.policy.battery_end_of_solar_target_soc, 0, 1) ||
    !inRange(snapshot.policy.terminal_soc_min, 0, 1) ||
    !inRange(snapshot.policy.terminal_energy_value_sek_per_kwh, -20, 100)
  ) {
    errors.push("policy is invalid");
  } else if (
    !battery && (
      snapshot.policy.battery_target_is_hard ||
      snapshot.policy.battery_end_of_solar_target_soc !== 0 ||
      snapshot.policy.terminal_soc_min !== 0 ||
      snapshot.policy.terminal_energy_value_sek_per_kwh !== 0
    )
  ) {
    errors.push(
      "battery policy must be disabled when no battery is configured",
    );
  } else if (
    battery && (
      !inRange(
        snapshot.policy.battery_end_of_solar_target_soc,
        battery.min_soc,
        battery.max_soc,
      ) ||
      !inRange(
        snapshot.policy.terminal_soc_min,
        battery.min_soc,
        battery.max_soc,
      )
    )
  ) {
    errors.push("battery policy targets are outside the configured SOC bounds");
  }
  if (
    typeof snapshot.policy.battery_export_enabled !== "boolean" ||
    !inRange(snapshot.policy.battery_export_reserve_soc, 0, 1) ||
    !inRange(
      snapshot.policy.battery_export_min_price_sek_per_kwh,
      0,
      100,
    )
  ) {
    errors.push("battery export policy is invalid");
  } else if (
    battery && snapshot.policy.battery_export_enabled &&
    !inRange(
      snapshot.policy.battery_export_reserve_soc,
      battery.min_soc,
      battery.max_soc,
    )
  ) {
    errors.push("battery export reserve is outside the configured SOC bounds");
  } else if (
    !battery && (
      snapshot.policy.battery_export_enabled ||
      snapshot.policy.battery_export_reserve_soc !== 0 ||
      snapshot.policy.battery_export_min_price_sek_per_kwh !== 0
    )
  ) {
    errors.push(
      "battery export policy must be disabled when no battery is configured",
    );
  }

  const firstStart = isoMs(snapshot?.slots?.[0]?.start);
  const horizonEnd = previous + SLOT_MINUTES * 60_000;
  const capturedAt = isoMs(snapshot?.captured_at);
  if (
    Number.isFinite(firstStart) && Number.isFinite(capturedAt) &&
    (firstStart < Math.floor(capturedAt / SLOT_MS) * SLOT_MS ||
      firstStart > capturedAt + SLOT_MS)
  ) {
    errors.push(
      "first forecast slot must start at the current or next quarter-hour",
    );
  }
  if (snapshot?.slots?.[0]?.import_price_sek_per_kwh === null) {
    errors.push("the first forecast slot must have import and export prices");
  }
  if (!Array.isArray(snapshot?.device_models)) {
    errors.push("device_models must be an array");
  }
  const deviceModelKeys = new Set<string>();
  const loadTypes = new Set<DeviceLoadType>([
    "fixed_full_load",
    "variable_full_load",
    "duty_cycle",
    "inverter",
  ]);
  const controlTypes = new Set<DeviceControlType>([
    "switch_schedule",
    "variable_power",
    "permit_inhibit",
    "setpoint",
  ]);
  for (const [index, model] of (snapshot?.device_models ?? []).entries()) {
    if (!model?.key || deviceModelKeys.has(model.key)) {
      errors.push(`device_models[${index}].key is missing or duplicated`);
    }
    deviceModelKeys.add(model?.key);
    if (
      !model?.name || !model?.statistic_id || !model?.category ||
      !loadTypes.has(model?.suggested_load_type) ||
      !loadTypes.has(model?.load_type) ||
      model?.planning_role !== "controllable" ||
      !controlTypes.has(model?.control_type) ||
      (model.active_power_w !== null &&
        !inRange(model.active_power_w, 0, 100_000)) ||
      !Number.isInteger(model?.profile_sample_count) ||
      model.profile_sample_count < 0 ||
      (model.forecast_method !== undefined &&
        ![
          "empirical_recent_history",
          "seasonal_heating_lockout_v1",
          "thermal_comfort_schedule_v1",
        ].includes(
          model.forecast_method,
        )) ||
      !Array.isArray(model?.forecast_w_by_slot) ||
      model.forecast_w_by_slot.length !== snapshot.slots.length ||
      model.forecast_w_by_slot.some((value) => !inRange(value, 0, 100_000))
    ) {
      errors.push(`device_models[${index}] is invalid`);
    }
  }
  if (
    snapshot?.thermal_zones !== undefined &&
    !Array.isArray(snapshot.thermal_zones)
  ) {
    errors.push("thermal_zones must be an array when supplied");
  }
  const thermalKeys = new Set<string>();
  const thermalDeviceKeys = new Set<string>();
  const horizonLength = snapshot?.slots?.length ?? 0;
  if (
    (snapshot?.thermal_zones?.length ?? 0) > 0 &&
    (!Array.isArray(snapshot.outdoor_temperature_c) ||
      snapshot.outdoor_temperature_c.length !== horizonLength ||
      snapshot.outdoor_temperature_c.some((value) =>
        value === null || !inRange(value, -80, 80)
      ))
  ) {
    errors.push("thermal_zones require complete outdoor_temperature_c");
  }
  for (const [index, zone] of (snapshot?.thermal_zones ?? []).entries()) {
    const model = zone?.model;
    const series = [
      zone?.comfort_min_c,
      zone?.target_c,
      zone?.comfort_max_c,
      zone?.maximum_power_w_by_slot,
      zone?.unplanned_power_w,
    ];
    const duplicateDevice = zone?.device_keys?.some((key) =>
      thermalDeviceKeys.has(key)
    );
    const invalidDevice = zone?.device_keys?.some((key) => {
      const device = snapshot.device_models.find((candidate) =>
        candidate.key === key
      );
      return !device || !["setpoint", "switch_schedule"].includes(
        device.control_type,
      );
    });
    if (
      !zone?.key || thermalKeys.has(zone.key) || !zone?.name ||
      !Array.isArray(zone?.device_keys) || zone.device_keys.length === 0 ||
      new Set(zone.device_keys).size !== zone.device_keys.length ||
      duplicateDevice || invalidDevice ||
      !inRange(zone?.start_temperature_c, -50, 80) ||
      !inRange(zone?.rated_power_w, 1, 100_000) || !model ||
      !inRange(model.gain_c_per_wh, 1e-9, 1) ||
      !inRange(model.cooling_constant_per_h, 0, 3.99) ||
      !inRange(model.background_gain_c_per_h, -10, 10) ||
      series.some((values) =>
        !Array.isArray(values) || values.length !== horizonLength ||
        values.some((value) => !finite(value))
      ) ||
      zone.comfort_min_c.some((value, slot) =>
        !inRange(value, 5, 30) || !inRange(zone.target_c[slot], 5, 30) ||
        !inRange(zone.comfort_max_c[slot], 5, 31) ||
        !inRange(zone.maximum_power_w_by_slot[slot], 0, 100_000) ||
        !inRange(zone.unplanned_power_w[slot], 0, 100_000) ||
        value > zone.target_c[slot] ||
        zone.target_c[slot] > zone.comfort_max_c[slot] ||
        zone.maximum_power_w_by_slot[slot] > zone.rated_power_w ||
        zone.unplanned_power_w[slot] > zone.maximum_power_w_by_slot[slot]
      )
    ) {
      errors.push(`thermal_zones[${index}] is invalid`);
      continue;
    }
    thermalKeys.add(zone.key);
    for (const key of zone.device_keys) thermalDeviceKeys.add(key);
  }
  if (!Array.isArray(snapshot?.services)) {
    errors.push("services must be an array");
  }
  const ids = new Set<string>();
  for (const [index, service] of (snapshot?.services ?? []).entries()) {
    if (!service?.id || ids.has(service.id)) {
      errors.push(`services[${index}].id is missing or duplicated`);
    }
    ids.add(service?.id);
    if (!["pool", "boiler", "ev"].includes(service?.device)) {
      errors.push(`services[${index}].device is invalid`);
    } else if (!snapshot?.capabilities?.[service.device]) {
      errors.push(`services[${index}] uses a disabled capability`);
    }
    const earliest = isoMs(service?.earliest_start);
    const deadline = isoMs(service?.deadline);
    const windowErrors: string[] = [];
    if (!Number.isFinite(earliest)) {
      windowErrors.push("earliest_start is invalid");
    }
    if (!Number.isFinite(deadline)) windowErrors.push("deadline is invalid");
    if (
      Number.isFinite(earliest) && Number.isFinite(deadline) &&
      earliest >= deadline
    ) {
      windowErrors.push("earliest_start is not before deadline");
    }
    if (Number.isFinite(earliest) && earliest < firstStart) {
      windowErrors.push("earliest_start precedes the first forecast slot");
    }
    if (Number.isFinite(deadline) && deadline > horizonEnd) {
      windowErrors.push("deadline exceeds the forecast horizon");
    }
    if (windowErrors.length > 0) {
      errors.push(
        `services[${index}] has an invalid service window: ${
          windowErrors.join(", ")
        }`,
      );
    }
    if (
      !inRange(service?.required_kwh, 0, 1_000) ||
      !Number.isInteger(service?.priority) || service.priority < 1
    ) errors.push(`services[${index}] has invalid energy or priority`);
    const control = service?.control;
    const minimumRunSlots = "min_run_slots" in service
      ? service.min_run_slots
      : Number.NaN;
    if (!control || typeof control !== "object") {
      errors.push(`services[${index}].control is missing`);
    } else if (control.type === "fixed_power") {
      if (
        service.device === "boiler" ||
        !inRange(control.power_w, 100, 100_000) ||
        !Number.isInteger(minimumRunSlots) ||
        !inRange(minimumRunSlots, 1, 96)
      ) {
        errors.push(`services[${index}] has invalid fixed power`);
      }
    } else if (control.type === "discrete_current") {
      if (service.device !== "ev") {
        errors.push(`services[${index}] current control is only valid for EVs`);
      }
      if (
        !inRange(control.min_current_a, 0.1, 80) ||
        !inRange(control.max_current_a, control.min_current_a, 80) ||
        !inRange(control.current_step_a, 0.1, control.max_current_a) ||
        !Number.isInteger(control.phase_count) ||
        !inRange(control.phase_count, 1, 3) ||
        !inRange(control.voltage_v, 100, 500) ||
        !stepAligned(
          control.max_current_a,
          control.min_current_a,
          control.current_step_a,
        ) ||
        !inRange(
          control.max_current_a * wattsPerAmp(control),
          100,
          100_000,
        ) || !Number.isInteger(minimumRunSlots) ||
        !inRange(minimumRunSlots, 1, 96)
      ) {
        errors.push(`services[${index}] has invalid discrete current control`);
      }
    } else if (control.type === "duty_cycle") {
      if (
        service.device !== "boiler" ||
        !inRange(control.rated_power_w, 100, 100_000) ||
        !Number.isInteger(control.max_consecutive_inhibit_slots) ||
        !inRange(control.max_consecutive_inhibit_slots, 1, 96) ||
        !Array.isArray(control.expected_power_w_by_slot) ||
        control.expected_power_w_by_slot.length !== snapshot.slots.length ||
        control.expected_power_w_by_slot.some((value) =>
          !inRange(value, 0, control.rated_power_w)
        )
      ) {
        errors.push(`services[${index}] has invalid duty-cycle control`);
      }
    } else {
      errors.push(`services[${index}].control type is unsupported`);
    }
  }

  const requiredSources = [
    "base_load",
    "import_price",
    "export_price",
  ] as const;
  const optionalSources = ["pv", "battery"] as const;
  for (const key of [...requiredSources, ...optionalSources]) {
    const source = snapshot?.sources?.[key];
    const enabled = key === "pv" || key === "battery"
      ? snapshot?.capabilities?.[key]
      : true;
    if (!enabled) {
      if (source !== null) errors.push(`sources.${key} must be null`);
      continue;
    }
    if (
      !source?.provider || !Array.isArray(source?.entity_ids) ||
      source.entity_ids.length === 0 ||
      source.entity_ids.some((entityId) =>
        typeof entityId !== "string" || !entityId
      ) ||
      !["measured", "calibrated", "provider_raw"].includes(source?.quality) ||
      !Number.isFinite(isoMs(source?.issued_at)) ||
      !Number.isFinite(isoMs(source?.valid_until))
    ) {
      errors.push(`sources.${key} is incomplete`);
      continue;
    }
    const issuedAt = isoMs(source.issued_at);
    const validUntil = isoMs(source.valid_until);
    if (
      issuedAt > capturedAt + MAX_SOURCE_FUTURE_SKEW_MS ||
      capturedAt - issuedAt > SOURCE_MAX_AGE_MS[key]
    ) {
      errors.push(`sources.${key} is stale or future-dated`);
    }
    if (validUntil <= firstStart) {
      errors.push(`sources.${key} does not cover the first forecast slot`);
    }
  }
  const pvLocation = snapshot?.sources?.pv?.location;
  if (
    snapshot?.capabilities?.pv && (
      !finite(pvLocation?.latitude) || !finite(pvLocation?.longitude) ||
      !inRange(pvLocation.latitude, -90, 90) ||
      !inRange(pvLocation.longitude, -180, 180)
    )
  ) {
    errors.push("sources.pv.location is required");
  }
  const importArea = snapshot?.sources?.import_price?.location?.market_area;
  const exportArea = snapshot?.sources?.export_price?.location?.market_area;
  if (!/^SE[1-4]$/.test(importArea ?? "") || importArea !== exportArea) {
    errors.push(
      "import and export sources must declare the same Swedish market area",
    );
  }
  const importEntities = new Set(
    snapshot?.sources?.import_price?.entity_ids ?? [],
  );
  if (
    (snapshot?.sources?.export_price?.entity_ids ?? []).some((entityId) =>
      importEntities.has(entityId)
    )
  ) {
    errors.push("import and export prices must use separate source entities");
  }
  if (
    !snapshot?.capabilities?.pv &&
    (snapshot?.slots ?? []).some((slot) => slot.pv_forecast_w !== 0)
  ) {
    errors.push("PV forecast must be zero when the capability is disabled");
  }
  const factors = snapshot?.pv_calibration?.correction_factor_by_lead_day;
  const counts = snapshot?.pv_calibration?.sample_count_by_lead_day;
  if (
    !Array.isArray(factors) || !Array.isArray(counts) || factors.length !== 4 ||
    counts.length !== factors.length ||
    factors.some((factor) => !inRange(factor, 0.25, 2)) ||
    counts.some((count) => !Number.isInteger(count) || count < 0)
  ) {
    errors.push(
      "pv_calibration must contain four bounded lead-day factors and sample counts",
    );
  }
  if (
    !snapshot?.service_requirement_sample_days ||
    typeof snapshot.service_requirement_sample_days !== "object" ||
    Array.isArray(snapshot.service_requirement_sample_days) ||
    Object.values(snapshot.service_requirement_sample_days).some((count) =>
      !Number.isInteger(count) || count < 0
    )
  ) {
    errors.push("service_requirement_sample_days is invalid");
  }
  return [...new Set(errors)];
}

function preparedSlots(
  snapshot: OptimisationSnapshot,
  archive: StoredPriceRow[] = [],
  resolvedPriceOutlook?: OptimisationPlan["price_outlook"],
): { slots: PreparedSlot[]; outlook: PriceOutlook } {
  const captured = isoMs(snapshot.captured_at);
  const controlledCategories = new Set<string>();
  if (snapshot.capabilities.boiler) controlledCategories.add("hot_water");
  if (snapshot.capabilities.pool) controlledCategories.add("pool_heating");
  if (snapshot.capabilities.ev) controlledCategories.add("ev_charging");
  const thermalDeviceKeys = new Set(
    (snapshot.thermal_zones ?? []).flatMap((zone) => zone.device_keys),
  );
  const outlook: PriceOutlook = resolvedPriceOutlook
    ? {
      shadowImportSekPerKwh:
        resolvedPriceOutlook.shadow_import_sek_per_kwh,
      levelSekPerKwh: resolvedPriceOutlook.level_sek_per_kwh,
      observedDays: resolvedPriceOutlook.observed_days,
      effectiveDays: resolvedPriceOutlook.effective_days,
      shaped: resolvedPriceOutlook.shaped,
    }
    : buildPriceOutlook(snapshot.slots, archive, {
      timeZone: snapshot.timezone,
      asOf: isoMs(snapshot.captured_at),
    });
  if (
    outlook.shadowImportSekPerKwh.length !== snapshot.slots.length ||
    outlook.shadowImportSekPerKwh.some((value) => !finite(value))
  ) {
    throw new Error("resolved price outlook must contain one finite value per slot");
  }
  // Export is not shaped separately: the archive stores an import price, and
  // the spread between them is a supplier and tariff construct rather than
  // something the market shape says anything about. Holding the observed ratio
  // is a weaker claim than inventing a second curve.
  const publishedRatios = snapshot.slots
    .filter((slot) =>
      slot.import_price_sek_per_kwh !== null &&
      slot.export_price_sek_per_kwh !== null &&
      slot.import_price_sek_per_kwh !== 0
    )
    .map((slot) =>
      slot.export_price_sek_per_kwh! / slot.import_price_sek_per_kwh!
    );
  const exportRatio = publishedRatios.length > 0
    ? publishedRatios.reduce((total, value) => total + value, 0) /
      publishedRatios.length
    : 0;
  let priceGapSeen = false;
  const slots = snapshot.slots.map((slot, index) => {
    const epoch = isoMs(slot.start);
    const local = localSlotTime(epoch, snapshot.timezone);
    const leadDay = Math.max(
      0,
      Math.min(
        snapshot.pv_calibration.correction_factor_by_lead_day.length - 1,
        Math.floor((epoch - captured) / 86_400_000),
      ),
    );
    const factor = snapshot.pv_calibration
      .correction_factor_by_lead_day[leadDay]!;
    const binding = !priceGapSeen && slot.import_price_sek_per_kwh !== null &&
      slot.export_price_sek_per_kwh !== null;
    if (!binding) priceGapSeen = true;
    return {
      ...slot,
      index,
      epoch_ms: epoch,
      local_day: local.day,
      local_minute_of_day: local.minuteOfDay,
      pv_raw_w: slot.pv_forecast_w,
      pv_w: Math.max(0, slot.pv_forecast_w * factor),
      uncontrolled_device_w: snapshot.device_models.reduce(
        (sum, model) =>
          sum +
          (controlledCategories.has(model.category) ||
              thermalDeviceKeys.has(model.key)
            ? 0
            : model.forecast_w_by_slot[index]),
        0,
      ),
      binding,
      shadow_import_sek_per_kwh: outlook.shadowImportSekPerKwh[index],
      shadow_export_sek_per_kwh: slot.export_price_sek_per_kwh ??
        outlook.shadowImportSekPerKwh[index] * exportRatio,
    };
  });
  return { slots, outlook };
}

const fixedLoadW = (slot: PreparedSlot) =>
  slot.base_load_forecast_w + slot.uncontrolled_device_w;

interface ServiceShape {
  count: number;
  target_kwh: number;
  current_increments: number;
}

const ceilEnergySteps = (value: number) => Math.ceil(value - 1e-9);

function availableServiceSlots(
  slots: PreparedSlot[],
  service: DispatchableServiceInput,
): number {
  const earliest = isoMs(service.earliest_start);
  const deadline = isoMs(service.deadline);
  return slots.filter((slot) =>
    slot.epoch_ms >= earliest && slot.epoch_ms + SLOT_MS <= deadline
  ).length;
}

function serviceShape(
  slots: PreparedSlot[],
  service: DispatchableServiceInput,
): ServiceShape {
  if (service.required_kwh <= 0) {
    return { count: 0, target_kwh: 0, current_increments: 0 };
  }
  if (!isDiscreteCurrentService(service)) {
    const slotKwh = service.control.power_w / 1_000 * SLOT_HOURS;
    const count = Math.max(
      service.min_run_slots,
      ceilEnergySteps(service.required_kwh / slotKwh),
    );
    return {
      count,
      target_kwh: count * slotKwh,
      current_increments: 0,
    };
  }

  const control = service.control;
  const perAmpSlotKwh = wattsPerAmp(control) / 1_000 * SLOT_HOURS;
  const minSlotKwh = control.min_current_a * perAmpSlotKwh;
  const maxSlotKwh = control.max_current_a * perAmpSlotKwh;
  const stepSlotKwh = control.current_step_a * perAmpSlotKwh;
  const minimumCount = Math.max(
    service.min_run_slots,
    ceilEnergySteps(service.required_kwh / maxSlotKwh),
  );
  const spreadCount = Math.max(
    minimumCount,
    Math.floor((service.required_kwh + 1e-9) / minSlotKwh),
  );
  const count = Math.min(
    Math.max(minimumCount, availableServiceSlots(slots, service)),
    spreadCount,
  );
  const baseKwh = count * minSlotKwh;
  const currentIncrements = Math.max(
    0,
    ceilEnergySteps((service.required_kwh - baseKwh) / stepSlotKwh),
  );
  return {
    count,
    target_kwh: baseKwh + currentIncrements * stepSlotKwh,
    current_increments: currentIncrements,
  };
}

function candidateStarts(
  slots: PreparedSlot[],
  service: DispatchableServiceInput,
  count: number,
): number[] {
  if (count === 0) return [];
  const earliest = isoMs(service.earliest_start);
  const deadline = isoMs(service.deadline);
  const candidates: number[] = [];
  for (let start = 0; start + count <= slots.length; start += 1) {
    if (slots[start].epoch_ms < earliest) continue;
    if (slots[start + count - 1].epoch_ms + SLOT_MINUTES * 60_000 > deadline) {
      continue;
    }
    candidates.push(start);
  }
  return candidates;
}

function emptySchedule(length: number): Schedule {
  return {
    pool: new Array(length).fill(0),
    boiler: new Array(length).fill(0),
    boilerPermitted: new Array(length).fill(true),
    ev: new Array(length).fill(0),
    evTargetCurrentA: new Array(length).fill(0),
    evMinCurrentA: new Array(length).fill(0),
    evMaxCurrentA: new Array(length).fill(0),
    roomHeating: {},
    serviceSlots: {},
    serviceCurrentsA: {},
    serviceInhibitedSlots: {},
    // Which devices the marginal-value dispatch owns. Empty on schema 5, where
    // the block model and simulate's own battery rule still apply.
    dispatched: new Set<string>(),
    batteryChargeW: new Array(length).fill(0),
    batteryDischargeW: new Array(length).fill(0),
    dispatchAllocations: Array.from({ length }, () => []),
    dispatchBattery: new Array(length).fill(null),
    dispatchImportW: new Array(length).fill(0),
    storeDiagnostics: [],
  };
}

function serviceCost(
  key: PlanKey,
  slots: PreparedSlot[],
  start: number,
  powers: number[],
  occupiedW: number[],
  reservedW: number[],
  preferred: number,
): number {
  if (key === "baseline") {
    return Math.abs(slots[start].epoch_ms - preferred);
  }
  return powers.reduce((total, powerW, offset) => {
    const index = start + offset;
    const slot = slots[index];
    const remainingSolar = Math.max(
      0,
      slot.pv_w - fixedLoadW(slot) - occupiedW[index] -
        reservedW[index],
    );
    const solarW = Math.min(powerW, remainingSolar);
    const gridW = powerW - solarW;
    // One objective across the whole horizon, in SEK. Published price where the
    // market set one, measured shape prior where it did not, so the day-ahead
    // boundary is no longer a discontinuity the planner can arbitrage.
    total += (solarW / 1_000) * SLOT_HOURS * slot.shadow_export_sek_per_kwh;
    total += (gridW / 1_000) * SLOT_HOURS * slot.shadow_import_sek_per_kwh;
    total += peakPenalty(slot, gridW, occupiedW[index], reservedW[index]);
    if (key === "priority" && reservedW[index] > 0 && powerW > 0) {
      total += 1_000_000;
    }
    return total;
  }, 0);
}

/**
 * What it will cost to put an exported kWh back, in SEK.
 *
 * Zero when the remaining horizon forecasts more surplus PV than the battery
 * can absorb — that energy would otherwise be exported or curtailed, so selling
 * it now costs nothing to replace. Otherwise the cheapest shadow import price
 * still ahead, grossed up by the round trip, because that is what refilling
 * actually takes.
 *
 * This is the comparison a fixed `battery_export_min_price_sek_per_kwh` cannot
 * make: the same 2 SEK spike is a good trade before a sunny day and a poor one
 * before a dark, expensive week (§1.4.5).
 */
function replacementCostsBySlot(
  slots: PreparedSlot[],
  snapshot: OptimisationSnapshot,
): number[] {
  const battery = snapshot.battery;
  if (!battery) return new Array(slots.length).fill(Number.POSITIVE_INFINITY);
  const headroomKwh = Math.max(
    0,
    (battery.max_soc - battery.min_soc) * battery.capacity_kwh,
  );
  const roundTrip = Math.max(
    0.05,
    battery.charge_efficiency * battery.discharge_efficiency,
  );
  const costs = new Array<number>(slots.length);
  let remainingCount = 0;
  let surplusKwh = 0;
  let cheapest = Number.POSITIVE_INFINITY;
  for (let index = slots.length - 1; index >= 0; index -= 1) {
    costs[index] = remainingCount === 0
      ? Number.POSITIVE_INFINITY
      : surplusKwh >= headroomKwh
      ? 0
      : Number.isFinite(cheapest)
      ? cheapest / roundTrip
      : Number.POSITIVE_INFINITY;
    const slot = slots[index];
    const surplusW = slot.pv_w - fixedLoadW(slot);
    if (surplusW > 0) surplusKwh += surplusW / 1_000 * SLOT_HOURS;
    cheapest = Math.min(cheapest, slot.shadow_import_sek_per_kwh);
    remainingCount += 1;
  }
  return costs;
}

/**
 * Convex penalty on grid draw, so a load spreads rather than stacking.
 *
 * Charged on the *marginal* increase in the square of total grid power, which
 * is what makes adding to an already-heavy slot cost more than adding to an
 * empty one. A linear term — the whole of the old unpriced objective — cannot
 * express that, because moving a kW between slots leaves the total unchanged.
 */
function peakPenalty(
  slot: PreparedSlot,
  addedGridW: number,
  occupiedW: number,
  reservedW: number,
): number {
  if (addedGridW <= 0) return 0;
  const existingGridKw = Math.max(
    0,
    fixedLoadW(slot) + occupiedW + reservedW - Math.max(0, slot.pv_w),
  ) / 1_000;
  const addedKw = addedGridW / 1_000;
  return PEAK_WEIGHT_SEK_PER_KW2 *
    ((existingGridKw + addedKw) ** 2 - existingGridKw ** 2);
}

function discreteCurrentCandidate(
  key: PlanKey,
  slots: PreparedSlot[],
  snapshot: OptimisationSnapshot,
  service: DiscreteCurrentServiceInput,
  shape: ServiceShape,
  start: number,
  occupiedW: number[],
  reservedW: number[],
  preferred: number,
):
  | { start: number; powers: number[]; currents: number[]; score: number }
  | null {
  const control = service.control;
  const powerPerAmp = wattsPerAmp(control);
  const powers = new Array(shape.count).fill(
    control.min_current_a * powerPerAmp,
  );
  const currents = new Array(shape.count).fill(control.min_current_a);
  for (let offset = 0; offset < shape.count; offset += 1) {
    const index = start + offset;
    if (
      fixedLoadW(slots[index]) + occupiedW[index] + powers[offset] >
        snapshot.grid.import_limit_w + Math.max(0, slots[index].pv_w)
    ) return null;
  }

  const deltaW = control.current_step_a * powerPerAmp;
  for (
    let increment = 0;
    increment < shape.current_increments;
    increment += 1
  ) {
    const choices = currents.flatMap((currentA, offset) => {
      const nextCurrentA = currentA + control.current_step_a;
      const index = start + offset;
      if (
        nextCurrentA > control.max_current_a + 1e-6 ||
        fixedLoadW(slots[index]) + occupiedW[index] + powers[offset] +
              deltaW >
          snapshot.grid.import_limit_w + Math.max(0, slots[index].pv_w)
      ) return [];
      if (key === "baseline") {
        return [{ offset, score: currentA * 1_000 + offset }];
      }
      const availableSolar = Math.max(
        0,
        slots[index].pv_w - fixedLoadW(slots[index]) -
          occupiedW[index] - reservedW[index],
      );
      const solarBefore = Math.min(powers[offset], availableSolar);
      const solarAfter = Math.min(powers[offset] + deltaW, availableSolar);
      const solarW = solarAfter - solarBefore;
      const gridW = deltaW - solarW;
      const score = solarW / 1_000 * SLOT_HOURS *
          slots[index].shadow_export_sek_per_kwh +
        gridW / 1_000 * SLOT_HOURS *
          slots[index].shadow_import_sek_per_kwh +
        peakPenalty(slots[index], gridW, occupiedW[index], reservedW[index]);
      return [{
        offset,
        score: score +
          (key === "priority" && reservedW[index] > 0 ? 1_000_000 : 0),
      }];
    });
    choices.sort((a, b) => a.score - b.score || a.offset - b.offset);
    if (choices.length === 0) return null;
    const offset = choices[0].offset;
    currents[offset] = round(currents[offset] + control.current_step_a, 6);
    powers[offset] = round(currents[offset] * powerPerAmp, 6);
  }
  return {
    start,
    powers,
    currents,
    score: serviceCost(
      key,
      slots,
      start,
      powers,
      occupiedW,
      reservedW,
      preferred,
    ),
  };
}

function applyEvCurrentEnvelopes(
  schedule: Schedule,
  slots: PreparedSlot[],
  services: ServiceInput[],
): void {
  for (const service of services) {
    if (!isDiscreteCurrentService(service)) continue;
    const scheduledSlots = schedule.serviceSlots[service.id] ?? [];
    if (service.required_kwh > 0 && scheduledSlots.length === 0) {
      // The scenario already carries an explicit scheduling error. Keep the
      // advisory envelope neutral so an infeasible plan remains structurally
      // valid and can be displayed, but can never request charging.
      continue;
    }
    const control = service.control;
    const powerPerAmp = wattsPerAmp(control);
    const perAmpSlotKwh = powerPerAmp / 1_000 * SLOT_HOURS;
    const earliest = isoMs(service.earliest_start);
    const deadline = isoMs(service.deadline);
    const targetByIndex = new Map(
      scheduledSlots.map((index, offset) => [
        index,
        schedule.serviceCurrentsA[service.id]?.[offset] ?? 0,
      ]),
    );
    let plannedKwh = 0;
    for (const slot of slots) {
      if (slot.epoch_ms < earliest || slot.epoch_ms + SLOT_MS > deadline) {
        continue;
      }
      const remainingKwh = Math.max(0, service.required_kwh - plannedKwh);
      const futureCount = slots.filter((candidate) =>
        candidate.index > slot.index && candidate.epoch_ms >= earliest &&
        candidate.epoch_ms + SLOT_MS <= deadline
      ).length;
      const futureCapacityKwh = futureCount * control.max_current_a *
        perAmpSlotKwh;
      const neededNowKwh = Math.max(0, remainingKwh - futureCapacityKwh);
      let minimumA = 0;
      if (neededNowKwh > 1e-9) {
        minimumA = control.min_current_a;
        if (neededNowKwh > control.min_current_a * perAmpSlotKwh) {
          minimumA += ceilEnergySteps(
            (neededNowKwh - control.min_current_a * perAmpSlotKwh) /
              (control.current_step_a * perAmpSlotKwh),
          ) * control.current_step_a;
        }
        minimumA = Math.min(control.max_current_a, minimumA);
      }
      schedule.evMinCurrentA[slot.index] = round(minimumA, 6);
      // Keep recovery headroom available until departure. The planned target
      // may finish early, but the local controller still needs room to replace
      // energy missed because of a disconnect, curtailment or command failure.
      schedule.evMaxCurrentA[slot.index] = control.max_current_a;
      plannedKwh += (targetByIndex.get(slot.index) ?? 0) * perAmpSlotKwh;
    }
  }
}

function wouldExceedInhibitLimit(
  permitted: boolean[],
  index: number,
  maximum: number,
): boolean {
  let run = 1;
  for (let cursor = index - 1; cursor >= 0 && !permitted[cursor]; cursor -= 1) {
    run += 1;
  }
  for (
    let cursor = index + 1;
    cursor < permitted.length && !permitted[cursor];
    cursor += 1
  ) {
    run += 1;
  }
  return run > maximum;
}

function applyDutyCycleServices(
  key: PlanKey,
  slots: PreparedSlot[],
  snapshot: OptimisationSnapshot,
  services: DutyCycleServiceInput[],
  occupiedW: number[],
  schedule: Schedule,
): void {
  for (const service of services) {
    const earliest = isoMs(service.earliest_start);
    const deadline = isoMs(service.deadline);
    const indices = slots.filter((slot) =>
      slot.epoch_ms >= earliest && slot.epoch_ms + SLOT_MS <= deadline
    ).map((slot) => slot.index);
    const expected = service.control.expected_power_w_by_slot;

    for (const index of indices) {
      schedule.boiler[index] += expected[index];
    }

    const inhibited: number[] = [];
    if (key !== "baseline") {
      for (const index of indices) {
        const otherPlannedLoad = occupiedW[index];
        const nonBoilerLoad = fixedLoadW(slots[index]) + otherPlannedLoad;
        const relativelyHighLoad = otherPlannedLoad > 0 ||
          nonBoilerLoad >= snapshot.grid.import_limit_w * 0.65;
        if (
          !relativelyHighLoad ||
          wouldExceedInhibitLimit(
            schedule.boilerPermitted,
            index,
            service.control.max_consecutive_inhibit_slots,
          )
        ) continue;
        schedule.boilerPermitted[index] = false;
        schedule.boiler[index] -= expected[index];
        inhibited.push(index);
      }

      // A thermostat normally catches up after an inhibit interval. Preserve
      // that empirical expected energy inside the same local-day window when
      // there is later headroom, without claiming an exact compressor or
      // element switch-on time.
      let deferredW = inhibited.reduce(
        (sum, index) => sum + expected[index],
        0,
      );
      //
      // Where it goes is a price decision. Ranking on residual load alone put
      // the catch-up in the quietest quarter — quiet precisely because PV was
      // covering the base load and the pool and car had just finished, which
      // is also when the evening price peaks. One observed plan parked 1690 W
      // into the dearest quarter of its window at 3.281 SEK/kWh while
      // 2.07 SEK/kWh quarters sat idle later the same night. Cost keeps what
      // the residual ranking was reaching for: surplus PV is charged at the
      // export price it forgoes, so a sunny quarter is still cheap, and the
      // convex peak term still separates two quarters at the same price.
      const firstInhibited = inhibited[0] ?? Number.POSITIVE_INFINITY;
      const recovery = indices.filter((index) =>
        index > firstInhibited && schedule.boilerPermitted[index]
      );
      // Room is bounded by the connection as well as by the element. A quarter
      // the stores have already filled cannot take the catch-up, and putting it
      // there anyway is how deferred water ends up unserved.
      const roomFor = (index: number) =>
        Math.max(
          0,
          Math.min(
            service.control.rated_power_w - schedule.boiler[index],
            snapshot.grid.import_limit_w + Math.max(0, slots[index].pv_w) -
              fixedLoadW(slots[index]) - occupiedW[index] -
              schedule.boiler[index],
          ),
        );
      const costOf = (index: number, powerW: number) => {
        const slot = slots[index];
        const takenW = occupiedW[index] + schedule.boiler[index];
        const surplusW = Math.max(0, slot.pv_w - fixedLoadW(slot) - takenW);
        const solarW = Math.min(powerW, surplusW);
        const gridW = powerW - solarW;
        return (solarW / 1_000) * SLOT_HOURS * slot.shadow_export_sek_per_kwh +
          (gridW / 1_000) * SLOT_HOURS * slot.shadow_import_sek_per_kwh +
          peakPenalty(slot, gridW, takenW, 0);
      };
      // Ties fall to the earliest quarter, which is the order `recovery` is
      // already in — a thermostat catches up as soon as it is allowed to.
      while (deferredW > 1e-6) {
        let cheapest: number | null = null;
        let bestRate = Number.POSITIVE_INFINITY;
        for (const index of recovery) {
          const takeW = Math.min(roomFor(index), deferredW);
          if (takeW <= 1e-6) continue;
          const rate = costOf(index, takeW) / takeW;
          if (rate < bestRate - 1e-12) {
            bestRate = rate;
            cheapest = index;
          }
        }
        if (cheapest === null) break;
        const takeW = Math.min(roomFor(cheapest), deferredW);
        schedule.boiler[cheapest] += takeW;
        deferredW -= takeW;
      }
    }

    schedule.serviceSlots[service.id] = indices.filter((index) =>
      schedule.boiler[index] > 0
    );
    schedule.serviceInhibitedSlots[service.id] = inhibited;
    for (const index of indices) occupiedW[index] += schedule.boiler[index];
  }
}

/** Seeded until the fit converges; see store-models.ts for why not asked for. */
const SEEDED_POOL_LOSS_KW_PER_K = 0.35;
const SEEDED_POOL_HEAT_PUMP = {
  rated_cop: 4.5,
  rated_air_c: 20,
  rated_water_c: 27,
  cop_per_air_c: 0.045,
  cop_per_water_c: -0.02,
  cutout_air_c: 8,
  rated_power_w: 3_500,
};
/** Until a fitted kWh/km exists, a mid-size EV at a mild temperature. */
const SEEDED_VEHICLE_KWH_PER_KM = 0.16;

interface DerivedBatteryValueCurve {
  curve: UtilityCurve;
  diagnostic: BatteryValueCurveDiagnostic;
}

/** Build the battery curve once and retain the exact evidence behind it. */
function deriveBatteryValueCurve(
  slots: PreparedSlot[],
  snapshot: OptimisationSnapshot,
): DerivedBatteryValueCurve | null {
  const battery = snapshot.battery;
  if (!battery) return null;

  const usableKwh = (battery.max_soc - battery.min_soc) *
    battery.capacity_kwh;
  const remainingSurplusKwh = slots.reduce((total, slot) => {
    const surplusW = slot.pv_w - fixedLoadW(slot);
    return total + (surplusW > 0 ? surplusW / 1_000 * SLOT_HOURS : 0);
  }, 0);

  // The covering band is the longest single deficit run in the horizon: the
  // battery must carry one night, rather than every deficit in three days.
  let expectedDrawKwh = 0;
  let runKwh = 0;
  let runDraw: Array<{
    start: string;
    sek_per_kwh: number;
    ac_kwh: number;
  }> = [];
  let windowDraw: typeof runDraw = [];
  for (const slot of slots) {
    const netW = slot.pv_w - fixedLoadW(slot);
    if (netW < 0) {
      const acKwh = -netW / 1_000 * SLOT_HOURS;
      runKwh += acKwh;
      runDraw.push({
        start: slot.start,
        sek_per_kwh: slot.shadow_import_sek_per_kwh,
        ac_kwh: acKwh,
      });
    } else {
      if (runKwh > expectedDrawKwh) {
        expectedDrawKwh = runKwh;
        windowDraw = runDraw;
      }
      runKwh = 0;
      runDraw = [];
    }
  }
  if (runKwh > expectedDrawKwh) {
    expectedDrawKwh = runKwh;
    windowDraw = runDraw;
  }
  if (windowDraw.length === 0) {
    windowDraw = slots.map((slot) => ({
      start: slot.start,
      sek_per_kwh: slot.shadow_import_sek_per_kwh,
      ac_kwh: 0,
    }));
  }

  const storedDrawKwh = windowDraw.map((slice) =>
    slice.ac_kwh / battery.discharge_efficiency
  );
  const curveInput: StoredEnergyValueInput = {
    futureImportSekPerKwh: windowDraw.map((slice) => slice.sek_per_kwh),
    futureImportKwh: storedDrawKwh,
    futureSurplusKwh: remainingSurplusKwh,
    usableKwh,
    roundTrip: battery.charge_efficiency * battery.discharge_efficiency,
    degradationSekPerKwh:
      DEFAULT_VALUE_SETTINGS.battery_degradation_sek_per_kwh,
    expectedDrawKwh: expectedDrawKwh / battery.discharge_efficiency,
  };
  const curve = batteryValueCurve(curveInput);
  return {
    curve,
    diagnostic: {
      schema_version: 1,
      curve,
      state_basis: "usable_kwh_above_min_soc",
      initial_state_kwh: Math.max(
        0,
        (battery.soc - battery.min_soc) * battery.capacity_kwh,
      ),
      usable_capacity_kwh: usableKwh,
      covering_window: windowDraw.map((slice, index) => ({
        start: slice.start,
        import_price_sek_per_kwh: slice.sek_per_kwh,
        residual_load_ac_kwh: slice.ac_kwh,
        battery_energy_kwh: storedDrawKwh[index],
      })),
      curve_input: {
        future_surplus_kwh: curveInput.futureSurplusKwh,
        usable_kwh: curveInput.usableKwh,
        round_trip_efficiency: curveInput.roundTrip,
        degradation_sek_per_kwh: curveInput.degradationSekPerKwh,
        expected_draw_kwh: curveInput.expectedDrawKwh,
      },
    },
  };
}

/**
 * Build the stores the marginal-value planner dispatches, or null.
 *
 * Returns null unless *every* dispatchable store can be expressed as measured
 * state. That is deliberate and is the one rule that keeps this migration
 * coherent: a planner holding a temperature for the pool and an energy budget
 * for the car cannot rank them against each other, so it would be worse than
 * either model applied consistently. A home without a pool temperature sensor
 * therefore stays on the schema 5 planner in full.
 */
function buildDispatchStores(
  slots: PreparedSlot[],
  snapshot: OptimisationSnapshot,
  derivedBatteryValue: DerivedBatteryValueCurve | null,
): DispatchStore[] | null {
  if (snapshot.schema_version < 6) return null;
  const stores: DispatchStore[] = [];
  const count = slots.length;
  const outdoor = snapshot.outdoor_temperature_c as number[] | null;
  const curves = {
    pool: snapshot.value_curves?.pool ?? DEFAULT_VALUE_CURVES.pool,
    ev: snapshot.value_curves?.ev ?? DEFAULT_VALUE_CURVES.ev,
  };

  if (snapshot.capabilities.pool) {
    const pool = snapshot.pool;
    if (!pool) return null;
    // Fitted where the evidence allowed it, seeded where it did not.
    const fitted = snapshot.pool_model;
    const model = {
      volume_m3: pool.volume_m3,
      loss_kw_per_k: fitted?.loss_kw_per_k ?? SEEDED_POOL_LOSS_KW_PER_K,
      heat_pump: {
        ...SEEDED_POOL_HEAT_PUMP,
        rated_cop: fitted?.rated_cop ?? SEEDED_POOL_HEAT_PUMP.rated_cop,
        cop_per_air_c: fitted?.cop_per_air_c ??
          SEEDED_POOL_HEAT_PUMP.cop_per_air_c,
      },
    };
    const capacityKwhPerK = pool.volume_m3 * WATER_KWH_PER_M3_K;
    const airAt = (index: number) => outdoor?.[index] ?? 15;
    stores.push({
      key: "pool",
      curve: curves.pool,
      initial_state: pool.water_temperature_c,
      max_power_w: SEEDED_POOL_HEAT_PUMP.rated_power_w,
      min_run_slots: 4,
      start_cost_sek: 0.5,
      // Warmth is wanted whenever somebody might swim, so the weight spreads
      // across the horizon rather than landing on a deadline. Replacing this
      // with observed pool use — the swim counter already exists — is what
      // turns a guess about the household into evidence about it.
      usage_weight: new Array(count).fill(1 / Math.max(1, count)),
      retention_per_slot: Math.max(
        0.9,
        1 - model.loss_kw_per_k * SLOT_HOURS / capacityKwhPerK,
      ),
      units_per_kwh: (waterC, index) =>
        poolCop(model.heat_pump, airAt(index), waterC) / capacityKwhPerK,
      drift: (waterC, index) =>
        stepPoolTemperature(model, waterC, airAt(index), 0),
    });
  }

  if (snapshot.capabilities.ev) {
    const vehicle = snapshot.ev_battery;
    if (!vehicle || !vehicle.connected) {
      // A disconnected car is not a store the planner can fill. It contributes
      // nothing rather than blocking the whole dispatch path.
      if (!vehicle) return null;
    } else {
      const perKm = vehicleKwhPerKm(vehicle);
      const control = evCurrentControl(snapshot);
      // A capability is a concrete actuator contract, not permission to
      // invent one. Legacy snapshots could omit the EV service once its
      // required energy reached zero; in that case keep the measured car
      // visible as undispatched until the real charger control is supplied.
      if (control) {
        const departure = vehicle.departure ? isoMs(vehicle.departure) : null;
        const usage = new Array(count).fill(0);
        if (departure !== null) {
          // A declared departure is a point in time, but the weight is still a
          // distribution: it is the slot before leaving that matters, and a
          // learned spread replaces this without changing anything downstream.
          let placed = false;
          for (let index = count - 1; index >= 0; index -= 1) {
            if (slots[index].epoch_ms <= departure) {
              usage[index] = 1;
              placed = true;
              break;
            }
          }
          if (!placed) usage[count - 1] = 1;
        } else {
          usage[count - 1] = 1;
        }
        stores.push({
          key: "ev",
          // This is the resolved customer/default curve supplied by the edge.
          // Rebuilding a fresh default here made the editor a placebo: the
          // persisted curve preview changed while the live planner ignored it.
          curve: curves.ev,
          initial_state: vehicle.soc * vehicle.capacity_kwh / perKm,
          // The vehicle refuses charge above its own limit, so this is a
          // hardware bound and not a preference the curve may outbid. Without
          // it `chargeRoomW` returns Infinity and the auction keeps buying
          // range the car cannot take: three consecutive replays planned the
          // Model Y to 160% SOC, 49.9 kWh of it undeliverable. The published
          // `ev_soc` clamps at 1, so only the km state showed it.
          max_state: vehicle.departure_target_soc * vehicle.capacity_kwh /
            perKm,
          max_power_w: wattsPerAmp(control) * control.max_current_a,
          min_power_w: wattsPerAmp(control) * control.min_current_a,
          power_step_w: wattsPerAmp(control) * control.current_step_a,
          usage_weight: usage,
          retention_per_slot: 1,
          units_per_kwh: () => vehicle.charge_efficiency / perKm,
          drift: (state) => state,
        });
      }
    }
  }

  const battery = snapshot.battery;
  if (battery && derivedBatteryValue) {
    const { curve } = derivedBatteryValue;
    if (curve.points.length > 0) {
      stores.push({
        key: "battery",
        curve,
        // State is measured in *usable* kWh above the floor, because that is
        // the domain `batteryValueCurve` defines its breakpoints over. Passing
        // absolute kWh offset every lookup by the reserve, which mattered
        // little against a step function and mis-prices every unit once the
        // curve is interpolated.
        initial_state: Math.max(
          0,
          (battery.soc - battery.min_soc) * battery.capacity_kwh,
        ),
        min_state: 0,
        max_state: derivedBatteryValue.diagnostic.usable_capacity_kwh,
        max_power_w: battery.charge_max_w,
        // No `wear_sek_per_kwh` here: `batteryValueCurve` already subtracts
        // degradation from what stored energy is worth. Charging it a second
        // time as a flow cost made charging unprofitable at any price the curve
        // would accept, so a discharged battery never refilled — it emptied
        // through one evening and then sat flat while surplus was exported.
        retention_per_slot: 1,
        usage_weight: new Array(count).fill(0),
        // Charge held at the horizon edge is worth what the curve says, which
        // is the whole of §8.4 and the reason no SOC target is needed.
        terminal_weight: 1,
        units_per_kwh: () => battery.charge_efficiency,
        drift: (state) => state,
        discharge: {
          max_power_w: battery.discharge_max_w,
          state_per_kwh_out: () => 1 / battery.discharge_efficiency,
          export_allowed: snapshot.policy.battery_export_enabled,
        },
      });
    }
  }

  return stores.length > 0 ? stores : null;
}

/**
 * Stores this home has evidence for that never entered the auction.
 *
 * A store that loses is visible: it holds a diagnostic row saying what it was
 * worth and what it would have cost. A store that was never *built* held
 * nothing at all, and an absent row is indistinguishable from a home that does
 * not own the equipment. That gap hid a connected car below its own charge
 * limit for two days behind a plan reporting "ready" with no errors, while the
 * surplus it wanted was exported.
 *
 * The test applied here is evidence, not capability: a row is emitted only
 * where the snapshot carries a measured state or a connected device. A house
 * with no pool says nothing about pools.
 */
function undispatchedStores(
  snapshot: OptimisationSnapshot,
  dispatched: Set<string>,
): StoreDiagnostic[] {
  if (snapshot.schema_version < 6) return [];
  const rows: StoreDiagnostic[] = [];
  const skip = (
    key: string,
    unit: string,
    state: number | null,
    reason: StoreDiagnostic["reason"],
  ) => {
    rows.push({
      key,
      unit,
      state: state === null ? null : round(state, 3),
      marginal_value_sek_per_kwh: null,
      cheapest_energy_sek_per_kwh: null,
      planned_kwh: 0,
      returned_kwh: 0,
      end_state: null,
      reason,
    });
  };

  if (!dispatched.has("pool")) {
    const pool = snapshot.pool;
    if (pool) {
      // A temperature is being measured, so the household has a pool. Whether
      // the planner may act on it is the separate question this answers.
      skip(
        "pool",
        "celsius",
        pool.water_temperature_c,
        snapshot.capabilities.pool ? "state_unavailable" : "not_controllable",
      );
    } else if (snapshot.capabilities.pool) {
      skip("pool", "celsius", null, "state_unavailable");
    }
  }

  if (!dispatched.has("ev")) {
    const vehicle = snapshot.ev_battery;
    if (vehicle) {
      // Range rather than SOC, so the row reads in the curve's own units even
      // when no curve was ever built for it.
      const rangeKm = vehicle.soc * vehicle.capacity_kwh /
        vehicleKwhPerKm(vehicle);
      skip(
        "ev",
        "km",
        rangeKm,
        !snapshot.capabilities.ev
          ? "not_controllable"
          : vehicle.connected
          ? "state_unavailable"
          : "disconnected",
      );
    } else if (snapshot.capabilities.ev) {
      skip("ev", "km", null, "state_unavailable");
    }
  }

  if (!dispatched.has("battery") && snapshot.battery) {
    // The battery's curve is derived from the price outlook rather than
    // configured (§8.4), so the only way it goes missing is that the outlook
    // had nothing to say.
    skip(
      "battery",
      "kwh",
      Math.max(
        0,
        (snapshot.battery.soc - snapshot.battery.min_soc) *
          snapshot.battery.capacity_kwh,
      ),
      "no_price_reference",
    );
  }

  return rows;
}

interface DispatchBundle {
  stores: DispatchStore[];
  slots: DispatchSlot[];
  result: DispatchResult;
}

function scheduleServices(
  key: PlanKey,
  slots: PreparedSlot[],
  snapshot: OptimisationSnapshot,
  reservedW: number[],
  dispatchCache: Map<string, DispatchBundle | null>,
  derivedBatteryValue: DerivedBatteryValueCurve | null,
): { schedule: Schedule; errors: string[] } {
  const schedule = emptySchedule(slots.length);
  const occupiedW = new Array(slots.length).fill(0);
  const errors: string[] = [];

  // Schema 6 with measured state: dispatch pool and vehicle by marginal value
  // instead of placing fixed-energy blocks. The boiler keeps its duty-cycle
  // permission contract below, because the house has no tank sensor and so no
  // state to value (§1.6.4).
  // Baseline and cost use the same electrical inputs, and priority does too
  // whenever there is no hard reservation. The store auction is deterministic
  // and independent of the scenario label, so solve each distinct input once
  // per generated plan rather than spending most of the Edge Function's CPU
  // solving the same 288-quarter problem two or three times.
  // The duty-cycle services are load whether or not they are stores. Leaving
  // them out of the auction's inputs cost twice over: the battery sized every
  // discharge against a deficit that excluded the boiler, so the grid covered
  // the hot water at any price, and the stores were free to spend a connection
  // the boiler still needed, so its demand was dropped as unserved. The
  // expected profile is what the thermostat draws if nothing interferes, and
  // it is the same in every scenario, so it belongs in `fixed_load_w` beside
  // the base load. Inhibiting or deferring a quarter later only ever frees
  // room the auction had already reserved.
  const dutyCycleW = new Array(slots.length).fill(0);
  for (const service of snapshot.services.filter(isDutyCycleService)) {
    const earliest = isoMs(service.earliest_start);
    const deadline = isoMs(service.deadline);
    for (const slot of slots) {
      if (slot.epoch_ms < earliest || slot.epoch_ms + SLOT_MS > deadline) {
        continue;
      }
      dutyCycleW[slot.index] +=
        service.control.expected_power_w_by_slot[slot.index] ?? 0;
    }
  }

  const dispatchKey = reservedW.every((watts) => Math.abs(watts) < 1e-9)
    ? "unreserved"
    : reservedW.join(",");
  let dispatchBundle = dispatchCache.get(dispatchKey);
  if (!dispatchCache.has(dispatchKey)) {
    const stores = buildDispatchStores(slots, snapshot, derivedBatteryValue);
    if (stores) {
      const dispatchSlots = slots.map((slot, index) => ({
        pv_w: slot.pv_w,
        fixed_load_w: fixedLoadW(slot) + reservedW[index] + dutyCycleW[index],
        import_price_sek_per_kwh: slot.shadow_import_sek_per_kwh,
        export_price_sek_per_kwh: slot.shadow_export_sek_per_kwh,
      }));
      dispatchBundle = {
        stores,
        slots: dispatchSlots,
        result: planDispatch(dispatchSlots, stores, {
          grid_import_limit_w: snapshot.grid.import_limit_w,
          grid_export_limit_w: snapshot.grid.export_limit_w,
        }),
      };
    } else {
      dispatchBundle = null;
    }
    dispatchCache.set(dispatchKey, dispatchBundle);
  }
  if (dispatchBundle) {
    const dispatchStores = dispatchBundle.stores;
    const dispatched = dispatchBundle.result;
    const dispatchSlots = dispatchBundle.slots;
    if (dispatched.stopped_because === "iteration_cap") {
      errors.push("store dispatch reached its iteration cap");
    }
    for (const store of dispatchStores) {
      // Record the comparison that decided this store, whichever way it went.
      const plannedKwh = dispatched.power_w[store.key]
        .reduce((total, watts) => total + watts, 0) / 4_000;
      const returnedKwh = dispatched.discharge_w[store.key]
        .reduce((total, watts) => total + watts, 0) / 4_000;
      const value = marginalValue(store.curve, store.initial_state) *
        store.units_per_kwh(store.initial_state, 0);
      const cheapest = dispatchSlots.reduce((lowest, slot) => {
        const surplusW = slot.pv_w - slot.fixed_load_w;
        const price = surplusW > 0
          ? slot.export_price_sek_per_kwh
          : slot.import_price_sek_per_kwh;
        return Math.min(lowest, price);
      }, Number.POSITIVE_INFINITY);
      const trajectory = dispatched.state[store.key];
      schedule.storeDiagnostics.push({
        key: store.key,
        unit: store.curve.unit,
        state: round(store.initial_state, 3),
        marginal_value_sek_per_kwh: round(value, 4),
        cheapest_energy_sek_per_kwh: round(cheapest, 4),
        planned_kwh: round(plannedKwh, 3),
        returned_kwh: round(returnedKwh, 3),
        end_state: trajectory && trajectory.length > 0
          ? round(trajectory[trajectory.length - 1], 3)
          : null,
        reason: plannedKwh > 0
          ? "scheduled"
          : value <= 0
          ? "state_above_curve"
          : value < cheapest
          ? "value_below_price"
          : "outbid",
      });
      schedule.dispatched.add(store.key);
      const powers = dispatched.power_w[store.key];
      const returns = dispatched.discharge_w[store.key];
      for (let index = 0; index < slots.length; index += 1) {
        const powerW = round(powers[index], 2);
        if (store.key === "battery") {
          // The battery's own charge is not a house load: it is settled in the
          // energy balance below, so it must not enter `occupiedW`.
          schedule.batteryChargeW[index] = powerW;
          schedule.batteryDischargeW[index] = round(returns[index], 2);
          continue;
        }
        if (powerW <= 0) continue;
        if (store.key === "pool") schedule.pool[index] = powerW;
        if (store.key === "ev") {
          schedule.ev[index] = powerW;
          const evControl = evCurrentControl(snapshot);
          if (!evControl) {
            throw new Error("dispatched EV has no charger control");
          }
          const perAmp = wattsPerAmp(evControl);
          schedule.evTargetCurrentA[index] = Math.round(powerW / perAmp);
        }
        occupiedW[index] += powerW;
      }
    }
    schedule.dispatchAllocations = dispatched.allocations;
    schedule.dispatchBattery = dispatched.battery;
    schedule.dispatchImportW = dispatched.import_w;
    applyDutyCycleServices(
      key,
      slots,
      snapshot,
      snapshot.services.filter(isDutyCycleService),
      occupiedW,
      schedule,
    );
    for (const service of snapshot.services.filter(isDispatchableService)) {
      // The schema 6 plan carries no per-service block, because there are no
      // blocks. The key is still published so a reader can see the service was
      // considered rather than dropped.
      schedule.serviceSlots[service.id] = [];
      if (isDiscreteCurrentService(service)) {
        schedule.serviceCurrentsA[service.id] = [];
      }
    }
    // The EV envelope has to come from the charger, not from whether a service
    // happens to exist. `applyEvCurrentEnvelopes` derives it from the service
    // schedule, so a dispatched car — which has no service block, and has none
    // at all once it is above its old `required_kwh` — ended up with a current
    // target and a zero envelope, and every such slot was reported infeasible.
    if (schedule.dispatched.has("ev")) {
      const control = evCurrentControl(snapshot);
      if (!control) throw new Error("dispatched EV has no charger control");
      const powerPerAmp = wattsPerAmp(control);
      const minimumA = control.min_current_a;
      const maximumA = control.max_current_a;
      const stepA = control.current_step_a;
      for (let index = 0; index < slots.length; index += 1) {
        if (schedule.ev[index] <= 0) {
          schedule.evTargetCurrentA[index] = 0;
          schedule.evMinCurrentA[index] = 0;
          schedule.evMaxCurrentA[index] = 0;
          continue;
        }
        const raw = schedule.ev[index] / powerPerAmp;
        const steps = Math.floor((raw - minimumA) / stepA + 1e-9);
        const amps = Math.min(
          maximumA,
          Math.max(minimumA, minimumA + Math.max(0, steps) * stepA),
        );
        // Below the charger's own minimum a slot cannot be executed at all, so
        // it is dropped rather than published as an unachievable request.
        if (raw + 1e-9 < minimumA) {
          schedule.ev[index] = 0;
          schedule.evTargetCurrentA[index] = 0;
          schedule.evMinCurrentA[index] = 0;
          schedule.evMaxCurrentA[index] = 0;
          continue;
        }
        schedule.ev[index] = round(amps * powerPerAmp, 2);
        schedule.evTargetCurrentA[index] = amps;
        schedule.evMinCurrentA[index] = minimumA;
        schedule.evMaxCurrentA[index] = maximumA;
      }
    } else {
      applyEvCurrentEnvelopes(
        schedule,
        slots,
        snapshot.services.filter(isDispatchableService),
      );
    }
    schedule.storeDiagnostics.push(
      ...undispatchedStores(snapshot, schedule.dispatched),
    );
    return { schedule, errors };
  }

  // The store model is in force from schema 6, so a home on it whose stores
  // could not be built at all still has to say what it was holding and why —
  // that case returns no dispatch, and used to return no explanation either.
  schedule.storeDiagnostics.push(
    ...undispatchedStores(snapshot, schedule.dispatched),
  );

  const services = snapshot.services.filter(isDispatchableService).sort((
    a,
    b,
  ) =>
    isoMs(a.deadline) - isoMs(b.deadline) || a.priority - b.priority ||
    a.id.localeCompare(b.id)
  );

  for (const service of services) {
    const shape = serviceShape(slots, service);
    if (shape.count === 0) {
      schedule.serviceSlots[service.id] = [];
      if (isDiscreteCurrentService(service)) {
        schedule.serviceCurrentsA[service.id] = [];
      }
      continue;
    }
    const preferred = service.baseline_preferred_start
      ? isoMs(service.baseline_preferred_start)
      : isoMs(service.earliest_start);
    const candidates = candidateStarts(slots, service, shape.count).flatMap(
      (start) => {
        for (let offset = 0; offset < shape.count; offset += 1) {
          if (schedule[service.device][start + offset] > 0) return [];
        }
        if (isDiscreteCurrentService(service)) {
          const candidate = discreteCurrentCandidate(
            key,
            slots,
            snapshot,
            service,
            shape,
            start,
            occupiedW,
            reservedW,
            preferred,
          );
          return candidate ? [candidate] : [];
        }
        const powers = new Array(shape.count).fill(service.control.power_w);
        if (
          powers.some((powerW, offset) => {
            const index = start + offset;
            return fixedLoadW(slots[index]) + occupiedW[index] + powerW >
              snapshot.grid.import_limit_w + Math.max(0, slots[index].pv_w);
          })
        ) return [];
        return [{
          start,
          powers,
          currents: [] as number[],
          score: serviceCost(
            key,
            slots,
            start,
            powers,
            occupiedW,
            reservedW,
            preferred,
          ),
        }];
      },
    );
    if (candidates.length === 0) {
      errors.push(
        `${service.id}: no feasible contiguous ${shape.count}-slot window`,
      );
      schedule.serviceSlots[service.id] = [];
      if (isDiscreteCurrentService(service)) {
        schedule.serviceCurrentsA[service.id] = [];
      }
      continue;
    }
    candidates.sort((a, b) => a.score - b.score || a.start - b.start);
    const chosen = candidates[0];
    const indices: number[] = [];
    for (let offset = 0; offset < shape.count; offset += 1) {
      const index = chosen.start + offset;
      const powerW = chosen.powers[offset];
      schedule[service.device][index] = powerW;
      occupiedW[index] += powerW;
      if (isDiscreteCurrentService(service)) {
        schedule.evTargetCurrentA[index] = chosen.currents[offset];
      }
      indices.push(index);
    }
    schedule.serviceSlots[service.id] = indices;
    if (isDiscreteCurrentService(service)) {
      schedule.serviceCurrentsA[service.id] = chosen.currents;
    }
  }
  applyDutyCycleServices(
    key,
    slots,
    snapshot,
    snapshot.services.filter(isDutyCycleService),
    occupiedW,
    schedule,
  );
  applyEvCurrentEnvelopes(schedule, slots, services);
  return { schedule, errors };
}

const THERMAL_SHIFT_STEP_W = 100;
const THERMAL_SHIFT_LOOKBACK_SLOTS = 48 * 4;
const THERMAL_PRIORITY_PEAK_WEIGHT_SEK_PER_KW2 = 0.04;

const scheduledServiceW = (schedule: Schedule, index: number) =>
  schedule.pool[index] + schedule.boiler[index] + schedule.ev[index];

/** Absolute slot score used when deciding whether to move room heat earlier. */
function thermalSlotScore(
  key: Exclude<PlanKey, "baseline">,
  slot: PreparedSlot,
  occupiedW: number,
  reservedW: number,
): number {
  const demandW = fixedLoadW(slot) + occupiedW;
  const importW = Math.max(0, demandW - slot.pv_w);
  const exportW = Math.max(0, slot.pv_w - demandW);
  const peakWeight = key === "priority"
    ? THERMAL_PRIORITY_PEAK_WEIGHT_SEK_PER_KW2
    : PEAK_WEIGHT_SEK_PER_KW2;
  let score = SLOT_HOURS / 1_000 * (
        importW * slot.shadow_import_sek_per_kwh -
        exportW * slot.shadow_export_sek_per_kwh
      ) + peakWeight * (importW / 1_000) ** 2;
  // In Priority, battery target reservations outrank discretionary preheat.
  if (key === "priority" && reservedW > 0) {
    score += occupiedW * 1_000;
  }
  return score;
}

/**
 * Move thermal power from a later quarter to an earlier one while preserving
 * its exact temperature contribution from the later quarter onward. Earlier
 * heat decays by alpha, so the moved wattage is increased by that known loss.
 * This gives the shared electrical objective genuine room-level flexibility
 * without weakening a single temperature deadline.
 */
function optimiseRoomPreheating(
  key: Exclude<PlanKey, "baseline">,
  slots: PreparedSlot[],
  snapshot: OptimisationSnapshot,
  schedule: Schedule,
  reservedW: number[],
): void {
  const outdoor = snapshot.outdoor_temperature_c as number[];
  const occupiedW = slots.map((slot) =>
    scheduledServiceW(schedule, slot.index) +
    Object.values(schedule.roomHeating).reduce(
      (sum, values) => sum + values[slot.index],
      0,
    )
  );
  const batterySupportW = snapshot.battery?.discharge_max_w ?? 0;

  for (
    const zone of [...(snapshot.thermal_zones ?? [])].sort((a, b) =>
      a.key.localeCompare(b.key)
    )
  ) {
    const powers = schedule.roomHeating[zone.key];
    const alpha = 1 - zone.model.cooling_constant_per_h * SLOT_HOURS;
    const heatGain = zone.model.gain_c_per_wh * SLOT_HOURS;
    if (!(alpha > 0) || !(heatGain > 0)) continue;
    let temperatures = projectZoneTemperature(
      zone.model,
      zone.start_temperature_c,
      outdoor,
      powers,
    );
    const retentionByLag = Array.from(
      { length: powers.length + 1 },
      (_value, lag) => alpha ** lag,
    );

    for (let source = powers.length - 1; source > 0; source -= 1) {
      let movedFromSource = false;
      while (powers[source] > 0.01) {
        let best: {
          candidate: number;
          removeW: number;
          addW: number;
          delta: number;
        } | null = null;
        const firstCandidate = Math.max(
          0,
          source - THERMAL_SHIFT_LOOKBACK_SLOTS,
        );
        // For candidate c, the comfort constraint is
        //   min(headroom[t] / (gain * alpha^(t-c-1))), t=c+1..source.
        // Walking backwards gives that same bound in O(window) instead of
        // rescanning the whole c..source interval for every candidate.
        const comfortHeadroomW = new Array<number>(source);
        let laterLimitW = Number.POSITIVE_INFINITY;
        for (
          let candidate = source - 1;
          candidate >= firstCandidate;
          candidate -= 1
        ) {
          const headroomC = zone.comfort_max_c[candidate + 1] -
            temperatures[candidate + 1];
          const immediateLimitW = headroomC <= 0 ? 0 : headroomC / heatGain;
          laterLimitW = Math.min(immediateLimitW, laterLimitW / alpha);
          comfortHeadroomW[candidate] = laterLimitW;
        }
        for (
          let candidate = firstCandidate;
          candidate < source;
          candidate += 1
        ) {
          const retention = retentionByLag[source - candidate];
          if (!(retention > 1e-6)) continue;
          const maxAddW = Math.min(
            zone.maximum_power_w_by_slot[candidate] - powers[candidate],
            comfortHeadroomW[candidate],
          );
          if (maxAddW <= 0.01) continue;
          const removeW = Math.min(
            powers[source],
            THERMAL_SHIFT_STEP_W,
            maxAddW * retention,
          );
          if (removeW <= 0.01) continue;
          const addW = removeW / retention;
          const candidateDemandW = fixedLoadW(slots[candidate]) +
            occupiedW[candidate] + addW;
          if (
            candidateDemandW > snapshot.grid.import_limit_w +
                slots[candidate].pv_w + batterySupportW + 0.01
          ) continue;

          const before = thermalSlotScore(
            key,
            slots[candidate],
            occupiedW[candidate],
            reservedW[candidate],
          ) + thermalSlotScore(
            key,
            slots[source],
            occupiedW[source],
            reservedW[source],
          );
          const after = thermalSlotScore(
            key,
            slots[candidate],
            occupiedW[candidate] + addW,
            reservedW[candidate],
          ) + thermalSlotScore(
            key,
            slots[source],
            occupiedW[source] - removeW,
            reservedW[source],
          );
          const delta = after - before;
          if (
            delta < -1e-8 &&
            (!best || delta < best.delta ||
              (Math.abs(delta - best.delta) < 1e-8 &&
                candidate > best.candidate))
          ) {
            best = { candidate, removeW, addW, delta };
          }
        }
        if (!best) break;
        powers[source] -= best.removeW;
        powers[best.candidate] += best.addW;
        occupiedW[source] -= best.removeW;
        occupiedW[best.candidate] += best.addW;
        // Extra warmth exists only through `source`; one quarter later the
        // earlier addition and removed source power cancel exactly. Updating
        // that interval avoids a full 72-hour projection after every 100 W
        // move while preserving the same trajectory.
        for (let at = best.candidate + 1; at <= source; at += 1) {
          temperatures[at] += best.addW * heatGain *
            retentionByLag[at - best.candidate - 1];
        }
        movedFromSource = true;
      }
      // Re-anchor once per source so round-off cannot accumulate across the
      // horizon; the previous implementation reprojected after every move.
      if (movedFromSource) {
        temperatures = projectZoneTemperature(
          zone.model,
          zone.start_temperature_c,
          outdoor,
          powers,
        );
      }
    }
  }
}

function scheduleRoomHeating(
  key: PlanKey,
  slots: PreparedSlot[],
  snapshot: OptimisationSnapshot,
  schedule: Schedule,
  reservedW: number[],
): string[] {
  const zones = snapshot.thermal_zones ?? [];
  if (zones.length === 0) return [];
  for (const zone of zones) {
    schedule.roomHeating[zone.key] = [...zone.unplanned_power_w];
  }
  if (key !== "baseline") {
    optimiseRoomPreheating(key, slots, snapshot, schedule, reservedW);
  }

  const outdoor = snapshot.outdoor_temperature_c as number[];
  const errors: string[] = [];
  for (const zone of zones) {
    const powers = schedule.roomHeating[zone.key];
    const temperatures = projectZoneTemperature(
      zone.model,
      zone.start_temperature_c,
      outdoor,
      powers,
    );
    for (let index = 0; index < slots.length; index += 1) {
      if (
        powers[index] < -0.01 ||
        powers[index] > zone.maximum_power_w_by_slot[index] + 0.01
      ) {
        errors.push(`${zone.name}: heating power is outside its envelope`);
        break;
      }
      // The first slot is already underway when the snapshot is captured. A
      // plan can recover from an existing deficit, but cannot rewrite its
      // starting temperature. Every later quarter is a real deadline.
      if (
        index > 0 &&
        temperatures[index] + 0.01 < zone.comfort_min_c[index]
      ) {
        errors.push(
          `${zone.name}: ${temperatures[index].toFixed(2)} C misses the ` +
            `${zone.comfort_min_c[index].toFixed(2)} C objective at ` +
            slots[index].start,
        );
        break;
      }
    }
  }
  return errors;
}

function batteryReservation(
  slots: PreparedSlot[],
  snapshot: OptimisationSnapshot,
): { reservedW: number[]; protectedSoc: (number | null)[] } {
  const reservedW = new Array(slots.length).fill(0);
  const protectedSoc: (number | null)[] = new Array(slots.length).fill(null);
  if (!snapshot.battery || !snapshot.policy.battery_target_is_hard) {
    return { reservedW, protectedSoc };
  }

  const target = snapshot.policy.battery_end_of_solar_target_soc;
  const battery = snapshot.battery;
  const completedDays = completedLocalDays(slots, snapshot.timezone);
  const byDay = new Map<string, number[]>();
  for (const slot of slots) {
    const day = slot.local_day;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(slot.index);
  }

  // Build the reservation chronologically from a base-load-only battery
  // trajectory. This accounts for pre-dawn drain and cloudy dips instead of
  // sizing the target from midnight SOC. The protected trajectory prevents a
  // lower-ranked load from spending charge already accumulated for the hard
  // target; the final independent simulation remains authoritative.
  let assumedSoc = battery.soc;
  for (const [day, indices] of byDay) {
    const solar = indices.filter((index) => slots[index].pv_w > 50);
    const enforceTarget = completedDays.has(day) && solar.length > 0;
    const firstSolar = enforceTarget ? solar[0] : -1;
    const lastSolar = enforceTarget ? solar[solar.length - 1] : -1;
    for (const index of indices) {
      const netW = slots[index].pv_w - fixedLoadW(slots[index]);
      const roomKwh = Math.max(
        0,
        (battery.max_soc - assumedSoc) * battery.capacity_kwh,
      );
      const maxChargeW = Math.min(
        battery.charge_max_w,
        roomKwh / battery.charge_efficiency * 1_000 / SLOT_HOURS,
      );
      const availableKwh = Math.max(
        0,
        (assumedSoc - battery.min_soc) * battery.capacity_kwh,
      );
      let maxDischargeW = Math.min(
        battery.discharge_max_w,
        availableKwh * battery.discharge_efficiency * 1_000 / SLOT_HOURS,
      );
      if (enforceTarget && index >= lastSolar) {
        const aboveTargetKwh = Math.max(
          0,
          (assumedSoc - target) * battery.capacity_kwh,
        );
        maxDischargeW = Math.min(
          maxDischargeW,
          aboveTargetKwh * battery.discharge_efficiency * 1_000 / SLOT_HOURS,
        );
      }

      if (netW >= 0) {
        const chargeW = Math.min(netW, maxChargeW);
        const neededW = Math.max(0, target - assumedSoc) *
          battery.capacity_kwh /
          battery.charge_efficiency * 1_000 / SLOT_HOURS;
        if (enforceTarget && index >= firstSolar && index <= lastSolar) {
          reservedW[index] = Math.min(chargeW, neededW);
        }
        assumedSoc += chargeW * battery.charge_efficiency / 1_000 *
          SLOT_HOURS / battery.capacity_kwh;
      } else {
        const dischargeW = Math.min(-netW, maxDischargeW);
        assumedSoc -= dischargeW / battery.discharge_efficiency / 1_000 *
          SLOT_HOURS / battery.capacity_kwh;
      }
      assumedSoc = Math.max(
        battery.min_soc,
        Math.min(battery.max_soc, assumedSoc),
      );
      if (enforceTarget && index >= firstSolar && index <= lastSolar) {
        protectedSoc[index] = Math.min(target, assumedSoc);
      } else if (enforceTarget && index > lastSolar) {
        protectedSoc[index] = target;
      }
    }
  }
  return { reservedW, protectedSoc };
}

type DeviceLoadRule =
  | { key: string; kind: "fixed"; forecastW: number[] }
  | {
    key: string;
    kind: "controlled";
    service: "boiler" | "pool" | "ev";
    shareBySlot: number[];
  }
  | { key: string; kind: "room"; roomKey: string; share: number };

const deviceLoadRuleCache = new WeakMap<
  OptimisationSnapshot,
  DeviceLoadRule[]
>();

/** Compile device allocation coefficients once for all three simulations. */
function deviceLoadRules(snapshot: OptimisationSnapshot): DeviceLoadRule[] {
  const cached = deviceLoadRuleCache.get(snapshot);
  if (cached) return cached;

  const rules: DeviceLoadRule[] = [];
  const thermalDeviceKeys = new Set(
    (snapshot.thermal_zones ?? []).flatMap((zone) => zone.device_keys),
  );
  const controlledServiceByCategory = new Map<
    string,
    "boiler" | "pool" | "ev"
  >();
  if (snapshot.capabilities.boiler) {
    controlledServiceByCategory.set("hot_water", "boiler");
  }
  if (snapshot.capabilities.pool) {
    controlledServiceByCategory.set("pool_heating", "pool");
  }
  if (snapshot.capabilities.ev) {
    controlledServiceByCategory.set("ev_charging", "ev");
  }

  for (const model of snapshot.device_models) {
    if (thermalDeviceKeys.has(model.key)) continue;
    const service = controlledServiceByCategory.get(model.category);
    if (!service) {
      rules.push({
        key: model.key,
        kind: "fixed",
        forecastW: model.forecast_w_by_slot,
      });
      continue;
    }
    // A category can contain both a service meter and a room heater. Thermal
    // meters are excluded here and receive their room allocation below.
    const categoryModels = snapshot.device_models.filter((candidate) =>
      candidate.category === model.category &&
      !thermalDeviceKeys.has(candidate.key)
    );
    const activeTotal = categoryModels.reduce(
      (sum, candidate) => sum + (candidate.active_power_w ?? 0),
      0,
    );
    const forecastTotalBySlot = snapshot.slots.map((_slot, index) =>
      categoryModels.reduce(
        (sum, candidate) => sum + candidate.forecast_w_by_slot[index],
        0,
      )
    );
    rules.push({
      key: model.key,
      kind: "controlled",
      service,
      shareBySlot: forecastTotalBySlot.map((forecastTotal, index) =>
        forecastTotal > 0
          ? model.forecast_w_by_slot[index] / forecastTotal
          : activeTotal > 0
          ? (model.active_power_w ?? 0) / activeTotal
          : 1 / categoryModels.length
      ),
    });
  }
  const modelByKey = new Map(
    snapshot.device_models.map((model) => [model.key, model]),
  );
  for (const zone of snapshot.thermal_zones ?? []) {
    const models = zone.device_keys.map((key) => modelByKey.get(key)!);
    const activeTotal = models.reduce(
      (sum, model) => sum + (model.active_power_w ?? 0),
      0,
    );
    for (const model of models) {
      rules.push({
        key: model.key,
        kind: "room",
        roomKey: zone.key,
        share: activeTotal > 0
          ? (model.active_power_w ?? 0) / activeTotal
          : 1 / models.length,
      });
    }
  }
  deviceLoadRuleCache.set(snapshot, rules);
  return rules;
}

function empiricalDeviceLoads(
  snapshot: OptimisationSnapshot,
  index: number,
  controlled: Record<string, number>,
  roomHeating: Record<string, number>,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const rule of deviceLoadRules(snapshot)) {
    if (rule.kind === "fixed") {
      result[rule.key] = round(rule.forecastW[index], 2);
    } else if (rule.kind === "controlled") {
      result[rule.key] = round(
        (controlled[rule.service] ?? 0) * rule.shareBySlot[index],
        2,
      );
    } else {
      result[rule.key] = round(
        (roomHeating[rule.roomKey] ?? 0) * rule.share,
        2,
      );
    }
  }
  return result;
}

function simulate(
  key: PlanKey,
  slots: PreparedSlot[],
  snapshot: OptimisationSnapshot,
  schedule: Schedule,
  protectedSoc: (number | null)[],
): { slots: PlannedSlot[]; summary: PlanSummary; errors: string[] } {
  const battery = snapshot.battery ?? {
    capacity_kwh: 1,
    soc: 0,
    min_soc: 0,
    max_soc: 0,
    charge_max_w: 0,
    discharge_max_w: 0,
    charge_efficiency: 1,
    discharge_efficiency: 1,
  };
  let soc = battery.soc;
  let socLow = soc;
  let evSoc = snapshot.ev_battery?.soc ?? null;
  const output: PlannedSlot[] = [];
  const errors: string[] = [];
  const endOfSolar: Record<string, number> = {};
  const completedDays = completedLocalDays(slots, snapshot.timezone);
  const endMarkerByDay = new Map<string, number>();
  for (const day of completedDays) {
    const daySlots = slots.filter((slot) => slot.local_day === day);
    const solarSlots = daySlots.filter((slot) => slot.pv_w > 50);
    const marker = solarSlots.at(-1) ??
      (daySlots[0].local_minute_of_day === 0 ? daySlots.at(-1) : undefined);
    if (marker) endMarkerByDay.set(day, marker.index);
  }

  let loadKwh = 0;
  let flexibleKwh = 0;
  let pvKwh = 0;
  let importKwh = 0;
  let exportKwh = 0;
  let pricedImportKwh = 0;
  let pricedExportKwh = 0;
  let curtailedKwh = 0;
  let importCost = 0;
  let exportRevenue = 0;
  const representedCategories = new Set(
    snapshot.device_models.map((model) => model.category),
  );
  const evAvailableFrom = snapshot.ev_battery?.available_from == null
    ? Number.NaN
    : isoMs(snapshot.ev_battery.available_from);
  const evDeparture = snapshot.ev_battery?.departure == null
    ? slots.at(-1)!.epoch_ms + SLOT_MS
    : isoMs(snapshot.ev_battery.departure);
  const dispatchOwnsBattery = schedule.dispatched.has("battery");
  const replacementCosts = dispatchOwnsBattery
    ? null
    : replacementCostsBySlot(slots, snapshot);

  for (const slot of slots) {
    const poolW = schedule.pool[slot.index];
    const boilerW = schedule.boiler[slot.index];
    const evW = schedule.ev[slot.index];
    const evConnected = snapshot.ev_battery?.connected === true &&
      slot.epoch_ms >= evAvailableFrom && slot.epoch_ms < evDeparture;
    const roomHeating = Object.fromEntries(
      Object.entries(schedule.roomHeating).map(([roomKey, values]) => [
        roomKey,
        values[slot.index],
      ]),
    );
    const roomHeatingW = Object.values(roomHeating).reduce(
      (sum, watts) => sum + watts,
      0,
    );
    const serviceFlexibleW = poolW + boilerW + evW;
    const flexibleW = serviceFlexibleW + roomHeatingW;
    const deviceLoads = empiricalDeviceLoads(snapshot, slot.index, {
      boiler: boilerW,
      pool: poolW,
      ev: evW,
    }, roomHeating);
    const unrepresentedControlledW =
      (representedCategories.has("pool_heating") ? 0 : poolW) +
      (representedCategories.has("hot_water") ? 0 : boilerW) +
      (representedCategories.has("ev_charging") ? 0 : evW);
    const loadW = slot.base_load_forecast_w +
      Object.values(deviceLoads).reduce((sum, watts) => sum + watts, 0) +
      unrepresentedControlledW;
    const roomKwh = Math.max(0, (battery.max_soc - soc) * battery.capacity_kwh);
    const availableKwh = Math.max(
      0,
      (soc - battery.min_soc) * battery.capacity_kwh,
    );
    const maxChargeW = Math.min(
      battery.charge_max_w,
      roomKwh / battery.charge_efficiency * 1_000 / SLOT_HOURS,
    );
    let maxDischargeW = Math.min(
      battery.discharge_max_w,
      availableKwh * battery.discharge_efficiency * 1_000 / SLOT_HOURS,
    );
    const floor = protectedSoc[slot.index];
    if (floor !== null) {
      const aboveFloorKwh = Math.max(0, (soc - floor) * battery.capacity_kwh);
      maxDischargeW = Math.min(
        maxDischargeW,
        aboveFloorKwh * battery.discharge_efficiency * 1_000 / SLOT_HOURS,
      );
    }

    const netW = slot.pv_w - loadW;
    let batteryChargeW = 0;
    let batteryDischargeW = 0;
    let batteryExportW = 0;
    let gridImportW = 0;
    let gridExportW = 0;
    let curtailedW = 0;
    let unservedW = 0;
    // Export when the spike beats what refilling will cost, not when it clears
    // a fixed number (§1.4.5). The static threshold survives as a hard floor
    // beneath the comparison: a trade that beats a cheap tomorrow can still be
    // a bad trade outright. Still requires a published price — exporting the
    // battery on a guess is not a trade worth making.
    const replacementCost = replacementCosts?.[slot.index] ??
      Number.POSITIVE_INFINITY;
    const deliberateExport = key !== "baseline" &&
      snapshot.policy.battery_export_enabled === true && slot.binding &&
      slot.export_price_sek_per_kwh! >=
        snapshot.policy.battery_export_min_price_sek_per_kwh &&
      slot.export_price_sek_per_kwh! > replacementCost;
    const exportFloor = Math.max(
      battery.min_soc,
      floor ?? battery.min_soc,
      snapshot.policy.battery_export_reserve_soc,
    );
    const exportableKwh = Math.max(
      0,
      (soc - exportFloor) * battery.capacity_kwh,
    );
    const maxExportDischargeW = Math.min(
      maxDischargeW,
      exportableKwh * battery.discharge_efficiency * 1_000 / SLOT_HOURS,
    );
    // When the dispatch owns the battery it has already decided this slot by
    // marginal value, against the same prices every other store bid on. Simulate
    // must follow it rather than re-deciding: two mechanisms choosing the same
    // flow is how a plan comes to charge and discharge for contradictory
    // reasons within an hour.
    if (dispatchOwnsBattery) {
      batteryChargeW = Math.min(
        schedule.batteryChargeW[slot.index],
        maxChargeW,
      );
      batteryDischargeW = Math.min(
        schedule.batteryDischargeW[slot.index],
        maxDischargeW,
      );
      const balanceW = netW - batteryChargeW + batteryDischargeW;
      if (balanceW >= 0) {
        gridExportW = Math.min(balanceW, snapshot.grid.export_limit_w);
        curtailedW = Math.max(0, balanceW - gridExportW);
      } else {
        gridImportW = Math.min(-balanceW, snapshot.grid.import_limit_w);
        unservedW = Math.max(0, -balanceW - gridImportW);
      }
    } else if (netW >= 0) {
      batteryChargeW = Math.min(netW, maxChargeW);
      const afterBatteryW = netW - batteryChargeW;
      if (deliberateExport && batteryChargeW <= 0.01) {
        batteryExportW = Math.min(
          maxExportDischargeW,
          Math.max(0, snapshot.grid.export_limit_w - afterBatteryW),
        );
        batteryDischargeW = batteryExportW;
      }
      gridExportW = Math.min(
        afterBatteryW + batteryExportW,
        snapshot.grid.export_limit_w,
      );
      curtailedW = Math.max(
        0,
        afterBatteryW + batteryExportW - gridExportW,
      );
    } else {
      const deficitW = -netW;
      batteryDischargeW = Math.min(deficitW, maxDischargeW);
      const afterBatteryW = deficitW - batteryDischargeW;
      if (deliberateExport && afterBatteryW <= 0.01) {
        batteryExportW = Math.min(
          Math.max(0, maxExportDischargeW - batteryDischargeW),
          snapshot.grid.export_limit_w,
        );
        batteryDischargeW += batteryExportW;
      }
      if (afterBatteryW > 0) {
        gridImportW = Math.min(afterBatteryW, snapshot.grid.import_limit_w);
        unservedW = Math.max(0, afterBatteryW - gridImportW);
      } else {
        gridExportW = batteryExportW;
      }
    }
    soc += (
      batteryChargeW * battery.charge_efficiency -
      batteryDischargeW / battery.discharge_efficiency
    ) / 1_000 * SLOT_HOURS / battery.capacity_kwh;
    soc = Math.max(battery.min_soc, Math.min(battery.max_soc, soc));
    socLow = Math.min(socLow, soc);
    if (evSoc !== null && snapshot.ev_battery) {
      evSoc = Math.min(
        1,
        evSoc + evW * snapshot.ev_battery.charge_efficiency / 1_000 *
            SLOT_HOURS / snapshot.ev_battery.capacity_kwh,
      );
    }

    const slotImportKwh = gridImportW / 1_000 * SLOT_HOURS;
    const slotExportKwh = gridExportW / 1_000 * SLOT_HOURS;
    const importCostSek = slot.binding
      ? slotImportKwh * slot.import_price_sek_per_kwh!
      : null;
    const exportRevenueSek = slot.binding
      ? slotExportKwh * slot.export_price_sek_per_kwh!
      : null;

    const storeAllocations = schedule.dispatchAllocations[slot.index].map(
      (allocation) => ({
        ...allocation,
        power_w: round(allocation.power_w, 2),
        state_before: round(allocation.state_before, 4),
        state_after: round(allocation.state_after, 4),
        retention_factor: round(allocation.retention_factor, 6),
        average_value_sek_per_kwh: round(
          allocation.average_value_sek_per_kwh,
          5,
        ),
        energy_cost_sek_per_kwh: round(
          allocation.energy_cost_sek_per_kwh,
          5,
        ),
        wear_cost_sek_per_kwh: round(
          allocation.wear_cost_sek_per_kwh,
          5,
        ),
        start_cost_sek: round(allocation.start_cost_sek, 5),
        net_value_sek: round(allocation.net_value_sek, 5),
        run_net_value_sek: round(allocation.run_net_value_sek, 5),
        solar_w: round(allocation.solar_w, 2),
        grid_w: round(allocation.grid_w, 2),
      }),
    );
    let batteryDecision = schedule.dispatchBattery[slot.index];
    if (
      batteryDecision?.action === "hold" &&
      batteryDecision.reason === "balanced" &&
      gridImportW > 10 && schedule.dispatchImportW[slot.index] <= 10
    ) {
      // Duty-cycle and room comfort loads are installed after the store
      // auction. Do not fabricate a battery comparison the optimiser never
      // made; publish that ordering explicitly so it can be seen and fixed.
      batteryDecision = {
        ...batteryDecision,
        reason: "load_added_after_dispatch",
      };
    }
    const batteryEvidence = batteryDecision === null ? null : {
      ...batteryDecision,
      state_before: round(batteryDecision.state_before, 4),
      state_after: round(batteryDecision.state_after, 4),
      comparison_power_w: round(batteryDecision.comparison_power_w, 2),
      power_w: round(batteryDecision.power_w, 2),
      comparison_price_sek_per_kwh:
        batteryDecision.comparison_price_sek_per_kwh === null
          ? null
          : round(batteryDecision.comparison_price_sek_per_kwh, 5),
      stored_value_sek_per_kwh:
        batteryDecision.stored_value_sek_per_kwh === null
          ? null
          : round(batteryDecision.stored_value_sek_per_kwh, 5),
      wear_cost_sek_per_kwh: round(
        batteryDecision.wear_cost_sek_per_kwh,
        5,
      ),
      net_value_sek: batteryDecision.net_value_sek === null
        ? null
        : round(batteryDecision.net_value_sek, 5),
    };
    const residualW = loadW + batteryChargeW - slot.pv_w -
      batteryDischargeW;
    const gridDirection = gridImportW > 10
      ? "import" as const
      : gridExportW > 10
      ? "export" as const
      : "balanced" as const;
    const gridPowerW = gridDirection === "import"
      ? gridImportW
      : gridDirection === "export"
      ? gridExportW
      : 0;
    const gridLimitW = gridDirection === "import"
      ? snapshot.grid.import_limit_w
      : gridDirection === "export"
      ? snapshot.grid.export_limit_w
      : 0;
    const gridReason: QuarterGridBalanceDiagnostic["reason"] = unservedW > 1
      ? "import_limit"
      : curtailedW > 1
      ? "export_limit"
      : gridDirection === "balanced"
      ? "balanced"
      : "residual_after_dispatch";

    output.push({
      start: slot.start,
      binding: slot.binding,
      pv_raw_w: round(slot.pv_raw_w, 2),
      pv_w: round(slot.pv_w, 2),
      base_w: round(slot.base_load_forecast_w, 2),
      base_p10_w: round(slot.base_load_p10_w, 2),
      base_p90_w: round(slot.base_load_p90_w, 2),
      import_price_sek_per_kwh: slot.import_price_sek_per_kwh,
      export_price_sek_per_kwh: slot.export_price_sek_per_kwh,
      shadow_import_sek_per_kwh: round(slot.shadow_import_sek_per_kwh, 5),
      shadow_export_sek_per_kwh: round(slot.shadow_export_sek_per_kwh, 5),
      pool_w: poolW,
      boiler_expected_w: round(boilerW, 2),
      boiler_permitted: schedule.boilerPermitted[slot.index],
      ev_w: evW,
      room_heating_w: Object.fromEntries(
        Object.entries(roomHeating).map(([roomKey, watts]) => [
          roomKey,
          round(watts, 2),
        ]),
      ),
      device_loads_w: deviceLoads,
      ev_target_current_a: schedule.evTargetCurrentA[slot.index],
      ev_min_current_a: schedule.evMinCurrentA[slot.index],
      ev_max_current_a: schedule.evMaxCurrentA[slot.index],
      ev_soc: evSoc === null ? null : round(evSoc, 6),
      ev_connected: evConnected,
      load_w: round(loadW, 2),
      battery_charge_w: round(batteryChargeW, 2),
      battery_discharge_w: round(batteryDischargeW, 2),
      battery_export_w: round(batteryExportW, 2),
      battery_soc: round(soc, 6),
      grid_import_w: round(gridImportW, 2),
      grid_export_w: round(gridExportW, 2),
      curtailed_w: round(curtailedW, 2),
      unserved_w: round(unservedW, 2),
      import_cost_sek: importCostSek === null ? null : round(importCostSek),
      export_revenue_sek: exportRevenueSek === null
        ? null
        : round(exportRevenueSek),
      decision: {
        schema_version: 1,
        store_allocations: storeAllocations,
        battery: batteryEvidence,
        grid_balance: {
          load_w: round(loadW, 2),
          pv_w: round(slot.pv_w, 2),
          battery_charge_w: round(batteryChargeW, 2),
          battery_discharge_w: round(batteryDischargeW, 2),
          residual_w: round(residualW, 2),
          direction: gridDirection,
          power_w: round(gridPowerW, 2),
          limit_w: round(gridLimitW, 2),
          limit_binding: unservedW > 1 || curtailedW > 1,
          reason: gridReason,
        },
      },
    });

    loadKwh += loadW / 1_000 * SLOT_HOURS;
    flexibleKwh += flexibleW / 1_000 * SLOT_HOURS;
    pvKwh += slot.pv_w / 1_000 * SLOT_HOURS;
    importKwh += slotImportKwh;
    exportKwh += slotExportKwh;
    curtailedKwh += curtailedW / 1_000 * SLOT_HOURS;
    if (slot.binding) {
      pricedImportKwh += slotImportKwh;
      pricedExportKwh += slotExportKwh;
      importCost += importCostSek!;
      exportRevenue += exportRevenueSek!;
    }
    const suppliedW = slot.pv_w + gridImportW + batteryDischargeW;
    const consumedW = loadW - unservedW + gridExportW + batteryChargeW +
      curtailedW;
    if (Math.abs(suppliedW - consumedW) > 0.01) {
      errors.push(
        `${slot.start}: energy balance differs by ${
          round(suppliedW - consumedW, 2)
        } W`,
      );
    }
    if (
      (gridImportW > 0 && gridExportW > 0) ||
      (batteryChargeW > 0 && batteryDischargeW > 0)
    ) {
      errors.push(`${slot.start}: mutually exclusive power flows overlap`);
    }
    if (unservedW > 1) {
      errors.push(`${slot.start}: ${round(unservedW, 1)} W unserved`);
    }
    if (
      schedule.evMinCurrentA[slot.index] >
        schedule.evTargetCurrentA[slot.index] + 1e-6 ||
      schedule.evTargetCurrentA[slot.index] >
        schedule.evMaxCurrentA[slot.index] + 1e-6
    ) {
      errors.push(`${slot.start}: EV current target is outside its envelope`);
    }
    const day = slot.local_day;
    if (endMarkerByDay.get(day) === slot.index) endOfSolar[day] = round(soc, 6);
  }

  const requestedKwh = snapshot.services.reduce(
    (sum, service) => sum + service.required_kwh,
    0,
  );
  const deliveredKwh = snapshot.services.reduce((sum, service) => {
    // A dispatched store has no block to reconcile. Its energy is already in
    // `flexibleKwh` and is subtracted from it below, so counting it here too
    // would make the check compare a number against itself.
    if (schedule.dispatched.has(service.device)) return sum;
    const indices = schedule.serviceSlots[service.id] ?? [];
    if (isDutyCycleService(service)) {
      const earliest = isoMs(service.earliest_start);
      const deadline = isoMs(service.deadline);
      return sum +
        slots.reduce(
          (serviceSum, slot) =>
            slot.epoch_ms >= earliest && slot.epoch_ms + SLOT_MS <= deadline
              ? serviceSum + schedule.boiler[slot.index] / 1_000 * SLOT_HOURS
              : serviceSum,
          0,
        );
    }
    if (isDiscreteCurrentService(service)) {
      const currents = schedule.serviceCurrentsA[service.id] ?? [];
      return sum + currents.reduce(
        (serviceSum, currentA) =>
          serviceSum + currentA * wattsPerAmp(service.control) / 1_000 *
            SLOT_HOURS,
        0,
      );
    }
    return sum + indices.length * service.control.power_w / 1_000 * SLOT_HOURS;
  }, 0);
  const thermalKwh = Object.values(schedule.roomHeating).reduce(
    (total, powers) =>
      total + powers.reduce(
        (sum, watts) => sum + watts / 1_000 * SLOT_HOURS,
        0,
      ),
    0,
  );
  const dispatchedKwh = slots.reduce(
    (total, slot) =>
      total +
      (schedule.dispatched.has("pool") ? schedule.pool[slot.index] : 0) /
        1_000 *
        SLOT_HOURS +
      (schedule.dispatched.has("ev") ? schedule.ev[slot.index] : 0) / 1_000 *
        SLOT_HOURS,
    0,
  );
  if (
    Math.abs(flexibleKwh - thermalKwh - dispatchedKwh - deliveredKwh) > 1e-6
  ) {
    errors.push(
      `simulated service load ${
        round(flexibleKwh - thermalKwh - dispatchedKwh, 3)
      } differs from ` +
        `${round(deliveredKwh, 3)} delivered kWh`,
    );
  }
  for (const service of snapshot.services) {
    // A dispatched device is planned as a state, so it has no window to fill
    // and no daily energy to deliver. Judging it against either is judging it
    // by the model it replaced.
    if (schedule.dispatched.has(service.device)) continue;
    const indices = schedule.serviceSlots[service.id] ?? [];
    if (isDutyCycleService(service)) {
      let consecutive = 0;
      const inhibited = new Set(
        schedule.serviceInhibitedSlots[service.id] ?? [],
      );
      const earliest = isoMs(service.earliest_start);
      const deadline = isoMs(service.deadline);
      for (const slot of slots) {
        if (slot.epoch_ms < earliest || slot.epoch_ms + SLOT_MS > deadline) {
          continue;
        }
        consecutive = inhibited.has(slot.index) ? consecutive + 1 : 0;
        if (consecutive > service.control.max_consecutive_inhibit_slots) {
          errors.push(
            `${service.id}: maximum consecutive inhibit was exceeded`,
          );
          break;
        }
      }
      continue;
    }
    if (indices.length > 0 && indices.length < service.min_run_slots) {
      errors.push(
        `${service.id}: run is shorter than ${service.min_run_slots} slots`,
      );
    }
    if (
      indices.some((value, index) =>
        index > 0 && value !== indices[index - 1] + 1
      )
    ) {
      errors.push(`${service.id}: service run is fragmented`);
    }
    const serviceDelivered = isDiscreteCurrentService(service)
      ? (schedule.serviceCurrentsA[service.id] ?? []).reduce(
        (sum, currentA) =>
          sum + currentA * wattsPerAmp(service.control) / 1_000 * SLOT_HOURS,
        0,
      )
      : indices.length * service.control.power_w / 1_000 * SLOT_HOURS;
    if (serviceDelivered + 1e-6 < service.required_kwh) {
      errors.push(
        `${service.id}: delivered ${round(serviceDelivered, 3)} kWh for ` +
          `${round(service.required_kwh, 3)} kWh requirement`,
      );
    }
  }
  // A hard SOC target is meaningless once the battery bids by marginal value:
  // the trade-off is priced rather than switched (§8.4), and enforcing a target
  // on top would override the very comparison that replaced it.
  if (
    snapshot.policy.battery_target_is_hard &&
    !schedule.dispatched.has("battery")
  ) {
    for (const [day, endSoc] of Object.entries(endOfSolar)) {
      if (endSoc + 1e-6 < snapshot.policy.battery_end_of_solar_target_soc) {
        errors.push(
          `${day}: battery target ${
            (snapshot.policy.battery_end_of_solar_target_soc * 100).toFixed(0)
          }% ` +
            `is infeasible; forecast result ${(endSoc * 100).toFixed(1)}%`,
        );
      }
    }
  }
  if (soc + 1e-6 < snapshot.policy.terminal_soc_min) {
    errors.push(
      `terminal SOC ${(soc * 100).toFixed(1)}% is below ` +
        `${(snapshot.policy.terminal_soc_min * 100).toFixed(1)}%`,
    );
  }

  const terminalDeltaKwh = (soc - battery.soc) * battery.capacity_kwh;
  const netCost = importCost - exportRevenue;
  return {
    slots: output,
    summary: {
      load_kwh: round(loadKwh, 3),
      flexible_load_kwh: round(flexibleKwh, 3),
      pv_kwh: round(pvKwh, 3),
      grid_import_kwh: round(importKwh, 3),
      grid_export_kwh: round(exportKwh, 3),
      curtailed_kwh: round(curtailedKwh, 3),
      priced_import_kwh: round(pricedImportKwh, 3),
      priced_export_kwh: round(pricedExportKwh, 3),
      net_cost_sek: round(netCost, 3),
      terminal_adjusted_cost_sek: round(
        netCost -
          terminalDeltaKwh * snapshot.policy.terminal_energy_value_sek_per_kwh,
        3,
      ),
      battery_soc_start: battery.soc,
      battery_soc_end: round(soc, 6),
      battery_soc_low: round(socLow, 6),
      battery_end_of_solar_soc: endOfSolar,
      service_required_kwh: round(requestedKwh, 3),
      service_delivered_kwh: round(deliveredKwh, 3),
      duty_cycle_deferred_kwh: round(
        Math.max(
          0,
          snapshot.services.filter(isDutyCycleService).reduce(
            (sum, service) => sum + service.required_kwh,
            0,
          ) - snapshot.services.filter(isDutyCycleService).reduce(
            (sum, service) => {
              const earliest = isoMs(service.earliest_start);
              const deadline = isoMs(service.deadline);
              return sum +
                slots.reduce(
                  (serviceSum, slot) =>
                    slot.epoch_ms >= earliest &&
                      slot.epoch_ms + SLOT_MS <= deadline
                      ? serviceSum +
                        schedule.boiler[slot.index] / 1_000 * SLOT_HOURS
                      : serviceSum,
                  0,
                );
            },
            0,
          ),
        ),
        3,
      ),
    },
    errors,
  };
}

function buildPlan(
  key: PlanKey,
  slots: PreparedSlot[],
  snapshot: OptimisationSnapshot,
  reservedW: number[],
  protectedSoc: (number | null)[],
  dispatchCache: Map<string, DispatchBundle | null>,
  derivedBatteryValue: DerivedBatteryValueCurve | null,
): GeneratedPlan {
  const scheduled = scheduleServices(
    key,
    slots,
    snapshot,
    key === "priority" ? reservedW : new Array(slots.length).fill(0),
    dispatchCache,
    derivedBatteryValue,
  );
  const thermalErrors = scheduleRoomHeating(
    key,
    slots,
    snapshot,
    scheduled.schedule,
    key === "priority" ? reservedW : new Array(slots.length).fill(0),
  );
  const simulated = simulate(
    key,
    slots,
    snapshot,
    scheduled.schedule,
    key === "priority" ? protectedSoc : new Array(slots.length).fill(null),
  );
  const validationErrors = [
    ...scheduled.errors,
    ...thermalErrors,
    ...simulated.errors,
  ];
  return {
    key,
    label: key === "baseline"
      ? "A · Baseline"
      : key === "priority"
      ? "B · Priority stack"
      : "C · Cost-led",
    status: validationErrors.length === 0 ? "ready" : "infeasible",
    validation_errors: validationErrors,
    slots: simulated.slots,
    summary: simulated.summary,
    service_slots: scheduled.schedule.serviceSlots,
    service_currents_a: scheduled.schedule.serviceCurrentsA,
    service_inhibited_slots: scheduled.schedule.serviceInhibitedSlots,
    dispatched_devices: [...scheduled.schedule.dispatched].sort(),
    store_diagnostics: scheduled.schedule.storeDiagnostics,
  };
}

export function generateOptimisationPlan(
  snapshot: OptimisationSnapshot,
  now = new Date(),
  /**
   * This home's archived prices, newest or oldest first, it does not matter.
   *
   * Raw observations rather than a pre-computed shape: there is one estimator
   * and it lives in `energy-price-shape.ts`, so a caller cannot accidentally
   * hand the planner a shape built on different rules. Empty is fine — the
   * plan's own published day-ahead window is an observation too, so the tail
   * is still shaped rather than flat (§1.4.3).
   */
  priceArchive: StoredPriceRow[] = [],
  /** Exact resolved price vector from a replay capsule, bypassing estimation. */
  resolvedPriceOutlook?: OptimisationPlan["price_outlook"],
): OptimisationPlan {
  const validationErrors = validateSnapshot(snapshot);
  const snapshotAge = now.getTime() - isoMs(snapshot.captured_at);
  if (
    snapshotAge > MAX_SNAPSHOT_AGE_MS ||
    snapshotAge < -MAX_SOURCE_FUTURE_SKEW_MS
  ) {
    validationErrors.push("captured_at must describe a fresh snapshot");
  }
  if (validationErrors.length > 0) {
    throw new Error(validationErrors.join("; "));
  }
  const { slots, outlook } = preparedSlots(
    snapshot,
    priceArchive,
    resolvedPriceOutlook,
  );
  const { reservedW, protectedSoc } = batteryReservation(slots, snapshot);
  const derivedBatteryValue = snapshot.schema_version >= 6
    ? deriveBatteryValueCurve(slots, snapshot)
    : null;
  const dispatchCache = new Map<string, DispatchBundle | null>();
  const baseline = buildPlan(
    "baseline",
    slots,
    snapshot,
    reservedW,
    protectedSoc,
    dispatchCache,
    derivedBatteryValue,
  );
  const priority = buildPlan(
    "priority",
    slots,
    snapshot,
    reservedW,
    protectedSoc,
    dispatchCache,
    derivedBatteryValue,
  );
  const cost = buildPlan(
    "cost",
    slots,
    snapshot,
    reservedW,
    protectedSoc,
    dispatchCache,
    derivedBatteryValue,
  );
  const plans = { baseline, priority, cost };
  const batteryCurveWasUsed = [...dispatchCache.values()].some((bundle) =>
    bundle?.stores.some((store) => store.key === "battery")
  );
  const derivedBatteryValueCurve = batteryCurveWasUsed
    ? derivedBatteryValue?.diagnostic ?? null
    : null;

  // Dispatchable jobs must carry equal workloads. Duty-cycle devices are
  // intentionally different: the plan controls only permission to run, and
  // the portal reports any empirically expected energy deferred past the
  // horizon instead of pretending the thermostat can be commanded on.
  for (const service of snapshot.services.filter(isDispatchableService)) {
    const counts = Object.values(plans).map((plan) =>
      plan.service_slots[service.id]?.length ?? 0
    );
    if (new Set(counts).size !== 1) {
      validationErrors.push(
        `${service.id}: scenarios do not contain the same service workload`,
      );
    }
  }
  const bindingSlots = slots.filter((slot) => slot.binding);
  const bindingUntil = bindingSlots.length > 0
    ? new Date(
      bindingSlots[bindingSlots.length - 1].epoch_ms + SLOT_MINUTES * 60_000,
    ).toISOString()
    : slots[0].start;
  const priorityErrors = priority.validation_errors.map((error) =>
    `priority: ${error}`
  );
  const status = validationErrors.length > 0
    ? "incomplete"
    : priorityErrors.length > 0
    ? "infeasible"
    : "ready";

  return {
    schema_version: snapshot.schema_version,
    mode: snapshot.mode,
    capabilities: snapshot.capabilities,
    model_version: snapshot.schema_version >= 6
      ? OPTIMISATION_MODEL_VERSION
      : LEGACY_MODEL_VERSION,
    decision_diagnostics_version: 2,
    // One snapshot produces one deterministic plan identity, so retries cannot
    // append duplicate run-history rows.
    plan_id: snapshot.snapshot_id,
    snapshot_id: snapshot.snapshot_id,
    issued_at: now.toISOString(),
    valid_until: new Date(now.getTime() + 75 * 60_000).toISOString(),
    binding_until: bindingUntil,
    timezone: snapshot.timezone,
    slot_minutes: 15,
    status,
    validation_errors: [...validationErrors, ...priorityErrors],
    sources: snapshot.sources,
    pv_calibration: snapshot.pv_calibration,
    price_outlook: {
      shaped: outlook.shaped,
      observed_days: outlook.observedDays,
      effective_days: round(outlook.effectiveDays, 2),
      level_sek_per_kwh: outlook.levelSekPerKwh,
      shadow_import_sek_per_kwh: outlook.shadowImportSekPerKwh,
    },
    battery_value_curve: derivedBatteryValueCurve,
    policy: snapshot.policy,
    battery: snapshot.battery,
    ev_battery: snapshot.ev_battery ?? null,
    pool: snapshot.pool ?? null,
    grid: snapshot.grid,
    device_models: snapshot.device_models,
    services: snapshot.services,
    service_requirement_sample_days: snapshot.service_requirement_sample_days,
    plans,
  };
}
