import type {
  GeneratedPlan,
  DeviceControlType,
  DeviceLoadType,
  DevicePlanningRole,
  EmpiricalDeviceModelInput,
  OptimisationPlan,
  PlanKey,
  PlanSummary,
  PlannedSlot,
} from '../../../supabase/functions/_shared/energy-optimisation';

export type {
  GeneratedPlan,
  DeviceControlType,
  DeviceLoadType,
  DevicePlanningRole,
  EmpiricalDeviceModelInput,
  OptimisationPlan,
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
  control_type: 'switch_schedule' | 'setpoint';
  load_type: 'duty_cycle' | 'inverter';
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
  // Both live schemas are readable. Schema 6 adds pool state to the snapshot
  // and marginal-value dispatch to the plan; every field this reader touches is
  // unchanged, so pinning to one version only breaks the portal on a rollout.
  return (plan.schema_version === 5 || plan.schema_version === 6)
    && plan.mode === 'live'
    && plan.slot_minutes === 15
    && typeof plan.issued_at === 'string'
    && typeof plan.valid_until === 'string'
    && typeof plan.binding_until === 'string'
    && Boolean(plan.plans?.baseline)
    && Boolean(plan.plans?.priority)
    && Boolean(plan.plans?.cost)
    && Array.isArray(plan.plans?.baseline?.slots);
}
