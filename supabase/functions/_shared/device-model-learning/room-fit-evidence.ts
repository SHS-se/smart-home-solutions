import { roomResponseTrainingLength, connectedRoomResponseTrainingLength, connectedRoomObservedPeers, connectedRoomEvidenceUsable } from "../device-learning/room/chronological-evidence.ts";
import { usesConnectedRoomFit } from "../device-learning/room/fit-policy.ts";
import { roomIntervalSeconds } from "../device-learning/room/mean-evidence.ts";
import { thermalQuarter } from "../thermal-training.ts";
import { qualifyRoomEvidenceBlocks, type DecodedRoomEvidenceBlock } from "./room-evidence-capture.ts";
import type { RoomTrainingView } from "./room.ts";

/** Pure source qualification and training-prefix selection, before transport
 * discards raw vectors. This is part of mathematical learner compatibility. */
export function qualifyRoomFitEvidence(decoded: readonly DecodedRoomEvidenceBlock[], roomKey: string,
  fromAt: string, historyTo: string, connected: { peerKeys: string[]; observedOnly: boolean }) {
  const qualified = qualifyRoomEvidenceBlocks(decoded, roomKey, fromAt, historyTo, connected.peerKeys);
  const rows = qualified.quarters.map(thermalQuarter);
  const context = { peers: connected.peerKeys, observedOnly: connected.observedOnly };
  const adaptive = usesConnectedRoomFit(connected);
  let length = adaptive ? connectedRoomResponseTrainingLength(rows, context)
    : roomResponseTrainingLength(rows.map(row => row.duration_s ?? 900));
  const trainingTo = length ? new Date(rows[length - 1].start_ms + roomIntervalSeconds(rows[length - 1]) * 1000).toISOString() : fromAt;
  let training = length ? qualifyRoomEvidenceBlocks(decoded, roomKey, fromAt, trainingTo, connected.peerKeys).quarters : [];
  const observedContext = { ...context, peers: connectedRoomObservedPeers(rows, context.peers) };
  if (adaptive && length < rows.length && !training.some(row => connectedRoomEvidenceUsable(thermalQuarter(row), observedContext))) {
    // Prefix freshness is independent. With no usable prefix, fit the whole
    // qualified capture and report validation unavailable.
    length = rows.length;
    training = qualified.quarters.slice();
  }
  if (training.length !== length) throw new Error("Room evidence training prefix mismatch");
  const temperatures: RoomTrainingView["temperatures"] = [];
  const peerTemperatures: RoomTrainingView["peerTemperatures"] = [];
  training.forEach((row, index) => {
    if (row.room_temperature_c !== rows[index].room_c || row.house_temperature_c !== rows[index].house_c) {
      temperatures.push([index, row.room_temperature_c, row.house_temperature_c]);
    }
    if (row.peer_temperatures_c && connected.peerKeys.some(key => row.peer_temperatures_c![key] !== rows[index].peer_c?.[key])) {
      peerTemperatures.push([index, row.peer_temperatures_c]);
    }
  });
  const ratedPowerW = qualified.quarters.at(-1)?.active_power_w ?? null;
  const roomName = qualified.quarters.at(-1)?.room_name;
  return { rows, ratedPowerW, roomName, sourceFreshness: qualified.sourceFreshness,
    trainingView: { length, temperatures, peerTemperatures } };
}
