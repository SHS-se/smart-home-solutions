// A planner bench test case (docs/planner-bench/test-cases.md).
//
// A 72-hour scenario in the bench's own format: 288 quarters of what a planner
// is told, plus what was recorded for the same window afterwards. It carries no
// planner schema and no planner output; the adapter (bench/adapter.ts) is the
// only code that turns one into a planner's input.
//
// Two parts with two writers. `BenchScenarioData` is authored: made by a
// converter, edited on the bench page. `BenchRecorded` is filled by the runner
// from recorded history once the window has passed. Planners are shown the
// first and never the second's prices; the referee scores with the second.

export const QUARTERS = 288;
export const QUARTER_MS = 15 * 60_000;
export const CASE_FORMAT = 'shs-bench-case';
export const CASE_VERSION = 1;

/** One value per quarter. */
export type Series = number[];

export interface CaseStartState {
  battery_soc: number;
  pool_water_c: number;
  /** `target_soc` is the car's own charge limit, not a wish; the car is planned whether plugged in or not. */
  ev: { soc: number; target_soc: number };
}

/** What the owner wants: one number per store, in its own unit. Never money, never a band. */
export interface Targets {
  pool_c: number;
  ev_km: number;
}

export interface BenchScenarioData {
  format: typeof CASE_FORMAT;
  version: typeof CASE_VERSION;
  origin: { kind: 'replay' | 'history' | 'manual'; detail: string; created_at: string };
  /** First quarter, UTC, on a quarter boundary. The planner's "now". */
  start: string;
  timezone: string;
  location: { latitude: number; longitude: number };
  /** Prices known at the start; null from the first quarter the market had not published. */
  known_prices: { import_sek_per_kwh: (number | null)[]; export_sek_per_kwh: (number | null)[] };
  /** What the planner is told the panels will produce. */
  solar_forecast_w: Series;
  /** Everything the bench household does not plan, as fixed demand. */
  base_load_forecast_w: Series;
  /** The devices folded into base load, kept apart so the household can take one over later. */
  other_devices_w: Record<string, Series>;
  start_state: CaseStartState;
  /**
   * Start states the source had no reading for, holding a default until the
   * runner replaces them from recorded history. An edit on the page clears it.
   */
  start_state_unread?: ('battery_soc' | 'pool_water_c' | 'ev_soc')[];
  /** Home's targets captured by the runner; null until the first planning run. */
  comfort: Partial<Targets> | null;
}

/** Prices before the start, oldest first, one row per quarter. */
export interface PriceHistory {
  start: string;
  import_sek_per_kwh: (number | null)[];
  export_sek_per_kwh: (number | null)[];
}

/** Mean wind speed over the bidding zone for one UTC day. */
export interface WindDay {
  day: string;
  mean_speed_m_s: number;
}

/** One matured day before a case: what its base load was forecast to be the day before, and what it was. */
export interface DemandDay {
  day: string;
  forecast_kwh: number;
  actual_kwh: number;
}

export interface BenchRecorded {
  /** What electricity really cost in every quarter of the window. */
  prices: { import_sek_per_kwh: Series; export_sek_per_kwh: Series };
  /**
   * What the house really drew and the panels really gave. Planners never see
   * it; the referee carries the household through it instead of through the
   * forecasts. Absent on a window the home did not measure in full, which is
   * then refereed on the forecasts.
   */
  actual?: { base_load_w: Series; solar_w: Series };
  /** Measured at the house; given to planners as a perfect forecast. */
  outdoor_temperature_c: Series;
  solar_irradiance_w_per_m2: (number | null)[];
  /**
   * Observed daily wind over the zone, from weeks before the start to the end
   * of the window; given to planners as a perfect forecast, as the temperature
   * is. Absent on cases recorded before wind was kept.
   */
  wind?: { zone: string; days: WindDay[] };
  history: {
    prices: PriceHistory;
    /** Grid import per quarter from the start of the calendar month to the case start. */
    grid_import_kwh: { start: string; kwh: (number | null)[] };
    /**
     * The weeks before the start, day by day: base load as forecast against as
     * drawn. What a planner may level its forecast to. Absent on cases recorded
     * before it was kept.
     */
    demand_days?: DemandDay[];
  };
  recorded_at: string;
}

/** A case that can be run: both parts present and consistent. */
export interface BenchCase extends BenchScenarioData {
  recorded: BenchRecorded;
}

export class CaseFormatError extends Error {}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Planning and evaluation use the same captured targets, never internal defaults. */
export function caseTargets(data: Pick<BenchScenarioData, 'comfort'>): Targets {
  if (!finite(data.comfort?.pool_c) || !finite(data.comfort?.ev_km)) {
    throw new CaseFormatError('Comfort targets are missing. Run the bench with the home settings; local cases must supply comfort.pool_c and comfort.ev_km.');
  }
  return { pool_c: data.comfort.pool_c, ev_km: data.comfort.ev_km };
}

