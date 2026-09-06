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
  type DispatchInfeasibility,
  type DispatchSchedule,
  type DispatchScore,
} from '../../../supabase/functions/_shared/dispatch-plan';
import type { DispatchStore } from '../../../supabase/functions/_shared/dispatch-plan';
import { marginalValueHeld } from '../../../supabase/functions/_shared/store-value';
import type { DispatchWorkbench } from '../../../supabase/functions/_shared/energy-optimisation';
import { splitConsumption, type ConsumptionSeries } from './consumption-series';

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

export const storeLabel = (key: string): string =>
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
      label: storeLabel(store.key),
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
      label: `${storeLabel(store.key)} — out`,
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

/**
 * Residual grid flow a hand-typed figure is allowed to be wrong by.
 *
 * The editor's boxes are deliberately coarse — nobody wants to think in watts —
 * so covering a 676 W load is typed as 0.7 kW and leaves 24 W going the other
 * way. That residual is hand-rounding, not a decision: it makes the grid row
 * read as a sale nobody meant to make, and it trips the pack's export contract
 * over a twentieth of a kilowatt-hour. A tenth of a kilowatt is the editor's own
 * resolution, so anything inside it is the typing, and anything outside it is
 * the household actually asking to sell.
 */
const BALANCE_W = 100;

/** Expand the edited columns back into the quarters the planner works in. */
export function scheduleFromDraft(
  workbench: DispatchWorkbench,
  model: WorkbenchModel,
  draft: WorkbenchDraft,
  /** Quarters the household has opened to selling from store. */
  allowExportByColumn: boolean[] = [],
): DispatchSchedule {
  const count = workbench.slots.length;
  const schedule: DispatchSchedule = {
    power_w: {},
    discharge_w: {},
    allow_export: new Array<boolean>(count).fill(false),
  };
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
  model.columns.forEach((column, columnIndex) => {
    for (const slot of column.slots) {
      schedule.allow_export![slot] = allowExportByColumn[columnIndex] === true;
    }
  });

  // A store that may not sell cannot be *asked* to sell.
  //
  // The permit was a validation flag first, and that was the wrong shape: a
  // household could type the pack up past the house load, watch the grid row go
  // negative, and only then be told it was not allowed. The rule belongs on the
  // schedule, not on the report of it — with the switch off, the pack is capped
  // at the load it can cover, and the quarter simply cannot export.
  for (let index = 0; index < count; index += 1) {
    if (schedule.allow_export![index]) continue;
    const gated = workbench.stores.filter(
      store => store.discharge !== undefined && !store.discharge.export_allowed,
    );
    if (gated.length === 0) continue;
    const slot = workbench.slots[index];
    let occupied = 0;
    let freeReturn = 0;
    let gatedReturn = 0;
    for (const store of workbench.stores) {
      occupied += schedule.power_w[store.key]?.[index] ?? 0;
      const out = schedule.discharge_w[store.key]?.[index] ?? 0;
      if (gated.includes(store)) gatedReturn += out;
      else freeReturn += out;
    }
    // What is left of the house's own demand once the sun and any store that
    // *may* sell have had their say.
    const room = Math.max(
      0,
      slot.fixed_load_w + occupied - slot.pv_w - freeReturn,
    );
    if (gatedReturn <= room + 1e-9) continue;
    const scale = room / gatedReturn;
    for (const store of gated) {
      const out = schedule.discharge_w[store.key];
      if (out) out[index] *= scale;
    }
  }

  // Trim a hand-rounded overshoot back onto the load it was meant to cover.
  // Only ever downwards: this removes energy nobody asked to send, and never
  // invents any to make a quarter look tidy.
  for (let index = 0; index < count; index += 1) {
    const slot = workbench.slots[index];
    let occupied = 0;
    let returned = 0;
    for (const store of workbench.stores) {
      occupied += schedule.power_w[store.key]?.[index] ?? 0;
      returned += schedule.discharge_w[store.key]?.[index] ?? 0;
    }
    const net = slot.pv_w + returned - slot.fixed_load_w - occupied;
    if (!(net > 0) || net > BALANCE_W || returned <= 0) continue;
    const scale = Math.max(0, returned - net) / returned;
    for (const store of workbench.stores) {
      const out = schedule.discharge_w[store.key];
      if (out) out[index] *= scale;
    }
  }
  return schedule;
}

