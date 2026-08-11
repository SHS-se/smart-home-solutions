import type { GeneratedPlan } from './contracts';

export interface PlanComparison {
  loadKwhDelta: number;
  gridImportKwhDelta: number;
  gridExportKwhDelta: number;
  netCostSekDelta: number;
  terminalAdjustedCostSekDelta: number;
}

/**
 * Compare the executable plan with the no-plan baseline. Every delta follows
 * the same sign convention: with plan minus without plan.
 */
export function comparePlans(
  withPlan: GeneratedPlan,
  withoutPlan: GeneratedPlan,
): PlanComparison {
  return {
    loadKwhDelta: withPlan.summary.load_kwh - withoutPlan.summary.load_kwh,
    gridImportKwhDelta:
      withPlan.summary.grid_import_kwh - withoutPlan.summary.grid_import_kwh,
    gridExportKwhDelta:
      withPlan.summary.grid_export_kwh - withoutPlan.summary.grid_export_kwh,
    netCostSekDelta:
      withPlan.summary.net_cost_sek - withoutPlan.summary.net_cost_sek,
    terminalAdjustedCostSekDelta:
      withPlan.summary.terminal_adjusted_cost_sek -
      withoutPlan.summary.terminal_adjusted_cost_sek,
  };
}

export function formatSigned(value: number, digits: number): string {
  const rounded = Number(value.toFixed(digits));
  if (Object.is(rounded, -0) || rounded === 0) return (0).toFixed(digits);
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded).toFixed(digits)}`;
}
