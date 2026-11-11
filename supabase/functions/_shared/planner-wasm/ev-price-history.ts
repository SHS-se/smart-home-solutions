import type { StoredPriceRow } from "../planner/energy-price-shape.ts";
import { localDay } from "./calendar.ts";

const QUARTER_MS = 900_000;
const WINDOW_QUARTERS = 16;

/** A low-tail price for a useful block of energy, from the home's settled import archive.
 * Missing quarters break a window. The day of capture never enters its own reference. */
export function evReplacementPrice(rows: readonly StoredPriceRow[], asOf: string, timeZone: string): number | null {
  const captureDay = localDay(asOf, timeZone);
  const captureMs = Date.parse(asOf);
  const quarters = new Map<number, number>();
  for (const row of rows) {
    const time = Date.parse(row.start_ts);
    if (Number.isFinite(time) && time + QUARTER_MS <= captureMs &&
      typeof row.import_price_sek_per_kwh === "number" && Number.isFinite(row.import_price_sek_per_kwh)) {
      quarters.set(time, row.import_price_sek_per_kwh);
    }
  }
  const daily = new Map<string, number>();
  const window: number[] = [];
  let total = 0;
  let previous = -Infinity;
  let previousDay = "";
  for (const [time, price] of [...quarters].sort(([a], [b]) => a - b)) {
    const day = localDay(new Date(time).toISOString(), timeZone);
    if (day >= captureDay) break;
    if (time !== previous + QUARTER_MS || day !== previousDay) {
      window.length = 0;
      total = 0;
    }
    previous = time;
    previousDay = day;
    window.push(price);
    total += price;
    if (window.length > WINDOW_QUARTERS) total -= window.shift()!;
    if (window.length === WINDOW_QUARTERS) {
      daily.set(day, Math.min(daily.get(day) ?? Infinity, total / WINDOW_QUARTERS));
    }
  }
  const best = [...daily.values()].sort((a, b) => a - b);
  if (!best.length) return null;
  // Negative prices retain their full in-window value. Waiting for one does
  // not give stored charge a negative closing value in this approximation.
  return Math.max(0, best[Math.floor(0.1 * (best.length - 1))]);
}
