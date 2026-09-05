// Answering the planner back.
//
// ENERGY_OPTIMISATION_ARCHITECTURE.md §8.12 asks whether the operating
// heuristics *emerge* from the objective. When a plan looks wrong, that
// question has two possible answers needing opposite fixes: the search failed
// to find the best schedule the objective allows, or the objective prefers the
// wrong schedule. The planner's own output cannot separate them, because it is
// the only schedule ever scored.
//
// So this builds an editable copy of the auction's schedule, expands what a
// person types back into the quarters the planner works in, and scores both
// sides with `scoreDispatch` — the same function `planDispatch` selects on. A
// hand-built plan that scores better proves the search left money on the table.
// One that scores worse while still reading better to the household indicts a
// utility curve instead. Either way the answer is a number.

import {
  scoreDispatch,
  type DispatchSchedule,
  type DispatchScore,
} from '../../../supabase/functions/_shared/dispatch-plan';
import type { DispatchWorkbench } from '../../../supabase/functions/_shared/energy-optimisation';

/** Quarters per editable column at each granularity. */
export const GRANULARITY_SLOTS = { hour: 4, quarter: 1 } as const;
export type Granularity = keyof typeof GRANULARITY_SLOTS;

export interface WorkbenchRow {
  /** `${store}:${direction}`, the key every edited column is stored under. */
  id: string;
  storeKey: string;
  direction: 'charge' | 'discharge';
  label: string;
  minKw: number;
  maxKw: number;
  /** Executable increment, 0 when the device is continuously variable. */
  stepKw: number;
  /** Quarters a run must last once started. Compressor protection, not taste. */
  minRunSlots: number;
  stateUnit: string;
}

export interface WorkbenchColumn {
  startMs: number;
  slots: number[];
  importSekPerKwh: number;
  exportSekPerKwh: number;
  solarKw: number;
  fixedLoadKw: number;
  /** False for quarters the plan treats as indicative rather than committed. */
  binding: boolean;
}

/** kW per row per column. The single thing the editor mutates. */
export type WorkbenchDraft = Record<string, number[]>;

export interface WorkbenchModel {
  rows: WorkbenchRow[];
  columns: WorkbenchColumn[];
  granularity: Granularity;
  /**
   * The planner's schedule averaged into these columns.
   *
   * Averaged, not sampled: a quarter at 11 kW inside an otherwise idle hour
   * becomes 2.75 kW across that hour, which carries the same energy in a
   * different shape. That is a real edit, not a rounding artefact, which is why
   * the planner is always scored on `workbench.planned` — its true quarters —
   * and never on this. Loading the editor and changing nothing therefore still
   * asks a genuine question: is the smooth version of this plan worth more?
   */
  planned: WorkbenchDraft;
}

const LABELS: Record<string, string> = {
  battery: 'Home battery',
  ev: 'Car',
  pool: 'Pool',
  boiler: 'Hot water',
};

const labelFor = (key: string): string =>
  LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' ');

export function buildWorkbenchModel(
  workbench: DispatchWorkbench,
  granularity: Granularity,
): WorkbenchModel {
  const width = GRANULARITY_SLOTS[granularity];
  const columns: WorkbenchColumn[] = [];
  for (let start = 0; start < workbench.slots.length; start += width) {
    const slots: number[] = [];
    for (let i = start; i < Math.min(start + width, workbench.slots.length); i += 1) {
      slots.push(i);
    }
    const mean = (pick: (index: number) => number) =>
      slots.reduce((total, index) => total + pick(index), 0) / slots.length;
    columns.push({
      startMs: workbench.slot_start_ms[start],
      slots,
      importSekPerKwh: mean(i => workbench.slots[i].import_price_sek_per_kwh),
      exportSekPerKwh: mean(i => workbench.slots[i].export_price_sek_per_kwh),
      solarKw: mean(i => workbench.slots[i].pv_w) / 1_000,
      fixedLoadKw: mean(i => workbench.slots[i].fixed_load_w) / 1_000,
      binding: slots.every(i => workbench.slots[i].binding !== false),
    });
  }

  const rows: WorkbenchRow[] = [];
  const planned: WorkbenchDraft = {};
  for (const store of workbench.stores) {
    const charge: WorkbenchRow = {
      id: `${store.key}:charge`,
      storeKey: store.key,
      direction: 'charge',
      label: labelFor(store.key),
      minKw: (store.min_power_w ?? 0) / 1_000,
      maxKw: store.max_power_w / 1_000,
      stepKw: (store.power_step_w ?? 0) / 1_000,
      minRunSlots: store.min_run_slots ?? 1,
      stateUnit: store.curve.unit,
    };
    rows.push(charge);
    planned[charge.id] = columns.map(column =>
      column.slots.reduce(
        (total, index) => total + (workbench.planned.power_w[store.key]?.[index] ?? 0),
        0,
      ) / column.slots.length / 1_000
    );
    if (!store.discharge) continue;
    const discharge: WorkbenchRow = {
      id: `${store.key}:discharge`,
      storeKey: store.key,
      direction: 'discharge',
      label: `${labelFor(store.key)} — out`,
      minKw: 0,
      maxKw: store.discharge.max_power_w / 1_000,
      stepKw: 0,
      minRunSlots: 1,
      stateUnit: store.curve.unit,
    };
    rows.push(discharge);
    planned[discharge.id] = columns.map(column =>
      column.slots.reduce(
        (total, index) => total + (workbench.planned.discharge_w[store.key]?.[index] ?? 0),
        0,
      ) / column.slots.length / 1_000
    );
  }
  return { rows, columns, granularity, planned };
}


