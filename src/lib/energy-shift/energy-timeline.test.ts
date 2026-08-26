import type { ActualEnergySlot, PlannedSlot } from './contracts.ts';
import {
  activeDeviceKeys,
  availableDayWindows,
  buildEnergyTimeline,
  dayBounds,
  dayWindowRange,
  nowDividerIndex,
  SLOT_MS,
  summariseTimeline,
  unpricedMeasuredQuarters,
} from './energy-timeline.ts';

const assertEquals = (actual: unknown, expected: unknown, message: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
};

const assert = (value: boolean, message: string) => {
  if (!value) throw new Error(message);
};

// Local noon, so every day boundary in these tests is the runner's own
// midnight rather than UTC's.
const NOW = new Date(2026, 7, 16, 12, 0, 0).getTime();

const actual = (startMs: number, overrides: Partial<ActualEnergySlot> = {}): ActualEnergySlot => ({
  start_ts: new Date(startMs).toISOString(),
  total_load_kwh: 0.25,
  solar_production_kwh: 0.5,
  grid_import_kwh: 0.1,
  grid_export_kwh: 0.2,
  battery_charge_kwh: 0.05,
  battery_discharge_kwh: 0,
  battery_soc: null,
  ev_soc: null,
  ...overrides,
});

const planned = (startMs: number, overrides: Partial<PlannedSlot> = {}): PlannedSlot => ({
  start: new Date(startMs).toISOString(),
  binding: true,
  pv_raw_w: 0,
  pv_w: 2_000,
  base_w: 400,
  base_p10_w: 0,
  base_p90_w: 0,
  import_price_sek_per_kwh: 1,
  export_price_sek_per_kwh: 0.2,
  pool_w: 0,
  boiler_expected_w: 0,
  boiler_permitted: true,
  ev_w: 0,
  room_heating_w: {},
  device_loads_w: {},
  ev_target_current_a: 0,
  ev_min_current_a: 0,
  ev_max_current_a: 0,
  ev_soc: 0.6,
  ev_connected: true,
  load_w: 1_000,
  battery_charge_w: 800,
  battery_discharge_w: 0,
  battery_export_w: 0,
  battery_soc: 0.75,
  grid_import_w: 400,
  grid_export_w: 100,
  curtailed_w: 0,
  unserved_w: 0,
  import_cost_sek: 0.1,
  export_revenue_sek: 0.01,
  ...overrides,
});

const build = (overrides: Partial<Parameters<typeof buildEnergyTimeline>[0]> = {}) =>
  buildEnergyTimeline({
    actuals: [],
    deviceActuals: [],
    prices: [],
    planSlots: [],
    deviceKeyById: new Map(),
    nowMs: NOW,
    ...overrides,
  });

Deno.test('a day window is local midnight to midnight, whatever the clock says', () => {
  const today = dayBounds(NOW, 0);
  assertEquals(new Date(today.startMs).getHours(), 0, 'starts at midnight');
  assertEquals(new Date(today.endMs).getDate(), new Date(NOW).getDate() + 1, 'ends next day');
  const yesterday = dayBounds(NOW, -1);
  assertEquals(yesterday.endMs, today.startMs, 'yesterday ends where today starts');
  const tomorrow = dayBounds(NOW, 1);
  assertEquals(tomorrow.startMs, today.endMs, 'tomorrow starts where today ends');
});

Deno.test('measured quarters fill the past and planned quarters the future', () => {
  const rows = build({
    actuals: [actual(NOW - 2 * SLOT_MS), actual(NOW - SLOT_MS)],
    planSlots: [planned(NOW), planned(NOW + SLOT_MS)],
  });
  assertEquals(rows.map(row => row.measured), [true, true, false, false], 'sides');
  assertEquals(rows[0].solarW, 2_000, 'measured 0.5 kWh is 2 kW');
  assertEquals(rows[2].solarW, 2_000, 'planned watts pass through');
});

Deno.test('a plan slot never overwrites a quarter already measured', () => {
  const rows = build({
    actuals: [actual(NOW - SLOT_MS, { total_load_kwh: 0.1 })],
    // The plan was issued before now, so it still carries elapsed quarters.
    planSlots: [planned(NOW - SLOT_MS, { load_w: 9_999 }), planned(NOW)],
  });
  assertEquals(rows.length, 2, 'one quarter each');
  assertEquals(rows[0].loadW, 400, 'measurement wins over the stale forecast');
  assert(rows[0].measured, 'and stays marked as measured');
});

Deno.test('measured state of charge is read, never derived', () => {
  const rows = build({
    actuals: [actual(NOW - SLOT_MS, { battery_soc: 0.31, ev_soc: 0.44 })],
    planSlots: [planned(NOW)],
  });
  assertEquals(rows[0].batterySoc, 0.31, 'the measured house battery');
  assertEquals(rows[0].evSoc, 0.44, 'and the measured car');
  assertEquals(rows[1].batterySoc, 0.75, 'the plan carries its own');
  assertEquals(rows[1].evSoc, 0.6, 'and for the car');
});

Deno.test('a quarter recorded before SOC was sent leaves a gap, not a guess', () => {
  const rows = build({ actuals: [actual(NOW - SLOT_MS)], planSlots: [planned(NOW)] });
  assertEquals(rows[0].batterySoc, null, 'no level to show');
  assertEquals(rows[0].evSoc, null, 'nor for the car');
});

