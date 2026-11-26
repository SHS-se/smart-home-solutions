import { roomHeatingDirectionKnown } from "./operation-evidence.ts";
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

export interface ConnectedRoomEvidenceContext { peers: readonly string[]; observedOnly: boolean }
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const end = (row: RoomMeanQuarter) => row.start_ms + (row.duration_s ?? 900) * 1000;

/** Configured but never jointly observed peers cannot gate a causal partition. */
export function connectedRoomObservedPeers(rows: readonly RoomMeanQuarter[], peers: readonly string[]): string[] {
  return peers.filter(key => rows.some((row, i) => i > 0 && end(rows[i - 1]) === row.start_ms &&
    finite(row.room_c) && finite(rows[i - 1].room_c) && finite(row.peer_c?.[key]) && finite(rows[i - 1].peer_c?.[key])));
}

/** Eligibility uses measured source qualification, never fitted coefficients or a
 * missing-as-zero heat assumption. Pass the observed peer set from the full view. */
export function connectedRoomEvidenceUsable(row: RoomMeanQuarter, context: ConnectedRoomEvidenceContext): boolean {
  return finite(row.room_c) && finite(row.outdoor_c) &&
    (context.observedOnly || finite(row.heat_w) && row.heat_w >= 0 && roomHeatingDirectionKnown(row)) &&
    context.peers.every(key => finite(row.peer_c?.[key]));
}

/** Keep one chronological native prefix, measuring its split by usable duration.
 * Unusable intervals remain in the prefix for state propagation and provenance.
 * With no usable evidence the full capture is explicit unavailable validation. */
export function connectedRoomResponseTrainingLength(rows: readonly RoomMeanQuarter[], context: ConnectedRoomEvidenceContext): number {
  const observed = { ...context, peers: connectedRoomObservedPeers(rows, context.peers) };
  const duration = (row: RoomMeanQuarter) => connectedRoomEvidenceUsable(row, observed) ? row.duration_s ?? 900 : 0;
  const total = rows.reduce((sum, row) => sum + duration(row), 0);
  if (total === 0) return rows.length;
  let elapsed = 0;
  for (let i = 0; i < rows.length; i++) {
    elapsed += duration(rows[i]);
    if (elapsed * 3 >= total * 2) return i + 1;
  }
  return rows.length;
}

/** Full training is an explicit no-holdout fit when independent qualification
 * leaves the selected prefix unidentifiable. It must never claim validation. */
export function validateConnectedRoomResponseEvidence({ fullRows, trainingRows }: RoomResponseEvidence,
  context: ConnectedRoomEvidenceContext): void {
  if ((trainingRows.length !== fullRows.length && trainingRows.length !== connectedRoomResponseTrainingLength(fullRows, context)) ||
    fullRows.some((row, i) => i > 0 && row.start_ms <= fullRows[i - 1].start_ms) ||
    trainingRows.some((row, i) => row.start_ms !== fullRows[i].start_ms || (row.duration_s ?? 900) !== (fullRows[i].duration_s ?? 900))) {
    throw new Error("Invalid connected chronological room training prefix");
  }
}
