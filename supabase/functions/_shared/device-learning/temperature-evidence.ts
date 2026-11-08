interface TemperatureReading {
  at: number;
  c: number | null;
}

function median(values: number[]): number {
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

/** Estimate isolated excursions for fitting only. Reads are in quarter order. */
export function isolatedTemperatureCorrections(readings: readonly TemperatureReading[], intervalMs: number): Map<number, number> {
  const step = (before: TemperatureReading, after: TemperatureReading): number | null =>
    after.at - before.at === intervalMs && before.c !== null && after.c !== null &&
      Number.isFinite(before.c) && Number.isFinite(after.c) ? after.c - before.c : null;
  const steps = readings.slice(1).flatMap((reading, i) => {
    const change = step(readings[i], reading);
    return change === null ? [] : [Math.abs(change)];
  });
  if (!steps.length) return new Map();
  const typical = median(steps);
  const spread = median(steps.map(value => Math.abs(value - typical)));
  // A conservative robust scale, in degrees per observed interval.
  const unusual = typical + 6 * 1.4826 * spread;
  const candidates = new Map<number, number>();
  for (let i = 1; i + 1 < readings.length; i++) {
    const before = readings[i - 1], reading = readings[i], after = readings[i + 1];
    const into = step(before, reading), out = step(reading, after);
    if (into === null || out === null || Math.sign(into) === Math.sign(out)) continue;
    const excursion = Math.min(Math.abs(into), Math.abs(out));
    // Allow the surrounding trend to span two quarters, even when a long
    // idle stretch makes the typical step small relative to active heating.
    if (excursion <= unusual || Math.abs(into + out) > Math.max(2 * unusual, excursion / 4)) continue;
    candidates.set(i, (before.c! + after.c!) / 2);
  }
  const corrections = new Map<number, number>();
  for (const [i, estimate] of candidates) {
    if (!candidates.has(i - 1) && !candidates.has(i + 1)) corrections.set(readings[i].at, estimate);
  }
  return corrections;
}
