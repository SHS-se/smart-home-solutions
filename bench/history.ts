// What the home recorded, for filling in a test case (docs/planner-bench/test-cases.md).
//
// A case made from a replay knows what was forecast at its start. What really
// happened over its 72 hours (prices, outdoor temperature) and what came before
// it (price history, the month's grid import) is read once from the quarter
// tables the home's Home Assistant fills, and stored with the case. Planner
// runs never read these tables.

import {
  QUARTERS, QUARTER_MS, quarterStarts,
  type BenchRecorded, type BenchScenarioData,
} from "../src/lib/planner-bench/case.ts";

/** The live planner reads this much price history; a case stores what exists of it. */
export const PRICE_HISTORY_DAYS = 60;
/** PostgREST returns at most this many rows per request. */
const PAGE = 1000;

export interface HistorySource {
  url: string;
  key: string;
  homeId: string;
}

type Row = Record<string, unknown> & { start_ts: string };

/** Every row of a quarter table between two instants, oldest first, however many pages it takes. */
async function quarterRows(source: HistorySource, table: string, columns: string, from: number, to: number): Promise<Row[]> {
  const out: Row[] = [];
  for (let offset = 0;; offset += PAGE) {
    const query = `${table}?select=start_ts,${columns}&home_id=eq.${source.homeId}`
      + `&start_ts=gte.${new Date(from).toISOString()}&start_ts=lt.${new Date(to).toISOString()}&order=start_ts`;
    const response = await fetch(`${source.url}/rest/v1/${query}`, {
      headers: { apikey: source.key, Authorization: `Bearer ${source.key}`, Range: `${offset}-${offset + PAGE - 1}` },
    });
    if (!response.ok) throw new Error(`${table}: ${response.status} ${await response.text()}`);
    const page = await response.json() as Row[];
    out.push(...page);
    if (page.length < PAGE) return out;
  }
}

/** Rows laid onto consecutive quarters from `from`; a quarter without a row, or without the value, is null. */
function onto(rows: Row[], column: string, from: number, count: number): (number | null)[] {
  const out: (number | null)[] = new Array(count).fill(null);
  for (const row of rows) {
    const index = (Date.parse(row.start_ts) - from) / QUARTER_MS;
    const value = row[column];
    if (Number.isInteger(index) && index >= 0 && index < count && typeof value === "number" && Number.isFinite(value)) out[index] = value;
  }
  return out;
}

/** Midnight at the start of the calendar month containing `ms`, in `timeZone`. */
function monthStart(ms: number, timeZone: string): number {
  const parts = (at: number) => Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(at)).map(p => [p.type, p.value]));
  const local = parts(ms);
  const guess = Date.UTC(Number(local.year), Number(local.month) - 1, 1);
  // The zone's offset at that instant: what its clock reads there, taken as if it were UTC.
  const read = parts(guess);
  const offset = Date.UTC(Number(read.year), Number(read.month) - 1, Number(read.day), Number(read.hour), Number(read.minute)) - guess;
  return guess - offset;
}

/** Days of wind before a case's start that are kept with it: what a planner fits its prices to. */
export const WIND_HISTORY_DAYS = 45;

/**
 * The zone's observed daily wind from weeks before a case's start to the end
 * of its window, or null until every day of the window has been observed.
 */
export async function recordedWind(source: HistorySource, zone: string, caseStart: string): Promise<NonNullable<BenchRecorded["wind"]> | null> {
  const start = Date.parse(caseStart);
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const first = day(start - WIND_HISTORY_DAYS * 86_400_000), last = day(start + QUARTERS * QUARTER_MS - 1);
  const query = `energy_market_wind_observed?select=day,mean_speed_m_s&zone=eq.${zone}&day=gte.${first}&day=lte.${last}&order=day`;
  const response = await fetch(`${source.url}/rest/v1/${query}`, { headers: { apikey: source.key, Authorization: `Bearer ${source.key}` } });
  // A database without the table yet has no wind to give; the case runs without it.
  if (!response.ok) return null;
  const days = (await response.json() as { day: string; mean_speed_m_s: number | string }[])
    .map(row => ({ day: row.day, mean_speed_m_s: Number(row.mean_speed_m_s) }));
  const held = new Set(days.map(entry => entry.day));
  for (let ms = start; day(ms) <= last; ms += 86_400_000) if (!held.has(day(ms))) return null;
  return { zone, days };
}

