import {
  FALLBACK_HOME_TIME_ZONE,
  formatHomeDayMonthTime,
  formatHomeStamp,
  formatHomeTime,
  formatHomeTimeWithSeconds,
  homeDayBounds,
  homeHourMinute,
  resolveHomeTimeZone,
} from './home-time.ts';

const assertEquals = (actual: unknown, expected: unknown, message: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
};

const assert = (value: boolean, message: string) => {
  if (!value) throw new Error(message);
};

const STOCKHOLM = 'Europe/Stockholm';
const at = (iso: string) => Date.parse(iso);

Deno.test('the hour shown is the hour at the house, not where it is read', () => {
  // 07:30 UTC is 09:30 in Stockholm and 00:30 in Los Angeles. Only the zone
  // argument decides, so the reader's own clock cannot move it.
  const instant = '2026-09-05T07:30:00Z';
  assertEquals(formatHomeTime(instant, STOCKHOLM), '09:30', 'at the house');
  assertEquals(formatHomeTime(instant, 'America/Los_Angeles'), '00:30', 'elsewhere');
});

Deno.test('the clock is 24-hour wherever the reader lives', () => {
  // The reported bug: this rendered as "9:30:47 AM".
  assertEquals(
    formatHomeTimeWithSeconds('2026-09-05T07:30:47Z', STOCKHOLM),
    '09:30:47',
    'morning keeps its leading zero',
  );
  assertEquals(
    formatHomeTime('2026-09-05T19:05:00Z', STOCKHOLM),
    '21:05',
    'the afternoon is where a 12-hour clock would differ',
  );
  assertEquals(
    formatHomeTime('2026-09-04T22:00:00Z', STOCKHOLM),
    '00:00',
    'midnight is 00, never 24',
  );
});

Deno.test('a late UTC evening is already the next day at the house', () => {
  const stamp = formatHomeStamp('2026-09-05T22:30:00Z', STOCKHOLM);
  assert(stamp.includes('00:30'), `stamp keeps the house clock: ${stamp}`);
  const label = formatHomeDayMonthTime('2026-09-05T22:30:00Z', STOCKHOLM);
  assert(label.includes('00:30'), `label keeps the house clock: ${label}`);
});

Deno.test('a day window is midnight to midnight at the house', () => {
  const { startMs, endMs } = homeDayBounds(at('2026-09-05T12:00:00Z'), 0, STOCKHOLM);
  assertEquals(
    new Date(startMs).toISOString(),
    '2026-09-04T22:00:00.000Z',
    'starts at Stockholm midnight',
  );
  assertEquals(
    new Date(endMs).toISOString(),
    '2026-09-05T22:00:00.000Z',
    'ends at the next Stockholm midnight',
  );
});

Deno.test('the house day does not move when the reader does', () => {
  // The same house day, asked about from two different moments of the reader's
  // evening, because the zone is an argument rather than an ambient default.
  const midday = at('2026-09-05T12:00:00Z');
  const evening = at('2026-09-05T21:59:00Z');
  assertEquals(
    homeDayBounds(midday, 0, STOCKHOLM),
    homeDayBounds(evening, 0, STOCKHOLM),
    'one house day either side of the reader evening',
  );
  // 22:30 UTC is 00:30 on the 6th in Stockholm, so "today" there has moved on.
  const { startMs } = homeDayBounds(at('2026-09-05T22:30:00Z'), 0, STOCKHOLM);
  assertEquals(
    new Date(startMs).toISOString(),
    '2026-09-05T22:00:00.000Z',
    'past house midnight the window is the new day',
  );
});

Deno.test('windows step by calendar days, not by 24 hours', () => {
  const now = at('2026-09-05T12:00:00Z');
  assertEquals(
    new Date(homeDayBounds(now, -2, STOCKHOLM).startMs).toISOString(),
    '2026-09-02T22:00:00.000Z',
    'two days back',
  );
  assertEquals(
    new Date(homeDayBounds(now, 2, STOCKHOLM).startMs).toISOString(),
    '2026-09-06T22:00:00.000Z',
    'two days forward',
  );
  assertEquals(
    new Date(homeDayBounds(at('2026-08-31T12:00:00Z'), 1, STOCKHOLM).startMs).toISOString(),
    '2026-08-31T22:00:00.000Z',
    'crossing a month end',
  );
});

Deno.test('a day stays a day across both DST changes', () => {
  // Sweden falls back on 25 October 2026: that day is 25 hours long, and it
  // must still begin at local midnight rather than at 23:00 or 01:00.
  const autumn = homeDayBounds(at('2026-10-25T10:00:00Z'), 0, STOCKHOLM);
  assertEquals(autumn.endMs - autumn.startMs, 25 * 60 * 60_000, 'autumn day is 25 h');
  assertEquals(formatHomeTime(autumn.startMs, STOCKHOLM), '00:00', 'autumn starts at midnight');

  // 29 March 2026 is 23 hours long.
  const spring = homeDayBounds(at('2026-03-29T10:00:00Z'), 0, STOCKHOLM);
  assertEquals(spring.endMs - spring.startMs, 23 * 60 * 60_000, 'spring day is 23 h');
  assertEquals(formatHomeTime(spring.startMs, STOCKHOLM), '00:00', 'spring starts at midnight');
});

Deno.test('chart ticks are placed on the house hour', () => {
  // What the day divider and the six-hourly gridlines are positioned by. Read
  // off the browser this landed an hour or a continent from the day it marked.
  assertEquals(
    homeHourMinute('2026-09-04T22:00:00Z', STOCKHOLM),
    { hour: 0, minute: 0 },
    'house midnight',
  );
  assertEquals(
    homeHourMinute('2026-09-04T22:00:00Z', 'UTC'),
    { hour: 22, minute: 0 },
    'the same instant is not midnight in UTC',
  );
});

Deno.test('an unusable zone falls back instead of throwing on every row', () => {
  assertEquals(resolveHomeTimeZone(STOCKHOLM), STOCKHOLM, 'a real zone survives');
  assertEquals(resolveHomeTimeZone(null), FALLBACK_HOME_TIME_ZONE, 'null falls back');
  assertEquals(resolveHomeTimeZone(''), FALLBACK_HOME_TIME_ZONE, 'empty falls back');
  assertEquals(resolveHomeTimeZone('Middle/Earth'), FALLBACK_HOME_TIME_ZONE, 'nonsense falls back');
});
