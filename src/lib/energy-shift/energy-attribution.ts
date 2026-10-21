// Where each device's energy came from, and what the grid share of it cost.
//
// ENERGY_OPTIMISATION_ARCHITECTURE.md §1.3.7.4. Only grid energy costs money;
// solar and battery energy are priced at zero, with panel and cell degradation
// deliberately out of scope. So a per-device cost is not "device kWh × price" —
// it is the device's share of the grid energy that served the load in the same
// quarter, priced at that quarter's all-in marginal import price.
//
// Everything here is pure. The React layer adapts measured slots or plan slots
// into `SupplySlotInput` and renders what comes back.

export interface SupplySlotInput {
  start: string;
  loadKwh: number | null;
  solarKwh: number | null;
  gridImportKwh: number | null;
  gridExportKwh: number | null;
  batteryChargeKwh: number | null;
  batteryDischargeKwh: number | null;
  deviceKwh: Record<string, number>;
  importPriceSekPerKwh: number | null;
  exportPriceSekPerKwh: number | null;
  /**
   * The quarter's energy is not a reading: a planned quarter, or one whose
   * energy was spread over a delayed counter's reporting interval.
   */
  estimated?: boolean;
  /**
   * The planner's value for a quarter with no published price. Used only where
   * `importPriceSekPerKwh` is null, and any cost it prices is estimated.
   */
  shadowImportSekPerKwh?: number | null;
}

/** How one quarter's energy moved between the grid, the panels and the cells. */
export interface SlotSupply {
  gridToLoad: number;
  solarToLoad: number;
  batteryToLoad: number;
  gridToBattery: number;
  solarToBattery: number;
  solarToExport: number;
  batteryToExport: number;
  /** Load the three supply terms account for, after capping at the load. */
  supplyToLoad: number;
  /** Load none of the three sources explain. */
  unexplainedLoadKwh: number;
  /** Source energy the load does not explain, removed from the columns. */
  excessSupplyKwh: number;
}

export type AttributionRowKind = 'device' | 'base_load' | 'battery_charging';

export interface AttributionRow {
  key: string;
  kind: AttributionRowKind;
  name: string;
  gridKwh: number;
  solarKwh: number;
  batteryKwh: number;
  totalKwh: number;
  costSek: number;
  /**
   * The parts of the figures above that are estimates rather than readings
   * and published prices: energy from estimated quarters, load no supply
   * reading covers (credited in its quarter's mix), and cost from either or
   * from quarters priced at the planner's shadow price.
   */
  estimatedGridKwh: number;
  estimatedSolarKwh: number;
  estimatedBatteryKwh: number;
  estimatedCostSek: number;
  /** False once any quarter this row drew in had neither a price nor an estimate of one. */
  fullyPriced: boolean;
}

export interface WindowSummary {
  gridImportKwh: number;
  gridExportKwh: number;
  loadKwh: number;
  solarKwh: number;
  batteryChargeKwh: number;
  batteryDischargeKwh: number;
  importCostSek: number;
  exportCreditSek: number;
  netCostSek: number;
  slotCount: number;
  pricedSlotCount: number;
  /**
   * Load that grid, solar and battery do not account for. Zero whenever
   * `total_load_kwh` was derived from the category balance, which is the normal
   * case; non-zero means a separately metered load disagrees with its
   * categories. The rows carry it as estimated energy; it is also reported
   * here so the disagreement stays findable.
   */
  unexplainedLoadKwh: number;
  /**
   * Source energy the load does not account for, held out of the columns.
   * Curtailed solar reads this way, and so does an under-reporting load meter.
   */
  excessSupplyKwh: number;
}

export interface AttributionResult {
  rows: AttributionRow[];
  summary: WindowSummary;
}

