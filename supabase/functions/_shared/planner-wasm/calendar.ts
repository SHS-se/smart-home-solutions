import { timeZoneFormatter } from '../time-zone-formatter.ts';

const monthFormatter = timeZoneFormatter('en-US', { month: 'numeric' });
const dayFormatter = timeZoneFormatter('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });

/** Calendar facts prepared in the household timezone; solve has no clock. */
export function localMonths(starts: readonly string[], timeZone: string): number[] {
  const formatter = monthFormatter(timeZone);
  return starts.map(start => Number(formatter.format(new Date(start))));
}

/** Local date at immutable capture, for matured-day forecast evidence. */
export function localDay(start: string, timeZone: string): string {
  const parts = dayFormatter(timeZone).formatToParts(new Date(start));
  const value = (type: string) => parts.find(part => part.type === type)!.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}