/** Share of a window's quarters in which the device meters may add up to more than the house drew. */
const MAX_MISCOUNTED_SHARE = 0.02;

/**
 * What the house drew apart from the pool and the car, and what the panels
 * gave, for every quarter of a case's window; null unless the home measured
 * all of it. The bench household plans the pool and the car itself, so their
 * measured energy is taken out; everything else is the base load a planner was
 * given a forecast of.
 */
export async function recordedActual(source: HistorySource, caseStart: string): Promise<NonNullable<BenchRecorded["actual"]> | null> {
  const start = Date.parse(caseStart);
  const rows = await quarterRows(source, "energy_optimisation_actual_slots",
    "total_load_kwh,solar_production_kwh,pool_heating_kwh,ev_charging_kwh", start, start + QUARTERS * QUARTER_MS);
  const total = onto(rows, "total_load_kwh", start, QUARTERS), solar = onto(rows, "solar_production_kwh", start, QUARTERS);
  const pool = onto(rows, "pool_heating_kwh", start, QUARTERS), car = onto(rows, "ev_charging_kwh", start, QUARTERS);
  if (total.some(v => v === null) || solar.some(v => v === null)) return null;
  const perHour = 1_000 / (QUARTER_MS / 3_600_000);
  const base = total.map((kwh, i) => (kwh! - (pool[i] ?? 0) - (car[i] ?? 0)) * perHour);
  // Meters that disagree in more than the odd quarter do not describe the house.
  if (base.filter(w => w < -200).length > MAX_MISCOUNTED_SHARE * QUARTERS) return null;
  return { base_load_w: base.map(w => Math.round(Math.max(0, w))), solar_w: solar.map(kwh => Math.round(Math.max(0, kwh! * perHour))) };
}