/**
 * What another kilowatt-hour is worth to each store, quarter by quarter.
 *
 * The number the whole objective turns on, and the one a reader needs beside
 * the price to see why a quarter went the way it did: the pack charges while
 * this sits above what the energy costs and discharges while it sits below what
 * the grid is charging. Stated per kWh *delivered*, so a curve over kilometres
 * is already through the car's own efficiency and can be read against a price.
 *
 * `marginalValueHeld` rather than `marginalValue`: what is *held* at the top of
 * the curve is still worth the top of it, and the buy-side figure collapsing to
 * zero at full would read as "this energy is worthless" beside a discharge that
 * is being priced at anything but.
 */
export interface StoreValueSeries {
  key: string;
  label: string;
  stateUnit: string;
  sekPerKwh: number[];
}

export function storeValueSeries(
  workbench: DispatchWorkbench,
  score: DispatchScore,
): StoreValueSeries[] {
  return workbench.stores.map(store => ({
    key: store.key,
    label: storeLabel(store.key),
    stateUnit: store.curve.unit,
    sekPerKwh: workbench.slots.map((_slot, index) => {
      const state = score.state[store.key]?.[index] ?? store.initial_state;
      return marginalValueHeld(store.curve, state) *
        store.units_per_kwh(state, index);
    }),
  }));
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
  introduced: DispatchInfeasibility[];
  /** Manual minus planner. Negative means the hand-built plan costs less. */
  totalDeltaSek: number;
  /**
   * The same comparison in money alone, free of the utility curves.
   *
   * The objective's difference and this one answer different questions, and a
   * household that suspects a curve needs the one the curve cannot reach.
   */
  billableDeltaSek: number;
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
  const identity = (entry: DispatchInfeasibility) => `${entry.slot}|${entry.message}`;
  const inherited = new Set(planner.infeasibilities.map(identity));
  return {
    planner,
    manual: scored,
    introduced: scored.infeasibilities.filter(entry => !inherited.has(identity(entry))),
    totalDeltaSek: scored.total_sek - planner.total_sek,
    billableDeltaSek: scored.billable_sek - planner.billable_sek,
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

// ---------------------------------------------------------------------------
// The same chart the plan is read on, drawn from the schedule being edited.
//
// A number says a plan is better; it does not say whether it *looks* right. The
// shapes people actually check — is the car charging under the solar bell, does
// the battery come back up before the evening peak, does the storage curve ever
// flatten against its ceiling — are read off the panels, so an editor without
// them asks for judgement while withholding what judgement is made of.
//
// The row shape is declared here rather than imported from `PlanPanels` so this
// module stays free of anything React: `deno task test` runs `src/lib`, and a
// `.tsx` import would drag JSX into it. Structural typing keeps the two in
// agreement, and `tsc` fails at the call site if they ever drift.
// ---------------------------------------------------------------------------

export interface WorkbenchPanelRow {
  startMs: number;
  label: string;
  measured: boolean;
  solarW: number | null;
  loadW: number | null;
  gridImportW: number | null;
  gridExportW: number | null;
  batteryChargeW: number | null;
  batteryDischargeW: number | null;
  homeSoc: number | null;
  evSoc: number | null;
  importPriceSekPerKwh: number | null;
  exportPriceSekPerKwh: number | null;
  cumulativeCostSek: number;
}

export interface WorkbenchChart {
  rows: WorkbenchPanelRow[];
  series: ConsumptionSeries[];
  baseValues: number[];
  hasBattery: boolean;
  hasEvBattery: boolean;
}

/** State as a percentage of the store's own ceiling, when it declares one. */
const percentOf = (store: DispatchStore, state: number | undefined): number | null => {
  const ceiling = store.max_state;
  if (state === undefined || ceiling === undefined || !(ceiling > 0)) return null;
  return Math.max(0, Math.min(100, (state / ceiling) * 100));
};

/** A contiguous run of quarters, as `[from, to)`. */
export interface SlotRange {
  from: number;
  to: number;
}

export function buildWorkbenchChart(
  bench: DispatchWorkbench,
  schedule: DispatchSchedule,
  score: DispatchScore,
  formatLabel: (startMs: number) => string,
  nameFor: (storeKey: string) => string,
  /** Quarters to draw. Omitted means the whole horizon. */
  range: SlotRange = { from: 0, to: bench.slots.length },
): WorkbenchChart {
  const from = Math.max(0, range.from);
  const to = Math.min(bench.slots.length, range.to);
  // The pack is whichever store can give energy back; the car is the one whose
  // state is a distance. Neither is found by key, so a home that names them
  // differently still charts.
  const battery = bench.stores.find(store => store.discharge !== undefined);
  const vehicle = bench.stores.find(store => store.curve.unit === 'km');

  const houseDemandW: number[] = [];
  const rows: WorkbenchPanelRow[] = [];
  // The running total restarts at the window's own edge, as the plan view's
  // does: a day's cost is what that day cost, not what the horizon had reached
  // by the time it started.
  let running = 0;
  for (let index = from; index < to; index += 1) {
    const slot = bench.slots[index];
    // Charging the pack is a flow, not consumption: the flow panel already
    // draws it as "battery in", and counting it here would draw it twice.
    const demandW = bench.stores.reduce(
      (total, store) => total + (store === battery ? 0 : schedule.power_w[store.key]?.[index] ?? 0),
      slot.fixed_load_w,
    );
    houseDemandW.push(demandW);
    const importKwh = score.import_w[index] / 1_000 * 0.25;
    const exportKwh = score.export_w[index] / 1_000 * 0.25;
    running += importKwh * slot.import_price_sek_per_kwh -
      exportKwh * slot.export_price_sek_per_kwh;
    rows.push({
      startMs: bench.slot_start_ms[index],
      label: formatLabel(bench.slot_start_ms[index]),
      measured: false,
      solarW: slot.pv_w,
      loadW: demandW,
      gridImportW: score.import_w[index],
      gridExportW: score.export_w[index],
      batteryChargeW: battery ? schedule.power_w[battery.key]?.[index] ?? 0 : null,
      batteryDischargeW: battery ? schedule.discharge_w[battery.key]?.[index] ?? 0 : null,
      homeSoc: battery ? percentOf(battery, score.state[battery.key]?.[index]) : null,
      evSoc: vehicle ? percentOf(vehicle, score.state[vehicle.key]?.[index]) : null,
      importPriceSekPerKwh: slot.import_price_sek_per_kwh,
      exportPriceSekPerKwh: slot.export_price_sek_per_kwh,
      cumulativeCostSek: running,
    });
  }

  const split = splitConsumption(
    bench.stores
      .filter(store => store !== battery)
      .map(store => ({
        key: store.key,
        name: nameFor(store.key),
        values: Array.from(
          { length: to - from },
          (_value, offset) => schedule.power_w[store.key]?.[from + offset] ?? 0,
        ),
        schedulable: true,
      })),
    houseDemandW,
  );

  return {
    rows,
    series: split.series,
    baseValues: split.baseValues,
    hasBattery: battery !== undefined,
    hasEvBattery: vehicle !== undefined,
  };
}

// ---------------------------------------------------------------------------
// Handing the whole comparison to somebody who was not sitting here.
//
// A score settles which plan is better; it does not say *why*, and the answer
// to that is in the quarters. So the export carries both schedules, the inputs
// they were solved against, and the snapshot they came from — enough for the
// difference to be reproduced and argued with off this machine, which is the
// point of building a plan by hand in the first place.
// ---------------------------------------------------------------------------

/** One plan's doing in one quarter, with the state and value it implies. */
export interface QuarterSide {
  charge_w: Record<string, number>;
  discharge_w: Record<string, number>;
  grid_w: number;
  /** Each store's state at the start of the quarter, in its curve's unit. */
  state: Record<string, number>;
  /** What another kWh into each store is worth there, SEK/kWh delivered. */
  worth_sek_per_kwh: Record<string, number>;
}

export interface WorkbenchExport {
  format: 'shs.plan-workbench.v1';
  exported_at: string;
  snapshot_id: string;
  captured_at: string;
  slot_minutes: 15;
  limits: DispatchWorkbench['limits'];
  stores: {
    key: string;
    state_unit: string;
    initial_state: number;
    min_state: number | null;
    max_state: number | null;
    max_power_w: number;
    min_power_w: number;
    power_step_w: number;
    min_run_slots: number;
    discharge_max_power_w: number | null;
    export_allowed: boolean | null;
    /**
     * The utility curve the objective priced this store against.
     *
     * Carried because "why is a stored kilowatt-hour worth that" is otherwise
     * unanswerable from the file, and because the curve is *derived* per solve
     * for the battery (§8.4) — two exports of the same home can disagree, and
     * the disagreement is the finding.
     */
    curve: { at: number; sek_per_unit: number }[];
  }[];
  /** One entry per quarter: what it was solved against and what both plans do. */
  quarters: {
    start: string;
    binding: boolean;
    /** Whether the household opened this quarter to selling from store. */
    allow_store_export: boolean;
    pv_w: number;
    fixed_load_w: number;
    import_price_sek_per_kwh: number;
    export_price_sek_per_kwh: number;
    planner: QuarterSide;
    manual: QuarterSide;
  }[];
  scores: {
    planner: Omit<DispatchScore, 'import_w' | 'export_w' | 'state'>;
    manual: Omit<DispatchScore, 'import_w' | 'export_w' | 'state'>;
    total_delta_sek: number;
    import_delta_kwh: number;
    export_delta_kwh: number;
    introduced: DispatchInfeasibility[];
  };
  planner_stopped_because: string;
  planner_iterations: number;
}

/** Import positive, export negative — the sign convention the chart draws. */
export function gridWattsAt(score: DispatchScore, slot: number): number {
  return (score.import_w[slot] ?? 0) - (score.export_w[slot] ?? 0);
}

const withoutSeries = (score: DispatchScore) => {
  const { import_w: _i, export_w: _e, state: _s, ...rest } = score;
  return rest;
};

export function buildWorkbenchExport(
  bench: DispatchWorkbench,
  manual: DispatchSchedule,
  comparison: WorkbenchComparison,
): WorkbenchExport {
  const worth = new Map(
    [
      ['planner', storeValueSeries(bench, comparison.planner)],
      ['manual', storeValueSeries(bench, comparison.manual)],
    ] as const,
  );
  const per = (
    side: 'planner' | 'manual',
    schedule: DispatchSchedule,
    score: DispatchScore,
    slot: number,
  ): QuarterSide => ({
    charge_w: Object.fromEntries(
      bench.stores.map(store => [store.key, schedule.power_w[store.key]?.[slot] ?? 0]),
    ),
    discharge_w: Object.fromEntries(
      bench.stores.map(store => [store.key, schedule.discharge_w[store.key]?.[slot] ?? 0]),
    ),
    grid_w: gridWattsAt(score, slot),
    state: Object.fromEntries(
      bench.stores.map(store => [store.key, score.state[store.key]?.[slot] ?? store.initial_state]),
    ),
    worth_sek_per_kwh: Object.fromEntries(
      worth.get(side)!.map(series => [series.key, series.sekPerKwh[slot] ?? 0]),
    ),
  });

  return {
    format: 'shs.plan-workbench.v1',
    exported_at: new Date().toISOString(),
    snapshot_id: bench.snapshot_id,
    captured_at: bench.captured_at,
    slot_minutes: 15,
    limits: bench.limits,
    stores: bench.stores.map(store => ({
      key: store.key,
      state_unit: store.curve.unit,
      initial_state: store.initial_state,
      min_state: store.min_state ?? null,
      max_state: store.max_state ?? null,
      max_power_w: store.max_power_w,
      min_power_w: store.min_power_w ?? 0,
      power_step_w: store.power_step_w ?? 0,
      min_run_slots: store.min_run_slots ?? 1,
      discharge_max_power_w: store.discharge?.max_power_w ?? null,
      export_allowed: store.discharge?.export_allowed ?? null,
      curve: store.curve.points.map(point => ({ ...point })),
    })),
    quarters: bench.slots.map((slot, index) => ({
      start: new Date(bench.slot_start_ms[index]).toISOString(),
      binding: slot.binding !== false,
      allow_store_export: manual.allow_export?.[index] === true,
      pv_w: slot.pv_w,
      fixed_load_w: slot.fixed_load_w,
      import_price_sek_per_kwh: slot.import_price_sek_per_kwh,
      export_price_sek_per_kwh: slot.export_price_sek_per_kwh,
      planner: per('planner', bench.planned, comparison.planner, index),
      manual: per('manual', manual, comparison.manual, index),
    })),
    scores: {
      planner: withoutSeries(comparison.planner),
      manual: withoutSeries(comparison.manual),
      total_delta_sek: comparison.totalDeltaSek,
      import_delta_kwh: comparison.importDeltaKwh,
      export_delta_kwh: comparison.exportDeltaKwh,
      introduced: comparison.introduced,
    },
    planner_stopped_because: bench.stopped_because,
    planner_iterations: bench.iterations,
  };
}


/**
 * The most a store that may not sell can return in one column.
 *
 * The cap `scheduleFromDraft` enforces, exposed so the editor can apply it to a
 * typed figure straight away: a household that types 2 kW into a quarter with a
 * 0.7 kW load should see 0.7 appear, not discover afterwards that most of what
 * they asked for was quietly dropped. Taken as the *minimum* across the
 * column's quarters, so an hourly figure cannot sell in any one of them.
 */
export function exportFreeCeilingKw(
  workbench: DispatchWorkbench,
  column: WorkbenchColumn,
  schedule: DispatchSchedule,
  storeKey: string,
): number {
  const ceilings = column.slots.map(slot => {
    let occupied = 0;
    let others = 0;
    for (const store of workbench.stores) {
      occupied += schedule.power_w[store.key]?.[slot] ?? 0;
      if (store.key !== storeKey) {
        others += schedule.discharge_w[store.key]?.[slot] ?? 0;
      }
    }
    return Math.max(
      0,
      workbench.slots[slot].fixed_load_w + occupied - workbench.slots[slot].pv_w -
        others,
    );
  });
  return Math.min(...ceilings) / 1_000;
}

/**
 * Stores whose curve asks for a state the hardware will not let them reach.
 *
 * The condition behind "the car never stops being worth charging". A curve's
 * top breakpoint is where the next unit stops being worth buying; if the store
 * cannot get there, that point is unreachable and the store outbids the grid at
 * every hour of every horizon — §8.3's "charging to the limit from the grid is
 * rarely correct" cannot emerge, because the segments that would produce it are
 * beyond the ceiling.
 *
 * Reported as a **fraction of what the store can hold**, never as a level.
 * A vehicle's curve is stated over range, its cap is enforced as state of
 * charge, and the kilometres in an SOC move a long way between January and
 * July — so a level in kilometres is a season wearing a number, while the ratio
 * is the same in both. Multiply it by the charge limit to read it back as SOC:
 * a top at 1.28 against an 80% limit is a curve asking for 102% SOC.
 */
export interface CurveBeyondReach {
  key: string;
  label: string;
  stateUnit: string;
  /** Where the curve stops valuing another unit. */
  topAt: number;
  /** The most the store can hold, from its own hardware limit. */
  reachable: number;
  /** `topAt / reachable`. Above 1 is the defect. */
  ratio: number;
}

export function curvesBeyondReach(
  workbench: DispatchWorkbench,
): CurveBeyondReach[] {
  const found: CurveBeyondReach[] = [];
  for (const store of workbench.stores) {
    const top = store.curve.points.at(-1)?.at;
    const reachable = store.max_state;
    if (top === undefined || reachable === undefined || !(reachable > 0)) continue;
    if (top <= reachable * (1 + 1e-9)) continue;
    found.push({
      key: store.key,
      label: storeLabel(store.key),
      stateUnit: store.curve.unit,
      topAt: top,
      reachable,
      ratio: top / reachable,
    });
  }
  return found;
}