/**
 * What one quarter of an edited column actually draws.
 *
 * A column wider than a quarter states an *average*, and averages are not
 * executable: a pool asked for 0.9 kW across an hour would be commanded below
 * the 3.5 kW its compressor can run at, and the whole hour scores as
 * infeasible. A household editing by the hour means "about this much energy in
 * this hour", so an average under the device's floor becomes a duty cycle at
 * the floor instead — the same trade the planner makes — held for at least the
 * minimum run the hardware declares.
 *
 * At quarter resolution this is the identity, which is why that is the default:
 * loading the editor then reproduces the planner's plan exactly.
 */
function quarterWatts(
  row: WorkbenchRow,
  kw: number,
  width: number,
  offset: number,
): number {
  if (kw <= 0) return 0;
  if (width === 1 || kw + 1e-9 >= row.minKw) {
    return executableKw(row, kw) * 1_000;
  }
  const level = row.minKw;
  const wanted = Math.round((kw / level) * width);
  const held = Math.min(width, Math.max(wanted, row.minRunSlots));
  return offset < held ? level * 1_000 : 0;
}

/** Expand the edited columns back into the quarters the planner works in. */
export function scheduleFromDraft(
  workbench: DispatchWorkbench,
  model: WorkbenchModel,
  draft: WorkbenchDraft,
): DispatchSchedule {
  const count = workbench.slots.length;
  const schedule: DispatchSchedule = { power_w: {}, discharge_w: {} };
  for (const store of workbench.stores) {
    schedule.power_w[store.key] = new Array<number>(count).fill(0);
    schedule.discharge_w[store.key] = new Array<number>(count).fill(0);
  }
  for (const row of model.rows) {
    const values = draft[row.id] ?? model.planned[row.id];
    const target = row.direction === 'charge'
      ? schedule.power_w[row.storeKey]
      : schedule.discharge_w[row.storeKey];
    if (!target) continue;
    model.columns.forEach((column, columnIndex) => {
      const kw = Math.max(0, values?.[columnIndex] ?? 0);
      for (const [offset, slot] of column.slots.entries()) {
        target[slot] = quarterWatts(row, kw, column.slots.length, offset);
      }
    });
  }
  return schedule;
}

export interface WorkbenchComparison {
  planner: DispatchScore;
  manual: DispatchScore;
  /**
   * Rules the hand-built plan breaks that the planner's own plan does not.
   *
   * The editor starts from the planner's schedule, so anything already wrong
   * with that is inherited by every draft. Reporting the raw list would accuse
   * the household of a breach they did not make — and, worse, would keep
   * accusing them of it no matter what they changed. The difference is the part
   * they are answerable for; the planner's own list is shown beside it.
   */
  introduced: string[];
  /** Manual minus planner. Negative means the hand-built plan costs less. */
  totalDeltaSek: number;
  importDeltaKwh: number;
  exportDeltaKwh: number;
}

export function compareWorkbench(
  workbench: DispatchWorkbench,
  manual: DispatchSchedule,
): WorkbenchComparison {
  const planner = scoreDispatch(
    workbench.slots,
    workbench.stores,
    workbench.limits,
    workbench.planned,
  );
  const scored = scoreDispatch(
    workbench.slots,
    workbench.stores,
    workbench.limits,
    manual,
  );
  const inherited = new Set(planner.infeasibilities);
  return {
    planner,
    manual: scored,
    introduced: scored.infeasibilities.filter(entry => !inherited.has(entry)),
    totalDeltaSek: scored.total_sek - planner.total_sek,
    importDeltaKwh: scored.grid_import_kwh - planner.grid_import_kwh,
    exportDeltaKwh: scored.grid_export_kwh - planner.grid_export_kwh,
  };
}

/** Round a typed kW figure onto what the hardware can actually execute. */
export function executableKw(row: WorkbenchRow, kw: number): number {
  if (!(kw > 0)) return 0;
  const capped = Math.min(kw, row.maxKw);
  if (row.stepKw > 0) {
    const steps = Math.round((capped - row.minKw) / row.stepKw);
    const snapped = row.minKw + Math.max(0, steps) * row.stepKw;
    return Math.min(row.maxKw, Math.max(row.minKw, snapped));
  }
  return Math.max(row.minKw, capped);
}
