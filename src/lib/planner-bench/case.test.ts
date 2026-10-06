import { assert, assertAlmostEquals, assertEquals, assertThrows } from '@std/assert';
import { loadCase, parseScenarioData, publishedQuarters, QUARTERS, type BenchRecorded } from './case.ts';
import { caseFromReplay, ReplayFormatError } from './convert-replay.ts';
import { HOUSEHOLD } from './household.ts';
import { TARGETS } from './world.fixture.ts';
import { poolLevels, referee, type Decisions } from './referee.ts';
import type { PlanRecord } from './types.ts';
import { evaluate } from './evaluate.ts';
import { diagnose, laneParts, toldCase } from './lanes.ts';
import { CriteriaError } from './score.ts';

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
  assertEquals(data.start_state, { battery_soc: 0.4, pool_water_c: 29.6, ev: { soc: 0.8, target_soc: 0.8 } });
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

Deno.test('C-1005 runs now with explicit synthetic evaluation data and preserves the replay inputs', async () => {
  const file = JSON.parse(await Deno.readTextFile(new URL('../../../bench/cases/C-1005.json', import.meta.url)));
  const data = parseScenarioData(file.dataset);
  assertEquals(data.start, '2026-10-05T10:15:00.000Z');
  assertEquals(publishedQuarters(data), 47);
  assertEquals(data.start_state, { battery_soc: 0.139, pool_water_c: 30.01, ev: { soc: 0.66, target_soc: 0.8 } });
  assertEquals(data.known_prices.import_sek_per_kwh[0], 1.10176);
  assertEquals(data.solar_forecast_w.length, QUARTERS);
  assertEquals(data.base_load_forecast_w.length, QUARTERS);
  const c = loadCase(data, file.recorded);
  assertEquals(data.comfort, { pool_c: 30.5, ev_km: 360 });
  assertEquals(c.recorded.prices.import_sek_per_kwh.slice(0, 47), data.known_prices.import_sek_per_kwh.slice(0, 47));
  assertEquals(c.recorded.prices.export_sek_per_kwh.slice(0, 47), data.known_prices.export_sek_per_kwh.slice(0, 47));
  assertEquals(c.recorded.actual, { base_load_w: data.base_load_forecast_w, solar_w: data.solar_forecast_w });
  assertEquals(file.recorded.synthetic_quarters.prices.length, 49);
  assertEquals(file.recorded.synthetic_quarters.outdoor_temperature_c.length, 154);
  for (const i of file.recorded.synthetic_quarters.prices) {
    assertEquals(c.recorded.prices.import_sek_per_kwh[i], c.recorded.prices.import_sek_per_kwh[i - 96]);
    assertEquals(c.recorded.prices.export_sek_per_kwh[i], c.recorded.prices.export_sek_per_kwh[i - 96]);
  }
  assert(file.notes.startsWith('Synthetic evaluation:'));
  assert(file.notes.includes('not a measured 72-hour outcome'));
  assert(!/resolved_price_outlook|replan_reference|planner_output/.test(JSON.stringify(data)));
});

const recorded = (over: Partial<BenchRecorded> = {}): BenchRecorded => ({
  prices: { import_sek_per_kwh: quarters(i => i < 144 ? 1 : 3), export_sek_per_kwh: quarters(() => 0.5) },
  outdoor_temperature_c: quarters(() => 12),
  solar_irradiance_w_per_m2: quarters(() => null),
  history: { prices: { start: '2026-09-23T07:15:00Z', import_sek_per_kwh: [], export_sek_per_kwh: [] }, grid_import_kwh: { start: '2026-08-31T22:00:00Z', kwh: [] } },
  recorded_at: '2026-09-28T00:00:00Z',
  ...over,
});
/** The pool's heat pump on: its compressor at the 12 kW setting and the circulation pump. */
const POOL_W = 3764;
const idle = (): Decisions => ({ pool_w: quarters(() => 0), ev_w: quarters(() => 0), battery_charge_w: quarters(() => 0), battery_discharge_w: quarters(() => 0) });

