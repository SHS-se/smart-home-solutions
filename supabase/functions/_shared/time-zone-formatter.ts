/** Reuse immutable calendar formatters instead of constructing one per reading. */
export function timeZoneFormatter(locale: string, options: Intl.DateTimeFormatOptions) {
  const formatters = new Map<string, Intl.DateTimeFormat>();
  return (timeZone: string) => {
    let formatter = formatters.get(timeZone);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat(locale, { ...options, timeZone });
      formatters.set(timeZone, formatter);
    }
    return formatter;
  };
}
