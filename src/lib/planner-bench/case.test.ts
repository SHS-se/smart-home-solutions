import { assert, assertAlmostEquals, assertEquals, assertThrows } from '@std/assert';
import { loadCase, publishedQuarters, QUARTERS, type BenchRecorded } from './case.ts';
import { caseFromReplay, ReplayFormatError } from './convert-replay.ts';
import { HOUSEHOLD } from './household.ts';
import { referee, type Decisions } from './referee.ts';
import { evaluate } from './evaluate.ts';

const START = Date.parse('2026-09-24T07:15:00Z');
const quarters = <T>(make: (i: number) => T): T[] => Array.from({ length: QUARTERS }, (_, i) => make(i));

/** A replay with one device the household plans and one it does not. */
const replay = (snapshot: Record<string, unknown> = {}) => ({
  format: 'shs-energy-optimisation-quarter-replay',
  entrypoint: { arguments: { now: '2026-09-24T07:25:57Z', resolved_price_outlook: { marker: 'another planner' }, snapshot: {
    captured_at: '2026-09-24T07:25:46Z', timezone: 'Europe/Stockholm', location: { latitude: 59.4, longitude: 18 },
    slots: quarters(i => ({
      start: new Date(START + i * 900_000).toISOString(), pv_forecast_w: 1000, base_load_forecast_w: 400,
      import_price_sek_per_kwh: i < 60 || i === 70 ? 1.5 : null, export_price_sek_per_kwh: i < 60 || i === 70 ? 0.5 : null,
    })),
    pv_calibration: { correction_factor_by_lead_day: [0.8, 0.9, 1, 1] },
    battery: { soc: 0.4 }, pool: { water_temperature_c: 29.6 }, ev_battery: { soc: 0.8, connected: true, departure_target_soc: 0.8 },
    device_models: [
      { key: 'sensor.hot_water_energy', category: 'hot_water', forecast_w_by_slot: quarters(() => 150) },
      { key: 'sensor.pool_room_floor_heater_energy', category: 'pool_heating', forecast_w_by_slot: quarters(() => 50) },
      { key: 'sensor.pool_heater_energy', category: 'pool_heating', planning_service: 'pool', forecast_w_by_slot: quarters(() => 900) },
      { key: 'sensor.car_charging_total_energy', category: 'ev_charging', forecast_w_by_slot: quarters(() => 700) },
    ],
    value_curves: { pool: {} }, battery_cost_curve: { key: 'frozen' }, replan_reference: { plan_id: 'previous' },
    ...snapshot,
  } } },
});

Deno.test('a replay becomes a test case: the moment is kept, another planner\'s work is not', () => {
  const { data } = caseFromReplay(replay(), 'C-0924');
  assertEquals(data.start, '2026-09-24T07:15:00.000Z');
  // Prices stop at the first gap, even if a later quarter carries one.
  assertEquals(publishedQuarters(data), 60);
  assertEquals(data.known_prices.import_sek_per_kwh[70], null);
  // The home's own forecast correction is part of the forecast: 0.8 for the first
  // day after the capture (07:25, so one quarter into the second day of slots), then 0.9.
  assertAlmostEquals(data.solar_forecast_w[0], 800);
  assertAlmostEquals(data.solar_forecast_w[96], 800);
  assertAlmostEquals(data.solar_forecast_w[97], 900);
  // Devices the household plans (pool heater, car) leave the load; the rest fold into it, by key not category.
  assertEquals(data.base_load_forecast_w[0], 600);
  assertEquals(Object.keys(data.other_devices_w).sort(), ['sensor.hot_water_energy', 'sensor.pool_room_floor_heater_energy']);
  assertEquals(data.start_state, { battery_soc: 0.4, pool_water_c: 29.6, ev: { soc: 0.8, plugged_in: true, target_soc: 0.8 } });
  assertEquals(data.start_state_unread, undefined);
  assert(!/frozen|previous|another planner|value_curves/.test(JSON.stringify(data)));
});

Deno.test('a reading the replay lacks holds a default and is marked for recorded history to fill', () => {
  const { data } = caseFromReplay(replay({ pool: null }));
  assertEquals(data.start_state_unread, ['pool_water_c']);
  assertEquals(data.start_state.pool_water_c, 29);
});

