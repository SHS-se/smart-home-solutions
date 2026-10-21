import {
  attributeEnergy,
  decomposeSlotSupply,
  supplySlotsFromTimeline,
  totalRow,
  type SupplySlotInput,
} from './energy-attribution.ts';

const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

const assertClose = (
  actual: number,
  expected: number,
  message: string,
  tolerance = 1e-9,
) => {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message}: ${actual} !== ${expected}`);
  }
};

const slot = (overrides: Partial<SupplySlotInput> = {}): SupplySlotInput => ({
  start: '2026-08-13T10:00:00.000Z',
  loadKwh: null,
  solarKwh: 0,
  gridImportKwh: 0,
  gridExportKwh: 0,
  batteryChargeKwh: 0,
  batteryDischargeKwh: 0,
  deviceKwh: {},
  importPriceSekPerKwh: 1,
  exportPriceSekPerKwh: 0.5,
  ...overrides,
});

const labels = { baseLoad: 'Base load', batteryCharging: 'Battery charging' };
const names = (entries: Array<[string, string]>) => new Map(entries);

Deno.test('supply to load reconciles to the category balance', () => {
  const input = slot({
    solarKwh: 2,
    gridImportKwh: 1,
    gridExportKwh: 0.5,
    batteryChargeKwh: 0.8,
    batteryDischargeKwh: 0.3,
  });
  const supply = decomposeSlotSupply(input);
  assertClose(
    supply.supplyToLoad,
    1 + 2 + 0.3 - 0.8 - 0.5,
    'grid + solar + battery to load must equal G + S + Bd - Bc - E',
  );
});

Deno.test('supply beyond the load is held back, starting with solar', () => {
  // Curtailed solar, or a load meter reading low. Counting it as consumed
  // would hand every device a share of energy that never reached it.
  const supply = decomposeSlotSupply(slot({
    loadKwh: 1,
    solarKwh: 3,
    gridImportKwh: 0.5,
    batteryDischargeKwh: 0.5,
  }));
  assertClose(supply.supplyToLoad, 1, 'the supply columns cap at the load');
  assertClose(supply.gridToLoad, 0.5, 'the grid term survives intact');
  assertClose(supply.solarToLoad, 0, 'solar gives way first');
  assertClose(supply.batteryToLoad, 0.5, 'the battery only gives way after it');
  assertClose(supply.excessSupplyKwh, 3, 'and the held-back energy is reported');
});

Deno.test('surplus solar is not billed to devices as consumption', () => {
  const result = attributeEnergy([
    slot({
      loadKwh: 1,
      solarKwh: 5,
      gridImportKwh: 0,
      deviceKwh: { pool: 1 },
      importPriceSekPerKwh: 2,
    }),
  ], names([['pool', 'Pool heater']]), labels);

  const pool = result.rows.find(row => row.key === 'pool');
  assertClose(pool!.solarKwh, 1, 'the device is credited only what it drew');
  assertClose(
    result.summary.excessSupplyKwh,
    4,
    'the rest is reported as unmatched supply',
  );
});

Deno.test('surplus solar charges the battery before the grid does', () => {
  const sunny = decomposeSlotSupply(
    slot({ solarKwh: 4, gridImportKwh: 0.2, batteryChargeKwh: 1 }),
  );
  assertClose(sunny.solarToBattery, 1, 'sunny charging is solar');
  assertClose(sunny.gridToBattery, 0, 'sunny charging draws no grid');
  assertClose(sunny.gridToLoad, 0.2, 'the imported kWh served the load');

  const dark = decomposeSlotSupply(
    slot({ solarKwh: 0, gridImportKwh: 3, batteryChargeKwh: 2 }),
  );
  assertClose(dark.gridToBattery, 2, 'night charging is grid');
  assertClose(dark.gridToLoad, 1, 'the rest of the import served the load');
});

Deno.test('export is solar before it is battery', () => {
  const supply = decomposeSlotSupply(
    slot({ solarKwh: 3, gridExportKwh: 4, batteryDischargeKwh: 2 }),
  );
  assertClose(supply.solarToExport, 3, 'all solar exported');
  assertClose(supply.batteryToExport, 1, 'the remaining export came from cells');
  assertClose(supply.batteryToLoad, 1, 'the rest of the discharge served the load');
});

Deno.test('a disagreeing meter never produces a negative flow', () => {
  const supply = decomposeSlotSupply(
    slot({ solarKwh: 0, gridImportKwh: 0.1, batteryChargeKwh: 5 }),
  );
  assert(supply.gridToLoad >= 0, 'grid to load stays non-negative');
  assertClose(supply.gridToBattery, 0.1, 'charging is capped by what was imported');
});

Deno.test('the grid column and cost column reconcile to the invoice', () => {
  const result = attributeEnergy([
    slot({
      loadKwh: 2,
      gridImportKwh: 3,
      batteryChargeKwh: 1,
      deviceKwh: { pool: 1.5 },
      importPriceSekPerKwh: 2,
    }),
    slot({
      loadKwh: 1,
      solarKwh: 4,
      gridImportKwh: 0,
      gridExportKwh: 3,
      deviceKwh: { pool: 0.25, ev: 0.25 },
      importPriceSekPerKwh: 2,
      exportPriceSekPerKwh: 0.5,
    }),
  ], names([['pool', 'Pool heater'], ['ev', 'Car charger']]), labels);

  const totals = totalRow(result.rows);
  assertClose(totals.gridKwh, 3, 'the grid column totals the metered import');
  assertClose(totals.costSek, 6, 'the cost column totals import x price');
  assertClose(
    result.summary.importCostSek,
    6,
    'the summary card agrees with the table',
  );
  assertClose(result.summary.exportCreditSek, 1.5, 'export is credited');
  assertClose(result.summary.netCostSek, 4.5, 'net cost is import minus export');
});

Deno.test('battery charging carries the grid energy that went into the cells', () => {
  const result = attributeEnergy([
    slot({
      loadKwh: 1,
      gridImportKwh: 3,
      batteryChargeKwh: 2,
      deviceKwh: { pool: 1 },
      importPriceSekPerKwh: 1,
    }),
  ], names([['pool', 'Pool heater']]), labels);

  const charging = result.rows.find(row => row.kind === 'battery_charging');
  const pool = result.rows.find(row => row.key === 'pool');
  assert(charging !== undefined, 'a battery charging row exists');
  assertClose(charging!.gridKwh, 2, 'charging holds the grid energy it took');
  assertClose(charging!.costSek, 2, 'and is charged for it');
  assertClose(pool!.gridKwh, 1, 'the device holds only the grid that served load');
  assertClose(pool!.costSek, 1, 'and is charged only for that');
  assertClose(totalRow(result.rows).gridKwh, 3, 'together they total the import');
});

Deno.test('unmetered consumption lands in the base-load row', () => {
  const result = attributeEnergy([
    slot({
      loadKwh: 4,
      gridImportKwh: 4,
      deviceKwh: { pool: 1, unknown: 2 },
      importPriceSekPerKwh: 1,
    }),
  ], names([['pool', 'Pool heater']]), labels);

  const base = result.rows.find(row => row.kind === 'base_load');
  const pool = result.rows.find(row => row.key === 'pool');
  assertClose(pool!.totalKwh, 1, 'the named device keeps its own energy');
  assertClose(
    base!.totalKwh,
    3,
    'everything unnamed or unmetered falls to base load',
  );
  assertClose(totalRow(result.rows).totalKwh, 4, 'the table totals the house');
});

Deno.test('a device row splits into grid, solar and battery', () => {
  const result = attributeEnergy([
    slot({
      loadKwh: 4,
      solarKwh: 2,
      gridImportKwh: 1,
      batteryDischargeKwh: 1,
      deviceKwh: { pool: 2 },
      importPriceSekPerKwh: 3,
    }),
  ], names([['pool', 'Pool heater']]), labels);

  const pool = result.rows.find(row => row.key === 'pool');
  assertClose(pool!.gridKwh, 0.5, 'half the load means half the grid');
  assertClose(pool!.solarKwh, 1, 'and half the solar');
  assertClose(pool!.batteryKwh, 0.5, 'and half the discharge');
  assertClose(
    pool!.gridKwh + pool!.solarKwh + pool!.batteryKwh,
    pool!.totalKwh,
    'the three sources account for the whole device',
  );
  assertClose(pool!.costSek, 1.5, 'only the grid share is charged');
});

Deno.test('an unpriced quarter is flagged rather than costed as free', () => {
  const result = attributeEnergy([
    slot({
      loadKwh: 1,
      gridImportKwh: 1,
      deviceKwh: { pool: 1 },
      importPriceSekPerKwh: null,
      exportPriceSekPerKwh: null,
    }),
    slot({
      loadKwh: 1,
      gridImportKwh: 1,
      deviceKwh: { pool: 1 },
      importPriceSekPerKwh: 2,
    }),
  ], names([['pool', 'Pool heater']]), labels);

  const pool = result.rows.find(row => row.key === 'pool');
  assert(pool!.fullyPriced === false, 'the row reports a missing price');
  assertClose(pool!.costSek, 2, 'only the priced quarter contributes');
  assert(
    result.summary.pricedSlotCount === 1 && result.summary.slotCount === 2,
    'the summary counts how much of the window carried a price',
  );
});

Deno.test('a metered load that disagrees with its categories is reported', () => {
  const result = attributeEnergy([
    slot({ loadKwh: 5, gridImportKwh: 4, deviceKwh: { pool: 1 } }),
  ], names([['pool', 'Pool heater']]), labels);

  assertClose(
    result.summary.unexplainedLoadKwh,
    1,
    'the unexplained kWh is still surfaced in the summary',
  );
  const totals = totalRow(result.rows);
  const estimatedGrid = result.rows.reduce((sum, row) => sum + row.estimatedGridKwh, 0);
  assertClose(totals.gridKwh - estimatedGrid, 4, 'the measured grid still totals the metered import');
  assertClose(estimatedGrid, 1, 'the uncovered kWh is credited as estimated grid');
  const pool = result.rows.find(row => row.key === 'pool')!;
  assertClose(pool.gridKwh, pool.totalKwh, 'so a device splits fully into its sources');
});

Deno.test('uncovered load takes its quarter\'s supply mix as an estimate', () => {
  const result = attributeEnergy([
    // Supply covers 2 of 4 kWh, half grid and half battery.
    slot({ loadKwh: 4, gridImportKwh: 1, batteryDischargeKwh: 1, deviceKwh: { pool: 2 }, importPriceSekPerKwh: 2 }),
  ], names([['pool', 'Pool heater']]), labels);
  const pool = result.rows.find(row => row.key === 'pool')!;
  assertClose(pool.gridKwh, 1, 'measured 0.5 plus estimated 0.5');
  assertClose(pool.batteryKwh, 1, 'measured 0.5 plus estimated 0.5');
  assertClose(pool.estimatedGridKwh, 0.5, 'the grid half of the gap is estimated');
  assertClose(pool.estimatedBatteryKwh, 0.5, 'and so is the battery half');
  assertClose(pool.costSek, 2, 'all grid is priced');
  assertClose(pool.estimatedCostSek, 1, 'the gap\'s grid cost is estimated');
});

Deno.test('devices that out-measure the reported load do not over-attribute', () => {
  const result = attributeEnergy([
    slot({
      loadKwh: 1,
      gridImportKwh: 4,
      deviceKwh: { pool: 3, ev: 1 },
      importPriceSekPerKwh: 1,
    }),
  ], names([['pool', 'Pool heater'], ['ev', 'Car charger']]), labels);

  assertClose(
    totalRow(result.rows).gridKwh,
    4,
    'shares are taken against the larger of load and metered devices',
  );
});

Deno.test('the invoice identities hold across a randomised window', () => {
  // The fixed cases above each pin one behaviour. This one asserts the two
  // properties the whole table rests on — the grid column equals the metered
  // import, and the cost column equals the invoice — over a window wide enough
  // to hit sun, no sun, charging, discharging and export in combination.
  let seed = 20260813;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const slots: SupplySlotInput[] = [];
  let expectedGridKwh = 0;
  let expectedCostSek = 0;
  for (let index = 0; index < 2000; index += 1) {
    const solar = random() < 0.5 ? 0 : random() * 3;
    const charge = random() < 0.7 ? 0 : random() * 2;
    const discharge = charge > 0 ? 0 : (random() < 0.7 ? 0 : random() * 2);
    const load = random() * 4;
    // A consistent category balance, which is what the integration derives
    // total_load_kwh from: surplus leaves as export rather than vanishing.
    const net = load + charge - solar - discharge;
    const gridImport = Math.max(0, net);
    const gridExport = Math.max(0, -net);
    const price = 0.5 + random() * 2;
    expectedGridKwh += gridImport;
    expectedCostSek += gridImport * price;
    slots.push({
      start: new Date(Date.UTC(2026, 7, 1) + index * 900_000).toISOString(),
      loadKwh: load,
      solarKwh: solar,
      gridImportKwh: gridImport,
      gridExportKwh: gridExport,
      batteryChargeKwh: charge,
      batteryDischargeKwh: discharge,
      deviceKwh: { pool: load * 0.3, ev: load * 0.2 },
      importPriceSekPerKwh: price,
      exportPriceSekPerKwh: 0.4,
    });
  }

  const result = attributeEnergy(
    slots,
    names([['pool', 'Pool heater'], ['ev', 'Car charger']]),
    labels,
  );
  const totals = totalRow(result.rows);
  assertClose(totals.gridKwh, expectedGridKwh, 'grid column totals the import', 0.05);
  assertClose(totals.costSek, expectedCostSek, 'cost column totals the invoice', 0.05);
  assertClose(
    result.summary.importCostSek,
    expectedCostSek,
    'the summary card agrees with the table',
    0.05,
  );
  assertClose(
    result.summary.unexplainedLoadKwh,
    0,
    'a consistent balance leaves no unexplained load',
    0.05,
  );
  assertClose(
    result.summary.excessSupplyKwh,
    0,
    'and no unmatched supply',
    0.05,
  );
  for (const row of result.rows) {
    if (row.kind === 'battery_charging') continue;
    assertClose(
      row.gridKwh + row.solarKwh + row.batteryKwh,
      row.totalKwh,
      `${row.name} splits fully into three sources`,
      0.02,
    );
  }
});

Deno.test('rows are ordered by total consumption descending', () => {
  const result = attributeEnergy([
    slot({
      loadKwh: 6,
      gridImportKwh: 6,
      deviceKwh: { small: 1, large: 3 },
      importPriceSekPerKwh: 1,
    }),
  ], names([['small', 'Towel rack'], ['large', 'Pool heater']]), labels);

  const order = result.rows.map(row => row.totalKwh);
  assert(
    order.every((value, index) => index === 0 || order[index - 1] >= value),
    `rows must be sorted descending, got ${JSON.stringify(order)}`,
  );
});

Deno.test('timeline rows keep battery discharge and the real import price', () => {
  // Both were once hard-coded to zero and null in the plan page's adapter, so
  // every device showed no battery energy and no cost.
  const [input] = supplySlotsFromTimeline([{
    start: '2026-10-20T18:00:00.000Z',
    measured: true,
    loadW: 4_000,
    solarW: 0,
    gridImportW: 1_000,
    gridExportW: -0,
    batteryChargeW: -0,
    batteryDischargeW: 3_000,
    deviceW: { pool: 2_000 },
    importPriceSekPerKwh: 2,
    exportPriceSekPerKwh: 0.5,
    shadowImportSekPerKwh: null,
  }]);
  assertClose(input.batteryDischargeKwh ?? 0, 0.75, 'discharge passes through as kWh');
  const { rows } = attributeEnergy([input], names([['pool', 'Pool']]), labels);
  const pool = rows.find(row => row.key === 'pool')!;
  assertClose(pool.batteryKwh, 0.375, 'half the load takes half the battery');
  assertClose(pool.gridKwh, 0.125, 'and half the grid');
  assertClose(pool.costSek, 0.25, 'grid share priced at the quarter\'s import price');
  assert(pool.fullyPriced, 'a published price makes the row priced');
});

Deno.test('a missing load stays unknown instead of becoming zero', () => {
  const [input] = supplySlotsFromTimeline([{
    start: '2026-10-20T18:00:00.000Z',
    measured: true,
    loadW: null, solarW: 2_000, gridImportW: null, gridExportW: null,
    batteryChargeW: null, batteryDischargeW: null, deviceW: {},
    importPriceSekPerKwh: null, exportPriceSekPerKwh: null, shadowImportSekPerKwh: null,
  }]);
  assert(input.loadKwh === null, 'null load must not read as a zero-kWh quarter');
  assertClose(decomposeSlotSupply(input).solarToLoad, 0.5, 'solar is not capped away');
});

Deno.test('planned quarters and shadow prices are carried as estimates', () => {
  const result = attributeEnergy([
    // Measured, published price: nothing estimated.
    slot({ loadKwh: 1, gridImportKwh: 1, deviceKwh: { pool: 1 }, importPriceSekPerKwh: 2 }),
    // Measured energy, but only the planner's price: the cost is estimated.
    slot({ loadKwh: 1, gridImportKwh: 1, deviceKwh: { pool: 1 }, importPriceSekPerKwh: null, shadowImportSekPerKwh: 3 }),
    // Planned: energy and cost both estimated, even at a published price.
    slot({ estimated: true, loadKwh: 2, gridImportKwh: 1, solarKwh: 1, deviceKwh: { pool: 2 }, importPriceSekPerKwh: 1 }),
  ], names([['pool', 'Pool heater']]), labels);

  const pool = result.rows.find(row => row.key === 'pool')!;
  assertClose(pool.gridKwh, 3, 'grid includes every quarter');
  assertClose(pool.estimatedGridKwh, 1, 'only the planned grid is estimated');
  assertClose(pool.estimatedSolarKwh, 1, 'and the planned solar');
  assertClose(pool.costSek, 2 + 3 + 1, 'the shadow price fills the unpublished quarter');
  assertClose(pool.estimatedCostSek, 3 + 1, 'shadow-priced and planned cost are estimated');
  assert(pool.fullyPriced, 'a shadow price counts as a price');
  assertClose(result.summary.importCostSek, 2 + 1, 'the bill summary uses published prices only');
});

Deno.test('timeline rows mark planned and delayed-counter quarters estimated', () => {
  const row = {
    start: '2026-10-21T18:00:00.000Z', loadW: 0, solarW: 0, gridImportW: 0, gridExportW: 0,
    batteryChargeW: 0, batteryDischargeW: 0, deviceW: {},
    importPriceSekPerKwh: null, exportPriceSekPerKwh: null, shadowImportSekPerKwh: 1.5,
  };
  const [measured, delayed, planned] = supplySlotsFromTimeline([
    { ...row, measured: true },
    { ...row, measured: true, estimatedEnergy: true },
    { ...row, measured: false },
  ]);
  assert(measured.estimated === false && delayed.estimated === true && planned.estimated === true, 'only readings count as measured');
  assert(planned.shadowImportSekPerKwh === 1.5, 'the shadow price passes through');
});
