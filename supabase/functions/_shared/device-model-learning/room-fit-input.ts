import type { ConnectedFitContext } from "../device-learning/room/connected-response.ts";
import type { RoomMeanQuarter } from "../device-learning/room/mean-observations.ts";
import type { ConnectedRoomResponse } from "../planner/models/room/connected-exchange.ts";
import { ROOM_RESPONSE_CAPTURE_REVISION } from "./room-band-fit-capture.ts";
import type { RoomSharedMetadata } from "./room.ts";

type NumericalMetadata = Pick<RoomSharedMetadata, "connected" | "ratedPowerW" | "evidence" | "fromAt" | "historyTo">;

export function connectedFitContext(metadata: NumericalMetadata): ConnectedFitContext {
  const { graph } = metadata.connected;
  return { peers: metadata.connected.peerKeys, observedOnly: metadata.connected.observedOnly, ratedPowerW: metadata.ratedPowerW,
    basis: { graph_owner: graph.owner, graph_revision: graph.revision, topology_hash: graph.topology_hash,
      source_policy: metadata.connected.policyFingerprint, source_revision: metadata.evidence.sourceRevision,
      history_from: metadata.fromAt, history_to: metadata.historyTo } };
}

export function connectedFitEvidence(evidence: ConnectedRoomResponse["evidence"], metadata: NumericalMetadata,
  rows: readonly RoomMeanQuarter[], sha256: string): ConnectedRoomResponse["evidence"] {
  const last = rows.at(-1)!;
  return { ...evidence, process_source_prefix: { numeric_sha256: sha256, rows: rows.length, peer_keys: metadata.connected.peerKeys,
    through_ms: last.start_ms + (last.duration_s ?? 900) * 1000, from_at: metadata.fromAt, codec_revision: ROOM_RESPONSE_CAPTURE_REVISION } };
}
