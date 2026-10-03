// Make test cases from a home's hourly history, from the command line.
//
//   deno run -A --sloppy-imports --config deno.json bench/seed-history.ts \
//     --market market.json --out <dir> NAME=path/to/history.json [...]
//
// For windows the home's quarter tables do not reach (they begin in August
// 2026). A history file is what the house measured hour by hour, taken from
// Home Assistant's long-term statistics, in the format
// src/lib/planner-bench/convert-history.ts reads. This prices its window and
// the 60 days before it as the home paid: the day-ahead spot price with the
// supplier's and the grid's terms of the day, the way backfill-energy-prices
// prices recorded history. No database is read; the market file carries the
// terms and the wind:
//
//   { "area": "SE3",
//     "supplier_versions": [ { "valid_from", "valid_to", "definition" } ],   // energy_supplier_versions
//     "grid_catalogue": { "timezone", "configuration", "profiles" },         // as backfill-energy-prices builds it
//     "wind": { "zone": "SE3", "days": [ { "day", "mean_speed_m_s" } ] } }   // energy_market_wind_observed; optional
//
// Writes <dir>/NAME.json as { name, dataset, recorded }: a complete case, which
// `run.ts --local <dir>` plans as it is and `seed.ts NAME=<dir>/NAME.json`
// adds to the bench.

import { QUARTERS, QUARTER_MS, type PriceHistory, type WindDay } from "../src/lib/planner-bench/case.ts";
import { caseFromHourlyHistory } from "../src/lib/planner-bench/convert-history.ts";
import { currentGridPrices, type GridTariffCatalogue } from "../supabase/functions/_shared/energy-grid-pricing.ts";
import { calculateSupplierPrice, parseSpotPriceIntervals } from "../supabase/functions/_shared/energy-supplier-pricing.ts";
import { PRICE_HISTORY_DAYS, WIND_HISTORY_DAYS } from "./history.ts";

const SPOT_SOURCE = "https://www.elprisetjustnu.se/api/v1/prices";
/** Spot days fetched at once: a polite neighbour to a free public API. */
const FETCH_CONCURRENCY = 8;
const DAY_MS = 86_400_000;

interface Market {
  area: string;
  supplier_versions: { valid_from: string; valid_to: string | null; definition: unknown }[];
  grid_catalogue: GridTariffCatalogue;
  wind?: { zone: string; days: WindDay[] };
}

const round = (value: number) => Math.round((value + Number.EPSILON) * 1e5) / 1e5;
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** The calendar date an instant falls on at the home. */
const localDay = (ms: number, timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));

/** What the home paid and was paid in each quarter of one local day, by quarter start; empty if the day has no spot price. */
async function pricedDay(day: string, market: Market): Promise<Map<number, [number, number]>> {
  const out = new Map<number, [number, number]>();
  const [year, month, date] = day.split("-");
  const response = await fetch(`${SPOT_SOURCE}/${year}/${month}-${date}_${market.area}.json`);
  const supplier = market.supplier_versions.find(v => v.valid_from <= day && (!v.valid_to || v.valid_to >= day));
  if (!response.ok || !supplier) {
    await response.body?.cancel();
    console.log(`  ${day}: ${supplier ? `no spot price (${response.status})` : "no supplier terms"}; left out.`);
    return out;
  }
  for (const interval of parseSpotPriceIntervals(await response.json())) {
    const start = Date.parse(interval.time_start);
    const energy = calculateSupplierPrice(interval, supplier.definition);
    const grid = currentGridPrices(market.grid_catalogue, new Date(start));
    if (grid === null) throw new Error(`${day}: no grid tariff version covers this date.`);
    out.set(start, [
      round(energy.supplier_import_price_sek_per_kwh + grid.import_price_sek_per_kwh),
      round(energy.supplier_export_price_sek_per_kwh + grid.export_price_sek_per_kwh),
    ]);
  }
  return out;
}

