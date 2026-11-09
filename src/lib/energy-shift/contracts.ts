import type {
  BatteryValueCurveDiagnostic,
  GeneratedPlan,
  DeviceControlType,
  DeviceLoadType,
  DevicePlanningRole,
  EmpiricalDeviceModelInput,
  OptimisationPlan,
  OptimisationSnapshot,
  PlanKey,
  PlanSummary,
  PlannedSlot,
} from '../../../supabase/functions/_shared/planner/planning-contracts';

export type {
  BatteryValueCurveDiagnostic,
  GeneratedPlan,
  DeviceControlType,
  DeviceLoadType,
  DevicePlanningRole,
  EmpiricalDeviceModelInput,
  OptimisationPlan,
  OptimisationSnapshot,
  PlanKey,
  PlanSummary,
  PlannedSlot,
};

export interface ActualEnergySlot {
  start_ts: string;
  total_load_kwh: number | null;
  solar_production_kwh: number | null;
  grid_import_kwh: number | null;
  grid_export_kwh: number | null;
  battery_charge_kwh: number | null;
  battery_discharge_kwh: number | null;
  /** Measured fractions. Null for quarters recorded before they were sent. */
  battery_soc: number | null;
  ev_soc: number | null;
}

export type ThermalFixtureSeason = 'winter' | 'spring' | 'summer' | 'autumn' | 'ev_only';

export interface ThermalZoneProjection {
  key: string;
  name: string;
  /** The room's device models; absent on plans made before rooms named them. */
  device_keys?: string[];
  control_type: 'switch_schedule' | 'setpoint' | 'mixed';
  load_type: 'duty_cycle' | 'inverter' | 'fixed_full_load' | 'variable_full_load' | 'mixed';
  priority: number;
  rated_power_w: number;
  comfort_min_c: number[];
  target_c: number[];
  comfort_max_c: number[];
  planned_temperature_c: number[];
  unplanned_temperature_c: number[];
  planned_power_w: number[];
  unplanned_power_w: number[];
}

/** The room-temperature consequence of the executable comfort-driven demand. */
export interface ThermalProjection {
  source: 'synthetic_season_fixture' | 'comfort_schedule_model';
  season: ThermalFixtureSeason | null;
  slot_minutes: 15;
  starts: string[];
  outdoor_temperature_c: number[];
  planned_total_power_w: number[];
  unplanned_total_power_w: number[];
  zones: ThermalZoneProjection[];
}

export type PortalOptimisationPlan = OptimisationPlan & {
  thermal_projection?: ThermalProjection;
};

export interface DevicePlanningConfiguration {
  planning_role_override: DevicePlanningRole;
  control_type_override: DeviceControlType | null;
}

export const effectivePlanningRole = (
  device: DevicePlanningConfiguration,
): DevicePlanningRole => device.planning_role_override;

export const effectiveControlType = (
  device: DevicePlanningConfiguration,
): DeviceControlType | null => device.control_type_override;

export function isOptimisationPlan(value: unknown): value is PortalOptimisationPlan {
  if (!value || typeof value !== 'object') return false;
  const plan = value as Partial<OptimisationPlan>;
  const version = plan.schema_version;
  if (version !== 5 && version !== 6 && version !== 7 && version !== 8
    && version !== 9 && version !== 10 && version !== 11 && version !== 12) return false;
  // Stored plans leave out an `execution_plan` identical to their top level
  // (see `storedPlan`); one that is present must still be a valid schema 8 plan.
  if (version >= 9 && (!plan.operating_scope?.modes || (plan.execution_plan !== undefined
    && (plan.execution_plan?.schema_version !== 8 || !isOptimisationPlan(plan.execution_plan))))) return false;
  return plan.mode === 'live'
    && plan.slot_minutes === 15
    && typeof plan.issued_at === 'string'
    && typeof plan.valid_until === 'string'
    && typeof plan.binding_until === 'string'
    && Boolean(plan.plans?.baseline)
    && Boolean(plan.plans?.priority)
    && Boolean(plan.plans?.cost)
    && Array.isArray(plan.plans?.baseline?.slots);
}
