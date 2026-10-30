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

/** A trip the car could not cover leaves it empty, and the rest is bought just before leaving. */
export function withdrawTrip(energyKwh: number, demandKwh: number): { kwh: number; unservedKwh: number } {
  const left = energyKwh - demandKwh;
  return left < -1e-9 ? { kwh: 0, unservedKwh: -left } : { kwh: Math.max(0, left), unservedKwh: 0 };
}

/** What a simulated car could not cover, and the electricity it took to top it up for those trips. */
export interface UnservedTrips { trips: number; kwh: number; quarters: number[]; gridKwh: number[] }
export const noUnservedTrips = (): UnservedTrips => ({ trips: 0, kwh: 0, quarters: [], gridKwh: [] });
export function recordUnserved(unserved: UnservedTrips, i: number, kwh: number, efficiency: number) {
  if (kwh <= 0) return;
  unserved.trips++; unserved.kwh += kwh; unserved.quarters.push(i); unserved.gridKwh.push(kwh / efficiency);
}
