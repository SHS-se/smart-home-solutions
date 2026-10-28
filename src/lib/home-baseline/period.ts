import { homeMonthBounds } from '../energy-shift/home-time';
import type { HomeModelCapture } from './home-physics';
import { frameStart, shiftFrame, QUARTER_MS } from './model';

export type BaselineView = 'frame' | 'month';
export interface BaselineAnchor { solarSizing?: import('./equipment').SolarSizing | null; snapshot: HomeModelCapture; earliestStart: string; latestEnd: string }
export interface BaselinePeriod { view: BaselineView; start: string; end: string }

export const periodKey = (period: BaselinePeriod) => `${period.view}|${period.start}|${period.end}`;
const iso = (ms: number) => new Date(ms).toISOString();
const frame = (end: string): BaselinePeriod => ({ view: 'frame', start: frameStart(end), end });
const month = (anchor: BaselineAnchor, at: string, offset = 0): BaselinePeriod => {
  const bounds = homeMonthBounds(at, offset, anchor.snapshot.timezone);
  return { view: 'month', start: iso(bounds.startMs), end: iso(Math.min(bounds.endMs, Date.parse(anchor.latestEnd))) };
};

export function latestPeriod(anchor: BaselineAnchor, view: BaselineView): BaselinePeriod {
  return view === 'frame' ? frame(anchor.latestEnd) : month(anchor, iso(Date.parse(anchor.latestEnd) - QUARTER_MS));
}

export function switchPeriodView(anchor: BaselineAnchor, period: BaselinePeriod, view: BaselineView): BaselinePeriod {
  return view === 'frame' ? frame(period.end) : month(anchor, iso(Date.parse(period.end) - QUARTER_MS));
}

export function stepPeriod(anchor: BaselineAnchor, period: BaselinePeriod, direction: -1 | 1): BaselinePeriod | null {
  if (direction === 1 && Date.parse(period.end) >= Date.parse(anchor.latestEnd)) return null;
  return period.view === 'month' ? month(anchor, period.start, direction)
    : frame(direction === -1 ? shiftFrame(period.end, -1) : iso(Math.min(Date.parse(shiftFrame(period.end, 1)), Date.parse(anchor.latestEnd))));
}

export function monthPeriod(anchor: BaselineAnchor, key: string): BaselinePeriod | null {
  const at = `${key}-15T12:00:00.000Z`;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key) || !Number.isFinite(Date.parse(at))) throw new Error('Choose a valid month');
  const period = month(anchor, at);
  return Date.parse(period.start) < Date.parse(period.end) ? period : null;
}

/** The existing RPC allows seven days; 672 quarters also stay below REST's row cap. */
export function historyWindows(period: Pick<BaselinePeriod, 'start' | 'end'>) {
  const windows: { start: string; end: string; count: number }[] = [];
  const end = Date.parse(period.end);
  for (let from = Date.parse(period.start); from < end; from += 7 * 24 * 3_600_000) {
    const to = Math.min(from + 7 * 24 * 3_600_000, end);
    windows.push({ start: iso(from), end: iso(to), count: (to - from) / QUARTER_MS });
  }
  return windows;
}
