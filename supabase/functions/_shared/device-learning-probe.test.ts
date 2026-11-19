import { assertEquals } from "@std/assert";
import { createDeviceLearningProbe } from "./device-learning-probe.ts";
import { syntheticPoolLearningReplay } from "../../../tests/device-learning-cpu.fixture.ts";
import { encodeRoomBandFitCapture } from "./device-model-learning/room-band-fit-capture.ts";
import { finalizeIndependentRoomBand, fitIndependentRoomBandCell, prepareIndependentRoomBand,
  ROOM_BAND_FIT_CELL_COUNT, type RoomBandFitCell, type RoomMeanQuarter } from "./device-learning/room/mean-observations.ts";

Deno.test("full learning probe refuses production, anonymous access and non-pool captures", async () => {
  const request = (secret = "private", body = {}) => new Request("https://probe.test", {
    method: "POST", headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify(body),
  });
  const prod = createDeviceLearningProbe("private", "https://oosxndduqzhvrorgogaw.supabase.co");
  assertEquals((await prod(request())).status, 403);
  const probe = createDeviceLearningProbe("private", "https://vxqpgbzseckgceopitpm.supabase.co");
  assertEquals((await probe(request("wrong"))).status, 401);
  assertEquals((await probe(request())).status, 400);
});

Deno.test("full learning probe is deterministic without replacing the process clock", async () => {
  const now_ms = Date.UTC(2026, 6, 1), originalClock = Date.now;
  const input = syntheticPoolLearningReplay(now_ms);
  const probe = createDeviceLearningProbe("private", "https://vxqpgbzseckgceopitpm.supabase.co");
  const call = async (include_publication = false) => {
    const response = await probe(new Request("https://probe.test", { method: "POST",
      headers: { authorization: "Bearer private" }, body: JSON.stringify({ now_ms, input, include_publication }) }));
    assertEquals(response.status, 200);
    return await response.json();
  };
  const first = await call(), second = await call();
  assertEquals(Date.now, originalClock);
  assertEquals(first.publication_sha256, second.publication_sha256);
  assertEquals(first.table_reads, second.table_reads);
  assertEquals(Object.hasOwn(first, "publication"), false);
  const diagnostic = await call(true);
  assertEquals(diagnostic.publication_sha256, first.publication_sha256);
  assertEquals(diagnostic.publication.p_model.last_attempted_at, new Date(now_ms).toISOString());
});

Deno.test("room numerical probe validates phase, capture and ordered cells behind TEST authorization", async () => {
  const rows = syntheticProbeRows(), from_at = new Date(rows[0].start_ms).toISOString();
  const { base64, sha256 } = await encodeRoomBandFitCapture(rows, from_at);
  const payload = { kind: "room_band_step", from_at, band_c: 0, ratedPowerW: 800, capture: { base64, sha256 }, cells: [] };
  const request = (body: unknown = payload, secret = "private") => new Request("https://probe.test", {
    method: "POST", headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify(body),
  });
  const probe = createDeviceLearningProbe("private", "https://vxqpgbzseckgceopitpm.supabase.co");
  assertEquals((await createDeviceLearningProbe("private", "https://oosxndduqzhvrorgogaw.supabase.co")(request())).status, 403);
  assertEquals((await probe(request(payload, "wrong"))).status, 401);
  for (const invalid of [
    { ...payload, kind: "unknown_phase" }, { ...payload, phase: "finalize" }, { ...payload, index: 18 },
    { ...payload, band_c: 2 }, { ...payload, ratedPowerW: "800" }, { ...payload, from_at: "invalid" },
    { ...payload, capture: { base64, sha256: "a".repeat(64) } },
    { ...payload, capture: { base64: "corrupt", sha256 } },
    { ...payload, cells: [{ lag_h: 0, partition: "full", fits: { finite: null, equilibrium: null, integrator: null } }] },
    { ...payload, cells: Array(19).fill(null) },
  ]) assertEquals((await probe(request(invalid))).status, 400);
});

Deno.test("room numerical probe computes exactly one production cell and finalizes the same persisted prefix", async () => {
  const rows = syntheticProbeRows(), from_at = new Date(rows[0].start_ms).toISOString();
  const { base64, sha256 } = await encodeRoomBandFitCapture(rows, from_at);
  const prepared = prepareIndependentRoomBand(rows, outdoor => outdoor >= 0 && outdoor < 5, 800);
  const cells: RoomBandFitCell[] = [];
  const probe = createDeviceLearningProbe("private", "https://vxqpgbzseckgceopitpm.supabase.co");
  const run = async () => {
    const response = await probe(new Request("https://probe.test", { method: "POST",
      headers: { authorization: "Bearer private" }, body: JSON.stringify({ kind: "room_band_step", from_at,
        band_c: 0, ratedPowerW: 800, capture: { base64, sha256 }, cells }) }));
    assertEquals(response.status, 200);
    const result = await response.json();
    assertEquals(result.qualification, "test_room_band_step");
    assertEquals(result.capture_sha256, sha256);
    assertEquals(result.row_count, rows.length);
    assertEquals(Object.hasOwn(result, "publication"), false);
    return result;
  };
  for (let index = 0; index < ROOM_BAND_FIT_CELL_COUNT; index++) {
    let result = await run();
    for (let iteration = 0; result.phase === "iteration" && iteration < 1000; iteration++) {
      const response = await probe(new Request("https://probe.test", { method: "POST", headers: { authorization: "Bearer private" },
        body: JSON.stringify({ kind: "room_band_step", from_at, band_c: 0, ratedPowerW: 800,
          capture: { base64, sha256 }, cells, heat_state: result.heat_state }) }));
      assertEquals(response.status, 200); result = await response.json();
    }
    assertEquals(result.phase, "cell");
    assertEquals(result.index, index);
    assertEquals(result.cell, fitIndependentRoomBandCell(prepared, index));
    cells.push(result.cell);
  }
  const result = await run();
  assertEquals(result.phase, "finalize");
  assertEquals(result.fit, finalizeIndependentRoomBand(prepared, cells));
  assertEquals((await run()).result_sha256, result.result_sha256);
});

// Independently generated diagnostic observations, not a household replay.
function syntheticProbeRows(): RoomMeanQuarter[] {
  return Array.from({ length: 240 }, (_, i) => ({ start_ms: Date.UTC(2026, 0, 1) + i * 900_000,
    duration_s: 900, room_c: 19 + .2 * Math.sin(i / 11), outdoor_c: 2 + Math.sin(i / 23),
    house_c: 20 + .1 * Math.sin(i / 7), solar_w_per_m2: null,
    heat_w: i % 20 < 7 ? 800 : 0, cooling: false }));
}
