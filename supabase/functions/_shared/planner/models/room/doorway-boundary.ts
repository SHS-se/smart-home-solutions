import type { DoorwayProbeRow } from "../../../room-doorway-probes.ts";
import type { DoorwayResponse } from "../../../device-learning/room/doorway-exchange.ts";

const QUARTER_MS = 900_000;
export interface RoomDoorwayModel {
  source: string;
  peers: DoorwayResponse[];
}

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export function readRoomDoorwayModel(
  value: unknown,
  indoor: number,
): RoomDoorwayModel | null {
  if (!value || typeof value !== "object" || !(indoor > 0)) return null;
  const fit = value as Partial<RoomDoorwayModel>;
  if (
    typeof fit.source !== "string" || !Array.isArray(fit.peers) ||
    !fit.peers.length ||
    new Set(fit.peers.map((peer) => peer?.key)).size !== fit.peers.length ||
    !fit.peers.every((peer) =>
      peer && typeof peer.key === "string" && typeof peer.source === "string" &&
      finite(peer.weight) && peer.weight > 0 && finite(peer.usual) &&
      finite(peer.persistence) && peer.persistence >= 0 && peer.persistence <= 1
    )
  ) return null;
  if (
    fit.peers.reduce((total, peer) => total + peer.weight, 0) >
      indoor * (1 + 1e-12)
  ) return null;
  return { source: fit.source, peers: fit.peers };
}

/** Use an equivalent house boundary to reallocate the existing indoor exchange
 * without changing the room's loss rate or adding a second heat source. */
export function doorwayBoundary(
  fit: RoomDoorwayModel,
  indoor: number,
  probes: readonly DoorwayProbeRow[],
  house: number[],
  slots: readonly number[],
  originMs: number,
): { temperatures?: number[]; incomplete: boolean } {
  const neighbors = new Map(
    probes.filter((row) => row.room_source === fit.source).map(
      (row) => [row.other_key, row],
    ),
  );
  const observed: { time: number; anomaly: number; persistence: number }[] = [];
  let incomplete = false;
  for (const peer of fit.peers) {
    const binding = neighbors.get(peer.key);
    // A deleted doorway or replaced probe immediately stops contributing.
    if (!binding || binding.other_source !== peer.source) continue;
    const [time, c] = binding.quarters[0] ?? [];
    if (!finite(time) || !finite(c)) {
      incomplete = true;
      continue;
    }
    observed.push({
      time,
      anomaly: peer.weight / indoor * (c - house[0] - peer.usual),
      persistence: peer.persistence,
    });
  }
  if (!observed.length) return { incomplete };
  const temperatures = house.map((c, i) =>
    c +
    observed.reduce(
      (delta, peer) =>
        delta +
        peer.anomaly *
          peer.persistence **
            (Math.max(0, Math.max(slots[i], originMs) - peer.time) /
              QUARTER_MS),
      0,
    )
  );
  return { temperatures, incomplete };
}
