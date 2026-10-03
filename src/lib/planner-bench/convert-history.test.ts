import { assertEquals, assertThrows } from '@std/assert';
import { loadCase, publishedQuarters, QUARTERS, type PriceHistory } from './case.ts';
import { caseFromHourlyHistory, HistoryFormatError, HOURS } from './convert-history.ts';

const hourly = <T>(make: (i: number) => T): T[] => Array.from({ length: HOURS }, (_, i) => make(i));

/** Three days from local midnight in Stockholm (summer time), the pool heating in the second hour. */
const history = (over: Record<string, unknown> = {}) => ({
  format: 'shs-bench-hourly-history',
  start: '2026-07-16T22:00:00Z',
  timezone: 'Europe/Stockholm',
  location: { latitude: 59.4, longitude: 18 },
  source: 'a summer window',
  hourly: {
    load_kwh: hourly(i => i === 1 ? 4.5 : 1),
    solar_kwh: hourly(i => i % 24 === 12 ? 8 : 0),
    planned_devices_kwh: { 'sensor.pool_heater_energy': hourly(i => i === 1 ? 3.4 : 0), 'sensor.pool_pump_energy': hourly(i => i === 1 ? 0.4 : 0) },
    outdoor_temperature_c: hourly(i => 15 + i / 10),
  },
  start_state: { battery_soc: 0.3, pool_water_c: 29.9, ev: { soc: 0.8, target_soc: 0.8 } },
  ...over,
});

/** Two days of prices before a window and the window itself. */
const prices = (windowStart = '2026-07-16T22:00:00Z'): PriceHistory => ({
  start: new Date(Date.parse(windowStart) - 192 * 900_000).toISOString(),
  import_sek_per_kwh: Array.from({ length: 192 + QUARTERS }, (_, i) => 1 + i / 1000),
  export_sek_per_kwh: Array.from({ length: 192 + QUARTERS }, () => 0.4),
});

Deno.test('hourly history becomes a test case: what was measured is the forecast, and the load is less the planned devices', () => {
  const { data, recorded } = caseFromHourlyHistory(history(), prices(), { zone: 'SE3', days: [{ day: '2026-07-17', mean_speed_m_s: 4 }] });
  const c = loadCase(data, recorded);
  assertEquals([c.origin.kind, c.origin.detail, c.start], ['history', 'a summer window', '2026-07-16T22:00:00.000Z']);
  // An hour's energy is the average power of its four quarters.
  assertEquals(c.solar_forecast_w.slice(47, 53), [0, 8000, 8000, 8000, 8000, 0]);
  // The pool's 3.8 kWh is not base load: the household plans the pool itself.
  assertEquals(c.base_load_forecast_w.slice(3, 9), [1000, 700, 700, 700, 700, 1000]);
  assertEquals(c.recorded.actual, { base_load_w: c.base_load_forecast_w, solar_w: c.solar_forecast_w });
  assertEquals(c.recorded.outdoor_temperature_c.slice(3, 5), [15, 15.1]);
  assertEquals(c.recorded.wind?.days.length, 1);
  // What came before the start is the price history; the window is priced in full.
  assertEquals([c.recorded.history.prices.import_sek_per_kwh.length, c.recorded.prices.import_sek_per_kwh[0]], [192, 1.192]);
});

Deno.test('prices are known to the end of today, and of tomorrow from early afternoon', () => {
  // Local midnight: today's 96 quarters.
  assertEquals(publishedQuarters(caseFromHourlyHistory(history(), prices()).data), 96);
  // 12:00 local: still only the rest of today.
  const noon = caseFromHourlyHistory(history({ start: '2026-07-17T10:00:00Z' }), prices('2026-07-17T10:00:00Z')).data;
  assertEquals(publishedQuarters(noon), 48);
  // 13:00 local: tomorrow's prices are out.
  const afternoon = caseFromHourlyHistory(history({ start: '2026-07-17T11:00:00Z' }), prices('2026-07-17T11:00:00Z')).data;
  assertEquals(publishedQuarters(afternoon), 44 + 96);
  assertEquals(afternoon.known_prices.export_sek_per_kwh[140], null);
});

Deno.test('history that does not describe a whole window is refused', () => {
  assertThrows(() => caseFromHourlyHistory({ format: 'something-else' }, prices()), HistoryFormatError);
  assertThrows(() => caseFromHourlyHistory(history({ start: '2026-07-16T22:15:00Z' }), prices()), HistoryFormatError);
  const short = history();
  short.hourly.solar_kwh = short.hourly.solar_kwh.slice(1);
  assertThrows(() => caseFromHourlyHistory(short, prices()), HistoryFormatError, 'solar_kwh');
  // Prices that end before the window does, or miss a quarter of it.
  const cut = prices();
  cut.import_sek_per_kwh = cut.import_sek_per_kwh.slice(0, -1);
  assertThrows(() => caseFromHourlyHistory(history(), cut), HistoryFormatError, 'prices');
  const gap = prices();
  gap.export_sek_per_kwh[200] = null;
  assertThrows(() => caseFromHourlyHistory(history(), gap), HistoryFormatError, 'prices');
  // Device meters that read more than the house drew, in more than the odd hour.
  const miscounted = history();
  miscounted.hourly.planned_devices_kwh['sensor.pool_heater_energy'] = hourly(i => i < 3 ? 2 : 0);
  assertThrows(() => caseFromHourlyHistory(miscounted, prices()), HistoryFormatError, 'meters');
});