/** The fields of a timeline row (energy-timeline.ts) the attribution reads. */
export interface TimelineSupplyRow {
  start: string;
  /** History side; planned quarters are estimates. */
  measured: boolean;
  estimatedEnergy?: boolean;
  loadW: number | null;
  solarW: number | null;
  gridImportW: number | null;
  /** Negative on the timeline: export is drawn below the axis. */
  gridExportW: number | null;
  /** Negative on the timeline, for the same reason. */
  batteryChargeW: number | null;
  batteryDischargeW: number | null;
  deviceW: Record<string, number>;
  importPriceSekPerKwh: number | null;
  exportPriceSekPerKwh: number | null;
  shadowImportSekPerKwh: number | null;
}

const QUARTER_W_TO_KWH = 4_000;
const quarterKwh = (watts: number | null) =>
  watts === null ? null : Math.abs(watts) / QUARTER_W_TO_KWH;

/**
 * Timeline rows as attribution input, measured and planned alike.
 *
 * Every flow and the real import price pass through untouched. A battery
 * discharge left at zero bills the battery's share of the load to nobody and
 * shows it as unexplained; a price left null prices every device at zero. The
 * planner's shadow price for an unpublished quarter is not a price anyone pays,
 * so it travels separately and whatever it prices is marked estimated.
 */
export const supplySlotsFromTimeline = (
  rows: readonly TimelineSupplyRow[],
): SupplySlotInput[] => rows.map(row => ({
  start: row.start,
  loadKwh: quarterKwh(row.loadW),
  solarKwh: quarterKwh(row.solarW),
  gridImportKwh: quarterKwh(row.gridImportW),
  gridExportKwh: quarterKwh(row.gridExportW),
  batteryChargeKwh: quarterKwh(row.batteryChargeW),
  batteryDischargeKwh: quarterKwh(row.batteryDischargeW),
  deviceKwh: Object.fromEntries(
    Object.entries(row.deviceW).map(([key, value]) => [key, value / QUARTER_W_TO_KWH]),
  ),
  importPriceSekPerKwh: row.importPriceSekPerKwh,
  exportPriceSekPerKwh: row.exportPriceSekPerKwh,
  estimated: !row.measured || row.estimatedEnergy === true,
  shadowImportSekPerKwh: row.shadowImportSekPerKwh,
}));

const positive = (value: number) => (value > 0 ? value : 0);
const measured = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? positive(value) : 0;

/**
 * Split one quarter into where the load's energy came from.
 *
 * Two assumptions about flows no meter separates, both chosen because they are
 * the physically likely behaviour of a self-consumption inverter:
 *
 * - Export is solar before it is battery. A battery only exports when the
 *   planner tells it to, and that surplus is solar-driven anyway.
 * - Battery charging takes surplus solar before it takes grid, so a home
 *   charging in the middle of a sunny day is not billed for it.
 *
 * Every term is clamped at zero. Category meters are independent sensors and
 * can disagree slightly; a negative flow would otherwise turn into a negative
 * cost for a device, which is worse than a small unexplained residual.
 *
 * The supply terms are then capped at the reported load. Without the cap, a
 * quarter where the sources exceed the load — curtailed solar, an under-reading
 * load meter, an unmapped sink — hands every device a share of energy that
 * never reached it, and the solar column silently inflates. Only solar and
 * battery give way: the grid term must survive intact or the grid column stops
 * totalling the metered import, which is the one figure that has to match an
 * invoice.
 */
