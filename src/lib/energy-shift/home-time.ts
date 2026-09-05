/**
 * Every clock this planner shows belongs to the home, not to whoever is
 * looking at it.
 *
 * A plan is a schedule for a building: its quarters, its day boundaries and
 * the prices attached to them are all fixed to the wall clock at the house.
 * Rendering them in the reader's timezone moved the whole day whenever that
 * reader travelled, and for anyone a few hours away it split the house's day
 * across two calendar dates — so a day's totals described a slice of time the
 * building never experienced. The hour is always shown on a 24-hour clock for
 * a related reason: a schedule scanned at a glance cannot afford an am/pm to
 * be the only thing separating a cheap night hour from an expensive morning
 * one.
 *
 * The zone comes from Home Assistant, which is the machine that decided where
 * a quarter began in the first place. The fallback below is only for a plan
 * pushed before the integration started sending one.
 *
 * Locale is deliberately left to the reader: it decides whether a date reads
 * as 09/05 or 05/09, which changes nothing about *which* moment is shown.
 */

export const FALLBACK_HOME_TIME_ZONE = 'Europe/Stockholm';

/** Anything the portal holds a timestamp in. */
export type TimeValue = string | number | Date;

const toMs = (value: TimeValue): number => (
  value instanceof Date ? value.getTime()
    : typeof value === 'number' ? value
      : Date.parse(value)
);

// Intl formatters are expensive to build and these run once per chart row, so
// each distinct shape is built once and kept.
const formatterCache = new Map<string, Intl.DateTimeFormat>();

const formatter = (
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
  locale?: string,
): Intl.DateTimeFormat => {
  const key = `${locale ?? ''}|${timeZone}|${JSON.stringify(options)}`;
  const found = formatterCache.get(key);
  if (found) return found;
  const built = new Intl.DateTimeFormat(locale, { ...options, timeZone });
  formatterCache.set(key, built);
  return built;
};

const PART_OPTIONS: Intl.DateTimeFormatOptions = {
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
};

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall-clock fields an instant carries in one zone. */
const zonedParts = (utcMs: number, timeZone: string): ZonedParts => {
  const parts = formatter(timeZone, PART_OPTIONS, 'en-US')
    .formatToParts(new Date(utcMs));
  const field = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find(candidate => candidate.type === type);
    return part ? Number(part.value) : 0;
  };
  return {
    year: field('year'),
    month: field('month'),
    day: field('day'),
    // h23 renders midnight as 00, so this never has to undo a 24.
    hour: field('hour'),
    minute: field('minute'),
    second: field('second'),
  };
};

/** How far ahead of UTC the zone is at that instant, in milliseconds. */
const zoneOffsetMs = (utcMs: number, timeZone: string): number => {
  const parts = zonedParts(utcMs, timeZone);
  const asIfUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  // Date.UTC carries no milliseconds, so compare against a whole second.
  return asIfUtc - Math.floor(utcMs / 1000) * 1000;
};

/**
 * The instant at which a given calendar date begins in the zone.
 *
 * Solved rather than computed: the offset that converts wall time to an
 * instant is itself a function of the instant, so the first guess is corrected
 * once against the offset actually in force there. That second pass is what
 * makes the day after a DST change start at midnight rather than at 23:00 or
 * 01:00.
 */
const startOfZonedDate = (
  year: number,
  month: number,
  day: number,
  timeZone: string,
): number => {
  const wall = Date.UTC(year, month - 1, day, 0, 0, 0);
  const guess = wall - zoneOffsetMs(wall, timeZone);
  return wall - zoneOffsetMs(guess, timeZone);
};

/**
 * Midnight-to-midnight bounds for the home's day, `offset` days from the one
 * containing `nowMs`. Built from calendar fields rather than 24-hour
 * arithmetic so a day stays a day across a DST change.
 */
export const homeDayBounds = (
  nowMs: number,
  offset: number,
  timeZone: string,
): { startMs: number; endMs: number } => {
  const today = zonedParts(nowMs, timeZone);
  // Walked as a UTC calendar purely to borrow month-length and leap-year
  // rules; only the resulting year/month/day are used.
  const target = new Date(Date.UTC(today.year, today.month - 1, today.day));
  target.setUTCDate(target.getUTCDate() + offset);
  const next = new Date(target);
  next.setUTCDate(next.getUTCDate() + 1);
  return {
    startMs: startOfZonedDate(
      target.getUTCFullYear(),
      target.getUTCMonth() + 1,
      target.getUTCDate(),
      timeZone,
    ),
    endMs: startOfZonedDate(
      next.getUTCFullYear(),
      next.getUTCMonth() + 1,
      next.getUTCDate(),
      timeZone,
    ),
  };
};

/**
 * The hour and minute an instant falls on at the house.
 *
 * Chart ticks and the midnight divider are placed by asking which quarters sit
 * on the hour: done with `Date#getHours` they landed on the reader's hours, so
 * a reader an hour off the house saw the day divider drawn at 01:00 and the
 * six-hourly gridlines walk off the day.
 */
export const homeHourMinute = (
  value: TimeValue,
  timeZone: string,
): { hour: number; minute: number } => {
  const { hour, minute } = zonedParts(toMs(value), timeZone);
  return { hour, minute };
};

/** `14:30` at the house. */
export const formatHomeTime = (value: TimeValue, timeZone: string): string =>
  formatter(timeZone, { hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })
    .format(toMs(value));

/** `14:30:47` at the house, for the freshness lines that quote seconds. */
export const formatHomeTimeWithSeconds = (
  value: TimeValue,
  timeZone: string,
): string =>
  formatter(timeZone, {
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(toMs(value));

/** The house's calendar day, in the reader's own field order. */
export const formatHomeDayMonth = (value: TimeValue, timeZone: string): string =>
  formatter(timeZone, { day: '2-digit', month: '2-digit' }).format(toMs(value));

/** Day and clock together, for chart labels and tooltips. */
export const formatHomeDayMonthTime = (
  value: TimeValue,
  timeZone: string,
): string =>
  formatter(timeZone, {
    hourCycle: 'h23',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(toMs(value));

/** Full date and time, for the "issued at" provenance lines. */
export const formatHomeStamp = (value: TimeValue, timeZone: string): string =>
  formatter(timeZone, {
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(toMs(value));

/**
 * A zone this browser can actually resolve, or the fallback.
 *
 * A stored zone is whatever Home Assistant reported, and an unknown name would
 * otherwise throw inside a formatter on every chart row.
 */
export const resolveHomeTimeZone = (candidate: string | null | undefined): string => {
  if (!candidate) return FALLBACK_HOME_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return candidate;
  } catch {
    return FALLBACK_HOME_TIME_ZONE;
  }
};
