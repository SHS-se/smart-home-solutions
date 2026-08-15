// Slicing the 72-hour plan into the day the reader is actually looking at.
//
// The header numbers used to describe the whole horizon while the chart below
// them showed one day, so the two disagreed and neither could be checked
// against the other. Every figure here is recomputed from the slots in view,
// using the same arithmetic the planner uses for its own summary
// (ENERGY_OPTIMISATION_ARCHITECTURE.md §5.4): a quarter of average watts is
// that many watt-hours over four, and only binding slots carry a price.

import type { PlannedSlot } from './contracts';

/** A single day of the horizon, or the whole thing. */
export type PlanWindow = 1 | 2 | 3 | 'all';

export const PLAN_WINDOW_OPTIONS: PlanWindow[] = [1, 2, 3, 'all'];
export const SLOTS_PER_DAY = 96;

/** Watts averaged over one quarter, expressed as kWh. */
const QUARTER_W_TO_KWH = 4_000;

/** Below this a device is off; recorder noise should not light up a legend. */
const ACTIVE_POWER_W = 0.5;

export interface PlanWindowRange {
  from: number;
  /** Exclusive. */
  to: number;
}

/**
 * Day 1 is the first 24 hours of the horizon, not the first calendar day: the
 * plan is issued at whatever time Home Assistant last pushed, so a calendar
 * split would open with a stub of a few hours.
 */
export const planWindowRange = (
  slotCount: number,
  window: PlanWindow,
): PlanWindowRange => {
  if (window === 'all') return { from: 0, to: slotCount };
  const from = Math.min((window - 1) * SLOTS_PER_DAY, slotCount);
  return { from, to: Math.min(from + SLOTS_PER_DAY, slotCount) };
};

/** Which of Day 1/2/3 the horizon is long enough to offer. */
export const availablePlanWindows = (slotCount: number): PlanWindow[] =>
  PLAN_WINDOW_OPTIONS.filter(
    window => window === 'all' || (window - 1) * SLOTS_PER_DAY < slotCount,
  );

export interface WindowedPlanSummary {
  slotCount: number;
  loadKwh: number;
  flexibleKwh: number;
  pvKwh: number;
  gridImportKwh: number;
  pricedImportKwh: number;
  gridExportKwh: number;
  pricedExportKwh: number;
  netCostSek: number;
  batterySocStart: number | null;
  batterySocEnd: number | null;
  /** SOC at the first local midnight in view, with the day it belongs to. */
  batterySocAtMidnight: number | null;
  midnightStart: string | null;
}

const kwh = (watts: number) => watts / QUARTER_W_TO_KWH;

const isLocalMidnight = (start: string) => {
  const moment = new Date(start);
  return moment.getHours() === 0 && moment.getMinutes() === 0;
};

export const summarisePlanWindow = (
  slots: readonly PlannedSlot[],
  range: PlanWindowRange,
): WindowedPlanSummary => {
  const view = slots.slice(range.from, range.to);
  const summary: WindowedPlanSummary = {
    slotCount: view.length,
    loadKwh: 0,
    flexibleKwh: 0,
    pvKwh: 0,
    gridImportKwh: 0,
    pricedImportKwh: 0,
    gridExportKwh: 0,
    pricedExportKwh: 0,
    netCostSek: 0,
    batterySocStart: view.length > 0 ? view[0].battery_soc : null,
    batterySocEnd: view.length > 0 ? view[view.length - 1].battery_soc : null,
    batterySocAtMidnight: null,
    midnightStart: null,
  };

  for (const slot of view) {
    const roomHeatingW = Object.values(slot.room_heating_w ?? {}).reduce(
      (total, watts) => total + watts,
      0,
    );
    summary.loadKwh += kwh(slot.load_w);
    summary.flexibleKwh += kwh(
      slot.pool_w + slot.boiler_expected_w + slot.ev_w + roomHeatingW,
    );
    summary.pvKwh += kwh(slot.pv_w);
    summary.gridImportKwh += kwh(slot.grid_import_w);
    summary.gridExportKwh += kwh(slot.grid_export_w);
    // Unpriced slots are past the published horizon. They still move energy,
    // so they count as kWh but must not be added into a cost.
    if (slot.binding) {
      summary.pricedImportKwh += kwh(slot.grid_import_w);
      summary.pricedExportKwh += kwh(slot.grid_export_w);
      summary.netCostSek += (slot.import_cost_sek ?? 0) -
        (slot.export_revenue_sek ?? 0);
    }
    if (summary.midnightStart === null && isLocalMidnight(slot.start)) {
      summary.midnightStart = slot.start;
      summary.batterySocAtMidnight = slot.battery_soc;
    }
  }
  return summary;
};

/**
 * Device keys the plan actually runs somewhere in view. A house with eighteen
 * mapped devices puts eighteen entries in the legend, most of them flat at
 * zero, which buries the few series that carry the plan.
 */
export const scheduledDeviceKeys = (
  slots: readonly PlannedSlot[],
  range: PlanWindowRange,
): Set<string> => {
  const scheduled = new Set<string>();
  for (const slot of slots.slice(range.from, range.to)) {
    for (const [key, watts] of Object.entries(slot.device_loads_w ?? {})) {
      if (watts > ACTIVE_POWER_W) scheduled.add(key);
    }
  }
  return scheduled;
};

/** Whether an aggregate service series carries any load in view. */
export const isServiceScheduled = (
  slots: readonly PlannedSlot[],
  range: PlanWindowRange,
  read: (slot: PlannedSlot) => number,
): boolean => slots.slice(range.from, range.to)
  .some(slot => read(slot) > ACTIVE_POWER_W);
