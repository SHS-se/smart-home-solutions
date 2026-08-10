import type {
  GeneratedPlan,
  OptimisationPlanV1,
  PlanKey,
  PlannedSlot,
} from '../../../supabase/functions/_shared/energy-optimisation';

export type { GeneratedPlan, OptimisationPlanV1, PlanKey, PlannedSlot };

export interface ActualEnergySlot {
  start_ts: string;
  total_load_kwh: number | null;
  solar_production_kwh: number | null;
  grid_import_kwh: number | null;
  grid_export_kwh: number | null;
  battery_charge_kwh: number | null;
  battery_discharge_kwh: number | null;
}

export function isOptimisationPlan(value: unknown): value is OptimisationPlanV1 {
  if (!value || typeof value !== 'object') return false;
  const plan = value as Partial<OptimisationPlanV1>;
  return plan.schema_version === 1
    && plan.slot_minutes === 15
    && typeof plan.issued_at === 'string'
    && typeof plan.valid_until === 'string'
    && typeof plan.binding_until === 'string'
    && Boolean(plan.plans?.baseline)
    && Boolean(plan.plans?.priority)
    && Boolean(plan.plans?.cost)
    && Array.isArray(plan.plans?.baseline?.slots);
}
