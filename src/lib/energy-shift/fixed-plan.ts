import type { WorkbenchDraft, WorkbenchModel } from './plan-workbench';
import { QUARTER_MS } from '../../../supabase/functions/_shared/planner/fixed-energy-plan';

/** Reverting a cell removes it from the modified interval; a day filter does not. */
export function editedPeriodEnd(model: WorkbenchModel | null, draft: WorkbenchDraft, allowExport: boolean[]): number | null {
  if (!model) return null;
  let end: number | null = null;
  model.columns.forEach((column, i) => {
    if (allowExport[i] || Object.entries(draft).some(([key, values]) => Math.abs(values[i] - model.planned[key][i]) > 0.00001)) {
      end = column.startMs + column.slots.length * QUARTER_MS;
    }
  });
  return end;
}

export interface FixedPlanStatus {
  fixed_plan: { id: string; starts_at: string; ends_at: string } | null;
  revision: number;
  generated_revision: number;
  generated_fixed_plan_id: string | null;
  ha_ack_status: string;
  ha_ack_error: unknown;
  valid_until: string;
  error: string | null;
  pending: boolean;
}

export function fixedPlanState(status: FixedPlanStatus, now: number): 'failed' | 'waiting' | 'rejected' | 'expired' | 'scheduled' | 'active' | 'automatic' {
  if (status.error) return 'failed';
  if (status.generated_revision !== status.revision || status.pending) return 'waiting';
  if (status.ha_ack_status === 'rejected') return 'rejected';
  if (Date.parse(status.valid_until) <= now) return 'expired';
  if (status.ha_ack_status !== 'accepted') return 'waiting';
  if (!status.generated_fixed_plan_id) return 'automatic';
  if (!status.fixed_plan || status.fixed_plan.id !== status.generated_fixed_plan_id || Date.parse(status.fixed_plan.ends_at) <= now) return 'waiting';
  return Date.parse(status.fixed_plan.starts_at) > now ? 'scheduled' : 'active';
}
