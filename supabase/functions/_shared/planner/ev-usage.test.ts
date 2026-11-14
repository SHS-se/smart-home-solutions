import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { fitWeekdayEvUsage, observedEvUsageDays, weekdayEvUsageKw, type EvUsageQuarter } from "./ev-usage.ts";

import { localDay } from "../planner-wasm/calendar.ts";

const utc = (at: number) => localDay(at, "UTC");
const stockholm = (at: number) => localDay(at, "Europe/Stockholm");
const quarter = 900_000, day = 96 * quarter;
const monday = Date.parse("2026-01-05T00:00:00Z");
const car = { capacity_kwh: 50, charge_efficiency: 0.8 };

/** Synthetic car that uses 2 kWh on its first Monday and stays parked the next. */
function observations(): EvUsageQuarter[] {
  return Array.from({ length: 8 * 96 + 1 }, (_, i) => {
    const charge = i === 64 ? 2.5 : 0;
    // 2 kWh added and 2 kWh used on Monday. Only the daily balance matters.
    return [monday + i * quarter, 0.6, charge];
  });
}

Deno.test("weekday arithmetic averages count measured zero usage days", () => {
  const capture = monday + 8 * day + quarter;
  const fit = fitWeekdayEvUsage(observations(), capture, utc, car);
  assertEquals(fit.usage, { days: [1, 2, 1, 1, 1, 1, 1], kwh: [0, 1, 0, 0, 0, 0, 0] });
  assertEquals(fit.gaps, 0);
});

Deno.test("latest late quarter leaves the prior weekday sample, while a later capture repairs the fit", () => {
  const capture = monday + 8 * day;
  const fit = fitWeekdayEvUsage(observations(), capture, utc, car);
  assertEquals(fit.usage!.kwh[1], 2);
  assertEquals(fit.late, true);
  assertEquals(fit.gaps, 0);
  assertEquals(fitWeekdayEvUsage(observations(), capture + quarter, utc, car).usage!.kwh[1], 1);
});

Deno.test("a middle hole or unavailable charge counter never passes for a no-use day", () => {
  const capture = monday + 8 * day + quarter;
  const rows = observations().filter(([start]) => start !== monday + 3 * day + 16 * quarter);
  rows[7 * 96 + 10] = [rows[7 * 96 + 10][0], 0.6, null];
  const result = fitWeekdayEvUsage(rows, capture, utc, car);
  assertEquals(result.gaps, 2);
  assertEquals(result.usage!.days[1], 1);
  assertEquals(result.usage!.kwh[1], 2);
  assertEquals(result.usage!.days[4], 0);
  assertAlmostEquals(result.usage!.kwh[4], 2 / 6);
  assertEquals(fitWeekdayEvUsage(rows.map(([start, soc]) => [start, soc, null]), capture, utc, car).usage, null);
});

Deno.test("the local Sunday average is preserved over a 25-hour clock-change day", () => {
  const start = Date.parse("2026-10-24T22:00:00Z");
  const starts = Array.from({ length: 100 }, (_, i) => new Date(start + i * quarter).toISOString());
  const kw = weekdayEvUsageKw({ days: [1, 1, 1, 1, 1, 1, 1], kwh: [10, 0, 0, 0, 0, 0, 0] }, starts, stockholm);
  assertAlmostEquals(kw.reduce((sum, value) => sum + value * 0.25, 0), 10);
  const rows: EvUsageQuarter[] = Array.from({ length: 101 }, (_, i) => [start + i * quarter, i === 100 ? 0.4 : 0.6, 0]);
  assertAlmostEquals(observedEvUsageDays(rows, start + 101 * quarter, stockholm, car)[0].kwh!, 10);
});
