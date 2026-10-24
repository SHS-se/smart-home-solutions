/** Connection is initially assumed, as with historical starting energy. A decline
 * infers absence until a fresh nondeclining SOC observation. Aliases of an hourly
 * mean and telemetry gaps cannot establish a return. This is not charger telemetry.
 * Keep demand separate: every existing debit retains its original quarter/amount. */
export function inferredEvAvailability(demand: readonly number[], independentSoc: readonly boolean[]): boolean[] {
  if (demand.length !== independentSoc.length) throw new Error('Invalid recorded EV observation coverage');
  let available = true;
  return demand.map((kwh, i) => {
    if (kwh > 0) available = false;
    else if (independentSoc[i]) available = true;
    return available;
  });
}

/** Recorded declines are external withdrawals, never previous charging commands. */
export function recordedTrips(demand: readonly number[], count: number) {
  if (demand.length !== count || demand.some(v => !Number.isFinite(v) || v < 0)) throw new Error('Invalid recorded EV demand');
  const next = new Int32Array(count);
  let nextTrip = count;
  for (let i = count - 1; i >= 0; i--) {
    next[i] = nextTrip;
    if (demand[i] > 0) nextTrip = i;
  }
  return { next };
}

export function withdrawTrip(energyKwh: number, demandKwh: number, scenario: string, at: string): number {
  const left = energyKwh - demandKwh;
  if (left < -1e-9) throw new Error(`${scenario}: unserved recorded EV trip at ${at} (${demandKwh.toFixed(2)} kWh needed; ${energyKwh.toFixed(2)} kWh available). Excluded from savings.`);
  return Math.max(0, left);
}