/** Real prices per quarter from `PRICE_HISTORY_DAYS` before a window to its end, starting at the first quarter that has one. */
async function prices(start: number, timeZone: string, market: Market): Promise<PriceHistory> {
  const from = start - PRICE_HISTORY_DAYS * DAY_MS, end = start + QUARTERS * QUARTER_MS;
  const days: string[] = [];
  // Stepping by less than a day visits every local date, whatever the clocks did.
  for (let ms = from; ms < end + DAY_MS / 2; ms += DAY_MS / 2) {
    const day = localDay(Math.min(ms, end - 1), timeZone);
    if (days.at(-1) !== day) days.push(day);
  }
  const priced = new Map<number, [number, number]>();
  for (let i = 0; i < days.length; i += FETCH_CONCURRENCY) {
    for (const day of await Promise.all(days.slice(i, i + FETCH_CONCURRENCY).map(d => pricedDay(d, market)))) {
      for (const [at, pair] of day) priced.set(at, pair);
    }
  }
  const first = [...priced.keys()].filter(at => at >= from).sort((a, b) => a - b)[0] ?? start;
  const at = Array.from({ length: (end - first) / QUARTER_MS }, (_, i) => priced.get(first + i * QUARTER_MS) ?? null);
  return {
    start: new Date(first).toISOString(),
    import_sek_per_kwh: at.map(pair => pair?.[0] ?? null),
    export_sek_per_kwh: at.map(pair => pair?.[1] ?? null),
  };
}

/** The market file's wind from weeks before a window to its end, or nothing unless every day of the window is in it. */
function windFor(start: number, market: Market): Market["wind"] {
  if (!market.wind) return undefined;
  const first = utcDay(start - WIND_HISTORY_DAYS * DAY_MS), last = utcDay(start + QUARTERS * QUARTER_MS - 1);
  const days = market.wind.days.filter(entry => entry.day >= first && entry.day <= last);
  const held = new Set(days.map(entry => entry.day));
  for (let ms = start; utcDay(ms) <= last; ms += DAY_MS) if (!held.has(utcDay(ms))) return undefined;
  return { zone: market.wind.zone, days };
}

let marketPath: string | undefined, out: string | undefined;
const files: string[] = [];
for (let i = 0; i < Deno.args.length; i++) {
  if (Deno.args[i] === "--market") marketPath = Deno.args[++i];
  else if (Deno.args[i] === "--out") out = Deno.args[++i];
  else files.push(Deno.args[i]);
}
if (!marketPath || !out) throw new Error("Usage: seed-history.ts --market <market.json> --out <dir> NAME=path/to/history.json [...]");
const market: Market = JSON.parse(await Deno.readTextFile(marketPath));
await Deno.mkdir(out, { recursive: true });

for (const arg of files) {
  const at = arg.indexOf("=");
  if (at < 1) throw new Error(`Expected NAME=path, got ${arg}`);
  const name = arg.slice(0, at), history = JSON.parse(await Deno.readTextFile(arg.slice(at + 1)));
  console.log(`${name}: pricing ${PRICE_HISTORY_DAYS} days of history and the window.`);
  const start = Date.parse(history.start);
  const { data, recorded } = caseFromHourlyHistory(history, await prices(start, history.timezone, market), windFor(start, market));
  await Deno.writeTextFile(`${out}/${name}.json`, JSON.stringify({ name, dataset: data, recorded }));
  const kwh = (series: number[], day: number) => (series.slice(day * 96, day * 96 + 96).reduce((sum, w) => sum + w, 0) / 4_000).toFixed(1);
  console.log(`${name}: 72 hours from ${data.start}; sun ${[0, 1, 2].map(day => kwh(data.solar_forecast_w, day)).join(" / ")} kWh,`
    + ` base load ${[0, 1, 2].map(day => kwh(data.base_load_forecast_w, day)).join(" / ")} kWh,`
    + ` ${recorded.history.prices.import_sek_per_kwh.length / 96} days of price history, ${recorded.wind ? `${recorded.wind.days.length} days of wind` : "no wind"}.`);
}