export function decomposeSlotSupply(slot: SupplySlotInput): SlotSupply {
  const solar = measured(slot.solarKwh);
  const gridImport = measured(slot.gridImportKwh);
  const gridExport = measured(slot.gridExportKwh);
  const batteryCharge = measured(slot.batteryChargeKwh);
  const batteryDischarge = measured(slot.batteryDischargeKwh);

  const solarToExport = Math.min(solar, gridExport);
  const batteryToExport = Math.min(
    positive(gridExport - solarToExport),
    batteryDischarge,
  );
  const solarToBattery = Math.min(positive(solar - solarToExport), batteryCharge);
  const gridToBattery = Math.min(
    positive(batteryCharge - solarToBattery),
    gridImport,
  );
  let solarToLoad = positive(solar - solarToExport - solarToBattery);
  let batteryToLoad = positive(batteryDischarge - batteryToExport);
  const gridToLoad = positive(gridImport - gridToBattery);

  const rawSupply = gridToLoad + solarToLoad + batteryToLoad;
  const reportedLoad = typeof slot.loadKwh === 'number' &&
      Number.isFinite(slot.loadKwh)
    ? positive(slot.loadKwh)
    : rawSupply;
  const excess = positive(rawSupply - reportedLoad);
  const fromSolar = Math.min(excess, solarToLoad);
  solarToLoad -= fromSolar;
  batteryToLoad -= Math.min(excess - fromSolar, batteryToLoad);

  return {
    gridToLoad,
    solarToLoad,
    batteryToLoad,
    gridToBattery,
    solarToBattery,
    solarToExport,
    batteryToExport,
    supplyToLoad: gridToLoad + solarToLoad + batteryToLoad,
    unexplainedLoadKwh: positive(reportedLoad - rawSupply),
    excessSupplyKwh: excess,
  };
}

/**
 * The load the device shares are taken against.
 *
 * `total_load_kwh` is authoritative when present. When it is absent the supply
 * terms stand in for it, and when neither exists the metered devices are all we
 * know. Metered devices exceeding the reported load — a double-counted or
 * mis-mapped meter — raises the denominator instead of letting the shares sum
 * past one and over-attribute the grid.
 */
const attributionDenominator = (
  loadKwh: number | null,
  supplyToLoad: number,
  meteredKwh: number,
) => {
  const reported = typeof loadKwh === 'number' && Number.isFinite(loadKwh)
    ? positive(loadKwh)
    : supplyToLoad;
  return Math.max(reported, meteredKwh);
};

const BASE_LOAD_KEY = '__base_load__';
const BATTERY_CHARGING_KEY = '__battery_charging__';

interface Accumulator {
  gridKwh: number;
  solarKwh: number;
  batteryKwh: number;
  totalKwh: number;
  costSek: number;
  estimatedGridKwh: number;
  estimatedSolarKwh: number;
  estimatedBatteryKwh: number;
  estimatedCostSek: number;
  fullyPriced: boolean;
}

const emptyAccumulator = (): Accumulator => ({
  gridKwh: 0,
  solarKwh: 0,
  batteryKwh: 0,
  totalKwh: 0,
  costSek: 0,
  estimatedGridKwh: 0,
  estimatedSolarKwh: 0,
  estimatedBatteryKwh: 0,
  estimatedCostSek: 0,
  fullyPriced: true,
});

/**
 * Add one quarter's share to a row. The price is the published one when there
 * is one and the shadow price otherwise; a shadow-priced cost is estimated even
 * when the energy behind it was measured.
 */
const credit = (
  row: Accumulator,
  energy: { grid: number; solar: number; battery: number; total: number },
  price: { sekPerKwh: number | null; estimated: boolean },
  estimatedEnergy: boolean,
) => {
  row.gridKwh += energy.grid;
  row.solarKwh += energy.solar;
  row.batteryKwh += energy.battery;
  row.totalKwh += energy.total;
  if (estimatedEnergy) {
    row.estimatedGridKwh += energy.grid;
    row.estimatedSolarKwh += energy.solar;
    row.estimatedBatteryKwh += energy.battery;
  }
  if (price.sekPerKwh === null) {
    if (energy.grid > 0) row.fullyPriced = false;
    return;
  }
  const cost = energy.grid * price.sekPerKwh;
  row.costSek += cost;
  if (estimatedEnergy || price.estimated) row.estimatedCostSek += cost;
};

const round = (value: number, decimals: number) => {
  const scale = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * scale) / scale;
};

/**
 * Attribute a window of quarters across devices.
 *
 * `deviceNames` decides which keys become rows and what they are called;
 * anything metered but unnamed falls into the base-load row rather than being
 * dropped, so the column still totals the whole house.
 *
 * Two rows exist beyond the devices so the columns reconcile against the bill:
 * base load carries everything unmetered, and battery charging carries the grid
 * energy that went into the cells. Without the second row the grid column would
 * sum to less than the metered import and the cost column to less than the
 * invoice.
 */
