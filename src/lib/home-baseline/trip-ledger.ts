/** Recorded declines are external withdrawals, never previous charging commands. */
export function recordedTrips(demand: readonly number[], count: number) {
  if (demand.length !== count || demand.some(v => !Number.isFinite(v) || v < 0)) throw new Error('Invalid recorded EV demand');
  const next = new Int32Array(count);
  let departure = count;
  for (let i = count - 1; i >= 0; i--) {
    next[i] = departure;
    if (demand[i] > 0) departure = i;
  }
  return { next };
}

export function withdrawTrip(energyKwh: number, demandKwh: number, scenario: string, at: string): number {
  const left = energyKwh - demandKwh;
  if (left < -1e-9) throw new Error(`${scenario}: unserved recorded EV trip at ${at} (${demandKwh.toFixed(2)} kWh needed; ${energyKwh.toFixed(2)} kWh available). Excluded from savings.`);
  return Math.max(0, left);
}