Deno.test('the referee prices a plan at real prices, whatever the planner believed', () => {
  // The car below its 80 % charge limit, so it can take the charge.
  const c = loadCase(caseFromReplay(replay({ ev_battery: { soc: 0.5, connected: true, departure_target_soc: 0.8 } })).data, recorded());
  // Idle: 600 W of load against 800/900/1000 W of solar exports the difference at 0.5 kr.
  const nothing = referee(c, HOUSEHOLD, TARGETS, idle());
  assertAlmostEquals(nothing.cost_sek, -(200 * 97 + 300 * 96 + 400 * 95) * 0.5 * 0.25 / 1000, 1e-3);
  // The same 5 A of car charging costs three times as much in the dear second half.
  const early = idle(), late = idle();
  for (let i = 0; i < 8; i++) { early.ev_w[i] = 3450; late.ev_w[200 + i] = 3450; }
  const cheap = referee(c, HOUSEHOLD, TARGETS, early), dear = referee(c, HOUSEHOLD, TARGETS, late);
  assert(dear.cost_sek > cheap.cost_sek + 5, `${dear.cost_sek} vs ${cheap.cost_sek}`);
  assertEquals(cheap.terminal.ev_kwh, dear.terminal.ev_kwh);
});

Deno.test('the referee carries the stores with the household\'s physics and clips what cannot be done', () => {
  const c = loadCase(caseFromReplay(replay()).data, recorded());
  // An unheated pool at 29.6 °C in 12 °C air cools; a heated one warms.
  const cold = referee(c, HOUSEHOLD, TARGETS, idle());
  assert(cold.series.poolC[287]! < 29.6 - 1);
  const heating = idle();
  heating.pool_w = quarters(() => POOL_W);
  const heated = referee(c, HOUSEHOLD, TARGETS, heating);
  assert(heated.series.poolC[287]! > 29.6 + 1);
  assertEquals(heated.violations, []);
  // The heat pump is on at its setting, with the pump that circulates and heats nothing, or it is off. Asked
  // for the pump's power alone it does not run: that is reported, and the pool cools exactly as when idle.
  assertEquals(poolLevels(HOUSEHOLD), [{ setting: 0, draw_w: 0, heat_w: 0 }, { setting: 12, draw_w: 3764, heat_w: 12_450 }]);
  const circulating = idle();
  circulating.pool_w = quarters(i => i === 0 ? 764 : 0);
  const circulated = referee(c, HOUSEHOLD, TARGETS, circulating);
  assertEquals(circulated.violations, [{ quarter: 0, kind: 'pool_step', clipped_w: 764 }]);
  assertEquals(circulated.series.poolC, cold.series.poolC);
  // Full power from the start is what the scorer takes as reachable.
  heated.series.comfort!.poolReachableC.forEach((v, i) => assertAlmostEquals(v, heated.series.poolC[i]!, 0.006));
  // A battery at 40 % of 18 kWh cannot give 9.6 kW for a day: the surplus is clipped and reported.
  const drain = idle();
  drain.battery_discharge_w = quarters(i => i < 96 ? 9600 : 0);
  const drained = referee(c, HOUSEHOLD, TARGETS, drain);
  assert(drained.violations.some(v => v.kind === 'battery_empty'));
  assertAlmostEquals(Math.min(...drained.series.homeSoc as number[]), 5, 0.2);
  // Energy is conserved each quarter: load + charging − discharging − solar = import − export.
  const s = drained.series;
  for (const i of [0, 3, 100, 287]) {
    assertAlmostEquals(s.loadW[i] + s.batteryChargeW[i] - s.batteryDischargeW[i] - s.solarW[i], s.gridImportW[i] - s.gridExportW[i], 0.2);
  }
});