/** The home's matured days before a case's start: base load as forecast the day before, and as drawn. */
export async function recordedDemandDays(source: HistorySource, timezone: string, caseStart: string): Promise<NonNullable<BenchRecorded["history"]["demand_days"]> | null> {
  const response = await fetch(`${source.url}/rest/v1/rpc/energy_optimisation_demand_days`, {
    method: "POST",
    headers: { apikey: source.key, Authorization: `Bearer ${source.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_home_id: source.homeId, p_timezone: timezone, p_until: caseStart }),
  });
  // A database without the function yet has no evidence to give; the case runs without it.
  if (!response.ok) return null;
  return (await response.json() as { day: string; forecast_kwh: number | string; actual_kwh: number | string }[])
    .map(row => ({ day: row.day, forecast_kwh: Number(row.forecast_kwh), actual_kwh: Number(row.actual_kwh) }));
}

export interface Completion {
  /** Present when every quarter the case needs is recorded. */
  recorded: BenchRecorded | null;
  /** What is still missing, in words, when `recorded` is null. */
  missing: string | null;
  /** Start states the source had not read, now read from history. */
  startState: Partial<{ battery_soc: number; pool_water_c: number; ev_soc: number }>;
}

/** Read what a case needs from recorded history; `recorded` stays null until its whole window exists. */
export async function completeCase(source: HistorySource, data: BenchScenarioData, now = Date.now()): Promise<Completion> {
  const start = Date.parse(data.start);
  const end = start + QUARTERS * QUARTER_MS;
  if (now < end) return { recorded: null, missing: `measurement window ends ${new Date(end).toISOString()}`, startState: {} };
  const [prices, outdoor, actual] = await Promise.all([
    quarterRows(source, "energy_optimisation_price_slots", "import_price_sek_per_kwh,export_price_sek_per_kwh", start, end),
    quarterRows(source, "energy_optimisation_outdoor_slots", "temperature_c,solar_w_per_m2", start, end),
    recordedActual(source, data.start),
  ]);
  const buy = onto(prices, "import_price_sek_per_kwh", start, QUARTERS);
  const sell = onto(prices, "export_price_sek_per_kwh", start, QUARTERS);
  const temperature = onto(outdoor, "temperature_c", start, QUARTERS);

  // Start states the replay could not read: the last reading before the start.
  const startState: Completion["startState"] = {};
  const unread = data.start_state_unread ?? [];
  if (unread.length) {
    const before = start - 4 * QUARTER_MS;
    const last = (rows: Row[], column: string) => onto(rows, column, before, 4).filter((v): v is number => v !== null).at(-1);
    if (unread.includes("pool_water_c")) {
      const value = last(await quarterRows(source, "energy_optimisation_pool_slots", "water_temperature_c", before, start), "water_temperature_c");
      if (value !== undefined) startState.pool_water_c = value;
    }
    if (unread.includes("battery_soc") || unread.includes("ev_soc")) {
      const actuals = await quarterRows(source, "energy_optimisation_actual_slots", "battery_soc,ev_soc", before, start);
      const battery = last(actuals, "battery_soc"), car = last(actuals, "ev_soc");
      if (unread.includes("battery_soc") && battery !== undefined) startState.battery_soc = battery;
      if (unread.includes("ev_soc") && car !== undefined) startState.ev_soc = car;
    }
  }

  const gaps = (name: string, values: (number | null)[]) => {
    const count = values.filter(v => v === null).length;
    return count ? `${count} of ${QUARTERS} quarters of ${name}` : null;
  };
  const missing = [gaps("prices", buy.map((v, i) => v === null || sell[i] === null ? null : v)), gaps("outdoor temperature", temperature),
    actual ? null : "complete measured load and solar"]
    .filter(Boolean).join(" and ");
  if (missing) return { recorded: null, missing: `not yet recorded: ${missing}`, startState };

  // A case's known prices are a prefix of what was recorded; if they disagree the case is not this home's window.
  const disagree = quarterStarts(data.start).findIndex((_, i) => {
    const known = data.known_prices.import_sek_per_kwh[i];
    return known !== null && Math.abs(known - buy[i]!) > 0.0005;
  });
  if (disagree >= 0) {
    return { recorded: null, missing: `the case's published price at quarter ${disagree} differs from the recorded one`, startState };
  }

  const historyFrom = start - PRICE_HISTORY_DAYS * 86_400_000;
  const month = monthStart(start, data.timezone);
  const [history, imports] = await Promise.all([
    quarterRows(source, "energy_optimisation_price_slots", "import_price_sek_per_kwh,export_price_sek_per_kwh", historyFrom, start),
    quarterRows(source, "energy_optimisation_actual_slots", "grid_import_kwh", month, start),
  ]);
  const historyStart = history.length ? Date.parse(history[0].start_ts) : start;
  const historyCount = (start - historyStart) / QUARTER_MS;
  return {
    missing: null,
    startState,
    recorded: {
      actual: actual!,
      prices: { import_sek_per_kwh: buy as number[], export_sek_per_kwh: sell as number[] },
      outdoor_temperature_c: temperature as number[],
      solar_irradiance_w_per_m2: onto(outdoor, "solar_w_per_m2", start, QUARTERS),
      history: {
        prices: {
          start: new Date(historyStart).toISOString(),
          import_sek_per_kwh: onto(history, "import_price_sek_per_kwh", historyStart, historyCount),
          export_sek_per_kwh: onto(history, "export_price_sek_per_kwh", historyStart, historyCount),
        },
        grid_import_kwh: { start: new Date(month).toISOString(), kwh: onto(imports, "grid_import_kwh", month, (start - month) / QUARTER_MS) },
      },
      recorded_at: new Date().toISOString(),
    },
  };
}
