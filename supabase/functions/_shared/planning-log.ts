import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.57.2';
import { actionablePlanningWarnings, type PlanningWarning } from './planner/planning-warnings.ts';

export interface PlanningActivity {
  receipt_id: string;
  source: 'home_assistant' | 'planner';
  counts?: Record<string, number>;
  warnings?: readonly PlanningWarning[];
}

/** Diagnostic recording cannot withhold a receipt or interrupt plan execution. */
export async function recordPlanningActivity(db: SupabaseClient, homeId: string, customerId: string,
  activity: PlanningActivity): Promise<void> {
  const warnings = (activity.warnings ?? []).filter(warning => warning.severity === 'error' || actionablePlanningWarnings([warning]).length > 0);
  if (!Object.values(activity.counts ?? {}).some(count => count > 0) && !warnings.length) return;
  try {
    const { error } = await db.rpc('record_energy_planning_activity', {
      p_home_id: homeId, p_customer_id: customerId, p_activity: { ...activity, warnings },
    });
    if (error) throw error;
  } catch (error) {
    console.error('[PLANNING-LOG] recording failed', {home_id: homeId, receipt_id: activity.receipt_id, error});
  }
}
