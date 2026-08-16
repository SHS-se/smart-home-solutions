// One continuous timeline: what the house did, and what it is about to do.
//
// Measured history and the forward plan used to live on separate tabs with
// separate charts and separate windows, so "today" existed in neither. They are
// the same quantities on the same 15-minute grid — the only difference is which
// side of now they fall on. Joining them means a day can be read as a day.
//
// Windows are calendar days in the reader's own timezone, midnight to midnight.
// The rolling 72-hour horizon made every total describe a slightly different
// slice of wall-clock time, which is what made the numbers look wrong.

import type { ActualEnergySlot, PlannedSlot } from './contracts';

/** Days either side of today, or the whole span. */
export type DayWindow = -2 | -1 | 0 | 1 | 2 | 'all';

export const DAY_WINDOW_OPTIONS: DayWindow[] = [-2, -1, 0, 1, 2, 'all'];

export const SLOT_MS = 15 * 60_000;

/** A quarter of average watts is that many watt-hours over four. */
const QUARTER_W_TO_KWH = 4_000;

/** Below this a device is off; recorder noise should not light up a legend. */
const ACTIVE_POWER_W = 0.5;

export interface TimelineRow {
  startMs: number;
  start: string;
  /** True for a measured quarter, false for a planned one. */
  measured: boolean;
  solarW: number | null;
  /** Whole-house consumption. */
  loadW: number | null;
  /** Consumption with the separately charted devices taken out. */
  baseW: number | null;
  gridImportW: number | null;
  /** Negative: energy leaving the house reads as demand when drawn positive. */
  gridExportW: number | null;
  batteryChargeW: number | null;
  /** Fractions, and only ever known on the planned side. */
  batterySoc: number | null;
  evSoc: number | null;
  deviceW: Record<string, number>;
  costSek: number | null;
}

export interface PriceRow {
  start_ts: string;
  import_price_sek_per_kwh: number | null;
  export_price_sek_per_kwh: number | null;
}

export interface DeviceSlotRow {
  start_ts: string;
  device_energy_kwh: Record<string, number>;
}

export interface TimelineInput {
  actuals: readonly ActualEnergySlot[];
  deviceActuals: readonly DeviceSlotRow[];
  prices: readonly PriceRow[];
  planSlots: readonly PlannedSlot[];
  /**
   * Measured device energy is keyed by the portal's device row id; the plan
   * keys the same devices by their Home Assistant statistic. One series per
   * device needs them reconciled onto the plan's key.
   */
  deviceKeyById: ReadonlyMap<string, string>;
  nowMs: number;
}

const quarterFloor = (ms: number) => Math.floor(ms / SLOT_MS) * SLOT_MS;

const watts = (kwh: number | null | undefined) =>
  kwh === null || kwh === undefined ? null : kwh * QUARTER_W_TO_KWH;

/**
 * Local midnight-to-midnight bounds for a day relative to today. Built from
 * calendar fields rather than millisecond arithmetic so a DST change keeps the
 * day a day.
 */
export const dayBounds = (nowMs: number, offset: number): { startMs: number; endMs: number } => {
  const start = new Date(nowMs);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + offset);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { startMs: start.getTime(), endMs: end.getTime() };
};

export const buildEnergyTimeline = ({
  actuals,
  deviceActuals,
  prices,
  planSlots,
  deviceKeyById,
  nowMs,
}: TimelineInput): TimelineRow[] => {
  const boundary = quarterFloor(nowMs);
  const priceByStart = new Map(prices.map(price => [quarterFloor(Date.parse(price.start_ts)), price]));
  const deviceByStart = new Map(
    deviceActuals.map(slot => [quarterFloor(Date.parse(slot.start_ts)), slot.device_energy_kwh]),
  );
  const rows = new Map<number, TimelineRow>();

  for (const slot of actuals) {
    const startMs = quarterFloor(Date.parse(slot.start_ts));
    if (!Number.isFinite(startMs) || startMs >= boundary) continue;
    const measuredDevices = deviceByStart.get(startMs) ?? {};
    const deviceW: Record<string, number> = {};
    let chartedW = 0;
    for (const [id, kwh] of Object.entries(measuredDevices)) {
      const key = deviceKeyById.get(id);
      if (key === undefined) continue;
      const value = kwh * QUARTER_W_TO_KWH;
      deviceW[key] = (deviceW[key] ?? 0) + value;
      chartedW += value;
    }
    const loadW = watts(slot.total_load_kwh);
    const price = priceByStart.get(startMs);
    const importCost = price?.import_price_sek_per_kwh == null || slot.grid_import_kwh == null
      ? null
      : slot.grid_import_kwh * price.import_price_sek_per_kwh;
    const exportCredit = price?.export_price_sek_per_kwh == null || slot.grid_export_kwh == null
      ? null
      : slot.grid_export_kwh * price.export_price_sek_per_kwh;
    rows.set(startMs, {
      startMs,
      start: new Date(startMs).toISOString(),
      measured: true,
      solarW: watts(slot.solar_production_kwh),
      loadW,
      baseW: loadW === null ? null : Math.max(0, loadW - chartedW),
      gridImportW: watts(slot.grid_import_kwh),
      gridExportW: slot.grid_export_kwh == null ? null : -slot.grid_export_kwh * QUARTER_W_TO_KWH,
      batteryChargeW: slot.battery_charge_kwh == null
        ? null
        : -slot.battery_charge_kwh * QUARTER_W_TO_KWH,
      // History carries no state of charge. Inventing one would make the line
      // look continuous across a boundary it does not cross.
      batterySoc: null,
      evSoc: null,
      deviceW,
      costSek: importCost === null && exportCredit === null
        ? null
        : (importCost ?? 0) - (exportCredit ?? 0),
    });
  }

  for (const slot of planSlots) {
    const startMs = quarterFloor(Date.parse(slot.start));
    if (!Number.isFinite(startMs) || startMs < boundary || rows.has(startMs)) continue;
    rows.set(startMs, {
      startMs,
      start: new Date(startMs).toISOString(),
      measured: false,
      solarW: slot.pv_w,
      loadW: slot.load_w,
      baseW: slot.base_w,
      gridImportW: slot.grid_import_w,
      gridExportW: -slot.grid_export_w,
      batteryChargeW: -slot.battery_charge_w,
      batterySoc: slot.battery_soc,
      evSoc: slot.ev_soc,
      deviceW: { ...slot.device_loads_w },
      costSek: slot.binding
        ? (slot.import_cost_sek ?? 0) - (slot.export_revenue_sek ?? 0)
        : null,
    });
  }

  return [...rows.values()].sort((left, right) => left.startMs - right.startMs);
};

