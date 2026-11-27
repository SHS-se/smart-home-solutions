import { packOwnedPlanningValue, unpackOwnedPlanningValue, OwnedPlanningArtifactError } from "../owned-planning-codec.ts";
import { readConnectedRoomCapture } from "../device-model-store.ts";
import { ROOM_RESPONSE_IMPLEMENTATION, ROOM_SHARED_METADATA_VERSION, ROOM_SOURCE_IMPLEMENTATION, type RoomSharedMetadata } from "./room.ts";

/** Immutable numerical inputs only. Publication retains its original database record. */
export type RoomFitNumericalMetadata = Pick<RoomSharedMetadata, "version" | "implementation" | "homeId" | "customerId" |
  "roomKey" | "binding" | "baseRevision" | "fromAt" | "historyTo" | "evidence" | "trainingView" | "ratedPowerW" | "connected">;
export interface RoomFitNumericalInput { capture: RoomFitNumericalMetadata; capture_base64: string }

export function roomFitNumericalInput(metadata: RoomSharedMetadata, capture: string): RoomFitNumericalInput {
  const { version, implementation, homeId, customerId, roomKey, binding, baseRevision, fromAt, historyTo,
    evidence, trainingView, ratedPowerW, connected } = metadata;
  return { capture: { version, implementation, homeId, customerId, roomKey, binding, baseRevision, fromAt, historyTo,
    evidence, trainingView, ratedPowerW, connected }, capture_base64: capture };
}

export function readRoomFitNumericalInput(value: unknown): RoomFitNumericalInput | null {
  if (!value || typeof value !== "object" || !("capture" in value) || !("capture_base64" in value) ||
    typeof value.capture_base64 !== "string" || !value.capture || typeof value.capture !== "object") return null;
  const c = value.capture as RoomFitNumericalMetadata;
  const finite = (n: unknown) => n === null || typeof n === "number" && Number.isFinite(n);
  if (c.version !== ROOM_SHARED_METADATA_VERSION || c.implementation !== ROOM_RESPONSE_IMPLEMENTATION ||
    ![c.homeId, c.customerId, c.roomKey, c.binding].every(v => typeof v === "string" && v.length > 0) ||
    !Number.isSafeInteger(c.baseRevision) || c.baseRevision < 0 ||
    ![c.fromAt, c.historyTo].every(v => typeof v === "string" && Number.isFinite(Date.parse(v))) ||
    !c.evidence || c.evidence.implementation !== ROOM_SOURCE_IMPLEMENTATION || c.evidence.fromAt !== c.fromAt ||
    c.evidence.toAt !== c.historyTo || !Number.isSafeInteger(c.evidence.sourceRevision) || c.evidence.sourceRevision < 0 ||
    !finite(c.ratedPowerW) || !readConnectedRoomCapture(c.connected) || !c.trainingView ||
    !Number.isSafeInteger(c.trainingView.length) || c.trainingView.length < 0 ||
    !Array.isArray(c.trainingView.temperatures) || !c.trainingView.temperatures.every((v, i, all) => Array.isArray(v) &&
      v.length === 3 && Number.isSafeInteger(v[0]) && v[0] >= 0 && v[0] < c.trainingView.length &&
      (i === 0 || v[0] > all[i - 1][0]) && finite(v[1]) && finite(v[2])) ||
    !Array.isArray(c.trainingView.peerTemperatures) || !c.trainingView.peerTemperatures.every((v, i, all) => Array.isArray(v) &&
      v.length === 2 && Number.isSafeInteger(v[0]) && v[0] >= 0 && v[0] < c.trainingView.length &&
      (i === 0 || v[0] > all[i - 1][0]) && v[1] && typeof v[1] === "object" && !Array.isArray(v[1]) && Object.values(v[1]).every(finite))) return null;
  return value as RoomFitNumericalInput;
}

export async function encodeRoomFitNumericalInput(input: RoomFitNumericalInput): Promise<string> {
  return await packOwnedPlanningValue(input);
}

export async function decodeRoomFitNumericalInput(packet: string): Promise<RoomFitNumericalInput> {
  const result = readRoomFitNumericalInput(await unpackOwnedPlanningValue(packet));
  if (!result) throw new OwnedPlanningArtifactError("Unreadable room numerical input");
  return result;
}