export function attributeEnergy(
  slots: SupplySlotInput[],
  deviceNames: Map<string, string>,
  labels: { baseLoad: string; batteryCharging: string },
): AttributionResult {
  const accumulators = new Map<string, Accumulator>();
  const accumulator = (key: string) => {
    const existing = accumulators.get(key);
    if (existing) return existing;
    const created = emptyAccumulator();
    accumulators.set(key, created);
    return created;
  };

  const summary: WindowSummary = {
    gridImportKwh: 0,
    gridExportKwh: 0,
    loadKwh: 0,
    solarKwh: 0,
    batteryChargeKwh: 0,
    batteryDischargeKwh: 0,
    importCostSek: 0,
    exportCreditSek: 0,
    netCostSek: 0,
    slotCount: slots.length,
    pricedSlotCount: 0,
    unexplainedLoadKwh: 0,
    excessSupplyKwh: 0,
  };

  for (const slot of slots) {
    const supply = decomposeSlotSupply(slot);
    const importPrice = typeof slot.importPriceSekPerKwh === 'number' &&
        Number.isFinite(slot.importPriceSekPerKwh)
      ? slot.importPriceSekPerKwh
      : null;
    const shadowPrice = typeof slot.shadowImportSekPerKwh === 'number' &&
        Number.isFinite(slot.shadowImportSekPerKwh)
      ? slot.shadowImportSekPerKwh
      : null;
    const rowPrice = {
      sekPerKwh: importPrice ?? shadowPrice,
      estimated: importPrice === null,
    };
    const estimated = slot.estimated === true;
    const exportPrice = typeof slot.exportPriceSekPerKwh === 'number' &&
        Number.isFinite(slot.exportPriceSekPerKwh)
      ? slot.exportPriceSekPerKwh
      : null;

    const gridImport = measured(slot.gridImportKwh);
    const gridExport = measured(slot.gridExportKwh);
    summary.gridImportKwh += gridImport;
    summary.gridExportKwh += gridExport;
    summary.solarKwh += measured(slot.solarKwh);
    summary.batteryChargeKwh += measured(slot.batteryChargeKwh);
    summary.batteryDischargeKwh += measured(slot.batteryDischargeKwh);
    if (importPrice !== null) {
      summary.importCostSek += gridImport * importPrice;
      summary.pricedSlotCount += 1;
    }
    if (exportPrice !== null) summary.exportCreditSek += gridExport * exportPrice;

    const deviceEntries = Object.entries(slot.deviceKwh ?? {})
      .map(([key, value]) => [key, measured(value)] as const)
      .filter(([, value]) => value > 0);
    const meteredKwh = deviceEntries.reduce((total, [, value]) => total + value, 0);
    const load = attributionDenominator(
      slot.loadKwh,
      supply.supplyToLoad,
      meteredKwh,
    );
    summary.loadKwh += load;
    summary.unexplainedLoadKwh += supply.unexplainedLoadKwh;
    summary.excessSupplyKwh += supply.excessSupplyKwh;

    credit(accumulator(BATTERY_CHARGING_KEY), {
      grid: supply.gridToBattery,
      solar: supply.solarToBattery,
      battery: 0,
      total: supply.gridToBattery + supply.solarToBattery,
    }, rowPrice, estimated);

    if (load <= 0) continue;
    // Load the supply readings do not cover still came from somewhere. It is
    // credited as estimated energy in the quarter's measured mix, or as grid
    // when the quarter has no supply reading at all.
    const gapKwh = positive(load - supply.supplyToLoad);
    const mix = supply.supplyToLoad > 0
      ? {
        grid: supply.gridToLoad / supply.supplyToLoad,
        solar: supply.solarToLoad / supply.supplyToLoad,
        battery: supply.batteryToLoad / supply.supplyToLoad,
      }
      : { grid: 1, solar: 0, battery: 0 };
    const creditShare = (key: string, kwh: number) => {
      const share = kwh / load;
      const row = accumulator(key);
      credit(row, {
        grid: share * supply.gridToLoad,
        solar: share * supply.solarToLoad,
        battery: share * supply.batteryToLoad,
        total: kwh,
      }, rowPrice, estimated);
      if (gapKwh > 0) {
        credit(row, {
          grid: share * gapKwh * mix.grid,
          solar: share * gapKwh * mix.solar,
          battery: share * gapKwh * mix.battery,
          total: 0,
        }, rowPrice, true);
      }
    };

    // Anything metered under a key we have no device for is unnamed, not
    // absent: it still consumed, so it belongs in the base-load remainder.
    let namedKwh = 0;
    for (const [key, value] of deviceEntries) {
      if (!deviceNames.has(key)) continue;
      namedKwh += value;
      creditShare(key, value);
    }

    const remainderKwh = positive(load - namedKwh);
    if (remainderKwh > 0) creditShare(BASE_LOAD_KEY, remainderKwh);
  }

  summary.netCostSek = summary.importCostSek - summary.exportCreditSek;

  const named = (key: string): { kind: AttributionRowKind; name: string } => {
    if (key === BASE_LOAD_KEY) return { kind: 'base_load', name: labels.baseLoad };
    if (key === BATTERY_CHARGING_KEY) {
      return { kind: 'battery_charging', name: labels.batteryCharging };
    }
    return { kind: 'device', name: deviceNames.get(key) ?? key };
  };

  const rows = [...accumulators.entries()]
    .filter(([, value]) => value.totalKwh > 0.0005)
    .map(([key, value]) => ({
      key,
      ...named(key),
      gridKwh: round(value.gridKwh, 4),
      solarKwh: round(value.solarKwh, 4),
      batteryKwh: round(value.batteryKwh, 4),
      totalKwh: round(value.totalKwh, 4),
      costSek: round(value.costSek, 4),
      estimatedGridKwh: round(value.estimatedGridKwh, 4),
      estimatedSolarKwh: round(value.estimatedSolarKwh, 4),
      estimatedBatteryKwh: round(value.estimatedBatteryKwh, 4),
      estimatedCostSek: round(value.estimatedCostSek, 4),
      fullyPriced: value.fullyPriced,
    }))
    .sort((left, right) => right.totalKwh - left.totalKwh);

  return {
    rows,
    summary: {
      ...summary,
      gridImportKwh: round(summary.gridImportKwh, 4),
      gridExportKwh: round(summary.gridExportKwh, 4),
      loadKwh: round(summary.loadKwh, 4),
      solarKwh: round(summary.solarKwh, 4),
      batteryChargeKwh: round(summary.batteryChargeKwh, 4),
      batteryDischargeKwh: round(summary.batteryDischargeKwh, 4),
      importCostSek: round(summary.importCostSek, 4),
      exportCreditSek: round(summary.exportCreditSek, 4),
      netCostSek: round(summary.netCostSek, 4),
      unexplainedLoadKwh: round(summary.unexplainedLoadKwh, 4),
      excessSupplyKwh: round(summary.excessSupplyKwh, 4),
    },
  };
}

/** Column totals, so the table can show a footer that reconciles. */
export const totalRow = (rows: AttributionRow[]) => ({
  gridKwh: round(rows.reduce((total, row) => total + row.gridKwh, 0), 4),
  solarKwh: round(rows.reduce((total, row) => total + row.solarKwh, 0), 4),
  batteryKwh: round(rows.reduce((total, row) => total + row.batteryKwh, 0), 4),
  totalKwh: round(rows.reduce((total, row) => total + row.totalKwh, 0), 4),
  costSek: round(rows.reduce((total, row) => total + row.costSek, 0), 4),
  estimatedCostSek: round(rows.reduce((total, row) => total + row.estimatedCostSek, 0), 4),
});