export interface TimelineRange {
  from: number;
  /** Exclusive. */
  to: number;
}

export const dayWindowRange = (
  rows: readonly TimelineRow[],
  window: DayWindow,
  nowMs: number,
): TimelineRange => {
  if (window === 'all') return { from: 0, to: rows.length };
  const { startMs, endMs } = dayBounds(nowMs, window);
  let from = rows.length;
  let to = 0;
  for (const [index, row] of rows.entries()) {
    if (row.startMs >= startMs && row.startMs < endMs) {
      from = Math.min(from, index);
      to = Math.max(to, index + 1);
    }
  }
  return from > to ? { from: 0, to: 0 } : { from, to };
};

/** Windows the loaded data can actually fill. */
export const availableDayWindows = (
  rows: readonly TimelineRow[],
  nowMs: number,
): DayWindow[] => DAY_WINDOW_OPTIONS.filter(window => {
  if (window === 'all') return rows.length > 0;
  const range = dayWindowRange(rows, window, nowMs);
  return range.to > range.from;
});

export interface TimelineSummary {
  slotCount: number;
  measuredSlotCount: number;
  plannedSlotCount: number;
  solarKwh: number;
  consumptionKwh: number;
  gridImportKwh: number;
  gridExportKwh: number;
  netCostSek: number;
  /** False when some quarter in view carried no price at all. */
  fullyPriced: boolean;
}

export const summariseTimeline = (
  rows: readonly TimelineRow[],
  range: TimelineRange,
): TimelineSummary => {
  const summary: TimelineSummary = {
    slotCount: 0,
    measuredSlotCount: 0,
    plannedSlotCount: 0,
    solarKwh: 0,
    consumptionKwh: 0,
    gridImportKwh: 0,
    gridExportKwh: 0,
    netCostSek: 0,
    fullyPriced: true,
  };
  for (const row of rows.slice(range.from, range.to)) {
    summary.slotCount += 1;
    if (row.measured) summary.measuredSlotCount += 1;
    else summary.plannedSlotCount += 1;
    summary.solarKwh += (row.solarW ?? 0) / QUARTER_W_TO_KWH;
    summary.consumptionKwh += (row.loadW ?? 0) / QUARTER_W_TO_KWH;
    summary.gridImportKwh += (row.gridImportW ?? 0) / QUARTER_W_TO_KWH;
    // Export is held negative for the chart; a total reads as energy sold.
    summary.gridExportKwh += Math.abs(row.gridExportW ?? 0) / QUARTER_W_TO_KWH;
    if (row.costSek === null) summary.fullyPriced = false;
    else summary.netCostSek += row.costSek;
  }
  return summary;
};

/** Devices carrying load somewhere in view; the rest are legend noise. */
export const activeDeviceKeys = (
  rows: readonly TimelineRow[],
  range: TimelineRange,
): Set<string> => {
  const active = new Set<string>();
  for (const row of rows.slice(range.from, range.to)) {
    for (const [key, value] of Object.entries(row.deviceW)) {
      if (value > ACTIVE_POWER_W) active.add(key);
    }
  }
  return active;
};

/**
 * Index of the first planned row, which is where the divider goes. Returns the
 * row count when everything in view is measured, so a past day draws no line.
 */
export const nowDividerIndex = (
  rows: readonly TimelineRow[],
  range: TimelineRange,
): number => {
  const view = rows.slice(range.from, range.to);
  const index = view.findIndex(row => !row.measured);
  return index < 0 ? view.length : index;
};

/**
 * Quarters that were measured but never priced, over the loaded window.
 *
 * Prices only accumulate forward from the day the integration started sending
 * them, while measured energy goes back months, so a fresh install shows kWh
 * with no cost against exactly the history a planner is judged on. The gap is
 * closed automatically on the next fetch rather than by a button: the fix is
 * always the same, it is never the reader's decision, and the same missing
 * spot day affects every home in that price area.
 */
export const unpricedMeasuredQuarters = (
  actuals: readonly { start_ts: string }[],
  prices: readonly { start_ts: string }[],
): number => {
  const priced = new Set(prices.map(price => quarterFloor(Date.parse(price.start_ts))));
  let missing = 0;
  for (const slot of actuals) {
    const startMs = quarterFloor(Date.parse(slot.start_ts));
    if (Number.isFinite(startMs) && !priced.has(startMs)) missing += 1;
  }
  return missing;
};
