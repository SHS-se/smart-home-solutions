export interface SolarProfile { profile_hash: string; start_ts: string; end_ts: string }
export interface SolarHour { start_ts: string; raw_kwh: number; modeled_kwh: number }
const HOUR = 3_600_000;

/** Published reconstruction supplies the hypothetical models only, in its explicit period. */
export function modeledSolar(profile: SolarProfile | null, hours: readonly SolarHour[]) {
  const byHour = new Map<number, number>();
  const start = profile ? Date.parse(profile.start_ts) : 0, end = profile ? Date.parse(profile.end_ts) : 0;
  if (profile && (!/^[a-f0-9]{64}$/.test(profile.profile_hash) || !Number.isFinite(start) || !Number.isFinite(end) || start % HOUR || end % HOUR || start >= end)) throw new Error('Invalid published solar profile');
  for (const hour of hours) {
    const at = Date.parse(hour.start_ts);
    if (!profile || !Number.isFinite(at) || at % HOUR || at < start || at >= end || byHour.has(at)
      || ![hour.raw_kwh, hour.modeled_kwh].every(v => Number.isFinite(v) && v >= 0)) throw new Error('Invalid reconstructed solar hour');
    byHour.set(at, hour.modeled_kwh);
  }
  return (at: number): number | null => {
    if (!profile || at < start || at >= end) return null;
    const kwh = byHour.get(Math.floor(at / HOUR) * HOUR);
    if (kwh === undefined) throw new Error(`Reconstructed solar history unavailable at ${new Date(at).toISOString()}`);
    return kwh / 4;
  };
}
