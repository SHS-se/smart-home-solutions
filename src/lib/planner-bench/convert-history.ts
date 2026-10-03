// Turn a window of a home's hourly history into a bench test case.
//
// For a window the home's quarter tables do not reach: they begin in August
// 2026, while Home Assistant keeps hourly statistics for good. The history
// file holds what the house measured, hour by hour; the real prices of the
// window and of the weeks before it come from the caller
// (bench/seed-history.ts prices them with the home's own terms).
//
// No forecast of the time was kept, so what was measured is what a planner is
// told: a perfect forecast of sun, load and temperature. Prices are hidden from
// the first quarter the market had not published at the start, as in any case.

import { homeDayBounds, homeHourMinute } from '@/lib/energy-shift/home-time';
import {
  CASE_FORMAT, CASE_VERSION, QUARTERS, QUARTER_MS, parseRecorded, parseScenarioData,
  type BenchRecorded, type BenchScenarioData, type CaseStartState, type PriceHistory, type Series, type WindDay,
} from './case';

export const HISTORY_FORMAT = 'shs-bench-hourly-history';
export const HOURS = QUARTERS / 4;

/** Local hour by which the market has published the next day's prices. */
const NEXT_DAY_PUBLISHED_HOUR = 13;
/** The planned devices' meters reading this much more than the house drew in an hour is a miscount. */
const MISCOUNTED_KWH = 0.2;
/** Share of a window's hours that may be miscounted; more and the meters do not describe the house. */
const MAX_MISCOUNTED_SHARE = 0.02;

export class HistoryFormatError extends Error {}

export interface HourlyHistory {
  format: typeof HISTORY_FORMAT;
  /** First hour, UTC, on the hour. The planner's "now". */
  start: string;
  timezone: string;
  location: { latitude: number; longitude: number };
  /** Where the numbers came from, in words; kept as the case's origin. */
  source: string;
  /** One value per hour of the window. */
  hourly: {
    /** Everything the house drew. */
    load_kwh: number[];
    solar_kwh: number[];
    /** Meters of what the bench household plans itself (pool, car): taken out of the load. */
    planned_devices_kwh: Record<string, number[]>;
    outdoor_temperature_c: number[];
  };
  start_state: CaseStartState;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function hours(value: unknown, name: string): number[] {
  if (!Array.isArray(value) || value.length !== HOURS) throw new HistoryFormatError(`${name} must have ${HOURS} hours.`);
  if (!value.every(v => typeof v === 'number' && Number.isFinite(v))) throw new HistoryFormatError(`${name} has a value that is not a number.`);
  return value;
}

/** An hour's value held through its four quarters. */
const quarters = (hourly: number[]): Series => hourly.flatMap(value => [value, value, value, value]);
/** Energy over an hour as the average power through it. */
const watts = (kwh: number): number => Math.round(Math.max(0, kwh) * 1_000);

/**
 * The case a window of hourly history describes. `prices` are the real prices
 * per quarter from before the window to its end; what lies before the start is
 * kept as the case's price history.
 */
export function caseFromHourlyHistory(
  raw: unknown, prices: PriceHistory, wind?: { zone: string; days: WindDay[] },
): { data: BenchScenarioData; recorded: BenchRecorded } {
  if (!isRecord(raw) || raw.format !== HISTORY_FORMAT) {
    throw new HistoryFormatError(`Not an hourly history file (expected format "${HISTORY_FORMAT}").`);
  }
  const history = raw as unknown as HourlyHistory;
  const start = Date.parse(history.start);
  if (!Number.isFinite(start) || start % (4 * QUARTER_MS) !== 0) throw new HistoryFormatError('start must be a UTC hour boundary.');
  if (!isRecord(history.hourly) || !isRecord(history.hourly.planned_devices_kwh)) throw new HistoryFormatError('hourly series are missing.');
  const load = hours(history.hourly.load_kwh, 'load_kwh'), solar = hours(history.hourly.solar_kwh, 'solar_kwh');
  const temperature = hours(history.hourly.outdoor_temperature_c, 'outdoor_temperature_c');
  const planned = Object.entries(history.hourly.planned_devices_kwh).map(([key, values]) => hours(values, `planned_devices_kwh.${key}`));

  const base = load.map((kwh, i) => kwh - planned.reduce((sum, device) => sum + device[i], 0));
  const miscounted = base.filter(kwh => kwh < -MISCOUNTED_KWH).length;
  if (miscounted > MAX_MISCOUNTED_SHARE * HOURS) {
    throw new HistoryFormatError(`The planned devices' meters read more than the house drew in ${miscounted} hours.`);
  }

  const before = (start - Date.parse(prices.start)) / QUARTER_MS;
  if (!Number.isInteger(before) || before < 0) throw new HistoryFormatError('prices must start on a quarter at or before the window.');
  const buy = prices.import_sek_per_kwh.slice(before, before + QUARTERS), sell = prices.export_sek_per_kwh.slice(before, before + QUARTERS);
  if (buy.length !== QUARTERS || sell.length !== QUARTERS || [...buy, ...sell].some(price => price === null)) {
    throw new HistoryFormatError('prices do not cover every quarter of the window.');
  }
  // Tomorrow's prices are out from early afternoon; before that only today's are known.
  const tomorrowKnown = homeHourMinute(start, history.timezone).hour >= NEXT_DAY_PUBLISHED_HOUR;
  const knownUntil = homeDayBounds(start, tomorrowKnown ? 1 : 0, history.timezone).endMs;
  const known = (series: (number | null)[]) => series.map((price, i) => start + i * QUARTER_MS < knownUntil ? price : null);

  const baseLoad = quarters(base.map(watts)), solarW = quarters(solar.map(watts));
  const data: BenchScenarioData = {
    format: CASE_FORMAT,
    version: CASE_VERSION,
    origin: { kind: 'history', detail: String(history.source ?? 'hourly history'), created_at: new Date().toISOString() },
    start: new Date(start).toISOString(),
    timezone: history.timezone,
    location: history.location,
    known_prices: { import_sek_per_kwh: known(buy), export_sek_per_kwh: known(sell) },
    solar_forecast_w: solarW,
    base_load_forecast_w: baseLoad,
    other_devices_w: {},
    start_state: history.start_state,
    comfort: null,
  };
  const recorded: BenchRecorded = {
    prices: { import_sek_per_kwh: buy as number[], export_sek_per_kwh: sell as number[] },
    actual: { base_load_w: baseLoad, solar_w: solarW },
    outdoor_temperature_c: quarters(temperature),
    solar_irradiance_w_per_m2: new Array(QUARTERS).fill(null),
    ...(wind ? { wind } : {}),
    history: {
      prices: {
        start: prices.start,
        import_sek_per_kwh: prices.import_sek_per_kwh.slice(0, before),
        export_sek_per_kwh: prices.export_sek_per_kwh.slice(0, before),
      },
      // Neither is in hourly history: the month's grid import and the forecasts of the days before.
      grid_import_kwh: { start: new Date(start).toISOString(), kwh: [] },
      demand_days: [],
    },
    recorded_at: new Date().toISOString(),
  };
  try {
    return { data: parseScenarioData(data), recorded: parseRecorded(recorded) };
  } catch (error) {
    throw new HistoryFormatError((error as Error).message);
  }
}
