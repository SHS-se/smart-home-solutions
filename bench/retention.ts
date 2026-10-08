/** User-selected lower bound: production main when the new planner was introduced. */
export const BENCH_BASELINE_SHA = "4cc6718cecdcc6b06fbc48216c504e6022fd659d";
export const BENCH_BASELINE_COMMITTED_AT = "2026-10-07T16:37:53Z";

export function retainedCommit(committedAt: string): boolean {
  const at = Date.parse(committedAt);
  if (!Number.isFinite(at)) throw new Error("Invalid benchmark commit timestamp");
  return at >= Date.parse(BENCH_BASELINE_COMMITTED_AT);
}
