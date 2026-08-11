import type {
  GeneratedPlan,
  DeviceControlType,
  DeviceLoadType,
  DevicePlanningRole,
  EmpiricalDeviceModelInput,
  OptimisationPlanV5,
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
  OptimisationPlanV5,
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
}

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

export function isOptimisationPlan(value: unknown): value is OptimisationPlanV5 {
  if (!value || typeof value !== 'object') return false;
  const plan = value as Partial<OptimisationPlanV5>;
  return plan.schema_version === 5
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
