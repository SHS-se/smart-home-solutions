/** A day is one observation for model promotion, regardless of its sample count. */
export interface PairedDay {
  sum: number;
  count: number;
}

export function addPairedLoss(days: Map<number, PairedDay>, at: number, candidate: number, incumbent: number): void {
  const day = Math.floor(at / 86_400_000);
  const paired = days.get(day) ?? { sum: 0, count: 0 };
  paired.sum += incumbent - candidate;
  paired.count++;
  days.set(day, paired);
}

export function pairedImprovement(days: ReadonlyMap<number, PairedDay>): "better" | "worse" | "undecided" {
  const differences = [...days.values()].map(day => day.sum / day.count);
  if (differences.length < 2) return "undecided";
  const mean = differences.reduce((sum, difference) => sum + difference, 0) / differences.length;
  const meanVariance = differences.reduce((sum, difference) => sum + (difference - mean) ** 2, 0) /
    (differences.length * (differences.length - 1));
  // Whole-day paired evidence, with an approximate one-sided 95% error margin.
  const margin = 1.645 * Math.sqrt(meanVariance);
  return mean > margin ? "better" : mean < -margin ? "worse" : "undecided";
}
