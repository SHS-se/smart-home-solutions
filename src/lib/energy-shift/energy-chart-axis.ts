import { homeHourMinute } from './home-time';

/** Same local-time axis for live plans, bench cases and historical models. */
export function energyChartTicks(rows: readonly { startMs: number }[], timeZone: string, maxLabels = 16) {
  if (!Number.isSafeInteger(maxLabels) || maxLabels < 1) throw new Error('Axis label limit must be a positive integer');
  const ticks = rows.map((row, index) => ({ index, date: new Date(row.startMs), ...homeHourMinute(row.startMs, timeZone) }));
  const midnights = ticks.filter(tick => tick.index > 0 && tick.hour === 0 && tick.minute === 0);
  const hours = rows.length < 2 ? 0 : (rows.at(-1)!.startMs - rows[0].startMs) / 3_600_000;
  if (hours > 96) {
    const every = Math.ceil(midnights.length / maxLabels);
    return { hourTicks: [], dayTicks: midnights.filter((_, index) => index % every === 0) };
  }
  const every = rows.length > 200 ? 6 : rows.length > 100 ? 3 : 2;
  const hourly = ticks.filter(tick => tick.minute === 0 && tick.hour % every === 0);
  const stride = Math.ceil(hourly.length / maxLabels);
  return { hourTicks: hourly.filter((_, index) => index % stride === 0), dayTicks: midnights };
}
