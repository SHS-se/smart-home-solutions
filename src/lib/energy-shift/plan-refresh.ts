import { isOptimisationPlan } from './contracts.ts';
import type { HaRuntimeRow } from './ha-runtime.ts';

/** A readable HA report must survive an unreadable plan payload. */
export function readPlanRefresh<T extends HaRuntimeRow & { plan: unknown }>(row: T | null) {
  const runtime: HaRuntimeRow | null = row ? {
    plan_id: row.plan_id,
    ha_runtime: row.ha_runtime,
    ha_runtime_received_at: row.ha_runtime_received_at,
  } : null;
  const current = row && isOptimisationPlan(row.plan) ? { ...row, plan: row.plan } : null;
  return { current, runtime, unsupported: row !== null && current === null };
}