Deno.test('measured devices are reconciled onto the key the plan uses', () => {
  const rows = build({
    actuals: [actual(NOW - SLOT_MS)],
    deviceActuals: [{
      start_ts: new Date(NOW - SLOT_MS).toISOString(),
      device_energy_kwh: { 'row-uuid': 0.25, 'unmapped-uuid': 1 },
    }],
    deviceKeyById: new Map([['row-uuid', 'sensor.pool_heater_energy']]),
  });
  assertEquals(rows[0].deviceW, { 'sensor.pool_heater_energy': 1_000 }, 'reconciled');
  // 1 kWh of house load minus the 1 kW charted device leaves nothing.
  assertEquals(rows[0].baseW, 0, 'base load excludes charted devices');
});

Deno.test('export and battery charge are held negative on both sides', () => {
  const rows = build({
    actuals: [actual(NOW - SLOT_MS)],
    planSlots: [planned(NOW)],
  });
  assert(rows[0].gridExportW! < 0, 'measured export');
  assert(rows[0].batteryChargeW! < 0, 'measured charge');
  assert(rows[1].gridExportW! < 0, 'planned export');
  assert(rows[1].batteryChargeW! < 0, 'planned charge');
});

Deno.test('today totals combine what happened with what is planned', () => {
  const midnight = dayBounds(NOW, 0).startMs;
  const rows = build({
    actuals: [actual(midnight, { total_load_kwh: 1, solar_production_kwh: 0 })],
    planSlots: [planned(NOW, { load_w: 4_000, pv_w: 4_000 })],
  });
  const summary = summariseTimeline(rows, dayWindowRange(rows, 0, NOW));
  assertEquals(summary.measuredSlotCount, 1, 'one elapsed quarter');
  assertEquals(summary.plannedSlotCount, 1, 'one forecast quarter');
  assertEquals(summary.consumptionKwh, 2, '1 kWh measured plus 1 kWh planned');
  assertEquals(summary.solarKwh, 1, 'solar only from the planned quarter');
});

Deno.test('an unpriced quarter is reported rather than counted as free', () => {
  const rows = build({
    actuals: [actual(NOW - SLOT_MS)],
    planSlots: [planned(NOW, { binding: false })],
  });
  const summary = summariseTimeline(rows, { from: 0, to: rows.length });
  assert(!summary.fullyPriced, 'a gap is visible');
  assertEquals(summary.netCostSek, 0, 'the unpriced quarter adds nothing');
});

Deno.test('windows only offer days the loaded data can fill', () => {
  const rows = build({
    actuals: [actual(dayBounds(NOW, -1).startMs)],
    planSlots: [planned(NOW), planned(dayBounds(NOW, 1).startMs)],
  });
  assertEquals(availableDayWindows(rows, NOW), [-1, 0, 1, 'all'], 'offered windows');
  const empty = dayWindowRange(rows, -2, NOW);
  assertEquals(empty, { from: 0, to: 0 }, 'a day with no data is empty');
});

Deno.test('the divider sits where measurement stops', () => {
  const rows = build({
    actuals: [actual(NOW - 2 * SLOT_MS), actual(NOW - SLOT_MS)],
    planSlots: [planned(NOW)],
  });
  const all = { from: 0, to: rows.length };
  assertEquals(nowDividerIndex(rows, all), 2, 'after the two measured quarters');
  // A finished day is entirely measured, so there is nothing to divide.
  const past = build({ actuals: [actual(dayBounds(NOW, -1).startMs)] });
  assertEquals(
    nowDividerIndex(past, dayWindowRange(past, -1, NOW)),
    1,
    'no divider drawn inside a finished day',
  );
});

Deno.test('only devices carrying load reach the legend', () => {
  const rows = build({
    planSlots: [
      planned(NOW, { device_loads_w: { pool: 3_000, towel: 0, dust: 0.2 } }),
      planned(NOW + SLOT_MS, { device_loads_w: { pool: 0, towel: 0, dust: 0.2 } }),
    ],
  });
  assertEquals([...activeDeviceKeys(rows, { from: 0, to: rows.length })], ['pool'], 'active');
});

Deno.test('a measured quarter with no price is what triggers a backfill', () => {
  const priced = new Date(NOW - 2 * SLOT_MS).toISOString();
  const missing = unpricedMeasuredQuarters(
    [{ start_ts: priced }, { start_ts: new Date(NOW - SLOT_MS).toISOString() }],
    [{ start_ts: priced }],
  );
  assertEquals(missing, 1, 'one unpriced quarter');
  assertEquals(
    unpricedMeasuredQuarters([{ start_ts: priced }], [{ start_ts: priced }]),
    0,
    'nothing to backfill when every quarter is priced',
  );
  // Timestamps arrive from two tables and need not be byte-identical.
  assertEquals(
    unpricedMeasuredQuarters(
      [{ start_ts: new Date(NOW - SLOT_MS).toISOString() }],
      [{ start_ts: new Date(NOW - SLOT_MS + 400).toISOString() }],
    ),
    0,
    'matched on the quarter, not the exact string',
  );
});

Deno.test('standby draw never earns a place on the chart', () => {
  const rows = build({
    planSlots: [planned(NOW, {
      device_loads_w: {
        'sensor.fridge': 4,          // rounds to 0.00 kW
        'sensor.tv_standby': 9.9,    // just under the line
        'sensor.internet': 10,       // exactly on it
        'sensor.hot_water': 2_590,
      },
    })],
  });
  assertEquals(
    [...activeDeviceKeys(rows, { from: 0, to: rows.length })].sort(),
    ['sensor.hot_water', 'sensor.internet'],
    'only loads worth a colour',
  );
});
