export interface FusePeriod { valid_from: string | null; fuse_a: number }
export interface FuseChange { changed_on: string; previous_fuse_a: number }

/** Each change records the fuse it replaced; today's answer supplies the last period. */
export function homeFusePeriods(currentFuse: number, changes: FuseChange[]): FusePeriod[] {
  const ordered = [...changes].sort((a, b) => a.changed_on.localeCompare(b.changed_on));
  return [
    { valid_from: null, fuse_a: ordered[0]?.previous_fuse_a ?? currentFuse },
    ...ordered.map((change, index) => ({
      valid_from: change.changed_on,
      fuse_a: ordered[index + 1]?.previous_fuse_a ?? currentFuse,
    })),
  ];
}
