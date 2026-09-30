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
// browser can hand the real planner a copy with one curve
// swapped and read the answer. A prettier approximation living in the portal
// would be free to disagree with the thing it claims to predict, which is the
// failure §3.1.1 records in the load model.

import {
  dispatchWorkbench,
  validateSnapshot,
  type OptimisationSnapshot,
  type OptimisationPlan,
} from '../../../supabase/functions/_shared/planner/energy-optimisation';
import { scoreDispatch } from '../../../supabase/functions/_shared/planner/dispatch-plan';
import type { UtilityCurve } from '../../../supabase/functions/_shared/planner/store-value';
import type { ValueStoreKey } from '../../../supabase/functions/_shared/planner/value-curves';

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
  batteryCurve?: UtilityCurve;
  publishedUntil: string;
}

/**
 * Re-solve only published-price quarters with these curves in place.
 * Forecast padding cannot affect either candidate dispatch or its comparison.
 *
 * Keep the comparison time anchored to the stored snapshot, so opening an
 * older plan does not silently advance or shorten its published-price window.
 * A server-selected curve supplies its frozen comparison time instead.
 */
export function solveWith(
  snapshot: OptimisationSnapshot,
  curves: Partial<Record<ValueStoreKey, UtilityCurve>>,
  priceOutlook?: OptimisationPlan['price_outlook'],
  comparisonNow?: Date,
): PlanOutcome | string {
  try {
    const input: OptimisationSnapshot = { ...snapshot, value_curves: curves,
      ...(curves.battery ? { battery_curve_mode: 'custom', battery_cost_curve: undefined } : {}),
    };
    const errors = validateSnapshot(input);
    if (errors.length) return errors.join('; ');
    const workbench = dispatchWorkbench(input, [], priceOutlook,
      comparisonNow ?? new Date(Date.parse(snapshot.captured_at) + 60_000), 'published');
    if (!workbench) return 'No measured stores are available for comparison';
    const score = scoreDispatch(workbench.slots, workbench.stores, workbench.limits, workbench.planned);
    return {
      gridImportKwh: score.grid_import_kwh,
      gridExportKwh: score.grid_export_kwh,
      netCostSek: score.billable_quoted_sek,
      batteryCurve: workbench.stores.find(store => store.key === 'battery')?.curve,
      publishedUntil: new Date(workbench.slot_start_ms.at(-1)! + 900_000).toISOString(),
      stores: score.stores.map(entry => ({
        key: entry.key,
        unit: entry.state_unit,
        plannedKwh: entry.charged_kwh,
        runHours: workbench.planned.power_w[entry.key].reduce((hours, watts, i) =>
          hours + (watts > 0 ? workbench.slots[i].duration_hours ?? 0.25 : 0), 0),
        endState: entry.end_state,
        reason: entry.charged_kwh > 0 ? 'scheduled' : 'not_scheduled',
      })),
    };
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
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

/** Compare preferences against the same snapshot and published-price window. */
export function comparePreference(
  snapshot: OptimisationSnapshot,
  current: Partial<Record<ValueStoreKey, UtilityCurve>>,
  edited: Partial<Record<ValueStoreKey, UtilityCurve>>,
  priceOutlook?: OptimisationPlan['price_outlook'],
  comparisonNow?: Date,
): PreviewComparison | string {
  const before = solveWith(snapshot, current, priceOutlook, comparisonNow);
  if (typeof before === 'string') return before;
  const after = solveWith(snapshot, edited, priceOutlook, comparisonNow);
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
