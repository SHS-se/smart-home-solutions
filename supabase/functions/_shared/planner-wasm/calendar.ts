/** Calendar facts prepared in the household timezone; solve has no clock. */
export function localMonths(starts: readonly string[], timeZone: string): number[] {
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone, month: "numeric" });
  return starts.map(start => Number(formatter.format(new Date(start))));
}

/** Local date at immutable capture, for matured-day forecast evidence. */
export function localDay(start: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(start));
  const value = (type: string) => parts.find(part => part.type === type)!.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}
