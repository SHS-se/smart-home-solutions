// Independently generated synthetic native means; no captured household inputs.
import { assertEquals } from "@std/assert";
import { roomResponseEvidence, readConnectedRoomPlanningRows } from "./room.ts";
import type { RoomMeanQuarter } from "../device-learning/room/mean-observations.ts";

Deno.test("connected training prefix overrides peer qualification without changing full observations", () => {
  const rows: RoomMeanQuarter[] = [{ start_ms: 0, duration_s: 900, room_c: 20, outdoor_c: 5, house_c: 19,
    solar_w_per_m2: null, heat_w: null, cooling: null, peer_c: { east: 22, west: null } }];
  const evidence = roomResponseEvidence(rows, { length: 1, temperatures: [], peerTemperatures: [[0, { east: null, west: 21 }]] });
  assertEquals(evidence.fullRows[0].peer_c, { east: 22, west: null });
  assertEquals(evidence.trainingRows[0].peer_c, { east: null, west: 21 });
  assertEquals(evidence.trainingRows[0].heat_w, null);
});

Deno.test("planning native replay retains a middle hole, late newest interval and unavailable counter until repaired", async () => {
  const start = Date.UTC(2026, 0, 1), at = (q: number) => new Date(start + q * 900_000).toISOString();
  const row = (q: number, heat: number | null) => ({ room_key: "synthetic", room_name: "Synthetic", start_ts: at(q), duration_s: 900,
    active_power_w: 500, room_temperature_c: 19 + q / 10, outdoor_temperature_c: 5, house_temperature_c: 20,
    solar_w_per_m2: null, cooling: false, heat_w: heat, temperature_source_key: "receiver", probe_values: [[0, 22 + q / 10, 0]] });
  let rows = [row(0, 100), row(2, null)];
  const db = { rpc: (name: string) => Promise.resolve({ error: null,
    data: name === "get_energy_room_operation_facts" ? [] : {
      sources: [{ source_key: "peer-probe", area_key: "peer", cohort_key: null }], rows } }) };
  const read = () => readConnectedRoomPlanningRows(db, "synthetic-home", "synthetic-customer", "synthetic", at(0), at(4), ["peer"]);
  assertEquals((await read()).map(r => [r.start_ms, r.heat_w, r.peer_c?.peer]), [[start, 100, 22], [start + 1_800_000, null, 22.2]]);
  rows = [row(0, 100), row(1, 200), row(2, 250), row(3, 125)];
  assertEquals((await read()).map(r => r.heat_w), [100, 200, 250, 125]);
});

Deno.test("connected source capture persists the usable-duration cut and independently qualifies its native prefix", async () => {
  const { prepareStoredRoomHeating } = await import("./room.ts");
  const { evidenceStore } = await import("./room-evidence.fixture.ts");
  const { qualifyRoomEvidenceBlocks } = await import("./room-evidence-capture.ts");
  const { encodeRoomResponseFitCapture, decodeRoomResponseFitCapture } = await import("./room-band-fit-capture.ts");
  const { thermalQuarter } = await import("../thermal-training.ts");
  const from = Date.UTC(2026, 0, 1), at = (i: number) => new Date(from + i * 3600000).toISOString();
  const raw = Array.from({ length: 12 }, (_, i) => ({ room_key: "room", room_name: "Synthetic room", active_power_w: 500,
    start_ts: at(i), duration_s: 3600 as const, room_temperature_c: 20 + i / 10, house_temperature_c: null,
    outdoor_temperature_c: 5, heat_w: 100, solar_w_per_m2: null, cooling: false,
    temperature_source_key: "receiver", probe_evidence: [
      { source_key: "receiver", area_key: "room", cohort_key: null, mean: 20 + i / 10,
        unchanged: false, joint_unchanged: false, reported: true, unavailable: i < 9 },
      { source_key: "neighbor", area_key: "peer", cohort_key: null, mean: 22 + i / 100,
        unchanged: false, joint_unchanged: false, reported: true, unavailable: false },
    ] }));
  const store = evidenceStore(raw, [{ from_at: at(0), to_at: at(12) }]);
  const db = { async rpc(name: string, args: Record<string, unknown>) {
    const result = await store.rpc(name, args);
    if (name === "get_energy_room_evidence_work") {
      const work = result.data as { connected: { peerKeys: string[] } };
      work.connected.peerKeys = ["peer"];
    }
    return result;
  } };
  const step = () => prepareStoredRoomHeating(db, { id: "synthetic", home_id: "synthetic", customer_id: "synthetic",
    owner_key: "room", generation: 1, fence: 1 }, { binding: "synthetic", observed_since: at(0) }, undefined, null,
    { historyTo: Date.parse(at(12)), wallNow: Date.parse(at(12)) });
  assertEquals((await step()).kind, "refreshed");
  const captured = await step();
  if (captured.kind !== "shared") throw new Error("Expected complete connected capture");
  assertEquals(captured.work.metadata.trainingView.length, 11);
  const encoded = await encodeRoomResponseFitCapture(captured.work.rows, at(0));
  const restored = roomResponseEvidence(await decodeRoomResponseFitCapture(encoded.base64, at(0), encoded.sha256), captured.work.metadata.trainingView);
  const independentlyQualified = qualifyRoomEvidenceBlocks([{ from_at: at(0), to_at: at(12), rows: raw }], "room", at(0), at(11), ["peer"]);
  assertEquals(restored.trainingRows, independentlyQualified.quarters.map(thermalQuarter));
  assertEquals(restored.fullRows.length, 12);
  assertEquals(restored.trainingRows.length, 11);
  assertEquals(restored.trainingRows[8].room_c, null);
  assertEquals(restored.trainingRows[10].room_c, raw[10].room_temperature_c);
});
