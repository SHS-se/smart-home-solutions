// Independently generated native observations; no household history.
import { assertEquals, assertThrows } from "@std/assert";
import { connectedRoomObservedPeers, connectedRoomResponseTrainingLength, connectedRoomEvidenceUsable,
  roomResponseTrainingLength, validateConnectedRoomResponseEvidence, validateRoomResponseEvidence } from "./chronological-evidence.ts";
import type { RoomMeanQuarter } from "./mean-observations.ts";
const context = { peers: ["peer", "unobserved"], observedOnly: false };
const rows = (count: number): RoomMeanQuarter[] => Array.from({ length: count }, (_, i) => ({ start_ms: i * 3600000,
  duration_s: 3600, room_c: 20 + i / 100, outdoor_c: 5, house_c: null, heat_w: 200,
  cooling: false, solar_w_per_m2: null, peer_c: { peer: 22 + i / 200, unobserved: null } }));

Deno.test("connected training follows usable native duration after a long unavailable prefix", () => {
  const full = rows(12).map((row, i) => ({ ...row, room_c: i < 9 ? null : row.room_c }));
  assertEquals(connectedRoomResponseTrainingLength(full, context), 11);
  assertEquals(roomResponseTrainingLength(full.map(row => row.duration_s!)), 8,
    "the non-connected chronological partition is unchanged");
  assertEquals(connectedRoomObservedPeers(full, context.peers), ["peer"]);
  validateConnectedRoomResponseEvidence({ fullRows: full, trainingRows: full.slice(0, 11) }, context);
  assertThrows(() => validateConnectedRoomResponseEvidence({ fullRows: full, trainingRows: full.slice(0, 8) }, context));
});

Deno.test("connected duration weights mixed native intervals and does not treat unavailable meters or direction as zero", () => {
  const full = rows(12).map((row, i) => ({ ...row, room_c: i < 9 ? null : row.room_c,
    ...(i >= 10 ? { start_ms: 10 * 3600000 + (i - 10) * 900000, duration_s: 900 as const } : {}) }));
  assertEquals(connectedRoomResponseTrainingLength(full, context), 10,
    "the first usable hour is two thirds of the final 90 usable minutes");
  const measured = full[9];
  const supported = { ...context, peers: ["peer"] };
  assertEquals(connectedRoomEvidenceUsable({ ...measured, heat_w: null }, supported), false);
  assertEquals(connectedRoomEvidenceUsable({ ...measured, cooling: null }, supported), false);
  assertEquals(connectedRoomEvidenceUsable({ ...measured, heat_w: 0 }, supported), true);
  assertEquals(connectedRoomEvidenceUsable({ ...measured, cooling: null, operation_fact: "qualified-witness" }, supported), true);
  assertEquals(connectedRoomEvidenceUsable({ ...measured, heat_w: null, cooling: null }, { ...supported, observedOnly: true }), true);
});

Deno.test("observed peer gaps qualify the cut while never-observed configured peers do not invent a rejection", () => {
  const full = rows(12).map((row, i) => ({ ...row, peer_c: { peer: i < 9 ? null : 22, unobserved: null } }));
  assertEquals(connectedRoomResponseTrainingLength(full, context), 11);
  const unavailable = full.map(row => ({ ...row, cooling: null }));
  assertEquals(connectedRoomResponseTrainingLength(unavailable, context), full.length);
  validateConnectedRoomResponseEvidence({ fullRows: full, trainingRows: full }, context);
  assertThrows(() => validateRoomResponseEvidence({ fullRows: full, trainingRows: full }));
  const independent = full.slice(0, 11).map(row => ({ ...row, room_c: null }));
  validateConnectedRoomResponseEvidence({ fullRows: full, trainingRows: independent }, context);
  assertEquals(full[0].room_c, 20, "independent qualification does not rewrite full observations");
});