Deno.test('a file that is not a 72-hour replay is refused', () => {
  assertThrows(() => caseFromReplay({ format: 'something-else' }), ReplayFormatError);
  assertThrows(() => caseFromReplay(replay({ slots: [] })), ReplayFormatError);
});

const recorded = (over: Partial<BenchRecorded> = {}): BenchRecorded => ({
  prices: { import_sek_per_kwh: quarters(i => i < 144 ? 1 : 3), export_sek_per_kwh: quarters(() => 0.5) },
  outdoor_temperature_c: quarters(() => 12),
  solar_irradiance_w_per_m2: quarters(() => null),
  history: { prices: { start: '2026-09-23T07:15:00Z', import_sek_per_kwh: [], export_sek_per_kwh: [] }, grid_import_kwh: { start: '2026-08-31T22:00:00Z', kwh: [] } },
  recorded_at: '2026-09-28T00:00:00Z',
  ...over,
});
const idle = (): Decisions => ({ pool_w: quarters(() => 0), ev_w: quarters(() => 0), battery_charge_w: quarters(() => 0), battery_discharge_w: quarters(() => 0) });

Deno.test('the referee prices a plan at real prices, whatever the planner believed', () => {
  const c = loadCase(caseFromReplay(replay()).data, recorded());
  // Idle: 600 W of load against 800/900/1000 W of solar exports the difference at 0.5 kr.
  const nothing = referee(c, HOUSEHOLD, idle());
  assertAlmostEquals(nothing.cost_sek, -(200 * 97 + 300 * 96 + 400 * 95) * 0.5 * 0.25 / 1000, 1e-3);
  // The same 2 kW of car charging costs three times as much in the dear second half.
  const early = idle(), late = idle();
  for (let i = 0; i < 8; i++) { early.ev_w[i] = 2000; late.ev_w[200 + i] = 2000; }
  const cheap = referee(c, HOUSEHOLD, early), dear = referee(c, HOUSEHOLD, late);
  assert(dear.cost_sek > cheap.cost_sek + 5, `${dear.cost_sek} vs ${cheap.cost_sek}`);
  assertEquals(cheap.terminal.ev_kwh, dear.terminal.ev_kwh);
});

Deno.test('the referee carries the stores with the household\'s physics and clips what cannot be done', () => {
  const c = loadCase(caseFromReplay(replay()).data, recorded());
  // An unheated pool at 29.6 °C in 12 °C air cools; a heated one warms.
  const cold = referee(c, HOUSEHOLD, idle());
  assert(cold.series.poolC[287]! < 29.6 - 1);
  const heating = idle();
  heating.pool_w = quarters(() => 3078);
  assert(referee(c, HOUSEHOLD, heating).series.poolC[287]! > 29.6 + 1);
  // A battery at 40 % of 18 kWh cannot give 9.6 kW for a day: the surplus is clipped and reported.
  const drain = idle();
  drain.battery_discharge_w = quarters(i => i < 96 ? 9600 : 0);
  const drained = referee(c, HOUSEHOLD, drain);
  assert(drained.violations.some(v => v.kind === 'battery_empty'));
  assertAlmostEquals(Math.min(...drained.series.homeSoc as number[]), 5, 0.2);
  // Energy is conserved each quarter: load + charging − discharging − solar = import − export.
  const s = drained.series;
  for (const i of [0, 3, 100, 287]) {
    assertAlmostEquals(s.loadW[i] + s.batteryChargeW[i] - s.batteryDischargeW[i] - s.solarW[i], s.gridImportW[i] - s.gridExportW[i], 0.2);
  }
});

Deno.test('an evaluation is derived wholly from the stored decisions', () => {
  const c = loadCase(caseFromReplay(replay()).data, recorded());
  const record = { status: 'ready', generation: 'snapshot', decisions: idle(), beliefs: { import_sek_per_kwh: quarters(() => 2), grid_cost_sek: 1 }, curves: [] };
  const first = evaluate(c, record, {}), again = evaluate(c, structuredClone(record), {});
  assertEquals(first, again);
  assertEquals(first.series.believedImportPrice![0], 2);
  assertEquals(first.series.importPrice[0], 1);
});
