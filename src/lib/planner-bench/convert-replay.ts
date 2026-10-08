// Turn a downloaded plan replay into a bench test case.
//
// The only code that reads replay files. It keeps the moment the replay
// describes (prices known then, solar and load forecasts, device readings) and
// drops everything that was another planner's work or that home's setup of
// the day: the price outlook, value curves, the battery cost curve, the
// previous plan, operating modes. What a planner is given instead comes from
// the bench household and the case (bench/adapter.ts).

import {
  CASE_FORMAT, CASE_VERSION, QUARTERS, QUARTER_MS, parseScenarioData,
  type BenchScenarioData, type Series,
} from './case';

export const REPLAY_FORMAT = 'shs-energy-optimisation-quarter-replay';

export class ReplayFormatError extends Error {}

export interface ConvertedReplay {
  data: BenchScenarioData;
  /** Suggested case name; the uploader can change it. */
  suggestedName: string;
}

/** Start states used when neither the replay nor recorded history has a reading. */
export const DEFAULT_START_STATE = { battery_soc: 0.5, pool_water_c: 29, ev_soc: 0.5, ev_target_soc: 0.8 };

/** The meters the bench household plans itself, so their forecasts are not base load. */
const POOL_METERS = new Set(['sensor.pool_pump_energy', 'sensor.pool_heater_energy']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;

interface ReplaySlot {
  start: string;
  pv_forecast_w: number;
  base_load_forecast_w: number;
  import_price_sek_per_kwh: number | null;
  export_price_sek_per_kwh: number | null;
}
interface ReplayDevice {
  key: string;
  category: string;
  planning_service?: string;
  forecast_w_by_slot: number[];
}

export function caseFromReplay(raw: unknown, detail = 'replay'): ConvertedReplay {
  if (!isRecord(raw) || raw.format !== REPLAY_FORMAT) {
    throw new ReplayFormatError(`Not a plan replay file (expected format "${REPLAY_FORMAT}").`);
  }
  const args = isRecord(raw.entrypoint) ? raw.entrypoint.arguments : undefined;
  const snapshot = isRecord(args) && isRecord(args.snapshot) ? args.snapshot : null;
  if (!snapshot) throw new ReplayFormatError('The replay has no planner snapshot (entrypoint.arguments.snapshot).');
  const slots = snapshot.slots as ReplaySlot[] | undefined;
  if (!Array.isArray(slots) || slots.length !== QUARTERS) {
    throw new ReplayFormatError(`The replay must cover ${QUARTERS} quarters; this one has ${Array.isArray(slots) ? slots.length : 0}.`);
  }
  const start = Date.parse(slots[0].start);
  if (!slots.every((slot, i) => Date.parse(slot.start) === start + i * QUARTER_MS)) {
    throw new ReplayFormatError('The replay quarters are not consecutive.');
  }

  // Published prices stop at the first gap; nothing after it was known.
  let published = true;
  const buy: (number | null)[] = [], sell: (number | null)[] = [];
  for (const slot of slots) {
    published &&= num(slot.import_price_sek_per_kwh) !== null && num(slot.export_price_sek_per_kwh) !== null;
    buy.push(published ? slot.import_price_sek_per_kwh : null);
    sell.push(published ? slot.export_price_sek_per_kwh : null);
  }

  // The home's own forecast correction is part of the forecast, not of a planner.
  const captured = Date.parse(String(snapshot.captured_at));
  const factors = (isRecord(snapshot.pv_calibration) ? snapshot.pv_calibration.correction_factor_by_lead_day : null) as number[] | null;
  const solar: Series = slots.map(slot => {
    if (!factors?.length) return Math.max(0, slot.pv_forecast_w);
    const lead = Math.max(0, Math.min(factors.length - 1, Math.floor((Date.parse(slot.start) - captured) / 86_400_000)));
    return Math.max(0, slot.pv_forecast_w * factors[lead]);
  });

  const others: Record<string, Series> = {};
  for (const device of (snapshot.device_models ?? []) as ReplayDevice[]) {
    const owned = device.category === 'ev_charging' || device.planning_service === 'pool' || POOL_METERS.has(device.key);
    if (owned || !Array.isArray(device.forecast_w_by_slot) || device.forecast_w_by_slot.length !== QUARTERS) continue;
    others[device.key] = device.forecast_w_by_slot.map(w => Math.max(0, num(w) ?? 0));
  }
  const baseLoad: Series = slots.map((slot, i) =>
    Math.max(0, slot.base_load_forecast_w) + Object.values(others).reduce((sum, series) => sum + series[i], 0));

  const battery = isRecord(snapshot.battery) ? snapshot.battery : null;
  const pool = isRecord(snapshot.pool) ? snapshot.pool : null;
  const car = isRecord(snapshot.ev_battery) ? snapshot.ev_battery : null;
  const unread: NonNullable<BenchScenarioData['start_state_unread']> = [];
  const reading = (value: unknown, fallback: number, name: (typeof unread)[number]) => {
    const read = num(value);
    if (read === null) unread.push(name);
    return read ?? fallback;
  };
  const location = [snapshot.location, isRecord(snapshot.sources) && isRecord(snapshot.sources.pv) ? snapshot.sources.pv.location : null]
    .find((l): l is { latitude: number; longitude: number } => isRecord(l) && num(l.latitude) !== null && num(l.longitude) !== null);
  if (!location) throw new ReplayFormatError('The replay does not say where the home is.');

  const data: BenchScenarioData = {
    format: CASE_FORMAT,
    version: CASE_VERSION,
    origin: { kind: 'replay', detail, created_at: new Date().toISOString() },
    start: new Date(start).toISOString(),
    timezone: typeof snapshot.timezone === 'string' ? snapshot.timezone : 'Europe/Stockholm',
    location: { latitude: location.latitude, longitude: location.longitude },
    known_prices: { import_sek_per_kwh: buy, export_sek_per_kwh: sell },
    solar_forecast_w: solar,
    base_load_forecast_w: baseLoad,
    other_devices_w: others,
    start_state: {
      battery_soc: reading(battery?.soc, DEFAULT_START_STATE.battery_soc, 'battery_soc'),
      pool_water_c: reading(pool?.water_temperature_c, DEFAULT_START_STATE.pool_water_c, 'pool_water_c'),
      pool_heater: replayHeaterState(pool),
      ev: {
        soc: reading(car?.soc, DEFAULT_START_STATE.ev_soc, 'ev_soc'),
        target_soc: num(car?.departure_target_soc) ?? DEFAULT_START_STATE.ev_target_soc,
      },
    },
    ...(unread.length ? { start_state_unread: unread } : {}),
    comfort: null,
  };
  try {
    parseScenarioData(data);
  } catch (error) {
    throw new ReplayFormatError((error as Error).message);
  }
  return { data, suggestedName: `Case ${data.start.slice(0, 16).replace('T', ' ')} UTC` };
}

/** Capture command memory; power meters cannot identify startup or steady state. */
function replayHeaterState(pool: Record<string, unknown> | null): import('../../../supabase/functions/_shared/planner/device-models').HeaterState {
  if (pool?.heating_running !== true) return { kind: 'off_unobserved' };
  const age = num(pool.heating_elapsed_seconds);
  if (age === null || age < 0) throw new ReplayFormatError('A running pool heater needs its captured elapsed seconds.');
  return { kind: 'running', seconds: age };
}
