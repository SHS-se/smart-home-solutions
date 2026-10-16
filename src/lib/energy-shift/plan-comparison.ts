import type { GeneratedPlan } from './contracts';
import type { BaselinePlan } from '../../../supabase/functions/_shared/planner/planning-contracts';

export interface PlanComparison {
  loadKwhDelta: number;
  gridImportKwhDelta: number;
  gridExportKwhDelta: number;
  evChargeKwhDelta: number | null;
  netCostSekDelta: number | null;
  terminalAdjustedCostSekDelta: number | null;
}

/**
 * Compare the executable plan with the no-plan baseline. Every delta follows
 * the same sign convention: with plan minus without plan.
 */
export function comparePlans(
  withPlan: GeneratedPlan,
  withoutPlan: BaselinePlan,
): PlanComparison | null {
  if (withPlan.status !== 'ready' || withoutPlan.status !== 'ready' || withoutPlan.summary === null) return null;
  const evEnergy = (plan: Pick<GeneratedPlan, 'slots'>) => plan.slots.reduce((sum, slot) => sum + slot.ev_w * slot.duration_hours! / 1000, 0);
  const evDelta = evEnergy(withPlan) - evEnergy(withoutPlan);
  // Different delivered charging is a real forecast difference, not a saving.
  // Keep energy deltas, but do not impute the missing energy's price or delivery.
  const equalEvEnergy = Number.isFinite(evDelta) && Math.abs(evDelta) <= 1e-7;
  return {
    loadKwhDelta: withPlan.summary.load_kwh - withoutPlan.summary.load_kwh,
    gridImportKwhDelta:
      withPlan.summary.grid_import_kwh - withoutPlan.summary.grid_import_kwh,
    gridExportKwhDelta:
      withPlan.summary.grid_export_kwh - withoutPlan.summary.grid_export_kwh,
    evChargeKwhDelta: Number.isFinite(evDelta) ? evDelta : null,
    netCostSekDelta: equalEvEnergy ?
      withPlan.summary.net_cost_sek - withoutPlan.summary.net_cost_sek : null,
    terminalAdjustedCostSekDelta: equalEvEnergy ?
      withPlan.summary.terminal_adjusted_cost_sek -
      withoutPlan.summary.terminal_adjusted_cost_sek : null,
  };
}

export function formatSigned(value: number, digits: number): string {
  const rounded = Number(value.toFixed(digits));
  if (Object.is(rounded, -0) || rounded === 0) return (0).toFixed(digits);
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded).toFixed(digits)}`;
}
