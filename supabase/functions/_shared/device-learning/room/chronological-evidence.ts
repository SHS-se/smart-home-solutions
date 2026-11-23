import type { RoomMeanQuarter } from "./mean-observations.ts";
export interface RoomResponseEvidence {
  fullRows: RoomMeanQuarter[];
  trainingRows: RoomMeanQuarter[];
}
/** Training is a native interval prefix, independently source-qualified. */
export function roomResponseTrainingLength(durations: readonly (900 | 3600)[]): number {
  const total = durations.reduce<number>((sum, s) => sum + s, 0);
  let elapsed = 0;
  for (let i = 0; i < durations.length; i++) {
    elapsed += durations[i];
    if (elapsed * 3 >= total * 2) return i + 1;
  }
  return durations.length;
}
export function validateRoomResponseEvidence({ fullRows, trainingRows }: RoomResponseEvidence): void {
  if (trainingRows.length !== roomResponseTrainingLength(fullRows.map(row => row.duration_s ?? 900)) ||
    fullRows.some((row, i) => i > 0 && row.start_ms <= fullRows[i - 1].start_ms) ||
    trainingRows.some((row, i) => row.start_ms !== fullRows[i].start_ms || (row.duration_s ?? 900) !== (fullRows[i].duration_s ?? 900))) {
    throw new Error("Invalid chronological room training prefix");
  }
}
