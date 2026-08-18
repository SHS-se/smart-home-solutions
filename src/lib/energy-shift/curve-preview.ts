// What changes if you move a threshold.
//
// A household cannot tune a utility curve by reading it, and should not have to
// (ENERGY_OPTIMISATION_ARCHITECTURE.md §8.10). What they can judge is a
// consequence: four more hours of pool heating, eleven more kWh, twelve more
// kronor, and a pool that ends Wednesday at 29.4 °C instead of 27.1. So the
// editor states the change rather than the parameter.
//
// The re-solve runs **the planner itself**, not a second model of it. The
// snapshot every plan was built from is persisted alongside the plan, so the
// browser can hand the real `generateOptimisationPlan` a copy with one curve
// swapped and read the answer. A prettier approximation living in the portal
// would be free to disagree with the thing it claims to predict, which is the
// failure §3.1.1 records in the load model.

import {
  generateOptimisationPlan,
  type OptimisationSnapshotV5,
} from '../../../supabase/functions/_shared/energy-optimisation';
import type { UtilityCurve } from '../../../supabase/functions/_shared/store-value';
import type { ValueStoreKey } from '../../../supabase/functions/_shared/value-curves';

export interface StoreOutcome {
  key: string;
  unit: string;
  plannedKwh: number;
  /** Hours the store is actually commanded on, which is what a person sees. */
  runHours: number;
  endState: number | null;
  reason: string;
}

export interface PlanOutcome {
  gridImportKwh: number;
  gridExportKwh: number;
  netCostSek: number;
  stores: StoreOutcome[];
}

/** Which per-slot power column belongs to each store. */
const POWER_FIELD: Record<string, 'pool_w' | 'ev_w' | 'battery_charge_w'> = {
  pool: 'pool_w',
  ev: 'ev_w',
  battery: 'battery_charge_w',
};

/**
 * Re-solve the persisted snapshot with these curves in place.
 *
 * `now` is taken from the snapshot rather than the wall clock: the planner
 * refuses a snapshot older than fifteen minutes, and a preview is by nature
 * being run against one that has been sitting in a table.
 */
export function solveWith(
  snapshot: OptimisationSnapshotV5,
  curves: Partial<Record<ValueStoreKey, UtilityCurve>>,
): PlanOutcome | string {
  let plan;
  try {
    plan = generateOptimisationPlan(
      { ...snapshot, value_curves: curves },
      new Date(Date.parse(snapshot.captured_at) + 60_000),
    );
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const executed = plan.plans.priority;
  const slotHours = 0.25;
  return {
    gridImportKwh: executed.summary.grid_import_kwh,
    gridExportKwh: executed.summary.grid_export_kwh,
    netCostSek: executed.summary.net_cost_sek,
    stores: executed.store_diagnostics.map(entry => {
      const field = POWER_FIELD[entry.key];
      const runHours = field
        ? executed.slots.filter(slot => (slot[field] ?? 0) > 0).length * slotHours
        : 0;
      return {
        key: entry.key,
        unit: entry.unit,
        plannedKwh: entry.planned_kwh,
        runHours,
        endState: entry.end_state,
        reason: entry.reason,
      };
    }),
  };
}

export interface OutcomeDelta {
  key: string;
  unit: string;
  runHoursBefore: number;
  runHoursAfter: number;
  kwhBefore: number;
  kwhAfter: number;
  endStateBefore: number | null;
  endStateAfter: number | null;
}

export interface PreviewComparison {
  before: PlanOutcome;
  after: PlanOutcome;
  stores: OutcomeDelta[];
  importDeltaKwh: number;
  exportDeltaKwh: number;
  costDeltaSek: number;
}

/**
 * Both sides are solved locally, never compared against the stored plan.
 *
 * The stored plan was built with a measured price shape the portal does not
 * hold, so it would differ from a local solve for reasons that have nothing to
 * do with the edit. Solving both sides here makes the difference attributable
 * to the one thing that changed.
 */
export function comparePreference(
  snapshot: OptimisationSnapshotV5,
  current: Partial<Record<ValueStoreKey, UtilityCurve>>,
  edited: Partial<Record<ValueStoreKey, UtilityCurve>>,
): PreviewComparison | string {
  const before = solveWith(snapshot, current);
  if (typeof before === 'string') return before;
  const after = solveWith(snapshot, edited);
  if (typeof after === 'string') return after;

  const keys = [...new Set([...before.stores, ...after.stores].map(store => store.key))];
  const find = (outcome: PlanOutcome, key: string) =>
    outcome.stores.find(store => store.key === key);
  return {
    before,
    after,
    stores: keys.map(key => {
      const left = find(before, key);
      const right = find(after, key);
      return {
        key,
        unit: right?.unit ?? left?.unit ?? '',
        runHoursBefore: left?.runHours ?? 0,
        runHoursAfter: right?.runHours ?? 0,
        kwhBefore: left?.plannedKwh ?? 0,
        kwhAfter: right?.plannedKwh ?? 0,
        endStateBefore: left?.endState ?? null,
        endStateAfter: right?.endState ?? null,
      };
    }),
    importDeltaKwh: after.gridImportKwh - before.gridImportKwh,
    exportDeltaKwh: after.gridExportKwh - before.gridExportKwh,
    costDeltaSek: after.netCostSek - before.netCostSek,
  };
}