Deno.test('the pool cools and is heated the same whatever the weather', () => {
  const inAir = (airC: number, d: Decisions) => referee(loadCase(caseFromReplay(replay({ pool: { water_temperature_c: 30 } })).data,
    recorded({ outdoor_temperature_c: quarters(() => airC) })), HOUSEHOLD, TARGETS, d).series.poolC as number[];
  // Unheated at 30 °C it loses about 2.1 kW to its surroundings, a third of a degree in ten hours, in frost as in a heat wave.
  assertEquals(inAir(-5, idle()), inAir(32, idle()));
  assertAlmostEquals(30 - inAir(12, idle())[39], 0.333, 0.005);
  // An hour of the heat pump gives 12.45 kWh of heat for 3.76 kWh from the grid, in any air: COP is the machine's, at its setting.
  const hour = idle();
  for (let i = 0; i < 4; i++) hour.pool_w[i] = POOL_W;
  assertEquals(inAir(-5, hour), inAir(32, hour));
  assertAlmostEquals(inAir(12, hour)[3] - inAir(12, idle())[3], 12.45 / 63.965, 0.001);
});

Deno.test('an evaluation is derived wholly from the stored decisions', () => {
  const c = loadCase({ ...caseFromReplay(replay()).data, comfort: TARGETS }, recorded());
  const record: PlanRecord = { status: 'ready', generation: 'snapshot', valuation: { scale: 1, pool: 'none', ev: 'none', battery: 'none' }, decisions: idle(), beliefs: { import_sek_per_kwh: quarters(() => 2), grid_cost_sek: 1 }, curves: [] };
  const first = evaluate(c, record, {}, 'told/nominal'), again = evaluate(c, structuredClone(record), {}, 'told/nominal');
  assertEquals(first, again);
  assertEquals(first.series.believedImportPrice![0], 2);
  assertEquals(first.series.importPrice[0], 1);
  // The audit is part of the stored account, made for the plan's own lane; the default lane is the live one.
  assertEquals([first.series.audit!.lane, first.series.audit!.status, first.score.audit.lane], ['told/nominal', 'complete', 'told/nominal']);
  assertEquals(evaluate(c, record, {}), first);
  assertEquals(evaluate(c, record, {}, 'oracle/high').series.audit!.lane, 'oracle/high');
  // Criteria that cannot be scored with are refused before anything is replayed.
  assertThrows(() => evaluate(c, record, { pool_low: { points: 3 } }), CriteriaError);
});

Deno.test('the oracle lane tells the planner the real prices; refereeing never changes', () => {
  const c = loadCase(caseFromReplay(replay()).data, recorded());
  assertEquals(toldCase(c, 'told/high'), c);
  const oracle = toldCase(c, 'oracle/low');
  assertEquals(publishedQuarters(oracle), QUARTERS);
  assertEquals(oracle.known_prices.import_sek_per_kwh, c.recorded.prices.import_sek_per_kwh);
  assertEquals(oracle.recorded, c.recorded);
  assertAlmostEquals(laneParts('told/high').scale * laneParts('told/low').scale, 1);
});

Deno.test('the diagnosis splits a plan\'s cost into the price estimate and the valuation', () => {
  const lane = (cost_sek: number, points = 0, credit_sek = 0) => ({ cost_sek, credit_sek, points });
  assertEquals(diagnose({ 'told/nominal': lane(100) }), null);
  const d = diagnose({
    'told/low': lane(104), 'told/nominal': lane(100, 0, 10), 'told/high': lane(80, -3),
    'oracle/low': lane(60), 'oracle/nominal': lane(70), 'oracle/high': lane(75),
  })!;
  // Net of what is left in the stores: 90. Real prices would have saved 20; a lower valuation another 10.
  assertEquals([d.net_sek, d.price_estimate_sek, d.valuation_sek], [90, 20, 10]);
  // The cheaper told variant scored worse, so it is not "best".
  assertEquals(d.best, { told: 'nominal', oracle: 'low' });
});
