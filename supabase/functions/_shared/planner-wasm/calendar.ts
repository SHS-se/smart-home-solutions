/** Calendar facts prepared in the household timezone; solve has no clock. */
export function localMonths(starts: readonly string[], timeZone: string): number[] {
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone, month: "numeric" });
  return starts.map(start => Number(formatter.format(new Date(start))));
}