function series(value: unknown, name: string, nullable = false): void {
  if (!Array.isArray(value) || value.length !== QUARTERS) throw new CaseFormatError(`${name} must have ${QUARTERS} quarters.`);
  if (!value.every(v => finite(v) || (nullable && v === null))) throw new CaseFormatError(`${name} has a value that is not a number.`);
}

/** Leading quarters whose price was published at the start. */
export function publishedQuarters(data: BenchScenarioData): number {
  const { import_sek_per_kwh: buy, export_sek_per_kwh: sell } = data.known_prices;
  let count = 0;
  while (count < QUARTERS && buy[count] !== null && sell[count] !== null) count++;
  return count;
}

export function parseScenarioData(raw: unknown): BenchScenarioData {
  if (!isRecord(raw) || raw.format !== CASE_FORMAT) throw new CaseFormatError(`Not a bench test case (expected format "${CASE_FORMAT}").`);
  if (raw.version !== CASE_VERSION) throw new CaseFormatError(`Unknown test case version ${String(raw.version)}.`);
  const data = raw as unknown as BenchScenarioData;
  const start = Date.parse(data.start);
  if (!Number.isFinite(start) || start % QUARTER_MS !== 0) throw new CaseFormatError('start must be a UTC quarter boundary.');
  if (typeof data.timezone !== 'string' || !data.timezone) throw new CaseFormatError('timezone is missing.');
  if (!isRecord(data.location) || !finite(data.location.latitude) || !finite(data.location.longitude)) throw new CaseFormatError('location is missing.');
  if (!isRecord(data.known_prices)) throw new CaseFormatError('known_prices is missing.');
  series(data.known_prices.import_sek_per_kwh, 'known_prices.import_sek_per_kwh', true);
  series(data.known_prices.export_sek_per_kwh, 'known_prices.export_sek_per_kwh', true);
  if (publishedQuarters(data) === 0) throw new CaseFormatError('No price is published at the start.');
  series(data.solar_forecast_w, 'solar_forecast_w');
  series(data.base_load_forecast_w, 'base_load_forecast_w');
  if (!isRecord(data.other_devices_w)) throw new CaseFormatError('other_devices_w is missing.');
  for (const [key, values] of Object.entries(data.other_devices_w)) series(values, `other_devices_w.${key}`);
  const state = data.start_state;
  if (!isRecord(state) || !finite(state.battery_soc) || !finite(state.pool_water_c) || !isRecord(state.ev)
    || !finite(state.ev.soc) || !finite(state.ev.target_soc)) {
    throw new CaseFormatError('start_state is incomplete.');
  }
  return data;
}

export function parseRecorded(raw: unknown): BenchRecorded {
  if (!isRecord(raw) || !isRecord(raw.prices) || !isRecord(raw.history)) throw new CaseFormatError('recorded data is incomplete.');
  const recorded = raw as unknown as BenchRecorded;
  series(recorded.prices.import_sek_per_kwh, 'recorded.prices.import_sek_per_kwh');
  series(recorded.prices.export_sek_per_kwh, 'recorded.prices.export_sek_per_kwh');
  series(recorded.outdoor_temperature_c, 'recorded.outdoor_temperature_c');
  series(recorded.solar_irradiance_w_per_m2, 'recorded.solar_irradiance_w_per_m2', true);
  if (recorded.actual !== undefined) {
    if (!isRecord(recorded.actual)) throw new CaseFormatError('recorded.actual is malformed.');
    series(recorded.actual.base_load_w, 'recorded.actual.base_load_w');
    series(recorded.actual.solar_w, 'recorded.actual.solar_w');
  }
  const demand = recorded.history.demand_days;
  if (demand !== undefined && (!Array.isArray(demand)
    || !demand.every(d => isRecord(d) && typeof d.day === 'string' && finite(d.forecast_kwh) && finite(d.actual_kwh)))) {
    throw new CaseFormatError('recorded.history.demand_days is malformed.');
  }
  if (recorded.wind !== undefined && (!isRecord(recorded.wind) || !Array.isArray(recorded.wind.days)
    || !recorded.wind.days.every(d => isRecord(d) && typeof d.day === 'string' && finite(d.mean_speed_m_s)))) {
    throw new CaseFormatError('recorded.wind is malformed.');
  }
  return recorded;
}

export function loadCase(data: unknown, recorded: unknown): BenchCase {
  return { ...parseScenarioData(data), recorded: parseRecorded(recorded) };
}

export const quarterStarts = (start: string): string[] =>
  Array.from({ length: QUARTERS }, (_, i) => new Date(Date.parse(start) + i * QUARTER_MS).toISOString());

/** Stable JSON: object keys sorted, so equal content gives equal text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
