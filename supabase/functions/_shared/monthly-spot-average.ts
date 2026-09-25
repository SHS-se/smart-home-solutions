export interface SpotInterval { SEK_per_kWh: number; time_start: string; time_end: string }

/** Time-weighted mean, independent of the household's consumption timing. */
export function monthlySpotAverage(rows: SpotInterval[]): number {
  if (!rows.length) throw new Error('No market prices');
  let weighted = 0;
  let duration = 0;
  let previousEnd: number | null = null;
  for (const row of rows) {
    const start = Date.parse(row.time_start);
    const end = Date.parse(row.time_end);
    if (!Number.isFinite(row.SEK_per_kWh) || !Number.isFinite(start) || !Number.isFinite(end)
      || end <= start || (previousEnd !== null && start !== previousEnd)) throw new Error('Incomplete market prices');
    weighted += row.SEK_per_kWh * (end - start);
    duration += end - start;
    previousEnd = end;
  }
  return weighted / duration;
}
